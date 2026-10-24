/** Server chạy thử: Postgres trong bộ nhớ + AccessTrade giả lập + 1 affiliate mẫu "PHUC" đã kết nối. */
import http from "node:http";
import { randomBytes } from "node:crypto";
import { authenticator } from "otplib";
import { loadConfig } from "../src/config.js";
import { createPgliteDb } from "../src/db/db.js";
import { createDeps } from "../src/bootstrap.js";
import { buildApp } from "../src/app.js";

const KEY = "demo_access_key_000000";
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.url!.startsWith("/v1/product_link/create")) {
      const b = JSON.parse(body);
      return res.end(JSON.stringify({ success: true, data: { success_link: [{ short_link: `https://shorten.asia/demo-${b.utm_content}` }] } }));
    }
    res.end(JSON.stringify({ data: [
      { order_id: "2510200001", merchant: "shopee", billing: 142388, pub_commission: 9967, order_approved: 1, order_pending: 0, order_reject: 0, is_confirmed: 1, utm_content: "__REF__", sales_time: "2026-10-20T10:00:00+07:00" },
      { order_id: "2510230002", merchant: "shopee", billing: 259000, pub_commission: 18130, order_approved: 0, order_pending: 1, order_reject: 0, is_confirmed: 0, utm_content: "__REF__", sales_time: "2026-10-23T20:15:00+07:00" }
    ].map((o) => ({ ...o, utm_content: (globalThis as any).REF || o.utm_content })), total: 2 }));
  });
});
await new Promise<void>((r) => mock.listen(9911, "127.0.0.1", () => r()));
const config = loadConfig({ ...process.env, MASTER_KEY: randomBytes(32).toString("base64"), COOKIE_SECURE: "false",
  AUTO_APPROVE_AFFILIATES: "true", ACCESSTRADE_BASE_URL: "http://127.0.0.1:9911", NETWORK_MIN_INTERVAL_MS: "0",
  PUBLIC_BASE_URL: "http://localhost:8080" } as any);
const deps = await createDeps(config, await createPgliteDb());
const app = await buildApp(deps);
const ck = (r: any) => String([].concat(r.headers["set-cookie"])[0]).split(";")[0];
let r = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "phuc@example.com", password: "mat-khau-rat-dai-123", displayName: "Phúc Deal", code: "PHUC" } });
const cookie = ck(r);
r = await app.inject({ method: "POST", url: "/v1/auth/2fa/setup", headers: { cookie }, payload: {} });
const secret = r.json().secret;
await app.inject({ method: "POST", url: "/v1/auth/2fa/enable", headers: { cookie }, payload: { code: authenticator.generate(secret) } });
r = await app.inject({ method: "PUT", url: "/v1/aff/credentials", headers: { cookie }, payload: { network: "accesstrade", accessKey: KEY, campaignId: "4751584435713464237" } });
console.log("creds:", r.statusCode);
// cổng 9912 chỉ dùng cho demo: đồng bộ đơn cho khách mới nhất
http.createServer(async (_q, res) => {
  (globalThis as any).REF = (await deps.db.ownerQuery("SELECT ref_code FROM customers ORDER BY created_at DESC LIMIT 1"))[0]?.ref_code;
  const x = await app.inject({ method: "POST", url: "/v1/aff/sync", headers: { cookie }, payload: {} });
  res.end(x.body);
}).listen(9912, "127.0.0.1");
await app.listen({ port: 8080, host: "127.0.0.1" });
console.log("demo ready");
