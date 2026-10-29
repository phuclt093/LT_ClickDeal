/**
 * Ảnh bằng chứng (ảnh chụp đơn hàng, biên lai chuyển khoản).
 *  - Chỉ nhận JPEG/PNG/WebP, kiểm tra theo nội dung file (không tin tên/đuôi file).
 *  - Mã hóa AES-256-GCM trước khi lưu, gắn với đúng khách và affiliate.
 *  - Không sửa/xóa được qua ứng dụng (DB chỉ cấp quyền SELECT, INSERT).
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../db/db.js";
import { AppError, type Deps } from "./deps.js";

export const MAX_IMAGE_BYTES = 1_500_000;

function sniff(buf: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Nhận ảnh dạng data URL (trình duyệt đã nén sẵn). */
export function parseImage(dataUrl: string) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new AppError("Ảnh không hợp lệ (chỉ nhận JPG, PNG, WebP)");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_IMAGE_BYTES) throw new AppError("Ảnh quá lớn (tối đa 1,5 MB)");
  const mime = sniff(buf);
  if (!mime) throw new AppError("File không phải ảnh JPG, PNG hoặc WebP");
  return { buf, mime };
}

const ctx = (affiliateId: string, customerId: string) => `file:${affiliateId}:${customerId}`;

export async function saveImage(
  deps: Deps,
  q: Queryable,
  a: { affiliateId: string; customerId: string; uploader: "buyer" | "affiliate"; dataUrl: string }
): Promise<string> {
  const { buf, mime } = parseImage(a.dataUrl);
  const enc = await deps.box.encrypt(buf.toString("base64"), ctx(a.affiliateId, a.customerId));
  const r = await q.query<{ id: string }>(
    `INSERT INTO attachments (affiliate_id, customer_id, uploader, mime, size, sha256, data_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [a.affiliateId, a.customerId, a.uploader, mime, buf.length, createHash("sha256").update(buf).digest("hex"), enc]
  );
  return r.rows[0].id;
}

/** Đọc ảnh. Câu truy vấn chạy trong ngữ cảnh affiliate (RLS); customerId giới hạn thêm cho người mua. */
export async function readImage(deps: Deps, q: Queryable, id: string, onlyCustomerId?: string) {
  const r = await q.query<any>(
    "SELECT affiliate_id, customer_id, mime, data_enc FROM attachments WHERE id = $1 AND ($2::uuid IS NULL OR customer_id = $2)",
    [id, onlyCustomerId ?? null]
  );
  const f = r.rows[0];
  if (!f) throw new AppError("Không tìm thấy ảnh", 404);
  const b64 = await deps.box.decrypt(f.data_enc, ctx(f.affiliate_id, f.customer_id));
  return { mime: f.mime as string, buf: Buffer.from(b64, "base64") };
}
