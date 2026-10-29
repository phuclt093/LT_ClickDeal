/** Xem ảnh bằng chứng: chỉ người mua chủ đơn và affiliate của họ. */
import type { FastifyInstance } from "fastify";
import { readImage } from "../services/attachments.js";
import { AppError, type Deps } from "../services/deps.js";
import { loadSession } from "./auth.js";

export function fileRoutes(app: FastifyInstance, deps: Deps) {
  app.get("/v1/files/:id", async (req, reply) => {
    const id = String((req.params as any).id || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("Không tìm thấy ảnh", 404);
    const s = await loadSession(deps, req);
    if (!s) throw new AppError("Bạn cần đăng nhập", 401);
    let file;
    if (s.role === "buyer" && s.customer) {
      file = await deps.db.tx({ affiliateId: s.customer.affiliateId }, (q) => readImage(deps, q, id, s.customer!.customerId));
    } else if (s.affiliateId && s.totpEnabled && s.mfaPassed) {
      file = await deps.db.tx({ affiliateId: s.affiliateId }, (q) => readImage(deps, q, id));
    } else {
      throw new AppError("Không có quyền", 403);
    }
    reply
      .header("Content-Type", file.mime)
      .header("Cache-Control", "private, max-age=3600")
      .header("Content-Disposition", "inline")
      .header("X-Content-Type-Options", "nosniff");
    return reply.send(file.buf);
  });
}
