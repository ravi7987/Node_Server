import Mongoose from "mongoose";
import { DataBase } from "../EnumsAndConstants/Configuration";
import Config from "./ConfigLoader";

/*
 *  Class ConnectDataBase is used to define properties and methods for connection with database nodejs driver
 *  Switch case is used for static method init to select database on the basis of configuration variable
 *  Imports can be handled accordingly
 */
class ConnectDataBase {
	public static async init() {
		try {
			const database = Config.env.dataBase;
			if (!!!database || database.trim().length === 0) {
				throw new Error();
			}

			switch (database) {
				case DataBase.MONGODB: {
					const connection = await Mongoose.connect(Config.env.databaseURL, {
						dbName: Config.env.databaseName,
						autoIndex: false,
						// promiseLibrary: true,
						// authSource: '',
						// user: '',
						// pass: ''
					});

					Mongoose.set("strictQuery", false);

					/* If connection drops */
					connection.connection.on("disconnected", (error) => {
						throw new Error(error);
					});

					/* If connection drops due to an error */
					connection.connection.on("error", (error) => {
						throw new Error(error);
					});

					console.log(`Connection to the database successfull`);

					break;
				}
				case DataBase.MSSQL: {
					break;
				}
				case DataBase.MYSQL: {
					break;
				}
				case DataBase.POSTGRES: {
					break;
				}
			}
		} catch (error: any) {
			console.log(`Unable to connect to the database`);
		}
	}
}

export default ConnectDataBase;
