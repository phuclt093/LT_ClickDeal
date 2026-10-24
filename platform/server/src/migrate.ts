import { loadConfig } from "./config.js";
import { createPgDb } from "./db/db.js";
import { migrate } from "./db/migrate.js";

const config = loadConfig();
if (!config.databaseUrl) throw new Error("Cần DATABASE_URL");
const db = createPgDb(config.databaseUrl);
await migrate(db);
await db.close();
