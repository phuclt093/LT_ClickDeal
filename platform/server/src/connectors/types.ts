export type Network = "accesstrade" | "shopee";

export interface Credentials {
  network: Network;
  secret: string; // AccessTrade access key | Shopee Open API secret (đã giải mã, chỉ nằm trong bộ nhớ)
  appId?: string | null; // Shopee AppId
  campaignId?: string | null; // AccessTrade: campaign Shopee
}

export interface NormalizedOrder {
  networkOrderId: string;
  merchant: string | null;
  billing: number;
  pubCommission: number;
  status: "pending" | "approved" | "rejected";
  isConfirmed: boolean;
  refCode: string | null; // mã khách đã gắn khi tạo link
  salesTime: string | null;
}

export interface NetworkConnector {
  readonly network: Network;
  /** Kiểm tra khóa có dùng được không (gọi 1 API nhẹ). */
  verify(creds: Credentials): Promise<void>;
  createLink(creds: Credentials, input: { url: string; refCode: string; clickId: string }): Promise<string>;
  listOrders(
    creds: Credentials,
    input: { since: Date; until: Date; page: number }
  ): Promise<{ orders: NormalizedOrder[]; hasMore: boolean }>;
}

export class NetworkError extends Error {
  constructor(message: string, readonly status = 502, readonly retryable = false) {
    super(message);
  }
}

/** fetch có timeout, không theo redirect, không gửi cookie. */
export async function httpJson(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, { ...init, redirect: "error", signal: ctrl.signal });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 200) };
    }
    return { status: res.status, body };
  } catch (e: any) {
    throw new NetworkError(e?.name === "AbortError" ? "Mạng affiliate phản hồi quá chậm" : "Không gọi được mạng affiliate", 502, true);
  } finally {
    clearTimeout(t);
  }
}
