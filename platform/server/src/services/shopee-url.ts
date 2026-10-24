/**
 * Chuẩn hóa link sản phẩm Shopee mà người mua gửi lên.
 * An toàn (chống SSRF): chỉ nhận host thuộc danh sách Shopee cố định; link rút gọn chỉ được
 * mở theo redirect thủ công, mỗi bước kiểm tra lại host, tối đa 3 bước, timeout 4 giây.
 */
const PRODUCT_HOSTS = /^(shopee\.vn|www\.shopee\.vn|m\.shopee\.vn)$/i;
const SHORT_HOSTS = /^(s\.shopee\.vn|shope\.ee|shp\.ee|vn\.shp\.ee|[a-z0-9-]+\.shp\.ee)$/i;

export class BadUrlError extends Error {}

/** Lấy URL đầu tiên trong đoạn chữ (app Shopee chia sẻ kiểu "Xem sản phẩm ... https://s.shopee.vn/xxx"). */
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0].replace(/[).,;!?]+$/, "") : null;
}

function productIds(u: URL) {
  const m = u.pathname.match(/-i\.(\d+)\.(\d+)/) || u.pathname.match(/^\/product\/(\d+)\/(\d+)/);
  return m ? { shopId: m[1], itemId: m[2] } : null;
}

/** Trả về link sản phẩm sạch https://shopee.vn/product/<shop>/<item> (bỏ tham số theo dõi lạ). */
export async function normalizeShopeeUrl(input: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new BadUrlError("Link không hợp lệ");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new BadUrlError("Link không hợp lệ");

  for (let hop = 0; hop < 4; hop++) {
    if (PRODUCT_HOSTS.test(u.hostname)) {
      const ids = productIds(u);
      if (!ids) throw new BadUrlError("Đây không phải link sản phẩm Shopee");
      return `https://shopee.vn/product/${ids.shopId}/${ids.itemId}`;
    }
    if (!SHORT_HOSTS.test(u.hostname) || hop === 3) throw new BadUrlError("Chỉ hỗ trợ link sản phẩm Shopee");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    let loc: string | null = null;
    try {
      const res = await fetchImpl(u.toString(), { method: "GET", redirect: "manual", signal: ctrl.signal });
      loc = res.headers.get("location");
    } catch {
      throw new BadUrlError("Không mở được link rút gọn Shopee, hãy thử lại");
    } finally {
      clearTimeout(t);
    }
    if (!loc) throw new BadUrlError("Link rút gọn Shopee không dẫn tới sản phẩm");
    u = new URL(loc, u);
  }
  throw new BadUrlError("Link không hợp lệ");
}
