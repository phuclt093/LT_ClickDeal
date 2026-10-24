/**
 * API trang quản lý cho affiliate (bắt buộc đăng nhập + 2FA).
 * Mọi truy vấn chạy trong ngữ cảnh affiliate → RLS chặn đọc dữ liệu affiliate khác.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listCredentials, saveCredentials } from "../services/credentials.js";
import { syncAffiliate } from "../services/sync.js";
import { buildGatewayUrl, validateGatewayTemplate } from "../services/gateway.js";
import { audit, AppError, type Deps } from "../services/deps.js";
import { requireUser } from "./auth.js";
import { baseUrl } from "./util.js";

const CredBody = z.discriminatedUnion("network", [
  z.object({
    network: z.literal("accesstrade"),
    accessKey: z.string().trim().min(10).max(200),
    campaignId: z.string().trim().regex(/^\d{3,25}$/, "Campaign ID là dãy số")
  }),
  z.object({
    network: z.literal("shopee"),
    appId: z.string().trim().regex(/^\d{3,25}$/),
    secret: z.string().trim().min(10).max(200)
  })
]);
const GatewayBody = z.object({ template: z.string().min(10).max(500) });
const SettingsBody = z.object({
  linkMode: z.enum(["gateway", "api"]).optional(),
  defaultCashbackRate: z.number().min(0).max(100).optional(),
  preferredNetwork: z.enum(["accesstrade", "shopee"]).optional()
});
const PayoutBody = z.object({
  customerId: z.string().uuid(),
  amount: z.number().positive().max(1_000_000_000),
  note: z.string().max(200).optional()
});
const CustomerRateBody = z.object({ cashbackRate: z.number().min(0).max(100).nullable() });

export function affRoutes(app: FastifyInstance, deps: Deps) {
  const guard = { preHandler: requireUser(deps, { role: "affiliate" }) };
  const affId = (req: any) => {
    const id = req.session?.affiliateId;
    if (!id) throw new AppError("Tài khoản không phải affiliate", 403);
    return id as string;
  };

  app.get("/v1/aff/me", guard, async (req) => {
    const id = affId(req);
    return deps.db.tx({ affiliateId: id }, async (q) => {
      const a: any = (await q.query("SELECT code, display_name, default_cashback_rate, preferred_network, status, plan, last_synced_at, link_mode, gateway_template FROM affiliates WHERE id = $1", [id])).rows[0];
      return {
        code: a.code,
        displayName: a.display_name,
        defaultCashbackRate: Number(a.default_cashback_rate),
        preferredNetwork: a.preferred_network,
        status: a.status,
        plan: a.plan,
        lastSyncedAt: a.last_synced_at,
        linkMode: a.link_mode,
        gatewayTemplate: a.gateway_template,
        inviteUrl: `${baseUrl(deps, req)}/j/${a.code}`,
        credentials: await listCredentials(q)
      };
    });
  });

  app.put("/v1/aff/credentials", { ...guard, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const b = CredBody.parse(req.body);
    const id = affId(req);
    const input =
      b.network === "accesstrade"
        ? { network: b.network, secret: b.accessKey, campaignId: b.campaignId }
        : { network: b.network, secret: b.secret, appId: b.appId };
    return saveCredentials(deps, id, input, { userId: req.session!.userId, ip: req.ip });
  });

  // Cách 1: khai báo cổng nhận link trên trang của affiliate
  app.put("/v1/aff/gateway", guard, async (req) => {
    const id = affId(req);
    const template = validateGatewayTemplate(GatewayBody.parse(req.body).template);
    await deps.db.tx({ affiliateId: id }, async (q) => {
      await q.query("UPDATE affiliates SET gateway_template = $1, link_mode = 'gateway' WHERE id = $2", [template, id]);
      await audit(q, { affiliateId: id, actorUserId: req.session!.userId, action: "gateway.save", target: template, ip: req.ip });
    });
    return {
      ok: true,
      template,
      example: buildGatewayUrl(template, { url: "https://shopee.vn/product/301412525/28780427085", sub: "CVIDUKHACH", click: "vi-du" }),
      note: "Mở thử địa chỉ ví dụ: phải chuyển sang Shopee bằng link affiliate của bạn."
    };
  });

  app.put("/v1/aff/settings", guard, async (req) => {
    const b = SettingsBody.parse(req.body);
    const id = affId(req);
    await deps.db.tx({ affiliateId: id }, async (q) => {
      if (b.defaultCashbackRate !== undefined)
        await q.query("UPDATE affiliates SET default_cashback_rate = $1 WHERE id = $2", [b.defaultCashbackRate, id]);
      if (b.linkMode) await q.query("UPDATE affiliates SET link_mode = $1 WHERE id = $2", [b.linkMode, id]);
      if (b.preferredNetwork) await q.query("UPDATE affiliates SET preferred_network = $1 WHERE id = $2", [b.preferredNetwork, id]);
      await audit(q, { affiliateId: id, actorUserId: req.session!.userId, action: "settings.update", target: JSON.stringify(b), ip: req.ip });
    });
    return { ok: true };
  });

  app.get("/v1/aff/customers", guard, async (req) => {
    const id = affId(req);
    return deps.db.tx({ affiliateId: id }, async (q) => {
      const r = await q.query(
        `SELECT c.id, c.ref_code, c.nickname, c.contact_enc, c.cashback_rate, c.created_at, c.last_seen_at, c.revoked_at,
                coalesce(c.cashback_rate, a.default_cashback_rate) AS rate,
                (SELECT count(*) FROM links l WHERE l.customer_id = c.id) AS clicks,
                (SELECT coalesce(sum(o.pub_commission), 0) FROM orders o WHERE o.customer_id = c.id AND o.status = 'approved') AS approved_commission,
                (SELECT coalesce(sum(o.pub_commission), 0) FROM orders o WHERE o.customer_id = c.id AND o.status = 'pending') AS pending_commission,
                (SELECT coalesce(sum(p.amount), 0) FROM payouts p WHERE p.customer_id = c.id) AS paid
           FROM customers c JOIN affiliates a ON a.id = c.affiliate_id
          ORDER BY c.created_at DESC LIMIT 500`
      );
      return Promise.all(
        r.rows.map(async (c: any) => {
          const rate = Number(c.rate) / 100;
          const approvedCashback = Math.floor(Number(c.approved_commission) * rate);
          return {
            id: c.id,
            refCode: c.ref_code,
            nickname: c.nickname,
            contact: c.contact_enc ? await deps.box.decrypt(c.contact_enc, `contact:${id}:${c.ref_code}`) : null,
            cashbackRate: Number(c.rate),
            customRate: c.cashback_rate !== null,
            clicks: Number(c.clicks),
            pendingCashback: Math.floor(Number(c.pending_commission) * rate),
            approvedCashback,
            paid: Number(c.paid),
            owed: Math.max(0, approvedCashback - Number(c.paid)),
            joinedAt: c.created_at,
            lastSeenAt: c.last_seen_at,
            removed: !!c.revoked_at
          };
        })
      );
    });
  });

  app.put("/v1/aff/customers/:id/rate", guard, async (req) => {
    const b = CustomerRateBody.parse(req.body);
    const id = affId(req);
    const cid = z.string().uuid().parse((req.params as any).id);
    const r = await deps.db.tx({ affiliateId: id }, (q) =>
      q.query("UPDATE customers SET cashback_rate = $1 WHERE id = $2 RETURNING id", [b.cashbackRate, cid])
    );
    if (!r.rows.length) throw new AppError("Không tìm thấy khách", 404);
    return { ok: true };
  });

  app.get("/v1/aff/orders", guard, async (req) => {
    const id = affId(req);
    const status = (req.query as any)?.status;
    if (status && !["pending", "approved", "rejected"].includes(status)) throw new AppError("Trạng thái không hợp lệ");
    return deps.db.tx({ affiliateId: id }, async (q) =>
      (
        await q.query(
          `SELECT o.network, o.network_order_id, o.merchant, o.billing, o.pub_commission, o.status, o.is_confirmed, o.sales_time,
                  c.id AS customer_id, c.nickname
             FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
            WHERE ($1::text IS NULL OR o.status = $1)
            ORDER BY o.sales_time DESC NULLS LAST LIMIT 500`,
          [status ?? null]
        )
      ).rows.map((o: any) => ({
        network: o.network,
        orderId: o.network_order_id,
        merchant: o.merchant,
        billing: Number(o.billing),
        commission: Number(o.pub_commission),
        status: o.status,
        confirmed: o.is_confirmed,
        salesTime: o.sales_time,
        customer: o.customer_id ? { id: o.customer_id, nickname: o.nickname } : null
      }))
    );
  });

  // Lượt bấm mua gần đây (chế độ cổng: ClickDeal không có đơn, nên đây là dữ liệu chính)
  app.get("/v1/aff/links", guard, async (req) => {
    const id = affId(req);
    return deps.db.tx({ affiliateId: id }, async (q) =>
      (
        await q.query(
          `SELECT l.created_at, l.product_url, l.product_name, l.price, l.source, c.nickname, c.ref_code
             FROM links l JOIN customers c ON c.id = l.customer_id
            ORDER BY l.created_at DESC LIMIT 200`
        )
      ).rows.map((l: any) => ({
        at: l.created_at,
        productUrl: l.product_url,
        productName: l.product_name,
        price: l.price,
        source: l.source,
        customer: l.nickname,
        refCode: l.ref_code
      }))
    );
  });

  app.post("/v1/aff/payouts", guard, async (req) => {
    const b = PayoutBody.parse(req.body);
    const id = affId(req);
    return deps.db.tx({ affiliateId: id }, async (q) => {
      const c = await q.query("SELECT id FROM customers WHERE id = $1", [b.customerId]);
      if (!c.rows.length) throw new AppError("Không tìm thấy khách", 404);
      const p = await q.query<{ id: string }>(
        "INSERT INTO payouts (affiliate_id, customer_id, amount, note) VALUES ($1, $2, $3, $4) RETURNING id",
        [id, b.customerId, b.amount, b.note ?? null]
      );
      await audit(q, { affiliateId: id, actorUserId: req.session!.userId, action: "payout.record", target: `${b.customerId}:${b.amount}`, ip: req.ip });
      return { id: p.rows[0].id };
    });
  });

  app.post("/v1/aff/sync", { ...guard, config: { rateLimit: { max: 2, timeWindow: "5 minutes" } } }, async (req) => {
    return syncAffiliate(deps, affId(req), { days: 60 });
  });
}
