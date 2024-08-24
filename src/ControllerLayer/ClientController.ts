import { Service } from "typedi";
import { Request, Response, NextFunction } from "express";
import ClientService from "../ServiceLayer/ClientServices";

@Service()
class ClientController {
	constructor(private readonly clientService: ClientService) {}

	public testController = (request: Request, Response: Response) => {
		try {
			console.log("from test controller ", this);
			this.clientService.testService();
		} catch (error) {}
	};
}

export default ClientController;
