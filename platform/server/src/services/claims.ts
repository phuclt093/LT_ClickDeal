/**
 * Báo đơn và trao đổi giữa người mua và affiliate.
 * ClickDeal chỉ ghi nhận: không giữ tiền, không phân xử. Mọi sự kiện được lưu nguyên vẹn (chỉ ghi thêm).
 */
import type { Queryable } from "../db/db.js";
import { saveImage } from "./attachments.js";
import { AppError, type Deps } from "./deps.js";
import { bankName } from "./vietqr.js";

export type Actor = "buyer" | "affiliate" | "system";

export const STATUS_LABEL: Record<string, string> = {
  submitted: "Chờ affiliate xem",
  accepted: "Đã ghi nhận, chờ trả",
  rejected: "Bị từ chối",
  paid: "Affiliate báo đã trả",
  completed: "Hoàn tất",
  cancelled: "Đã hủy"
};

export const CLAIM_COLS = `cl.id, cl.no, cl.affiliate_id, cl.customer_id, cl.link_id, cl.order_code, cl.order_amount, cl.ordered_on,
  cl.product_name, cl.status, cl.commission, cl.cashback, cl.reject_reason, cl.disputed, cl.disputed_at, cl.remind_at,
  cl.payout_id, cl.submitted_at, cl.accepted_at, cl.paid_at, cl.completed_at, cl.updated_at`;

const num = (v: any) => (v === null || v === undefined ? null : Number(v));

export function serializeClaim(c: any) {
  const now = Date.now();
  const age = (now - new Date(c.submitted_at).getTime()) / 86400000;
  return {
    id: c.id,
    no: Number(c.no),
    orderCode: c.order_code,
    orderAmount: num(c.order_amount),
    orderedOn: c.ordered_on ? new Date(c.ordered_on).toISOString().slice(0, 10) : null,
    productName: c.product_name,
    linkId: c.link_id,
    status: c.status as string,
    statusLabel: STATUS_LABEL[c.status] ?? c.status,
    commission: num(c.commission),
    cashback: num(c.cashback),
    rejectReason: c.reject_reason,
    disputed: c.disputed,
    disputedAt: c.disputed_at,
    remindAt: c.remind_at,
    /** đã tới hạn nhắc affiliate tự kiểm tra (đơn đã ghi nhận nhưng chưa trả) */
    due: c.status === "accepted" && !!c.remind_at && new Date(c.remind_at).getTime() <= now,
    /** quá 6 tuần kể từ lúc báo đơn mà chưa trả */
    overdue: ["submitted", "accepted"].includes(c.status) && age > 42,
    ageDays: Math.floor(age),
    submittedAt: c.submitted_at,
    acceptedAt: c.accepted_at,
    paidAt: c.paid_at,
    completedAt: c.completed_at,
    updatedAt: c.updated_at,
    customer: c.nickname !== undefined ? { id: c.customer_id, nickname: c.nickname, refCode: c.ref_code } : undefined
  };
}

export async function addEvent(
  q: Queryable,
  c: { id: string; affiliate_id: string },
  e: { actor: Actor; kind: "message" | "status"; body?: string | null; attachmentId?: string | null }
) {
  await q.query(
    "INSERT INTO claim_events (claim_id, affiliate_id, actor, kind, body, attachment_id) VALUES ($1, $2, $3, $4, $5, $6)",
    [c.id, c.affiliate_id, e.actor, e.kind, e.body ?? null, e.attachmentId ?? null]
  );
  await q.query("UPDATE claims SET updated_at = now() WHERE id = $1", [c.id]);
}

/** Lấy 1 đơn (khóa dòng để đổi trạng thái an toàn). onlyCustomerId: người mua chỉ thấy đơn của mình. */
export async function getClaim(q: Queryable, id: string, onlyCustomerId?: string, lock = false) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("Không tìm thấy đơn", 404);
  const r = await q.query<any>(
    `SELECT ${CLAIM_COLS}, c.nickname, c.ref_code FROM claims cl JOIN customers c ON c.id = cl.customer_id
      WHERE cl.id = $1 AND ($2::uuid IS NULL OR cl.customer_id = $2) ${lock ? "FOR UPDATE OF cl" : ""}`,
    [id, onlyCustomerId ?? null]
  );
  if (!r.rows[0]) throw new AppError("Không tìm thấy đơn", 404);
  return r.rows[0];
}

export async function claimEvents(q: Queryable, claimId: string) {
  const r = await q.query<any>(
    `SELECT e.id, e.actor, e.kind, e.body, e.attachment_id, e.created_at FROM claim_events e WHERE e.claim_id = $1 ORDER BY e.id`,
    [claimId]
  );
  return r.rows.map((e) => ({
    id: Number(e.id),
    actor: e.actor,
    kind: e.kind,
    body: e.body,
    image: e.attachment_id ? `/v1/files/${e.attachment_id}` : null,
    at: e.created_at
  }));
}

/** Tin nhắn hoặc ảnh trong khung trao đổi của 1 đơn. */
export async function postMessage(
  deps: Deps,
  q: Queryable,
  claim: any,
  actor: "buyer" | "affiliate",
  m: { body?: string; image?: string }
) {
  const body = (m.body ?? "").trim();
  if (!body && !m.image) throw new AppError("Nhập nội dung hoặc chọn ảnh");
  if (["cancelled"].includes(claim.status)) throw new AppError("Đơn đã hủy, không gửi thêm được");
  const n = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM claim_events WHERE claim_id = $1 AND attachment_id IS NOT NULL", [claim.id]);
  if (m.image && n.rows[0].n >= 20) throw new AppError("Mỗi đơn tối đa 20 ảnh");
  const attachmentId = m.image
    ? await saveImage(deps, q, { affiliateId: claim.affiliate_id, customerId: claim.customer_id, uploader: actor, dataUrl: m.image })
    : null;
  await addEvent(q, claim, { actor, kind: "message", body: body || null, attachmentId });
}

/** Thông tin nhận tiền của khách (đã giải mã) — chỉ khách đó và affiliate của họ xem được. */
export async function loadBank(deps: Deps, q: Queryable, customerId: string) {
  const r = await q.query<any>("SELECT bank_enc FROM customers WHERE id = $1", [customerId]);
  const enc = r.rows[0]?.bank_enc;
  if (!enc) return null;
  const b = JSON.parse(await deps.box.decrypt(enc, `bank:${customerId}`));
  return { bin: b.bin as string, bankName: bankName(b.bin) ?? b.bankName ?? b.bin, account: b.account as string, holder: b.holder as string };
}

/** Tự hoàn tất đơn affiliate đã báo trả mà khách không phản hồi sau 7 ngày (chạy trong worker). */
export async function autoComplete(deps: Deps) {
  return deps.db.tx({ system: true }, async (q) => {
    const r = await q.query<any>(
      `UPDATE claims SET status = 'completed', completed_at = now(), updated_at = now()
        WHERE status = 'paid' AND NOT disputed AND paid_at < now() - interval '7 days'
        RETURNING id, affiliate_id`
    );
    for (const c of r.rows) {
      await q.query(
        "INSERT INTO claim_events (claim_id, affiliate_id, actor, kind, body) VALUES ($1, $2, 'system', 'status', $3)",
        [c.id, c.affiliate_id, "Tự hoàn tất: sau 7 ngày khách không xác nhận cũng không khiếu nại."]
      );
    }
    return r.rows.length;
  });
}
