import * as Path from "path";
import Os from "os";
import * as DotEnv from "dotenv";
import { existsSync as ExistsSync, promises as FsPromises } from "fs";
import { AppEnv, AppType } from "../EnumsAndConstants/Configuration";
import { ApplicationConfiguration } from "../CustomTypes/ConfigurationTypes";

/* 
    Access configuration environment file on the basis of operating system platform
    add more tertiary conditions on the basis of OS 
*/

let CONFIG_FILE_PATH = Os.platform() === "win32" ? Path.join(__dirname, "../../.env") : "/opt/env/ondc-server/.env";

class Config {
	/* static property env will be available to all the instances of the class Config */
	public static env: ApplicationConfiguration;

	/* creates payload to be assigned to the static class member env */
	public static async config(): Promise<ApplicationConfiguration> {
		const isConfigFileExists = ExistsSync(CONFIG_FILE_PATH);

		if (!!!isConfigFileExists) {
			throw new Error("Config file path does not exists");
		}

		DotEnv.config({ path: CONFIG_FILE_PATH });

		const serverPort = process.env.EXPRESS_SERVER_PORT ? parseInt(process.env.EXPRESS_SERVER_PORT) : 4040;
		const dataBase = process.env.DATABASE || "";
		const databaseURL = process.env.DATABASE_URL || "";
		const databaseName = process.env.DATABASE_NAME || "";
		const databaseUser = process.env.DATABASE_USER || "";
		const databasePassword = process.env.DATABASE_PASSWORD || "";
		const applicationEnv = (process.env.APP_ENV as AppEnv) || AppEnv.Dev;
		const applicationType = (process.env.APP_TYPE as AppType) || AppType.Default;

		return {
			serverPort,
			dataBase,
			databaseURL,
			databaseName,
			databaseUser,
			databasePassword,
			applicationEnv,
			applicationType,
		};
	}

	/* assigns configuration payload to the static property env */
	public static async init(): Promise<void> {
		this.env = await this.config();
	}
}

export default Config;
