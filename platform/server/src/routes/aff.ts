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
import { addEvent, CLAIM_COLS, claimEvents, getClaim, loadBank, postMessage, serializeClaim } from "../services/claims.js";
import { saveImage } from "../services/attachments.js";
import { vietQrPayload, vietQrSvgDataUrl } from "../services/vietqr.js";
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
  preferredNetwork: z.enum(["accesstrade", "shopee"]).optional(),
  remindAfterDays: z.number().int().min(3).max(60).optional(),
  orderSyncEnabled: z.boolean().optional()
});
const PayoutBody = z.object({
  customerId: z.string().uuid(),
  claimIds: z.array(z.string().uuid()).min(1, "Chọn ít nhất 1 đơn").max(100),
  method: z.string().trim().max(40).optional(),
  note: z.string().trim().max(300).optional(),
  receipt: z.string().max(2_100_000).optional()
});
const PayoutQrBody = z.object({ customerId: z.string().uuid(), claimIds: z.array(z.string().uuid()).min(1).max(100) });
const AffAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("accept"),
    commission: z.number().min(0).max(1_000_000_000).nullable().optional(),
    cashback: z.number().int().min(0).max(1_000_000_000),
    note: z.string().trim().max(1000).optional()
  }),
  z.object({ action: z.literal("reject"), reason: z.string().trim().min(5, "Ghi rõ lý do từ chối (ít nhất 5 ký tự)").max(1000) }),
  z.object({ action: z.literal("snooze"), days: z.number().int().min(1).max(30).default(7) }),
  z.object({ action: z.literal("close_dispute"), note: z.string().trim().max(1000).optional() })
]);
const MessageBody = z.object({ body: z.string().max(2000).optional(), image: z.string().max(2_100_000).optional() });
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
      const a: any = (await q.query("SELECT code, display_name, default_cashback_rate, preferred_network, status, plan, last_synced_at, link_mode, gateway_template, remind_after_days, order_sync_enabled FROM affiliates WHERE id = $1", [id])).rows[0];
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
        remindAfterDays: a.remind_after_days,
        orderSyncEnabled: a.order_sync_enabled,
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
      if (b.remindAfterDays !== undefined) await q.query("UPDATE affiliates SET remind_after_days = $1 WHERE id = $2", [b.remindAfterDays, id]);
      if (b.orderSyncEnabled !== undefined) await q.query("UPDATE affiliates SET order_sync_enabled = $1 WHERE id = $2", [b.orderSyncEnabled, id]);
      await audit(q, { affiliateId: id, actorUserId: req.session!.userId, action: "settings.update", target: JSON.stringify(b), ip: req.ip });
    });
    return { ok: true };
  });

  app.get("/v1/aff/customers", guard, async (req) => {
    const id = affId(req);
    return deps.db.tx({ affiliateId: id }, async (q) => {
      const r = await q.query(
        `SELECT c.id, c.ref_code, c.nickname, c.contact_enc, c.cashback_rate, c.created_at, c.last_seen_at, c.revoked_at, c.bank_label,
                coalesce(c.cashback_rate, a.default_cashback_rate) AS rate,
                (SELECT count(*) FROM links l WHERE l.customer_id = c.id) AS clicks,
                (SELECT count(*) FROM claims cl WHERE cl.customer_id = c.id AND cl.status <> 'cancelled') AS claims,
                (SELECT coalesce(sum(cl.cashback), 0) FROM claims cl WHERE cl.customer_id = c.id AND cl.status = 'accepted') AS owed,
                (SELECT coalesce(sum(cl.cashback), 0) FROM claims cl WHERE cl.customer_id = c.id AND cl.status IN ('paid', 'completed')) AS paid
           FROM customers c JOIN affiliates a ON a.id = c.affiliate_id
          ORDER BY c.created_at DESC LIMIT 500`
      );
      return Promise.all(
        r.rows.map(async (c: any) => ({
          id: c.id,
          refCode: c.ref_code,
          nickname: c.nickname,
          contact: c.contact_enc ? await deps.box.decrypt(c.contact_enc, `contact:${id}:${c.ref_code}`) : null,
          bankLabel: c.bank_label,
          cashbackRate: Number(c.rate),
          customRate: c.cashback_rate !== null,
          clicks: Number(c.clicks),
          claims: Number(c.claims),
          owed: Number(c.owed),
          paid: Number(c.paid),
          joinedAt: c.created_at,
          lastSeenAt: c.last_seen_at,
          removed: !!c.revoked_at
        }))
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

  // ---------- Việc cần làm ----------
  app.get("/v1/aff/overview", guard, async (req) => {
    const id = affId(req);
    return deps.db.tx({ affiliateId: id }, async (q) => {
      const c: any = (
        await q.query(
          `SELECT count(*) FILTER (WHERE status = 'submitted')::int AS review,
                  count(*) FILTER (WHERE status = 'accepted' AND remind_at <= now())::int AS due,
                  count(*) FILTER (WHERE status IN ('submitted', 'accepted') AND submitted_at < now() - interval '42 days')::int AS overdue,
                  count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
                  coalesce(sum(cashback) FILTER (WHERE status = 'accepted'), 0) AS owed,
                  coalesce(sum(cashback) FILTER (WHERE status = 'accepted' AND remind_at <= now()), 0) AS owed_due,
                  count(*) FILTER (WHERE disputed)::int AS disputed,
                  count(*) FILTER (WHERE status = 'paid')::int AS awaiting_confirm,
                  coalesce(sum(cashback) FILTER (WHERE status IN ('paid', 'completed') AND paid_at > date_trunc('month', now())), 0) AS paid_month
             FROM claims`
        )
      ).rows[0];
      const k: any = (
        await q.query(
          `SELECT (SELECT count(*) FROM customers WHERE revoked_at IS NULL)::int AS customers,
                  (SELECT count(*) FROM links WHERE created_at > now() - interval '7 days')::int AS clicks7`
        )
      ).rows[0];
      return { ...c, owed: Number(c.owed), owed_due: Number(c.owed_due), paid_month: Number(c.paid_month), ...k };
    });
  });

  // ---------- Đơn khách báo ----------
  const VIEWS: Record<string, string> = {
    review: "cl.status = 'submitted'",
    due: "cl.status = 'accepted' AND cl.remind_at <= now()",
    accepted: "cl.status = 'accepted'",
    disputed: "cl.disputed",
    paid: "cl.status IN ('paid', 'completed')",
    closed: "cl.status IN ('rejected', 'cancelled')",
    all: "true"
  };
  app.get("/v1/aff/claims", guard, async (req) => {
    const id = affId(req);
    const view = String((req.query as any)?.view || "all");
    const where = VIEWS[view];
    if (!where) throw new AppError("Bộ lọc không hợp lệ");
    const customerId = (req.query as any)?.customer;
    if (customerId && !/^[0-9a-f-]{36}$/i.test(customerId)) throw new AppError("Khách không hợp lệ");
    return deps.db.tx({ affiliateId: id }, async (q) =>
      (
        await q.query(
          `SELECT ${CLAIM_COLS}, c.nickname, c.ref_code FROM claims cl JOIN customers c ON c.id = cl.customer_id
            WHERE ${where} AND ($1::uuid IS NULL OR cl.customer_id = $1)
            ORDER BY cl.disputed DESC, cl.submitted_at ${view === "paid" || view === "closed" || view === "all" ? "DESC" : "ASC"} LIMIT 300`,
          [customerId ?? null]
        )
      ).rows.map(serializeClaim)
    );
  });

  app.get("/v1/aff/claims/:id", guard, async (req) => {
    const id = affId(req);
    return deps.db.tx({ affiliateId: id }, async (q) => {
      const claim = await getClaim(q, (req.params as any).id);
      const cu: any = (
        await q.query(
          `SELECT c.contact_enc, c.ref_code, c.revoked_at, coalesce(c.cashback_rate, a.default_cashback_rate) AS rate
             FROM customers c JOIN affiliates a ON a.id = c.affiliate_id WHERE c.id = $1`,
          [claim.customer_id]
        )
      ).rows[0];
      const link: any = claim.link_id
        ? (await q.query("SELECT product_url, product_name, price, created_at FROM links WHERE id = $1", [claim.link_id])).rows[0]
        : null;
      // đối chiếu tự động (tùy chọn): đơn đã đồng bộ từ AccessTrade có cùng mã
      const synced: any = (
        await q.query("SELECT status, pub_commission, billing, ref_code, sales_time FROM orders WHERE network_order_id = $1 LIMIT 1", [claim.order_code])
      ).rows[0];
      const others: any = (
        await q.query(
          "SELECT count(*)::int AS n, count(*) FILTER (WHERE disputed_at IS NOT NULL)::int AS d FROM claims WHERE customer_id = $1 AND id <> $2",
          [claim.customer_id, claim.id]
        )
      ).rows[0];
      return {
        claim: serializeClaim(claim),
        events: await claimEvents(q, claim.id),
        customer: {
          id: claim.customer_id,
          nickname: claim.nickname,
          refCode: cu.ref_code,
          contact: cu.contact_enc ? await deps.box.decrypt(cu.contact_enc, `contact:${id}:${cu.ref_code}`) : null,
          cashbackRate: Number(cu.rate),
          removed: !!cu.revoked_at,
          otherClaims: others.n,
          otherDisputes: others.d
        },
        bank: await loadBank(deps, q, claim.customer_id),
        click: link && { productUrl: link.product_url, productName: link.product_name, price: link.price, at: link.created_at },
        synced: synced && {
          status: synced.status,
          commission: Number(synced.pub_commission),
          billing: Number(synced.billing),
          refMatches: synced.ref_code === cu.ref_code,
          salesTime: synced.sales_time
        }
      };
    });
  });

  app.post("/v1/aff/claims/:id/messages", { ...guard, bodyLimit: 2_500_000 }, async (req) => {
    const b = MessageBody.parse(req.body);
    const id = affId(req);
    return deps.db.tx({ affiliateId: id }, async (q) => {
      const claim = await getClaim(q, (req.params as any).id, undefined, true);
      await postMessage(deps, q, claim, "affiliate", b);
      return { ok: true };
    });
  });

  app.post("/v1/aff/claims/:id/actions", guard, async (req) => {
    const b = AffAction.parse(req.body);
    const id = affId(req);
    const fmt = (n: number) => Math.round(n).toLocaleString("vi-VN") + "₫";
    return deps.db.tx({ affiliateId: id }, async (q) => {
      const claim = await getClaim(q, (req.params as any).id, undefined, true);
      const log = (body: string) => addEvent(q, claim, { actor: "affiliate", kind: "status", body });
      switch (b.action) {
        case "accept": {
          if (!["submitted", "accepted", "rejected"].includes(claim.status)) throw new AppError("Đơn đã trả tiền hoặc đã đóng");
          const again = claim.status === "accepted";
          await q.query(
            `UPDATE claims SET status = 'accepted', commission = $2, cashback = $3, reject_reason = NULL,
                    accepted_at = coalesce(accepted_at, now()), updated_at = now() WHERE id = $1`,
            [claim.id, b.commission ?? null, b.cashback]
          );
          await log(
            (again ? "Affiliate cập nhật số tiền hoàn: " : "Affiliate ghi nhận đơn hợp lệ. Tiền hoàn dự kiến: ") +
              fmt(b.cashback) +
              (b.commission ? ` (hoa hồng ${fmt(b.commission)})` : "") +
              ". Tiền được trả sau khi đơn hoàn tất trên Shopee." +
              (b.note ? `\nGhi chú: ${b.note}` : "")
          );
          break;
        }
        case "reject":
          if (!["submitted", "accepted"].includes(claim.status)) throw new AppError("Không từ chối được đơn ở trạng thái này");
          await q.query("UPDATE claims SET status = 'rejected', reject_reason = $2, updated_at = now() WHERE id = $1", [claim.id, b.reason]);
          await log(`Affiliate từ chối: ${b.reason}`);
          break;
        case "snooze":
          if (claim.status !== "accepted") throw new AppError("Chỉ hoãn nhắc được với đơn đã ghi nhận");
          await q.query("UPDATE claims SET remind_at = now() + make_interval(days => $2), updated_at = now() WHERE id = $1", [claim.id, b.days]);
          break; // việc nội bộ của affiliate, không ghi vào khung trao đổi
        case "close_dispute":
          if (!claim.disputed) throw new AppError("Đơn không có khiếu nại");
          await q.query("UPDATE claims SET disputed = false, updated_at = now() WHERE id = $1", [claim.id]);
          await log("Affiliate đóng khiếu nại." + (b.note ? ` ${b.note}` : ""));
          break;
      }
      await audit(q, { affiliateId: id, actorUserId: req.session!.userId, action: `claim.${b.action}`, target: claim.id, ip: req.ip });
      return { ok: true };
    });
  });

  // ---------- Trả tiền ----------
  // Danh sách cần trả, gom theo khách
  app.get("/v1/aff/payables", guard, async (req) => {
    const id = affId(req);
    return deps.db.tx({ affiliateId: id }, async (q) => {
      const r = await q.query<any>(
        `SELECT ${CLAIM_COLS}, c.nickname, c.ref_code, c.bank_label FROM claims cl JOIN customers c ON c.id = cl.customer_id
          WHERE cl.status = 'accepted' ORDER BY cl.submitted_at`
      );
      const groups = new Map<string, any>();
      for (const row of r.rows) {
        const g = groups.get(row.customer_id) ?? {
          customer: { id: row.customer_id, nickname: row.nickname, refCode: row.ref_code, bankLabel: row.bank_label },
          claims: [] as any[],
          total: 0,
          dueTotal: 0
        };
        const c = serializeClaim(row);
        g.claims.push(c);
        g.total += c.cashback ?? 0;
        if (c.due) g.dueTotal += c.cashback ?? 0;
        groups.set(row.customer_id, g);
      }
      return [...groups.values()].sort((a, b) => b.dueTotal - a.dueTotal || b.total - a.total);
    });
  });

  async function pickClaims(q: any, customerId: string, claimIds: string[]) {
    const r = await q.query(
      `SELECT ${CLAIM_COLS} FROM claims cl WHERE cl.id = ANY($1::uuid[]) AND cl.customer_id = $2 AND cl.status = 'accepted' FOR UPDATE OF cl`,
      [claimIds, customerId]
    );
    if (r.rows.length !== new Set(claimIds).size) throw new AppError("Có đơn không hợp lệ hoặc đã được trả", 409);
    const total = r.rows.reduce((s: number, c: any) => s + Number(c.cashback ?? 0), 0);
    if (total <= 0) throw new AppError("Tổng tiền hoàn bằng 0");
    return { rows: r.rows, total };
  }
  const transferNote = (rows: any[]) => {
    const nos = rows.map((r: any) => Number(r.no)).sort((a: number, b: number) => a - b);
    return `CLICKDEAL ${nos[0]}${nos.length > 1 ? ` VA ${nos.length - 1} DON` : ""}`;
  };

  // Mã VietQR có sẵn số tiền + nội dung để affiliate quét bằng app ngân hàng
  app.post("/v1/aff/payouts/qr", guard, async (req) => {
    const b = PayoutQrBody.parse(req.body);
    const id = affId(req);
    return deps.db.tx({ affiliateId: id }, async (q) => {
      const { rows, total } = await pickClaims(q, b.customerId, b.claimIds);
      const bank = await loadBank(deps, q, b.customerId);
      const note = transferNote(rows);
      if (!bank) return { amount: total, note, bank: null, qr: null };
      const payload = vietQrPayload({ bin: bank.bin, account: bank.account, amount: total, note });
      return { amount: total, note, bank, qr: await vietQrSvgDataUrl(payload) };
    });
  });

  app.post("/v1/aff/payouts", { ...guard, bodyLimit: 2_500_000 }, async (req) => {
    const b = PayoutBody.parse(req.body);
    const id = affId(req);
    const fmt = (n: number) => Math.round(n).toLocaleString("vi-VN") + "₫";
    return deps.db.tx({ affiliateId: id }, async (q) => {
      const { rows, total } = await pickClaims(q, b.customerId, b.claimIds);
      const receiptId = b.receipt
        ? await saveImage(deps, q, { affiliateId: id, customerId: b.customerId, uploader: "affiliate", dataUrl: b.receipt })
        : null;
      const p = await q.query<{ id: string }>(
        "INSERT INTO payouts (affiliate_id, customer_id, amount, note, method, receipt_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [id, b.customerId, total, b.note ?? null, b.method ?? null, receiptId]
      );
      for (const c of rows) {
        await q.query("UPDATE claims SET status = 'paid', paid_at = now(), payout_id = $2, updated_at = now() WHERE id = $1", [c.id, p.rows[0].id]);
        await addEvent(q, c, {
          actor: "affiliate",
          kind: "status",
          body:
            `Affiliate báo đã chuyển ${fmt(Number(c.cashback))}` +
            (rows.length > 1 ? ` (trong lần chuyển gộp ${fmt(total)} cho ${rows.length} đơn)` : "") +
            (b.method ? ` qua ${b.method}` : "") +
            ". Bạn kiểm tra và bấm \"Đã nhận tiền\". Sau 7 ngày không phản hồi, đơn tự hoàn tất." +
            (b.note ? `\nGhi chú: ${b.note}` : ""),
          attachmentId: receiptId
        });
      }
      await audit(q, { affiliateId: id, actorUserId: req.session!.userId, action: "payout.record", target: `${b.customerId}:${total}`, ip: req.ip });
      return { id: p.rows[0].id, amount: total };
    });
  });

  app.post("/v1/aff/sync", { ...guard, config: { rateLimit: { max: 2, timeWindow: "5 minutes" } } }, async (req) => {
    return syncAffiliate(deps, affId(req), { days: 60 });
  });
}
