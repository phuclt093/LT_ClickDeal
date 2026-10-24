/**
 * Mã hóa bí mật (khóa API của affiliate, liên hệ của khách) theo kiểu envelope:
 *   - Mỗi bí mật có 1 khóa dữ liệu (DEK) ngẫu nhiên 32 byte, mã hóa bằng AES-256-GCM.
 *   - DEK được "bọc" bằng khóa chính (KEK) qua KeyProvider. Production: KMS — khóa chính
 *     không bao giờ nằm cùng chỗ với DB.
 *   - AAD (ngữ cảnh) gắn bản mã với chủ của nó (vd "cred:<affiliateId>:accesstrade"):
 *     chép bản mã sang dòng khác sẽ KHÔNG giải mã được.
 * Định dạng: v1.<dekWrapped>.<iv>.<ciphertext>.<tag> (base64url)
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface KeyProvider {
  wrap(dek: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

/** Bọc DEK bằng khóa chính trong biến môi trường. Thay bằng KmsKeyProvider khi lên production. */
export class LocalKeyProvider implements KeyProvider {
  constructor(private readonly kek: Buffer) {
    if (kek.length !== 32) throw new Error("KEK phải dài 32 byte");
  }
  async wrap(dek: Buffer) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.kek, iv);
    const ct = Buffer.concat([c.update(dek), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }
  async unwrap(w: Buffer) {
    const d = createDecipheriv("aes-256-gcm", this.kek, w.subarray(0, 12));
    d.setAuthTag(w.subarray(12, 28));
    return Buffer.concat([d.update(w.subarray(28)), d.final()]);
  }
}

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

export class SecretBox {
  constructor(private readonly keys: KeyProvider) {}

  async encrypt(plaintext: string, context: string): Promise<string> {
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", dek, iv);
    c.setAAD(Buffer.from(context, "utf8"));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    const tag = c.getAuthTag();
    const wrapped = await this.keys.wrap(dek);
    dek.fill(0);
    return ["v1", b64(wrapped), b64(iv), b64(ct), b64(tag)].join(".");
  }

  async decrypt(token: string, context: string): Promise<string> {
    const [v, wrapped, iv, ct, tag] = token.split(".");
    if (v !== "v1" || !wrapped || !iv || !ct || !tag) throw new Error("Bản mã không hợp lệ");
    const dek = await this.keys.unwrap(unb64(wrapped));
    try {
      const d = createDecipheriv("aes-256-gcm", dek, unb64(iv));
      d.setAAD(Buffer.from(context, "utf8"));
      d.setAuthTag(unb64(tag));
      return Buffer.concat([d.update(unb64(ct)), d.final()]).toString("utf8");
    } finally {
      dek.fill(0);
    }
  }
}

/** Token ngẫu nhiên 32 byte cho khách/phiên đăng nhập. DB chỉ lưu SHA-256 của nó. */
export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Mã khách ngắn, khó đoán, dùng gắn vào utm_content (không phải bí mật). */
export function newRefCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `C${s}`;
}

export function last4(secret: string): string {
  return secret.slice(-4);
}
