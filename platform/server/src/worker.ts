/** Tiến trình riêng chạy đồng bộ đơn định kỳ (tách khỏi API để API luôn nhanh). */
import { createDeps } from "./bootstrap.js";
import { syncAll } from "./services/sync.js";

const deps = await createDeps();
let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));

while (!stopping) {
  const started = Date.now();
  await syncAll(deps);
  const wait = Math.max(0, deps.config.syncIntervalMs - (Date.now() - started));
  await deps.sleep(wait);
}
await deps.db.close();
