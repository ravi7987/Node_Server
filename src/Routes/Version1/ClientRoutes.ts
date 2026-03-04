import { Router } from "express";
import Container from "typedi";
import ClientController from "../../ControllerLayer/ClientController";
import RateLimiter from "../../Middlewares/RateLimiter";

/* Function is used to declare signature for routes from Client side i.e. browser or mobile application */
export default function ClientRoutesHandler() {
	const router = Router();
	const clientController = Container.get(ClientController);
	const rateLimiter = new RateLimiter();

	/* define signature */
	router.post(
		"/test",
		(req, res, next) => rateLimiter.leakyBucketRateLimiter(req, res, next, 20, 5),
		clientController.testController
	);

	return router;
}
