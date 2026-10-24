/**
 * Đăng ký / đăng nhập affiliate.
 *  - Mật khẩu: Argon2id. Khóa tạm 15 phút sau 5 lần sai.
 *  - 2FA (TOTP) BẮT BUỘC: chưa bật 2FA thì chỉ vào được trang cài 2FA.
 *  - Phiên: cookie httpOnly + Secure + SameSite=Strict; DB chỉ lưu SHA-256 của token phiên.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import argon2 from "argon2";
import { authenticator } from "otplib";
import { z } from "zod";
import QRCode from "qrcode";
import { hashToken, newToken } from "../security/crypto.js";
import { audit, AppError, type Deps } from "../services/deps.js";

export const SESSION_COOKIE = "cd_session";
const SESSION_HOURS = 12;
authenticator.options = { window: 1 };

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string;
  role: "admin" | "affiliate";
  totpEnabled: boolean;
  mfaPassed: boolean;
  affiliateId: string | null;
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
    .pipe(z.string().regex(/^[A-Z0-9]{3,20}$/, "Mã affiliate: 3–20 chữ cái không dấu hoặc số"))
});
const LoginBody = z.object({
  email: z.string().email().transform((s) => s.toLowerCase()),
  password: z.string().max(200),
  totp: z.string().regex(/^\d{6}$/).optional()
});
const CodeBody = z.object({ code: z.string().regex(/^\d{6}$/) });

async function startSession(deps: Deps, reply: FastifyReply, req: FastifyRequest, userId: string, mfaPassed: boolean) {
  const token = newToken("cds");
  await deps.db.tx({ system: true }, (q) =>
    q.query(
      "INSERT INTO sessions (user_id, token_hash, mfa_passed, expires_at, ip, user_agent) VALUES ($1, $2, $3, now() + $4::interval, $5, $6)",
      [userId, hashToken(token), mfaPassed, `${SESSION_HOURS} hours`, req.ip, String(req.headers["user-agent"] || "").slice(0, 200)]
    )
  );
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: deps.config.cookieSecure,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_HOURS * 3600
  });
}

export async function loadSession(deps: Deps, req: FastifyRequest): Promise<SessionUser | undefined> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || token.length > 200) return undefined;
  const r = await deps.db.tx({ system: true }, (q) =>
    q.query(
      `SELECT s.id AS sid, s.mfa_passed, u.id AS uid, u.email, u.role, u.totp_enabled, a.id AS aid
         FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN affiliates a ON a.user_id = u.id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)]
    )
  );
  const x: any = r.rows[0];
  if (!x) return undefined;
  return {
    sessionId: x.sid,
    userId: x.uid,
    email: x.email,
    role: x.role,
    totpEnabled: x.totp_enabled,
    mfaPassed: x.mfa_passed,
    affiliateId: x.aid
  };
}

/** Yêu cầu đăng nhập; mặc định bắt buộc đã qua 2FA. */
export function requireUser(deps: Deps, opts: { mfa?: boolean; role?: "admin" | "affiliate" } = {}) {
  return async (req: FastifyRequest) => {
    const s = await loadSession(deps, req);
    if (!s) throw new AppError("Bạn cần đăng nhập", 401);
    if ((opts.mfa ?? true) && !(s.totpEnabled && s.mfaPassed)) throw new AppError("Cần bật và xác thực 2 lớp (2FA) trước", 403);
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
        "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'affiliate') RETURNING id",
        [b.email, hash]
      );
      const a = await q.query<{ id: string }>(
        "INSERT INTO affiliates (user_id, code, display_name, status) VALUES ($1, $2, $3, $4) RETURNING id",
        [u.rows[0].id, b.code, b.displayName, status]
      );
      await audit(q, { affiliateId: a.rows[0].id, actorUserId: u.rows[0].id, action: "affiliate.register", ip: req.ip });
      return u.rows[0].id;
    });
    await startSession(deps, reply, req, userId, false);
    return { ok: true, status, next: "Bật xác thực 2 lớp tại /v1/auth/2fa/setup" };
  });

  app.post("/v1/auth/login", strict, async (req, reply) => {
    const b = LoginBody.parse(req.body);
    const u: any = (
      await deps.db.tx({ system: true }, (q) =>
        q.query("SELECT id, password_hash, totp_enabled, totp_secret_enc, failed_logins, locked_until FROM users WHERE email = $1", [b.email])
      )
    ).rows[0];
    const fail = () => new AppError("Email, mật khẩu hoặc mã 2FA không đúng", 401);
    if (!u) {
      await argon2.hash(b.password, { type: argon2.argon2id }); // cân thời gian, tránh dò email
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
    await startSession(deps, reply, req, u.id, !!u.totp_enabled);
    return { ok: true, totpEnabled: !!u.totp_enabled };
  });

  app.post("/v1/auth/logout", { preHandler: requireUser(deps, { mfa: false }) }, async (req, reply) => {
    await deps.db.tx({ system: true }, (q) => q.query("DELETE FROM sessions WHERE id = $1", [req.session!.sessionId]));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/v1/auth/me", { preHandler: requireUser(deps, { mfa: false }) }, async (req) => {
    const s = req.session!;
    return { email: s.email, role: s.role, totpEnabled: s.totpEnabled, mfaPassed: s.mfaPassed, isAffiliate: !!s.affiliateId };
  });

  app.post("/v1/auth/2fa/setup", { preHandler: requireUser(deps, { mfa: false }) }, async (req) => {
    const s = req.session!;
    if (s.totpEnabled) throw new AppError("2FA đã được bật", 409);
    const secret = authenticator.generateSecret(20);
    const enc = await deps.box.encrypt(secret, `totp:${s.userId}`);
    await deps.db.tx({ system: true }, (q) => q.query("UPDATE users SET totp_secret_enc = $1 WHERE id = $2", [enc, s.userId]));
    const otpauthUrl = authenticator.keyuri(s.email, "ClickDeal", secret);
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
