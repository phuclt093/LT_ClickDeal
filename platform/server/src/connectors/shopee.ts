/**
 * Shopee Affiliate Open API (GraphQL).
 * ⚠ CHƯA KIỂM CHỨNG với tài khoản thật: tên trường/định dạng chữ ký dưới đây theo mô tả công khai
 * của Open API (short link + conversion report). Khi Shopee cấp quyền, đối chiếu lại tài liệu
 * chính thức trước khi bật cho affiliate.
 * Chữ ký: Authorization: SHA256 Credential={AppId}, Timestamp={ts}, Signature=sha256(AppId+ts+payload+Secret)
 */
import { createHash } from "node:crypto";
import { httpJson, NetworkError, type Credentials, type NetworkConnector, type NormalizedOrder } from "./types.js";

export class ShopeeConnector implements NetworkConnector {
  readonly network = "shopee" as const;
  constructor(private readonly url: string) {}

  private async call(creds: Credentials, query: string, variables: Record<string, unknown> = {}) {
    if (!creds.appId) throw new NetworkError("Thiếu Shopee AppId", 400);
    const payload = JSON.stringify({ query, variables });
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHash("sha256").update(`${creds.appId}${ts}${payload}${creds.secret}`).digest("hex");
    const r = await httpJson(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `SHA256 Credential=${creds.appId}, Timestamp=${ts}, Signature=${sig}`
      },
      body: payload
    });
    if (r.status >= 400 || r.body?.errors?.length) {
      const msg = r.body?.errors?.[0]?.message || `Shopee trả lỗi ${r.status}`;
      throw new NetworkError(`Shopee Open API: ${msg}`, r.status === 401 ? 400 : 502);
    }
    return r.body?.data;
  }

  async verify(creds: Credentials) {
    await this.call(creds, "query { shopeeOfferV2(limit: 1) { nodes { offerName } } }");
  }

  async createLink(creds: Credentials, input: { url: string; refCode: string; clickId: string }) {
    const data = await this.call(
      creds,
      "mutation ($url: String!, $subIds: [String]) { generateShortLink(input: { originUrl: $url, subIds: $subIds }) { shortLink } }",
      { url: input.url, subIds: [input.refCode, input.clickId] }
    );
    const link = data?.generateShortLink?.shortLink;
    if (!link) throw new NetworkError("Shopee không tạo được link", 502);
    return link as string;
  }

  async listOrders(creds: Credentials, input: { since: Date; until: Date; page: number }) {
    // TODO(khi có quyền Open API): xác nhận tên trường conversionReport + phân trang scrollId
    const data = await this.call(
      creds,
      "query ($s: Int!, $e: Int!) { conversionReport(purchaseTimeStart: $s, purchaseTimeEnd: $e, limit: 500) { nodes { conversionId purchaseTime totalCommission utmContent orders { orderId orderStatus } } pageInfo { hasNextPage } } }",
      { s: Math.floor(input.since.getTime() / 1000), e: Math.floor(input.until.getTime() / 1000) }
    );
    const nodes: any[] = data?.conversionReport?.nodes ?? [];
    const orders: NormalizedOrder[] = nodes.flatMap((n) =>
      (n.orders ?? [{ orderId: n.conversionId, orderStatus: "PENDING" }]).map((o: any) => ({
        networkOrderId: String(o.orderId),
        merchant: "shopee",
        billing: 0,
        pubCommission: Number(n.totalCommission || 0),
        status: /COMPLETED/i.test(o.orderStatus) ? "approved" : /CANCEL/i.test(o.orderStatus) ? "rejected" : "pending",
        isConfirmed: /COMPLETED/i.test(o.orderStatus),
        refCode: (n.utmContent || "").split("-")[0] || null,
        salesTime: n.purchaseTime ? new Date(Number(n.purchaseTime) * 1000).toISOString() : null
      }))
    );
    return { orders, hasMore: false };
  }
}
