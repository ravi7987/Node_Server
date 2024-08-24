import Express, { Request, Response } from "express";
import Cors from "cors";
import Config from "./ConfigLoader";
import Version1RoutesHandler from "../Routes/Version1/Index";

/* Initializes the express server application class */
class ExpressApplication {
	/* static property express */
	public static express: Express.Application;

	/* static fucnction init, which will be used to start the server with necessary configuration */
	public static init() {
		this.express = Express();

		/* parser configuration */
		this.express.use(
			Express.json({
				limit: "16mb",
			})
		);

		this.express.use(Express.urlencoded({ extended: true }));

		/* cors configuration */
		this.express.use(Cors());

		/* Routes configuration */
		this.express.use("/v1", Version1RoutesHandler());

		/* listens to specified port for server */
		this.express.listen(
			{
				port: Config.env.serverPort,
				host: "0.0.0.0",
			},
			() => {
				console.log(`express server is up and running on port ${Config.env.serverPort}`);
			}
		);
	}
}

export default ExpressApplication;
