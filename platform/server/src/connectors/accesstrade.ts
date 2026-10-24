/**
 * AccessTrade Publisher API
 *  - Tạo link:  POST /v1/product_link/create   (developers.accesstrade.vn/api-publisher-vietnamese/tao-tracking-link)
 *  - Đơn hàng:  GET  /v1/order-list            (…/lay-danh-sach-don-hang-v2) — giới hạn 10 lần/phút, tối đa 300 đơn/trang
 * Mã khách được gắn vào utm_content (order-list trả lại trường này) để ghép đơn với khách.
 */
import { httpJson, NetworkError, type Credentials, type NetworkConnector, type NormalizedOrder } from "./types.js";

export class AccessTradeConnector implements NetworkConnector {
  readonly network = "accesstrade" as const;
  constructor(private readonly baseUrl: string) {}

  private headers(creds: Credentials) {
    return { Authorization: `Token ${creds.secret}`, "Content-Type": "application/json", Accept: "application/json" };
  }

  async verify(creds: Credentials) {
    const until = new Date();
    const since = new Date(until.getTime() - 24 * 3600 * 1000);
    const q = new URLSearchParams({ since: since.toISOString(), until: until.toISOString(), page: "1", limit: "1" });
    const r = await httpJson(`${this.baseUrl}/v1/order-list?${q}`, { headers: this.headers(creds) });
    if (r.status === 401 || r.status === 403) throw new NetworkError("Khóa AccessTrade không đúng hoặc đã bị thu hồi", 400);
    if (r.status >= 400) throw new NetworkError(`AccessTrade trả lỗi ${r.status}`, 502, r.status >= 500);
  }

  async createLink(creds: Credentials, input: { url: string; refCode: string; clickId: string }) {
    if (!creds.campaignId) throw new NetworkError("Affiliate chưa cài campaign Shopee của AccessTrade", 400);
    const r = await httpJson(`${this.baseUrl}/v1/product_link/create`, {
      method: "POST",
      headers: this.headers(creds),
      body: JSON.stringify({
        campaign_id: creds.campaignId,
        urls: [input.url],
        url_enc: true,
        utm_source: "clickdeal",
        utm_content: input.refCode,
        sub1: input.clickId
      })
    });
    if (r.status === 401 || r.status === 403) throw new NetworkError("Khóa AccessTrade của affiliate không còn hiệu lực", 502);
    if (r.status === 429) throw new NetworkError("AccessTrade đang giới hạn tần suất, thử lại sau ít giây", 503, true);
    const ok = r.body?.success && r.body?.data?.success_link?.[0];
    if (r.status >= 400 || !ok) {
      throw new NetworkError("AccessTrade không tạo được link cho sản phẩm này", 502);
    }
    return (ok.short_link || ok.aff_link) as string;
  }

  async listOrders(creds: Credentials, input: { since: Date; until: Date; page: number }) {
    const limit = 300;
    const q = new URLSearchParams({
      since: input.since.toISOString(),
      until: input.until.toISOString(),
      page: String(input.page),
      limit: String(limit),
      utm_source: "clickdeal"
    });
    const r = await httpJson(`${this.baseUrl}/v1/order-list?${q}`, { headers: this.headers(creds) });
    if (r.status === 429) throw new NetworkError("AccessTrade giới hạn tần suất", 503, true);
    if (r.status >= 400) throw new NetworkError(`AccessTrade trả lỗi ${r.status} khi lấy đơn`, 502, r.status >= 500);
    const data: any[] = Array.isArray(r.body?.data) ? r.body.data : [];
    const orders: NormalizedOrder[] = data.map((o) => {
      const approved = Number(o.order_approved || 0);
      const pending = Number(o.order_pending || 0);
      const rejected = Number(o.order_reject || 0);
      const status = pending > 0 ? "pending" : approved > 0 ? "approved" : rejected > 0 ? "rejected" : "pending";
      return {
        networkOrderId: String(o.order_id),
        merchant: o.merchant ?? null,
        billing: Number(o.billing || 0),
        pubCommission: Number(o.pub_commission || 0),
        status,
        isConfirmed: Number(o.is_confirmed || 0) === 1,
        refCode: o.utm_content ? String(o.utm_content) : null,
        salesTime: o.sales_time ?? null
      };
    });
    const total = Number(r.body?.total || 0);
    return { orders, hasMore: input.page * limit < total };
  }
}
