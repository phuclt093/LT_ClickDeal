/**
 * API cho người mua: ứng dụng web/PWA (đăng nhập bằng cookie) và tiện ích trình duyệt (mã kết nối "cdk_…", Bearer).
 * Người mua chỉ thấy dữ liệu của chính mình: mọi truy vấn chạy trong ngữ cảnh affiliate của họ (RLS) + lọc theo customer_id.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { hashToken, newToken } from "../security/crypto.js";
import { createLink, type CustomerCtx } from "../services/links.js";
import { AppError, audit, type Deps } from "../services/deps.js";
import { addEvent, CLAIM_COLS, claimEvents, getClaim, loadBank, postMessage, serializeClaim } from "../services/claims.js";
import { BANKS, bankName } from "../services/vietqr.js";
import { loadSession } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    customer?: CustomerCtx & { nickname: string | null; userId: string | null };
  }
}

const LinkBody = z.object({
  url: z.string().trim().min(8).max(2000),
  source: z.enum(["extension", "pwa", "web", "shortcut", "bot"]).default("web"),
  product: z
    .object({ name: z.string().max(500).optional(), price: z.string().max(60).optional(), image: z.string().max(1000).optional() })
    .optional()
});
const BankBody = z.object({
  bin: z.string().regex(/^\d{6}$/, "Chọn ngân hàng"),
  account: z.string().trim().regex(/^[0-9]{4,19}$/, "Số tài khoản chỉ gồm 4–19 chữ số"),
  holder: z
    .string()
    .trim()
    .min(2, "Nhập tên chủ tài khoản")
    .max(60)
    // tên chủ tài khoản ngân hàng: chữ in hoa không dấu (giống trên app ngân hàng)
    .transform((s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toUpperCase())
});
const ClaimBody = z.object({
  orderCode: z
    .string()
    .trim()
    .transform((s) => s.replace(/\s+/g, "").toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{6,30}$/, "Mã đơn Shopee gồm 6–30 chữ và số")),
  orderAmount: z.number().int().min(0).max(1_000_000_000).optional(),
  orderedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  linkId: z.string().uuid().optional(),
  productName: z.string().trim().max(300).optional(),
  note: z.string().trim().max(1000).optional(),
  image: z.string().max(2_100_000).optional()
});
const MessageBody = z.object({ body: z.string().max(2000).optional(), image: z.string().max(2_100_000).optional() });
const BuyerAction = z.object({
  action: z.enum(["cancel", "confirm_received", "dispute", "close_dispute"]),
  reason: z.string().trim().max(1000).optional()
});

function bearer(req: FastifyRequest) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer (cdk_[A-Za-z0-9_-]{20,80})$/);
  return m ? m[1] : null;
}

/** Người mua: phiên đăng nhập (cookie) hoặc mã kết nối của tiện ích (Bearer). */
export function requireCustomer(deps: Deps) {
  return async (req: FastifyRequest) => {
    const token = bearer(req);
    if (token) {
      const r = await deps.db.tx({ system: true }, (q) =>
        q.query(
          `SELECT c.id, c.affiliate_id, c.ref_code, c.nickname, c.user_id FROM customers c
            WHERE c.token_hash = $1 AND c.revoked_at IS NULL`,
          [hashToken(token)]
        )
      );
      const c: any = r.rows[0];
      if (!c) throw new AppError("Mã kết nối không còn hiệu lực, hãy lấy mã mới trong ClickDeal", 401);
      req.customer = { customerId: c.id, affiliateId: c.affiliate_id, refCode: c.ref_code, nickname: c.nickname, userId: c.user_id };
      return;
    }
    const s = await loadSession(deps, req);
    if (!s) throw new AppError("Bạn cần đăng nhập", 401);
    if (s.role !== "buyer" || !s.customer) throw new AppError("Chức năng này dành cho người mua", 403);
    req.session = s;
    req.customer = { ...s.customer, userId: s.userId };
  };
}

const big = { bodyLimit: 2_500_000 };

export function extRoutes(app: FastifyInstance, deps: Deps) {
  const guard = { preHandler: requireCustomer(deps) };
  const scoped = <T>(req: FastifyRequest, fn: (q: any, c: NonNullable<FastifyRequest["customer"]>) => Promise<T>) =>
    deps.db.tx({ affiliateId: req.customer!.affiliateId }, (q) => fn(q, req.customer!));

  // Thông tin công khai của affiliate + chỉ số uy tín (trang đăng ký bằng link mời)
  app.get("/v1/public/affiliates/:code", async (req) => {
    const code = String((req.params as any).code || "").toUpperCase();
    if (!/^[A-Z0-9]{3,20}$/.test(code)) throw new AppError("Mã không hợp lệ", 404);
    return deps.db.tx({ system: true }, async (q) => {
      const a: any = (
        await q.query("SELECT id, code, display_name, default_cashback_rate, status, created_at FROM affiliates WHERE code = $1", [code])
      ).rows[0];
      if (!a || a.status !== "active") throw new AppError("Không tìm thấy affiliate này", 404);
      const s: any = (
        await q.query(
          `SELECT count(*) FILTER (WHERE status IN ('paid', 'completed'))::int AS paid,
                  count(*) FILTER (WHERE disputed OR disputed_at IS NOT NULL)::int AS disputed,
                  count(*)::int AS total,
                  avg(extract(epoch FROM paid_at - submitted_at) / 86400) FILTER (WHERE paid_at IS NOT NULL) AS avg_days
             FROM claims WHERE affiliate_id = $1`,
          [a.id]
        )
      ).rows[0];
      return {
        code: a.code,
        displayName: a.display_name,
        cashbackRate: Number(a.default_cashback_rate),
        memberSince: a.created_at,
        stats: {
          paidOrders: s.paid,
          totalOrders: s.total,
          disputeRate: s.total ? Math.round((s.disputed / s.total) * 100) : 0,
          avgDaysToPay: s.avg_days === null ? null : Math.round(Number(s.avg_days))
        }
      };
    });
  });

  app.get("/v1/public/banks", async () => BANKS);

  // Trang đăng nhập cần biết: không có mã mời thì có đăng ký được không (affiliate mặc định)
  app.get("/v1/public/signup-info", async () => {
    const code = deps.config.defaultInviteCode;
    if (!code) return { defaultAffiliate: null };
    const a: any = (
      await deps.db.tx({ system: true }, (q) => q.query("SELECT display_name, status FROM affiliates WHERE code = $1", [code]))
    ).rows[0];
    return { defaultAffiliate: a && a.status === "active" ? { displayName: a.display_name } : null };
  });

  app.get("/v1/ext/me", guard, async (req) =>
    scoped(req, async (q, c) => {
      const a: any = (
        await q.query(
          `SELECT a.code, a.display_name, coalesce(cu.cashback_rate, a.default_cashback_rate) AS rate, cu.bank_label, cu.token_hash IS NOT NULL AS has_token
             FROM customers cu JOIN affiliates a ON a.id = cu.affiliate_id WHERE cu.id = $1`,
          [c.customerId]
        )
      ).rows[0];
      return {
        nickname: c.nickname,
        phone: req.session?.phone ?? null,
        refCode: c.refCode,
        cashbackRate: Number(a.rate),
        affiliate: { code: a.code, displayName: a.display_name },
        bank: await loadBank(deps, q, c.customerId),
        hasExtensionKey: a.has_token
      };
    })
  );

  app.put("/v1/ext/bank", guard, async (req) => {
    const b = BankBody.parse(req.body);
    const name = bankName(b.bin);
    if (!name) throw new AppError("Ngân hàng không có trong danh sách");
    return scoped(req, async (q, c) => {
      const enc = await deps.box.encrypt(JSON.stringify(b), `bank:${c.customerId}`);
      await q.query("UPDATE customers SET bank_enc = $1, bank_label = $2 WHERE id = $3", [enc, `${name} ••• ${b.account.slice(-4)}`, c.customerId]);
      await audit(q, { affiliateId: c.affiliateId, actorUserId: c.userId, action: "buyer.bank.update", ip: req.ip });
      return { ok: true };
    });
  });

  // Mã kết nối cho tiện ích trình duyệt: chỉ trả về 1 lần, tạo mới thì mã cũ hết hiệu lực
  app.post("/v1/ext/extension-key", { ...guard, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    if (bearer(req)) throw new AppError("Hãy tạo mã trong ứng dụng ClickDeal", 403);
    const token = newToken("cdk");
    await scoped(req, (q, c) => q.query("UPDATE customers SET token_hash = $1 WHERE id = $2", [hashToken(token), c.customerId]));
    return { token };
  });
  app.delete("/v1/ext/extension-key", guard, async (req) => {
    await scoped(req, (q, c) => q.query("UPDATE customers SET token_hash = NULL WHERE id = $1", [c.customerId]));
    return { ok: true };
  });

  app.post(
    "/v1/ext/links",
    {
      preHandler: requireCustomer(deps),
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => bearer(req) || req.cookies?.cd_session || req.ip }
      }
    },
    async (req) => createLink(deps, req.customer!, LinkBody.parse(req.body))
  );

  // Tổng quan + sản phẩm đã mở gần đây
  app.get("/v1/ext/history", guard, async (req) =>
    scoped(req, async (q, c) => {
      const links = await q.query(
        `SELECT l.id, l.product_name, l.price, l.image, l.product_url, l.aff_link, l.source, l.created_at,
                (SELECT cl.no FROM claims cl WHERE cl.link_id = l.id AND cl.status <> 'cancelled' LIMIT 1) AS claim_no
           FROM links l WHERE l.customer_id = $1 ORDER BY l.created_at DESC LIMIT 100`,
        [c.customerId]
      );
      const t: any = (
        await q.query(
          `SELECT coalesce(sum(cashback) FILTER (WHERE status = 'accepted'), 0) AS waiting,
                  coalesce(sum(cashback) FILTER (WHERE status = 'paid'), 0) AS paid_unconfirmed,
                  coalesce(sum(cashback) FILTER (WHERE status = 'completed'), 0) AS received,
                  count(*) FILTER (WHERE status = 'submitted')::int AS submitted
             FROM claims WHERE customer_id = $1`,
          [c.customerId]
        )
      ).rows[0];
      return {
        totals: { waiting: Number(t.waiting), paidUnconfirmed: Number(t.paid_unconfirmed), received: Number(t.received), submitted: t.submitted },
        links: links.rows.map((l: any) => ({ ...l, claim_no: l.claim_no === null ? null : Number(l.claim_no) }))
      };
    })
  );

  // ---------- Báo đơn ----------
  app.get("/v1/ext/claims", guard, async (req) =>
    scoped(req, async (q, c) =>
      (
        await q.query(
          `SELECT ${CLAIM_COLS} FROM claims cl WHERE cl.customer_id = $1 ORDER BY cl.updated_at DESC LIMIT 200`,
          [c.customerId]
        )
      ).rows.map(serializeClaim)
    )
  );

  app.post("/v1/ext/claims", { ...guard, ...big, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const b = ClaimBody.parse(req.body);
    return scoped(req, async (q, c) => {
      const a: any = (await q.query("SELECT remind_after_days, status FROM affiliates WHERE id = $1", [c.affiliateId])).rows[0];
      if (a.status !== "active") throw new AppError("Affiliate của bạn đang tạm ngưng", 403);
      let productName = b.productName ?? null;
      if (b.linkId) {
        const l: any = (await q.query("SELECT product_name FROM links WHERE id = $1 AND customer_id = $2", [b.linkId, c.customerId])).rows[0];
        if (!l) throw new AppError("Không tìm thấy lượt mua này");
        productName = productName || l.product_name;
      }
      const dup: any = (await q.query("SELECT customer_id FROM claims WHERE order_code = $1", [b.orderCode])).rows[0];
      if (dup) {
        throw new AppError(dup.customer_id === c.customerId ? "Bạn đã báo đơn này rồi" : "Mã đơn này đã được người khác báo. Nếu là đơn của bạn, hãy liên hệ affiliate.", 409);
      }
      const r = await q.query(
        `INSERT INTO claims (affiliate_id, customer_id, link_id, order_code, order_amount, ordered_on, product_name, remind_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8)) RETURNING id, affiliate_id, no`,
        [c.affiliateId, c.customerId, b.linkId ?? null, b.orderCode, b.orderAmount ?? null, b.orderedOn ?? null, productName?.slice(0, 300) ?? null, a.remind_after_days]
      );
      const claim = { ...r.rows[0], customer_id: c.customerId, status: "submitted" };
      await addEvent(q, claim, { actor: "system", kind: "status", body: `Khách báo đơn ${b.orderCode}.` });
      if (b.note || b.image) await postMessage(deps, q, claim, "buyer", { body: b.note, image: b.image });
      return { id: claim.id, no: Number(claim.no) };
    });
  });

  app.get("/v1/ext/claims/:id", guard, async (req) =>
    scoped(req, async (q, c) => {
      const claim = await getClaim(q, (req.params as any).id, c.customerId);
      const a: any = (await q.query("SELECT display_name, code FROM affiliates WHERE id = $1", [c.affiliateId])).rows[0];
      const payout: any = claim.payout_id
        ? (await q.query("SELECT amount, method, note, paid_at, receipt_id FROM payouts WHERE id = $1", [claim.payout_id])).rows[0]
        : null;
      return {
        claim: serializeClaim(claim),
        events: await claimEvents(q, claim.id),
        affiliate: { displayName: a.display_name, code: a.code },
        payout: payout && {
          amount: Number(payout.amount),
          method: payout.method,
          note: payout.note,
          paidAt: payout.paid_at,
          receipt: payout.receipt_id ? `/v1/files/${payout.receipt_id}` : null
        }
      };
    })
  );

  app.post("/v1/ext/claims/:id/messages", { ...guard, ...big, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const b = MessageBody.parse(req.body);
    return scoped(req, async (q, c) => {
      const claim = await getClaim(q, (req.params as any).id, c.customerId, true);
      await postMessage(deps, q, claim, "buyer", b);
      return { ok: true };
    });
  });

  app.post("/v1/ext/claims/:id/actions", guard, async (req) => {
    const b = BuyerAction.parse(req.body);
    return scoped(req, async (q, c) => {
      const claim = await getClaim(q, (req.params as any).id, c.customerId, true);
      const set = async (sql: string, body: string) => {
        await q.query(`UPDATE claims SET ${sql}, updated_at = now() WHERE id = $1`, [claim.id]);
        await addEvent(q, claim, { actor: "buyer", kind: "status", body });
      };
      switch (b.action) {
        case "cancel":
          if (claim.status !== "submitted") throw new AppError("Chỉ hủy được khi affiliate chưa xử lý");
          await set("status = 'cancelled'", "Khách hủy báo đơn.");
          break;
        case "confirm_received":
          if (claim.status !== "paid") throw new AppError("Affiliate chưa báo đã trả tiền cho đơn này");
          await set("status = 'completed', completed_at = now(), disputed = false", "Khách xác nhận đã nhận tiền. ✓");
          break;
        case "dispute":
          if (!["submitted", "accepted", "rejected", "paid"].includes(claim.status)) throw new AppError("Đơn này không khiếu nại được nữa");
          if (claim.disputed) throw new AppError("Đơn đang trong khiếu nại");
          if (!b.reason || b.reason.length < 5) throw new AppError("Ghi rõ lý do khiếu nại");
          await set("disputed = true, disputed_at = now()", `Khách mở khiếu nại: ${b.reason}`);
          break;
        case "close_dispute":
          if (!claim.disputed) throw new AppError("Đơn không có khiếu nại");
          await set("disputed = false", "Khách đóng khiếu nại.");
          break;
      }
      return { ok: true };
    });
  });

  // Xóa tài khoản: xóa thông tin cá nhân, vô hiệu đăng nhập.
  // Lịch sử báo đơn và trao đổi vẫn được lưu theo Điều khoản (phục vụ đối soát và yêu cầu của cơ quan chức năng).
  app.delete("/v1/ext/me", guard, async (req) => {
    const c = req.customer!;
    await deps.db.tx({ affiliateId: c.affiliateId }, (q) =>
      q.query(
        "UPDATE customers SET nickname = NULL, contact_enc = NULL, bank_enc = NULL, bank_label = NULL, token_hash = NULL, revoked_at = now() WHERE id = $1",
        [c.customerId]
      )
    );
    if (c.userId) {
      await deps.db.tx({ system: true }, async (q) => {
        await q.query("UPDATE users SET phone = NULL, email = $2, display_name = NULL, disabled_at = now() WHERE id = $1", [
          c.userId,
          `xoa-${c.userId}@deleted.invalid`
        ]);
        await q.query("DELETE FROM sessions WHERE user_id = $1", [c.userId]);
        await audit(q, { affiliateId: c.affiliateId, actorUserId: c.userId, action: "buyer.delete", ip: req.ip });
      });
    }
    return { ok: true };
  });
}
