import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Db } from "./db.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/** Chạy các file migrations/*.sql chưa chạy, theo thứ tự tên, mỗi file trong 1 transaction. */
export async function migrate(db: Db, log: (m: string) => void = console.log) {
  await db.ownerExec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
  );
  const done = new Set(
    (await db.ownerQuery<{ version: string }>("SELECT version FROM schema_migrations")).map((r) => r.version)
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_[a-z0-9_]+\.sql$/.test(f)).sort();
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    if (done.has(version)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, f), "utf8");
    await db.ownerExec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations(version) VALUES ('${version}');\nCOMMIT;`);
    log(`migrated ${version}`);
  }
}
