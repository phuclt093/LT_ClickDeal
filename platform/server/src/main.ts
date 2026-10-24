import { createDeps } from "./bootstrap.js";
import { buildApp } from "./app.js";

const deps = await createDeps();
if (!deps.config.databaseUrl) console.warn("⚠ Chưa có DATABASE_URL: đang chạy Postgres tạm trong bộ nhớ (PGlite), dữ liệu mất khi tắt.");
const app = await buildApp(deps, { logger: true });
await app.listen({ port: deps.config.port, host: "0.0.0.0" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await deps.db.close();
    process.exit(0);
  });
}
