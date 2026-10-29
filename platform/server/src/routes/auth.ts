/**
 * Đăng ký / đăng nhập cho 2 vai trò: người mua (buyer) và affiliate.
 *  - Mật khẩu: Argon2id. Khóa tạm 15 phút sau 5 lần sai.
 *  - Affiliate/admin: 2FA (TOTP) BẮT BUỘC. Người mua: đăng nhập bằng số điện thoại + mật khẩu.
 *  - Phiên: cookie httpOnly + Secure + SameSite=Strict; DB chỉ lưu SHA-256 của token phiên.
 *  - Đăng ký phải đồng ý Điều khoản & miễn trừ trách nhiệm (lưu phiên bản + thời điểm).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import argon2 from "argon2";
import { authenticator } from "otplib";
import { z } from "zod";
import QRCode from "qrcode";
import { hashToken, newRefCode, newToken } from "../security/crypto.js";
import { audit, AppError, type Deps } from "../services/deps.js";

export const SESSION_COOKIE = "cd_session";
/** Phiên bản điều khoản hiện hành (public/terms.html). Đổi nội dung điều khoản thì tăng số này. */
export const TERMS_VERSION = "2026-10-29";
const SESSION_HOURS = { admin: 12, affiliate: 12, buyer: 24 * 30 } as const;
type Role = keyof typeof SESSION_HOURS;
authenticator.options = { window: 1 };

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string | null;
  phone: string | null;
  displayName: string | null;
  role: Role;
  totpEnabled: boolean;
  mfaPassed: boolean;
  /** affiliate đang đăng nhập (vai trò affiliate) */
  affiliateId: string | null;
  /** hồ sơ khách (vai trò người mua) */
  customer: { customerId: string; affiliateId: string; refCode: string; nickname: string | null } | null;
}

declare module "fastify" {
  interface FastifyRequest {
    session?: SessionUser;
  }
}

const RegisterBody = z.object({
  email: z.string().email().max(200).transform((s) => s.toLowerCase()),
  password: z.string().min(10, "Mật khẩu tối thiểu 10 ký tự").max(200),
  displayName: z.string().trim().min(2).max(80),
  code: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{3,20}$/, "Mã affiliate: 3–20 chữ cái không dấu hoặc số")),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: "Bạn cần đồng ý Điều khoản sử dụng" }) })
});

/** Chuẩn hóa số điện thoại Việt Nam về dạng 0xxxxxxxxx. */
export function normalizePhone(s: string): string | null {
  let p = s.replace(/[\s.\-()]/g, "");
  if (p.startsWith("+84")) p = "0" + p.slice(3);
  else if (/^84\d{9,10}$/.test(p)) p = "0" + p.slice(2);
  return /^0\d{9,10}$/.test(p) ? p : null;
}
const Phone = z.string().transform((s, ctx) => {
  const p = normalizePhone(s);
  if (!p) ctx.addIssue({ code: "custom", message: "Số điện thoại không hợp lệ" });
  return p ?? "";
});

const RegisterBuyerBody = z.object({
  // để trống → gắn vào affiliate mặc định (DEFAULT_INVITE_CODE) nếu server có cài
  inviteCode: z.string().trim().toUpperCase().regex(/^([A-Z0-9]{3,20})?$/, "Mã mời không hợp lệ").default(""),
  name: z.string().trim().min(1, "Nhập tên của bạn").max(40),
  phone: Phone,
  password: z.string().min(8, "Mật khẩu tối thiểu 8 ký tự").max(200),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: "Bạn cần đồng ý Điều khoản sử dụng" }) })
});
const LoginBody = z
  .object({
    login: z.string().trim().max(200).optional(),
    email: z.string().trim().max(200).optional(),
    password: z.string().max(200),
    totp: z.string().regex(/^\d{6}$/).optional(),
    role: z.enum(["buyer", "affiliate"]).optional()
  })
  .transform((b) => ({ ...b, login: (b.login || b.email || "").toLowerCase() }));
const CodeBody = z.object({ code: z.string().regex(/^\d{6}$/) });

async function startSession(deps: Deps, reply: FastifyReply, req: FastifyRequest, userId: string, mfaPassed: boolean, role: Role) {
  const token = newToken("cds");
  const hours = SESSION_HOURS[role];
  await deps.db.tx({ system: true }, (q) =>
    q.query(
      "INSERT INTO sessions (user_id, token_hash, mfa_passed, expires_at, ip, user_agent) VALUES ($1, $2, $3, now() + $4::interval, $5, $6)",
      [userId, hashToken(token), mfaPassed, `${hours} hours`, req.ip, String(req.headers["user-agent"] || "").slice(0, 200)]
    )
  );
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: deps.config.cookieSecure,
    sameSite: "strict",
    path: "/",
    maxAge: hours * 3600
  });
}

export async function loadSession(deps: Deps, req: FastifyRequest): Promise<SessionUser | undefined> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || token.length > 200) return undefined;
  const r = await deps.db.tx({ system: true }, (q) =>
    q.query(
      `SELECT s.id AS sid, s.mfa_passed, u.id AS uid, u.email, u.phone, u.display_name, u.role, u.totp_enabled, a.id AS aid,
              c.id AS cid, c.affiliate_id AS c_aff, c.ref_code, c.nickname
         FROM sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN affiliates a ON a.user_id = u.id
         LEFT JOIN customers c ON c.user_id = u.id AND c.revoked_at IS NULL
        WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
      [hashToken(token)]
    )
  );
  const x: any = r.rows[0];
  if (!x) return undefined;
  return {
    sessionId: x.sid,
    userId: x.uid,
    email: x.email,
    phone: x.phone,
    displayName: x.display_name,
    role: x.role,
    totpEnabled: x.totp_enabled,
    mfaPassed: x.mfa_passed,
    affiliateId: x.aid,
    customer: x.cid ? { customerId: x.cid, affiliateId: x.c_aff, refCode: x.ref_code, nickname: x.nickname } : null
  };
}

/** Yêu cầu đăng nhập; affiliate/admin mặc định bắt buộc đã qua 2FA. */
export function requireUser(deps: Deps, opts: { mfa?: boolean; role?: Role } = {}) {
  return async (req: FastifyRequest) => {
    const s = await loadSession(deps, req);
    if (!s) throw new AppError("Bạn cần đăng nhập", 401);
    const needMfa = s.role !== "buyer" && (opts.mfa ?? true);
    if (needMfa && !(s.totpEnabled && s.mfaPassed)) throw new AppError("Cần bật và xác thực 2 lớp (2FA) trước", 403);
    if (opts.role && s.role !== opts.role) throw new AppError("Không có quyền", 403);
    req.session = s;
  };
}

export function authRoutes(app: FastifyInstance, deps: Deps) {
  const strict = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post("/v1/auth/register", strict, async (req, reply) => {
    const b = RegisterBody.parse(req.body);
    const hash = await argon2.hash(b.password, { type: argon2.argon2id });
    const status = deps.config.autoApproveAffiliates ? "active" : "pending";
    const userId = await deps.db.tx({ system: true }, async (q) => {
      const dup = await q.query("SELECT 1 FROM users WHERE email = $1 UNION ALL SELECT 1 FROM affiliates WHERE code = $2", [b.email, b.code]);
      if (dup.rows.length) throw new AppError("Email hoặc mã affiliate đã được dùng", 409);
      const u = await q.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role, display_name, terms_version, terms_accepted_at)
         VALUES ($1, $2, 'affiliate', $3, $4, now()) RETURNING id`,
        [b.email, hash, b.displayName, TERMS_VERSION]
      );
      const a = await q.query<{ id: string }>(
        "INSERT INTO affiliates (user_id, code, display_name, status) VALUES ($1, $2, $3, $4) RETURNING id",
        [u.rows[0].id, b.code, b.displayName, status]
      );
      await audit(q, { affiliateId: a.rows[0].id, actorUserId: u.rows[0].id, action: "affiliate.register", ip: req.ip });
      return u.rows[0].id;
    });
    await startSession(deps, reply, req, userId, false, "affiliate");
    return { ok: true, status, next: "Bật xác thực 2 lớp tại /v1/auth/2fa/setup" };
  });

  // Người mua đăng ký bằng mã mời của affiliate → tạo tài khoản + hồ sơ khách (mã khách gắn vào link)
  app.post("/v1/auth/register-buyer", strict, async (req, reply) => {
    const b = RegisterBuyerBody.parse(req.body);
    const hash = await argon2.hash(b.password, { type: argon2.argon2id });
    const code = b.inviteCode || deps.config.defaultInviteCode;
    if (!code) throw new AppError("Cần mã mời của người giới thiệu (hỏi người đã gửi ClickDeal cho bạn)");
    const out = await deps.db.tx({ system: true }, async (q) => {
      const a: any = (await q.query("SELECT id, display_name, status FROM affiliates WHERE code = $1", [code])).rows[0];
      if (!a || a.status !== "active") {
        throw new AppError(
          b.inviteCode ? `Không có affiliate nào dùng mã mời ${code} (hoặc đang tạm ngưng)` : "Chưa có người giới thiệu mặc định, hãy nhập mã mời",
          404
        );
      }
      const dup = await q.query("SELECT 1 FROM users WHERE phone = $1", [b.phone]);
      if (dup.rows.length) throw new AppError("Số điện thoại này đã có tài khoản, hãy đăng nhập", 409);
      const u = await q.query<{ id: string }>(
        `INSERT INTO users (phone, password_hash, role, display_name, terms_version, terms_accepted_at)
         VALUES ($1, $2, 'buyer', $3, $4, now()) RETURNING id`,
        [b.phone, hash, b.name, TERMS_VERSION]
      );
      const refCode = newRefCode();
      const contactEnc = await deps.box.encrypt(b.phone, `contact:${a.id}:${refCode}`);
      await q.query(
        "INSERT INTO customers (affiliate_id, ref_code, nickname, contact_enc, user_id) VALUES ($1, $2, $3, $4, $5)",
        [a.id, refCode, b.name, contactEnc, u.rows[0].id]
      );
      await audit(q, { affiliateId: a.id, actorUserId: u.rows[0].id, action: "buyer.register", ip: req.ip });
      return { userId: u.rows[0].id, affiliate: { code, displayName: a.display_name } };
    });
    await startSession(deps, reply, req, out.userId, false, "buyer");
    return { ok: true, role: "buyer", affiliate: out.affiliate };
  });

  app.post("/v1/auth/login", strict, async (req, reply) => {
    const b = LoginBody.parse(req.body);
    const byPhone = !b.login.includes("@");
    const key = byPhone ? normalizePhone(b.login) : b.login;
    const u: any = key
      ? (
          await deps.db.tx({ system: true }, (q) =>
            q.query(
              `SELECT id, role, password_hash, totp_enabled, totp_secret_enc, failed_logins, locked_until, disabled_at
                 FROM users WHERE ${byPhone ? "phone" : "email"} = $1`,
              [key]
            )
          )
        ).rows[0]
      : undefined;
    const fail = () => new AppError("Tài khoản, mật khẩu hoặc mã 2FA không đúng", 401);
    if (!u || u.disabled_at) {
      await argon2.hash(b.password, { type: argon2.argon2id }); // cân thời gian, tránh dò tài khoản
      throw fail();
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new AppError("Tài khoản tạm khóa do nhập sai nhiều lần, thử lại sau 15 phút", 429);
    let ok = await argon2.verify(u.password_hash, b.password);
    if (ok && u.totp_enabled) {
      const secret = await deps.box.decrypt(u.totp_secret_enc, `totp:${u.id}`);
      ok = !!b.totp && authenticator.check(b.totp, secret);
      if (ok === false && !b.totp) {
        throw new AppError("Nhập mã 2FA 6 số từ ứng dụng xác thực", 401);
      }
    }
    if (!ok) {
      await deps.db.tx({ system: true }, (q) =>
        q.query(
          `UPDATE users SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
           WHERE id = $1`,
          [u.id]
        )
      );
      throw fail();
    }
    await deps.db.tx({ system: true }, (q) => q.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [u.id]));
    // chọn nhầm vai trò ở trang đăng nhập → báo rõ (mật khẩu đã đúng nên không lộ thông tin cho người lạ)
    const isAff = u.role === "affiliate" || u.role === "admin";
    if (b.role === "buyer" && isAff) throw new AppError("Đây là tài khoản affiliate, hãy chọn vai trò Affiliate", 409);
    if (b.role === "affiliate" && !isAff) throw new AppError("Đây là tài khoản người mua, hãy chọn vai trò Người mua", 409);
    await startSession(deps, reply, req, u.id, !!u.totp_enabled, u.role);
    return { ok: true, role: u.role, totpEnabled: !!u.totp_enabled };
  });

  app.post("/v1/auth/logout", { preHandler: requireUser(deps, { mfa: false }) }, async (req, reply) => {
    await deps.db.tx({ system: true }, (q) => q.query("DELETE FROM sessions WHERE id = $1", [req.session!.sessionId]));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/v1/auth/me", { preHandler: requireUser(deps, { mfa: false }) }, async (req) => {
    const s = req.session!;
    return {
      email: s.email,
      phone: s.phone,
      name: s.displayName,
      role: s.role,
      totpEnabled: s.totpEnabled,
      mfaPassed: s.mfaPassed,
      isAffiliate: !!s.affiliateId,
      isBuyer: !!s.customer
    };
  });

  app.post("/v1/auth/2fa/setup", { preHandler: requireUser(deps, { mfa: false }) }, async (req) => {
    const s = req.session!;
    if (s.totpEnabled) throw new AppError("2FA đã được bật", 409);
    const secret = authenticator.generateSecret(20);
    const enc = await deps.box.encrypt(secret, `totp:${s.userId}`);
    await deps.db.tx({ system: true }, (q) => q.query("UPDATE users SET totp_secret_enc = $1 WHERE id = $2", [enc, s.userId]));
    const otpauthUrl = authenticator.keyuri(s.email || s.phone || "clickdeal", "ClickDeal", secret);
    const svg = await QRCode.toString(otpauthUrl, { type: "svg", margin: 1, width: 220 });
    return { secret, otpauthUrl, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` };
  });

  app.post("/v1/auth/2fa/enable", { ...strict, preHandler: requireUser(deps, { mfa: false }) }, async (req) => {
    const s = req.session!;
    const { code } = CodeBody.parse(req.body);
    const u: any = (await deps.db.tx({ system: true }, (q) => q.query("SELECT totp_secret_enc FROM users WHERE id = $1", [s.userId]))).rows[0];
    if (!u?.totp_secret_enc) throw new AppError("Hãy gọi bước cài đặt 2FA trước", 400);
    const secret = await deps.box.decrypt(u.totp_secret_enc, `totp:${s.userId}`);
    if (!authenticator.check(code, secret)) throw new AppError("Mã 2FA không đúng", 400);
    await deps.db.tx({ system: true }, async (q) => {
      await q.query("UPDATE users SET totp_enabled = true WHERE id = $1", [s.userId]);
      await q.query("UPDATE sessions SET mfa_passed = true WHERE id = $1", [s.sessionId]);
      await audit(q, { affiliateId: s.affiliateId, actorUserId: s.userId, action: "2fa.enable", ip: req.ip });
    });
    return { ok: true };
  });
}
