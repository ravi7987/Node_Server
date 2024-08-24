import { Service } from "typedi";

@Service()
class ClientService {
	constructor() {}

	public testService() {
		try {
			console.log("from client service ", this);
		} catch (error) {}
	}
}

export default ClientService;
