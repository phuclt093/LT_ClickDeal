/**
 * Đồng bộ đơn hàng từ mạng affiliate về bảng orders, ghép với khách qua ref_code (utm_content).
 * Tôn trọng giới hạn tần suất: mỗi khóa cách nhau tối thiểu networkMinIntervalMs giữa 2 lần gọi.
 */
import type { Network } from "../connectors/types.js";
import { NetworkError } from "../connectors/types.js";
import { loadCredentials } from "./credentials.js";
import type { Deps } from "./deps.js";

const lastCall = new Map<string, number>();

async function throttle(deps: Deps, key: string) {
  const wait = (lastCall.get(key) ?? 0) + deps.config.networkMinIntervalMs - Date.now();
  if (wait > 0) await deps.sleep(wait);
  lastCall.set(key, Date.now());
}

export async function syncAffiliate(deps: Deps, affiliateId: string, opts: { days?: number; maxPages?: number } = {}) {
  const until = new Date();
  const since = new Date(until.getTime() - (opts.days ?? 60) * 24 * 3600 * 1000);
  const maxPages = opts.maxPages ?? 20;
  let upserted = 0;

  for (const network of ["accesstrade", "shopee"] as Network[]) {
    const creds = await deps.db.tx({ affiliateId }, (q) => loadCredentials(deps, q, affiliateId, network));
    if (!creds) continue;
    for (let page = 1; page <= maxPages; page++) {
      await throttle(deps, `${affiliateId}:${network}`);
      let res;
      try {
        res = await deps.connectors[network].listOrders(creds, { since, until, page });
      } catch (e) {
        if (e instanceof NetworkError && e.retryable) break; // thử lại ở lượt sau
        throw e;
      }
      if (res.orders.length) {
        await deps.db.tx({ affiliateId }, async (q) => {
          for (const o of res.orders) {
            await q.query(
              `INSERT INTO orders (affiliate_id, customer_id, network, network_order_id, merchant, billing, pub_commission,
                                   status, is_confirmed, ref_code, sales_time, synced_at)
               VALUES ($1, (SELECT id FROM customers WHERE affiliate_id = $1 AND ref_code = $9), $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
               ON CONFLICT (affiliate_id, network, network_order_id) DO UPDATE SET
                 customer_id = EXCLUDED.customer_id, billing = EXCLUDED.billing, pub_commission = EXCLUDED.pub_commission,
                 status = EXCLUDED.status, is_confirmed = EXCLUDED.is_confirmed, synced_at = now()`,
              [affiliateId, network, o.networkOrderId, o.merchant, o.billing, o.pubCommission, o.status, o.isConfirmed, o.refCode, o.salesTime]
            );
            upserted++;
          }
        });
      }
      if (!res.hasMore) break;
    }
  }
  await deps.db.tx({ affiliateId }, (q) => q.query("UPDATE affiliates SET last_synced_at = now() WHERE id = $1", [affiliateId]));
  return { upserted };
}

export async function syncAll(deps: Deps, log: (m: string) => void = console.log) {
  const ids = await deps.db.tx({ system: true }, async (q) =>
    (await q.query<{ id: string }>("SELECT id FROM affiliates WHERE status = 'active' ORDER BY last_synced_at NULLS FIRST")).rows.map((r) => r.id)
  );
  for (const id of ids) {
    try {
      const r = await syncAffiliate(deps, id);
      log(`sync ${id}: ${r.upserted} đơn`);
    } catch (e: any) {
      log(`sync ${id} lỗi: ${e?.message}`);
    }
  }
}
