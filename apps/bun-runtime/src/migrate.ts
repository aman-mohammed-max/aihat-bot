import { parseBunRuntimeConfig } from "./config.js";
import { openSqliteDatabase } from "./migrations.js";

const config = parseBunRuntimeConfig(process.env);
const db = openSqliteDatabase(config.databasePath);
db.close();
console.log(JSON.stringify({ event: "database_migrations_applied", databasePath: config.databasePath }));
