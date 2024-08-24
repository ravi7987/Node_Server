import "reflect-metadata";
import Application from "./Loaders/Index";

export async function startServer() {
	const application = new Application();

	application.bootstrap();
}

startServer();
