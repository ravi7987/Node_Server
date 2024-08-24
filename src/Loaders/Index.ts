import Config from "./ConfigLoader";
import ExpressApplication from "./ExpressLoader";
import DatabaseLoader from "./DatabaseLoader";

class Application {
	constructor() {}

	private _clearConsole(): void {
		process.stdout.write("\x1B[2J\x1B[0f");
	}

	public async bootstrap() {
		await Config.init();

		ExpressApplication.init();

		// await DatabaseLoader.init();
	}
}

export default Application;
