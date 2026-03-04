import { NextFunction, Request, Response } from 'express';
import Redis from '../Loaders/cacheLoader';

/**
 * RateLimiter
 *
 * Provides Express-compatible rate-limiting middleware using Redis as the
 * backing store. Three strategies are implemented:
 *
 * 1. **Token Bucket** (`tokenBucketRateLimiter`)
 *    - Each user gets a bucket that holds up to `capacity` tokens.
 *    - Tokens are consumed one-per-request and replenished at `refillRate`
 *      tokens/second, calculated lazily on every incoming request rather
 *      than via a background timer.
 *    - Pros: smooth traffic shaping, tolerates small bursts up to `capacity`.
 *
 * 2. **Sliding Window with Sorted Sets** (`tokenBucketRateLimiterWithRedisSortedSets`)
 *    - Uses a Redis Sorted Set whose scores are request timestamps.
 *    - On each request the set is pruned of entries older than `interval` ms,
 *      then the current count is checked against `capacity`.
 *    - Pros: precise sliding window; no lazy-refill math needed.
 *
 * 3. **Leaky Bucket** (`leakyBucketRateLimiter`)
 *    - Models a FIFO queue of fixed `capacity` that "leaks" (drains) at a
 *      constant `drainRate` requests/second.
 *    - Incoming requests are added to the queue; when the queue is full the
 *      request is rejected.
 *    - Pros: guarantees a perfectly smooth, fixed output rate regardless of
 *      input burstiness — ideal for protecting downstream services that
 *      cannot tolerate traffic spikes.
 *
 * All approaches key per-user data on the `email` field extracted from the
 * request body.  In production you would typically key on a more stable
 * identifier (user ID, API key, or IP address).
 *
 * @example
 * ```ts
 * const limiter = new RateLimiter();
 *
 * // Token Bucket: allow 10 requests with a refill of 1 token/second
 * app.post('/login', (req, res, next) =>
 *   limiter.tokenBucketRateLimiter(req, res, next, 10, 1),
 * );
 *
 * // Leaky Bucket: queue up to 20 requests, drain at 5 req/sec
 * app.post('/api/data', (req, res, next) =>
 *   limiter.leakyBucketRateLimiter(req, res, next, 20, 5),
 * );
 * ```
 */
class RateLimiter {
	/**
	 * tokenBucketRateLimiter
	 *
	 * Express middleware that enforces rate limiting via the **Token Bucket**
	 * algorithm.
	 *
	 * ### How it works
	 * 1. Read the user's current token count and last-refill timestamp from
	 *    Redis (two keys: `<email>:tokens`, `<email>:lastRefillTimeStamp`).
	 * 2. Call `refill()` to lazily add tokens based on elapsed time.
	 * 3. If tokens > 0 the request is allowed and a token is consumed;
	 *    otherwise the request is rejected (429 Too Many Requests).
	 *
	 * If the Redis lookup fails (first request or cache miss), the bucket is
	 * initialised at full `capacity`.
	 *
	 * @param request   - Incoming Express request (must contain `email` in body)
	 * @param response  - Express response object
	 * @param next      - Express next function — called when the request is allowed
	 * @param capacity  - Maximum number of tokens the bucket can hold (burst size)
	 * @param refillRate - Number of tokens added per second
	 */
	public async tokenBucketRateLimiter(
		request: Request,
		response: Response,
		next: NextFunction,
		capacity: number,
		refillRate: number
	) {
		try {
			let tokens: number;
			let lastRefillTimestamp: String;
			let currentTokenValue: number;

			// -----------------------------------------------------------
			// Step 1: Identify the user from the request body.
			// In production, prefer a unique & stable identifier such as
			// a JWT subject claim, API key, or IP address.
			// -----------------------------------------------------------
			const { email } = request.body;

			// -----------------------------------------------------------
			// Step 2: Fetch the user's bucket state from Redis.
			// `mGet` retrieves both keys atomically in a single round-trip.
			// If the keys exist, delegate to `refill()` for lazy token
			// replenishment; if they don't (cache miss / first visit),
			// fall through to the catch block and initialise the bucket.
			// -----------------------------------------------------------
			try {
				const cachedData = await Redis.redisClient.mGet([`${email}:tokens`, `${email}:lastRefillTimeStamp`]);
				currentTokenValue = await this.refill(capacity, cachedData[0], cachedData[1], email, refillRate);
			} catch (error) {
				// ---------------------------------------------------------
				// First-time initialisation:
				// Seed the bucket with full capacity and record the current
				// timestamp so future refill calculations have a baseline.
				// ---------------------------------------------------------
				const now = String(performance.now());
				await Redis.redisClient.mSet({
					[`${email}:tokens`]: String(capacity),
					[`${email}:lastRefillTimeStamp`]: now,
				});
				tokens = capacity;
				lastRefillTimestamp = String(now);
				currentTokenValue = await this.refill(capacity, tokens, lastRefillTimestamp, email, refillRate);
			}

			// -----------------------------------------------------------
			// Step 3: Decide whether to allow or reject the request.
			// If tokens remain after refill, consume one and forward the
			// request downstream via `next()`.  Otherwise respond with
			// 429 Too Many Requests.
			// -----------------------------------------------------------
			if (currentTokenValue > 0) {
				// Consume one token and persist the decremented count
				const updatedTokens = currentTokenValue - 1;
				await Redis.redisClient.set(`${email}:tokens`, String(updatedTokens));

				// Allow the request through to the next middleware / route
				next();
			} else {
				// ---------------------------------------------------------
				// Tokens exhausted — reject the request.
				// `Retry-After` tells the client the minimum seconds to
				// wait before a new token becomes available (1 / refillRate).
				// ---------------------------------------------------------
				const retryAfterSeconds = Math.ceil(1 / refillRate);

				response
					.status(429)
					.set('Retry-After', String(retryAfterSeconds))
					.json({
						error: 'Too Many Requests',
						message: `Rate limit exceeded. Please retry after ${retryAfterSeconds} second(s).`,
					});
			}
		} catch (error) {
			// -----------------------------------------------------------
			// Fail-open: if Redis is unreachable we let the request
			// through rather than blocking legitimate users.
			// -----------------------------------------------------------
			next();
		}
	}

	/**
	 * refill (private)
	 *
	 * Lazily replenishes tokens based on the time elapsed since the last
	 * refill and persists the updated state back to Redis.
	 *
	 * ### Calculation
	 * ```
	 * elapsedSeconds = (now - lastRefillTimestamp) / 1000
	 * newTokens      = elapsedSeconds * refillRate
	 * tokens         = min(capacity, currentTokens + newTokens)
	 * ```
	 *
	 * The `Math.min` clamp ensures the bucket never exceeds its maximum
	 * `capacity`, even if a long period passes between requests.
	 *
	 * @param capacity           - Maximum bucket size (upper clamp)
	 * @param tokens             - Current token count before refill
	 * @param lastrefilltimeStamp - Timestamp (ms, from `performance.now()`) of previous refill
	 * @param email              - User identifier used as Redis key prefix
	 * @param refillRate         - Tokens added per second
	 * @returns The updated token count after refill, or 0 if no time has passed
	 */
	private async refill(
		capacity: number,
		tokens: number,
		lastrefilltimeStamp: String,
		email: String,
		refillRate: number
	): Promise<number> {
		// Calculate how much time has elapsed since the last refill
		const now = performance.now();
		const elapsedTime = now - Number(lastrefilltimeStamp);

		// Derive the fractional number of tokens earned in that window
		const newTokens = (elapsedTime / 1000) * refillRate;

		if (newTokens > 0) {
			// Clamp to capacity so the bucket never overflows
			tokens = Math.min(capacity, tokens + newTokens);
			lastrefilltimeStamp = String(now);

			// Persist updated bucket state atomically via `mSet`
			await Redis.redisClient.mSet({
				[`${email}:tokens`]: String(tokens),
				[`${email}:lastRefillTimeStamp`]: String(lastrefilltimeStamp),
			});
			return tokens;
		}

		// No time has passed — no tokens to add
		return 0;
	}

	/**
	 * tokenBucketRateLimiterWithRedisSortedSets
	 *
	 * An alternative rate-limiting strategy that uses a **Sliding Window**
	 * backed by a Redis **Sorted Set** (ZSET).
	 *
	 * ### How it works
	 * Each request timestamp is stored as both the score and the member of a
	 * sorted set keyed by the user's email.  On every incoming request the
	 * following four Redis commands are executed atomically in a pipeline
	 * (`MULTI`/`EXEC`):
	 *
	 * | # | Command               | Purpose                                          |
	 * |---|-----------------------|--------------------------------------------------|
	 * | 1 | `ZREMRANGEBYSCORE`    | Remove all entries older than `interval` ms ago  |
	 * | 2 | `ZRANGE 0 -1`         | Retrieve remaining entries (the sliding window)  |
	 * | 3 | `ZADD now now`        | Optimistically add the current request timestamp |
	 * | 4 | `PEXPIRE`             | Set a TTL so idle keys are auto-cleaned          |
	 *
	 * After execution:
	 * - If the number of timestamps in the window (step 2) **≥ capacity**,
	 *   the newest entry (just added) is removed via `ZPOPMAX` and the
	 *   request is **rejected** (`false`).
	 * - Otherwise the request is **allowed** (`true`) and the new entry stays.
	 *
	 * ### Edge case
	 * If `results` is falsy (e.g., Redis returns null due to a transient
	 * error), the method falls back to allowing the request and seeding a
	 * fresh sorted set — fail-open behaviour.
	 *
	 * @param request   - Incoming Express request (must contain `email` in body)
	 * @param response  - Express response object
	 * @param next      - Express next function
	 * @param capacity  - Maximum number of requests allowed within the window
	 * @param interval  - Sliding window size in **milliseconds**
	 * @returns `true` if the request is within the rate limit, `false` otherwise
	 */
	public async tokenBucketRateLimiterWithRedisSortedSets(
		request: Request,
		response: Response,
		next: NextFunction,
		capacity: number,
		interval: number
	): Promise<boolean> {
		// Identify the user — the sorted set is keyed per user
		const { email } = request.body;

		const sortedSetName = email;
		const now = performance.now();

		// Compute the lower bound of the sliding window
		const oneIntervalAgo = now - interval;

		// -----------------------------------------------------------
		// Execute the four-command pipeline atomically.
		// Using MULTI/EXEC guarantees that no other client can
		// observe a partial state between prune → read → write.
		// -----------------------------------------------------------
		const results = await Redis.redisClient
			.multi()
			// 1. Prune: discard timestamps outside the current window
			.zremrangebyscore(sortedSetName, '-inf', oneIntervalAgo)
			// 2. Read: get all remaining timestamps (the current window)
			.zrange(sortedSetName, 0, -1)
			// 3. Write: optimistically record this request's timestamp
			.zadd(sortedSetName, now, now)
			// 4. Expire: auto-delete the key if the user goes idle,
			//    preventing unbounded memory growth
			.pexpire(sortedSetName, Math.ceil(interval / 1000))
			.exec();

		if (results) {
			// `results[1]` corresponds to the ZRANGE command (step 2)
			const timeStamps = results[1];

			if (timeStamps.length() >= capacity) {
				// ---------------------------------------------------
				// Over the limit: remove the entry we just added
				// (it has the highest score) and reject the request.
				// ---------------------------------------------------
				await Redis.redisClient.zpopmax(sortedSetName);
				return false;
			} else {
				// Within limit — let the request through
				return true;
			}
		} else {
			// -----------------------------------------------------------
			// Fail-open fallback: if the pipeline returned nothing
			// (transient Redis issue), allow the request and seed a
			// fresh sorted set so subsequent requests can be tracked.
			// -----------------------------------------------------------
			await Redis.redisClient
				.multi()
				.zadd(sortedSetName, now, now)
				.pexpire(sortedSetName, Math.ceil(interval / 1000))
				.exec();
			return true;
		}
	}

	// =================================================================
	//  LEAKY BUCKET ALGORITHM
	// =================================================================

	/**
	 * leakyBucketRateLimiter
	 *
	 * Express middleware that enforces rate limiting via the **Leaky Bucket**
	 * algorithm with a **fixed processing (drain) rate**.
	 *
	 * ### Conceptual Model
	 * Imagine a bucket with a small hole at the bottom:
	 * - Incoming requests are "poured" into the bucket (enqueued).
	 * - Water "leaks" out through the hole at a constant rate (`drainRate`
	 *   requests per second), regardless of how fast water is poured in.
	 * - If the bucket is already full (`queueSize >= capacity`), any new
	 *   water (request) overflows and is **rejected** (HTTP 429).
	 *
	 * This produces a perfectly smooth output rate, which is ideal when
	 * downstream services (databases, third-party APIs) can only handle a
	 * fixed throughput.
	 *
	 * ### Redis State (per user)
	 * | Key                              | Type   | Description                              |
	 * |----------------------------------|--------|------------------------------------------|
	 * | `<email>:leaky:queueSize`        | number | Current number of requests in the queue  |
	 * | `<email>:leaky:lastDrainTimestamp`| string | `performance.now()` value of last drain  |
	 *
	 * ### Flow
	 * 1. Fetch `queueSize` and `lastDrainTimestamp` from Redis.
	 * 2. Call `drainLeakyBucket()` to lazily subtract requests that would
	 *    have leaked out since the last check.
	 * 3. If the post-drain queue size < `capacity`, enqueue the request
	 *    (increment queue size), persist state, and call `next()`.
	 * 4. Otherwise respond with **429 Too Many Requests** and a
	 *    `Retry-After` header telling the client how long to wait before
	 *    a slot opens up.
	 *
	 * @param request   - Incoming Express request (must contain `email` in body)
	 * @param response  - Express response object
	 * @param next      - Express next function — called when the request is allowed
	 * @param capacity  - Maximum queue depth (how many requests can wait)
	 * @param drainRate - Fixed number of requests drained (processed) per second
	 */
	public async leakyBucketRateLimiter(
		request: Request,
		response: Response,
		next: NextFunction,
		capacity: number,
		drainRate: number
	): Promise<void> {
		try {
			// -----------------------------------------------------------
			// Step 1: Identify the user.
			// -----------------------------------------------------------
			const { email } = request.body;

			const queueSizeKey = `${email}:leaky:queueSize`;
			const lastDrainKey = `${email}:leaky:lastDrainTimestamp`;

			// -----------------------------------------------------------
			// Step 2: Fetch the current queue state from Redis.
			// On a cache miss (first request or eviction) we initialise
			// the queue as empty.
			// -----------------------------------------------------------
			let queueSize: number;
			let lastDrainTimestamp: number;

			const cachedData = await Redis.redisClient.mGet([queueSizeKey, lastDrainKey]);

			if (cachedData[0] !== null && cachedData[1] !== null) {
				queueSize = Number(cachedData[0]);
				lastDrainTimestamp = Number(cachedData[1]);
			} else {
				// ---------------------------------------------------------
				// First request for this user — empty queue, drain baseline
				// set to "now".
				// ---------------------------------------------------------
				queueSize = 0;
				lastDrainTimestamp = performance.now();
			}

			// -----------------------------------------------------------
			// Step 3: Lazily drain the bucket.
			// Rather than running a background timer, we calculate how
			// many requests *would have* drained since the last check
			// and subtract them from the queue.
			// -----------------------------------------------------------
			const drainResult = this.drainLeakyBucket(queueSize, lastDrainTimestamp, drainRate);
			queueSize = drainResult.queueSize;
			lastDrainTimestamp = drainResult.lastDrainTimestamp;

			// -----------------------------------------------------------
			// Step 4: Admission decision.
			// -----------------------------------------------------------
			if (queueSize < capacity) {
				// Enqueue the request (increment queue depth)
				queueSize += 1;
				// Persist updated state atomically
				await Redis.redisClient.mSet({
					[queueSizeKey]: String(queueSize),
					[lastDrainKey]: String(lastDrainTimestamp),
				});
				// Allow the request to proceed to the next middleware/route
				next();
			} else {
				// ---------------------------------------------------------
				// Queue is full — reject the request.
				// Provide a `Retry-After` header (in seconds) so well-
				// behaved clients know when to retry.  The earliest a slot
				// opens is after one drain interval (1 / drainRate).
				// ---------------------------------------------------------
				const retryAfterSeconds = Math.ceil(1 / drainRate);

				// Persist the drained state even on rejection so the next
				// request sees an up-to-date queue depth.
				await Redis.redisClient.mSet({
					[queueSizeKey]: String(queueSize),
					[lastDrainKey]: String(lastDrainTimestamp),
				});

				response
					.status(429)
					.set('Retry-After', String(retryAfterSeconds))
					.json({
						error: 'Too Many Requests',
						message: `Rate limit exceeded. Please retry after ${retryAfterSeconds} second(s).`,
					});
			}
		} catch (error) {
			// -----------------------------------------------------------
			// Fail-open: if Redis is unreachable we let the request
			// through rather than blocking legitimate users.  In a
			// strict security context you may prefer fail-closed here.
			// -----------------------------------------------------------
			next();
		}
	}

	/**
	 * drainLeakyBucket (private, synchronous)
	 *
	 * Calculates how many queued requests have "leaked" out since the last
	 * drain and returns the updated queue depth and timestamp.
	 *
	 * ### Calculation
	 * ```
	 * elapsedSeconds = (now - lastDrainTimestamp) / 1000
	 * leaked         = floor(elapsedSeconds * drainRate)
	 * queueSize      = max(0, queueSize - leaked)
	 * ```
	 *
	 * - `Math.floor` ensures we only subtract **whole** requests (you can't
	 *   half-process a request).
	 * - `Math.max(0, …)` prevents the queue from going negative when the
	 *   user has been idle for a long time.
	 * - The timestamp is only updated when at least one request has leaked;
	 *   this avoids "losing" fractional time between calls.
	 *
	 * @param queueSize          - Current queue depth before draining
	 * @param lastDrainTimestamp - `performance.now()` value of the previous drain
	 * @param drainRate          - Requests drained per second (fixed processing rate)
	 * @returns Object with updated `queueSize` and `lastDrainTimestamp`
	 */
	private drainLeakyBucket(
		queueSize: number,
		lastDrainTimestamp: number,
		drainRate: number
	): { queueSize: number; lastDrainTimestamp: number } {
		const now = performance.now();
		const elapsedTimeMs = now - lastDrainTimestamp;

		// Convert elapsed time to seconds and calculate whole requests drained
		const leaked = Math.floor((elapsedTimeMs / 1000) * drainRate);

		if (leaked > 0) {
			// Subtract drained requests; clamp to zero to avoid negatives
			queueSize = Math.max(0, queueSize - leaked);

			// Advance the drain timestamp by exactly the time consumed by
			// the leaked requests, preserving any fractional remainder for
			// the next call.  This avoids drift over many small intervals.
			lastDrainTimestamp = lastDrainTimestamp + (leaked / drainRate) * 1000;
		}

		return { queueSize, lastDrainTimestamp };
	}
}

export default RateLimiter;
