/**
 * Tiến trình chạy nền (tách khỏi API để API luôn nhanh):
 *  - Tự hoàn tất đơn affiliate đã báo trả mà khách không phản hồi sau 7 ngày.
 *  - Đồng bộ đơn AccessTrade cho affiliate đã bật "tự đối chiếu" (tùy chọn).
 */
import { createDeps } from "./bootstrap.js";
import { syncAll } from "./services/sync.js";
import { autoComplete } from "./services/claims.js";

const deps = await createDeps();
let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));

while (!stopping) {
  const started = Date.now();
  try {
    const n = await autoComplete(deps);
    if (n) console.log(`tự hoàn tất ${n} đơn`);
  } catch (e: any) {
    console.log(`tự hoàn tất lỗi: ${e?.message}`);
  }
  await syncAll(deps);
  const wait = Math.max(0, deps.config.syncIntervalMs - (Date.now() - started));
  await deps.sleep(wait);
}
await deps.db.close();
