/**
 * Lưu / đọc khóa API của affiliate.
 *  - Kiểm tra khóa với mạng affiliate TRƯỚC khi lưu.
 *  - Chỉ lưu bản mã hóa + 4 ký tự cuối; API không bao giờ trả lại khóa.
 *  - Bản mã gắn với (affiliate, mạng) qua AAD → không chép sang affiliate khác được.
 */
import { last4 } from "../security/crypto.js";
import type { Credentials, Network } from "../connectors/types.js";
import type { Queryable } from "../db/db.js";
import { audit, AppError, type Deps } from "./deps.js";

const ctx = (affiliateId: string, network: Network) => `cred:${affiliateId}:${network}`;

export interface SaveCredentialsInput {
  network: Network;
  secret: string;
  appId?: string;
  campaignId?: string;
}

export async function saveCredentials(deps: Deps, affiliateId: string, input: SaveCredentialsInput, meta: { userId: string; ip?: string }) {
  const creds: Credentials = { network: input.network, secret: input.secret, appId: input.appId, campaignId: input.campaignId };
  if (input.network === "accesstrade" && !input.campaignId) throw new AppError("Cần nhập campaign Shopee của AccessTrade");
  if (input.network === "shopee" && !input.appId) throw new AppError("Cần nhập Shopee AppId");
  await deps.connectors[input.network].verify(creds);

  const enc = await deps.box.encrypt(input.secret, ctx(affiliateId, input.network));
  return deps.db.tx({ affiliateId }, async (q) => {
    await q.query(
      `INSERT INTO affiliate_credentials (affiliate_id, network, secret_enc, key_last4, app_id, campaign_id, verified_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())
       ON CONFLICT (affiliate_id, network) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, key_last4 = EXCLUDED.key_last4,
         app_id = EXCLUDED.app_id, campaign_id = EXCLUDED.campaign_id, verified_at = now(), updated_at = now()`,
      [affiliateId, input.network, enc, last4(input.secret), input.appId ?? null, input.campaignId ?? null]
    );
    await audit(q, { affiliateId, actorUserId: meta.userId, action: "credentials.save", target: input.network, ip: meta.ip });
    return { network: input.network, keyLast4: last4(input.secret), verified: true };
  });
}

export async function listCredentials(q: Queryable) {
  const r = await q.query(
    "SELECT network, key_last4, app_id, campaign_id, verified_at, updated_at FROM affiliate_credentials ORDER BY network"
  );
  return r.rows.map((x: any) => ({
    network: x.network,
    keyLast4: x.key_last4,
    appId: x.app_id,
    campaignId: x.campaign_id,
    verifiedAt: x.verified_at,
    updatedAt: x.updated_at
  }));
}

/** Giải mã khóa để gọi API. Kết quả chỉ được giữ trong bộ nhớ, không log, không trả ra ngoài. */
export async function loadCredentials(deps: Deps, q: Queryable, affiliateId: string, network: Network): Promise<Credentials | null> {
  const r = await q.query(
    "SELECT secret_enc, app_id, campaign_id FROM affiliate_credentials WHERE affiliate_id = $1 AND network = $2",
    [affiliateId, network]
  );
  const row: any = r.rows[0];
  if (!row) return null;
  const secret = await deps.box.decrypt(row.secret_enc, ctx(affiliateId, network));
  return { network, secret, appId: row.app_id, campaignId: row.campaign_id };
}
