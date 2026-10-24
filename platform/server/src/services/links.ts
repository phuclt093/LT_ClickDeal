/**
 * Tạo link hoàn tiền cho người mua.
 * Không giữ transaction DB mở trong lúc gọi mạng affiliate: đọc khóa → gọi API → ghi kết quả.
 */
import { randomUUID } from "node:crypto";
import type { Network } from "../connectors/types.js";
import { extractUrl, normalizeShopeeUrl } from "./shopee-url.js";
import { loadCredentials } from "./credentials.js";
import { buildGatewayUrl } from "./gateway.js";
import { AppError, type Deps } from "./deps.js";

export interface CustomerCtx {
  customerId: string;
  affiliateId: string;
  refCode: string;
}

export interface CreateLinkInput {
  url: string;
  source: "extension" | "pwa" | "web" | "shortcut" | "bot";
  product?: { name?: string; price?: string; image?: string };
}

export async function createLink(deps: Deps, c: CustomerCtx, input: CreateLinkInput) {
  // app Shopee chia sẻ kèm chữ ("Xem sản phẩm … https://s.shopee.vn/…") → tách lấy URL
  const productUrl = await normalizeShopeeUrl(extractUrl(input.url) ?? input.url, deps.fetchImpl);

  const clickId = randomUUID();
  const aff = await deps.db.tx({ affiliateId: c.affiliateId }, async (q) => {
    const a = await q.query<{ preferred_network: Network; status: string; link_mode: string; gateway_template: string | null }>(
      "SELECT preferred_network, status, link_mode, gateway_template FROM affiliates WHERE id = $1",
      [c.affiliateId]
    );
    const row = a.rows[0];
    if (row?.status !== "active") throw new AppError("Affiliate của bạn đang tạm ngưng, hãy liên hệ họ", 403);
    if (row.link_mode === "gateway") return { mode: "gateway" as const, template: row.gateway_template };
    const order: Network[] = row.preferred_network === "shopee" ? ["shopee", "accesstrade"] : ["accesstrade", "shopee"];
    for (const n of order) {
      const creds = await loadCredentials(deps, q, c.affiliateId, n);
      if (creds) return { mode: "api" as const, creds };
    }
    return { mode: "api" as const, creds: null };
  });

  let affLink: string;
  let network: string;
  if (aff.mode === "gateway") {
    // Cách 1 (ưu tiên): cổng nhận link trên trang affiliate — không cần ClickDeal giữ khóa API
    if (!aff.template) throw new AppError("Affiliate chưa khai báo cổng nhận link", 409);
    affLink = buildGatewayUrl(aff.template, { url: productUrl, sub: c.refCode, click: clickId });
    network = "gateway";
  } else {
    // Cách 3 (dự phòng): gọi API mạng affiliate bằng khóa đã mã hóa
    if (!aff.creds) throw new AppError("Affiliate chưa kết nối tài khoản AccessTrade/Shopee", 409);
    affLink = await deps.connectors[aff.creds.network].createLink(aff.creds, { url: productUrl, refCode: c.refCode, clickId });
    network = aff.creds.network;
  }
  // chỉ chấp nhận link https hợp lệ (chặn javascript:, data:…)
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|\?|$)/i.test(affLink) || affLink.length > 2000) {
    throw new AppError("Link hoàn tiền trả về không hợp lệ", 502);
  }

  const p = input.product ?? {};
  const clip = (s: string | undefined, n: number) => (s ? s.slice(0, n) : null);
  const image = p.image && /^https:\/\//i.test(p.image) ? p.image.slice(0, 500) : null;
  await deps.db.tx({ affiliateId: c.affiliateId }, async (q) => {
    await q.query(
      `INSERT INTO links (id, affiliate_id, customer_id, network, source, product_url, product_name, price, image, aff_link)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [clickId, c.affiliateId, c.customerId, network, input.source, productUrl, clip(p.name, 300), clip(p.price, 40), image, affLink]
    );
    await q.query("UPDATE customers SET last_seen_at = now() WHERE id = $1", [c.customerId]);
  });
  return { linkId: clickId, affLink, productUrl, network };
}
