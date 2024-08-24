import { Router } from "express";
import ClientRoutesHandler from "./ClientRoutes";

/* Function for configuring routes in one single exported entity */
export default function Version1RoutesHandler() {
	const router = Router();

	/* signature for entertaining client side routes */
	router.use("/client", ClientRoutesHandler());

	return router;
}
