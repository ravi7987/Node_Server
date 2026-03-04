import { createClient, RedisClientOptions, RedisClientType } from 'redis';

/**
 * @description Configuration for connection to the Redis Client
 * @author (Ravinder)
 */
class RedisClient {
	public static redisClient: any;

	public static async initiateConfiguration() {
		try {
			let redisConnection: RedisClientType;

			/* Use this if Redis is required to be run at a different port than default port of 6379 */
			let REDIS_CLIENT_OPTS: RedisClientOptions = {
				url: 'redis://default:redispw@localhost:55000',
			};

			redisConnection = createClient() as any;

			const redisConnectionInWaiting = await redisConnection
				.on('error', (error) => {
					console.error('Issue with connection to the Redis Client ', error);
				})
				.connect();

			return redisConnectionInWaiting;
		} catch (error) {
			console.error('Issue with connection to the Redis Client ', error);
		}
	}

	/* Initialize the connection and assign to variable which can be used in services */
	public static async init() {
		this.redisClient = await this.initiateConfiguration();
		if (this.redisClient.isOpen) {
			console.info('Redis Connection Successfull');
		}
	}
}

export default RedisClient;
