import { AppEnv, AppType } from "../EnumsAndConstants/Configuration";

export type ApplicationConfiguration = {
	serverPort: number;
	dataBase: string;
	databaseURL: string;
	databaseName: string;
	databaseUser: string;
	databasePassword: string;
	applicationEnv: AppEnv;
	applicationType: AppType;
};
