import { Router } from "express";
import Container from "typedi";
import ClientController from "../../ControllerLayer/ClientController";

/* Function is used to declare signature for routes from Client side i.e. browser or mobile application */
export default function ClientRoutesHandler() {
	const router = Router();
	const clientController = Container.get(ClientController);

	/* define signature */
	router.post("/test", clientController.testController);

	return router;
}
