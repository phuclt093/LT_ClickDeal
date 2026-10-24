/**
 * ClickDeal Gateway — bản Cloudflare Worker (miễn phí ở gói Free của Cloudflare).
 * Affiliate tự triển khai trên tài khoản Cloudflare của mình, với khóa AccessTrade của chính mình.
 * ClickDeal chỉ mở địa chỉ:  https://<cổng-của-bạn>/go?url=<link Shopee>&sub=<mã khách>&click=<mã lần bấm>
 * → Worker tạo link affiliate rồi chuyển người mua sang Shopee. ClickDeal không bao giờ thấy khóa.
 *
 * Biến môi trường (Settings → Variables, chọn loại "Secret" cho khóa):
 *   AT_ACCESS_KEY   khóa API AccessTrade của bạn (Secret)
 *   AT_CAMPAIGN_ID  campaign Shopee trên AccessTrade của bạn
 */
const SHOPEE_PRODUCT = /^(shopee\.vn|www\.shopee\.vn|m\.shopee\.vn)$/i;
const SHOPEE_SHORT = /^(s\.shopee\.vn|shope\.ee|shp\.ee|vn\.shp\.ee|[a-z0-9-]+\.shp\.ee)$/i;
const SAFE_CODE = /^[A-Za-z0-9_-]{1,64}$/;

function productPath(u) {
  const m = u.pathname.match(/-i\.(\d+)\.(\d+)/) || u.pathname.match(/^\/product\/(\d+)\/(\d+)/);
  return m ? `https://shopee.vn/product/${m[1]}/${m[2]}` : null;
}

/** Chỉ nhận link Shopee; link rút gọn được mở theo redirect thủ công, kiểm tra host từng bước. */
async function normalize(raw, fetchImpl) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  for (let hop = 0; hop < 4; hop++) {
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (SHOPEE_PRODUCT.test(u.hostname)) return productPath(u);
    if (!SHOPEE_SHORT.test(u.hostname)) return null;
    const res = await fetchImpl(u.toString(), { redirect: "manual" });
    const loc = res.headers.get("location");
    if (!loc) return null;
    u = new URL(loc, u);
  }
  return null;
}

async function createAffLink(env, productUrl, sub, click, fetchImpl) {
  const res = await fetchImpl("https://api.accesstrade.vn/v1/product_link/create", {
    method: "POST",
    headers: { Authorization: `Token ${env.AT_ACCESS_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      campaign_id: env.AT_CAMPAIGN_ID,
      urls: [productUrl],
      url_enc: true,
      utm_source: "clickdeal",
      utm_content: sub || undefined,
      sub1: click || undefined
    })
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  const ok = j && j.success && j.data && j.data.success_link && j.data.success_link[0];
  const link = ok && (ok.short_link || ok.aff_link);
  return typeof link === "string" && /^https:\/\//i.test(link) ? link : null;
}

function redirect(to, fallback) {
  return new Response(null, {
    status: 302,
    headers: { Location: to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...(fallback ? { "X-ClickDeal-Fallback": "1" } : {}) }
  });
}

export async function handle(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname === "/") return new Response("ClickDeal gateway OK", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (url.pathname !== "/go" || request.method !== "GET") return new Response("Not found", { status: 404 });
  if (!env.AT_ACCESS_KEY || !env.AT_CAMPAIGN_ID) return new Response("Cổng chưa cài AT_ACCESS_KEY / AT_CAMPAIGN_ID", { status: 500 });

  const raw = url.searchParams.get("url") || "";
  const sub = url.searchParams.get("sub") || "";
  const click = url.searchParams.get("click") || "";
  if ((sub && !SAFE_CODE.test(sub)) || (click && !SAFE_CODE.test(click))) return new Response("Tham số không hợp lệ", { status: 400 });

  const productUrl = await normalize(raw, fetchImpl).catch(() => null);
  if (!productUrl) return new Response("Chỉ hỗ trợ link sản phẩm Shopee", { status: 400 });

  const aff = await createAffLink(env, productUrl, sub, click, fetchImpl).catch(() => null);
  // Lỗi thì vẫn cho khách mở sản phẩm (không hoàn tiền) thay vì trang lỗi
  return aff ? redirect(aff, false) : redirect(productUrl, true);
}

export default { fetch: (request, env) => handle(request, env) };
