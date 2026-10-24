import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, AppError, type Deps } from "../services/deps.js";
import { requireUser } from "./auth.js";

export function adminRoutes(app: FastifyInstance, deps: Deps) {
  const guard = { preHandler: requireUser(deps, { role: "admin" }) };

  app.get("/v1/admin/affiliates", guard, async () =>
    deps.db.tx({ system: true }, async (q) =>
      (
        await q.query(
          `SELECT a.id, a.code, a.display_name, a.status, a.plan, a.created_at, u.email,
                  (SELECT count(*) FROM customers c WHERE c.affiliate_id = a.id) AS customers
             FROM affiliates a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 500`
        )
      ).rows
    )
  );

  app.post("/v1/admin/affiliates/:id/status", guard, async (req) => {
    const id = z.string().uuid().parse((req.params as any).id);
    const { status } = z.object({ status: z.enum(["active", "suspended"]) }).parse(req.body);
    await deps.db.tx({ system: true }, async (q) => {
      const r = await q.query("UPDATE affiliates SET status = $1 WHERE id = $2 RETURNING id", [status, id]);
      if (!r.rows.length) throw new AppError("Không tìm thấy affiliate", 404);
      await audit(q, { affiliateId: id, actorUserId: req.session!.userId, action: `admin.affiliate.${status}`, ip: req.ip });
    });
    return { ok: true };
  });
}
