/**
 * API cho người mua (tiện ích trình duyệt, PWA điện thoại, Phím tắt iPhone).
 * Xác thực bằng token "cdk_…" (Bearer). DB chỉ lưu SHA-256 của token.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { hashToken, newRefCode, newToken } from "../security/crypto.js";
import { createLink, type CustomerCtx } from "../services/links.js";
import { AppError, type Deps } from "../services/deps.js";

declare module "fastify" {
  interface FastifyRequest {
    customer?: CustomerCtx & { nickname: string | null };
  }
}

const JoinBody = z.object({
  affiliateCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,20}$/),
  nickname: z.string().trim().min(1).max(40),
  contact: z.string().trim().max(80).optional()
});
const LinkBody = z.object({
  url: z.string().trim().min(8).max(2000),
  source: z.enum(["extension", "pwa", "web", "shortcut", "bot"]).default("web"),
  product: z
    .object({ name: z.string().max(500).optional(), price: z.string().max(60).optional(), image: z.string().max(1000).optional() })
    .optional()
});

function bearer(req: FastifyRequest) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer (cdk_[A-Za-z0-9_-]{20,80})$/);
  return m ? m[1] : null;
}

export function requireCustomer(deps: Deps) {
  return async (req: FastifyRequest) => {
    const token = bearer(req);
    if (!token) throw new AppError("Thiếu mã kết nối, hãy mở lại link mời của affiliate", 401);
    const r = await deps.db.tx({ system: true }, (q) =>
      q.query(
        `SELECT c.id, c.affiliate_id, c.ref_code, c.nickname FROM customers c
          WHERE c.token_hash = $1 AND c.revoked_at IS NULL`,
        [hashToken(token)]
      )
    );
    const c: any = r.rows[0];
    if (!c) throw new AppError("Mã kết nối không còn hiệu lực, hãy mở lại link mời", 401);
    req.customer = { customerId: c.id, affiliateId: c.affiliate_id, refCode: c.ref_code, nickname: c.nickname };
  };
}

export function extRoutes(app: FastifyInstance, deps: Deps) {
  // Thông tin công khai của affiliate (trang tham gia hiển thị tên)
  app.get("/v1/public/affiliates/:code", async (req) => {
    const code = String((req.params as any).code || "").toUpperCase();
    if (!/^[A-Z0-9]{3,20}$/.test(code)) throw new AppError("Mã không hợp lệ", 404);
    const r = await deps.db.tx({ system: true }, (q) =>
      q.query("SELECT code, display_name, default_cashback_rate, status FROM affiliates WHERE code = $1", [code])
    );
    const a: any = r.rows[0];
    if (!a || a.status !== "active") throw new AppError("Không tìm thấy affiliate này", 404);
    return { code: a.code, displayName: a.display_name, cashbackRate: Number(a.default_cashback_rate) };
  });

  app.post("/v1/ext/join", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const b = JoinBody.parse(req.body);
    const token = newToken("cdk");
    const out = await deps.db.tx({ system: true }, async (q) => {
      const a: any = (await q.query("SELECT id, display_name, status FROM affiliates WHERE code = $1", [b.affiliateCode])).rows[0];
      if (!a || a.status !== "active") throw new AppError("Mã affiliate không đúng hoặc chưa hoạt động", 404);
      const refCode = newRefCode();
      const contactEnc = b.contact ? await deps.box.encrypt(b.contact, `contact:${a.id}:${refCode}`) : null;
      await q.query(
        "INSERT INTO customers (affiliate_id, ref_code, nickname, contact_enc, token_hash) VALUES ($1, $2, $3, $4, $5)",
        [a.id, refCode, b.nickname, contactEnc, hashToken(token)]
      );
      return { refCode, affiliate: { code: b.affiliateCode, displayName: a.display_name } };
    });
    // token chỉ trả về 1 lần duy nhất
    return { token, ...out };
  });

  app.get("/v1/ext/me", { preHandler: requireCustomer(deps) }, async (req) => {
    const c = req.customer!;
    const a: any = (
      await deps.db.tx({ affiliateId: c.affiliateId }, (q) =>
        q.query("SELECT code, display_name FROM affiliates WHERE id = $1", [c.affiliateId])
      )
    ).rows[0];
    return { nickname: c.nickname, refCode: c.refCode, affiliate: { code: a.code, displayName: a.display_name } };
  });

  app.post(
    "/v1/ext/links",
    {
      preHandler: requireCustomer(deps),
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => bearer(req) || req.ip }
      }
    },
    async (req) => {
      const b = LinkBody.parse(req.body);
      return createLink(deps, req.customer!, b);
    }
  );

  app.get("/v1/ext/history", { preHandler: requireCustomer(deps) }, async (req) => {
    const c = req.customer!;
    return deps.db.tx({ affiliateId: c.affiliateId }, async (q) => {
      const rate: any = (
        await q.query(
          "SELECT coalesce(c.cashback_rate, a.default_cashback_rate) AS rate FROM customers c JOIN affiliates a ON a.id = c.affiliate_id WHERE c.id = $1",
          [c.customerId]
        )
      ).rows[0];
      const r = Number(rate?.rate ?? 0) / 100;
      const links = await q.query(
        "SELECT id, product_name, price, image, product_url, aff_link, source, created_at FROM links WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 100",
        [c.customerId]
      );
      const orders = await q.query(
        "SELECT network_order_id, merchant, billing, pub_commission, status, is_confirmed, sales_time FROM orders WHERE customer_id = $1 ORDER BY sales_time DESC NULLS LAST LIMIT 100",
        [c.customerId]
      );
      const paid: any = (await q.query("SELECT coalesce(sum(amount), 0) AS paid FROM payouts WHERE customer_id = $1", [c.customerId])).rows[0];
      const ord = orders.rows.map((o: any) => ({
        orderId: o.network_order_id,
        merchant: o.merchant,
        billing: Number(o.billing),
        status: o.status,
        confirmed: o.is_confirmed,
        cashback: Math.floor(Number(o.pub_commission) * r),
        salesTime: o.sales_time
      }));
      const approved = ord.filter((o) => o.status === "approved").reduce((s, o) => s + o.cashback, 0);
      const pending = ord.filter((o) => o.status === "pending").reduce((s, o) => s + o.cashback, 0);
      return {
        cashbackRate: r * 100,
        totals: { pending, approved, paid: Number(paid.paid), owed: Math.max(0, approved - Number(paid.paid)) },
        orders: ord,
        links: links.rows
      };
    });
  });

  // Quyền xóa dữ liệu: khách tự xóa thông tin cá nhân + vô hiệu token
  app.delete("/v1/ext/me", { preHandler: requireCustomer(deps) }, async (req) => {
    const c = req.customer!;
    await deps.db.tx({ affiliateId: c.affiliateId }, (q) =>
      q.query("UPDATE customers SET nickname = NULL, contact_enc = NULL, revoked_at = now() WHERE id = $1", [c.customerId])
    );
    return { ok: true };
  });
}
