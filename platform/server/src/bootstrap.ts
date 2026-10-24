import { loadConfig, type AppConfig } from "./config.js";
import { createPgDb, createPgliteDb, type Db } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { LocalKeyProvider, SecretBox } from "./security/crypto.js";
import { AccessTradeConnector } from "./connectors/accesstrade.js";
import { ShopeeConnector } from "./connectors/shopee.js";
import type { Deps } from "./services/deps.js";

export async function createDeps(config: AppConfig = loadConfig(), db?: Db): Promise<Deps> {
  const database = db ?? (config.databaseUrl ? createPgDb(config.databaseUrl) : await createPgliteDb());
  await migrate(database);
  return {
    config,
    db: database,
    box: new SecretBox(new LocalKeyProvider(config.masterKey)),
    connectors: {
      accesstrade: new AccessTradeConnector(config.accesstradeBaseUrl),
      shopee: new ShopeeConnector(config.shopeeGraphqlUrl)
    },
    fetchImpl: fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms))
  };
}
