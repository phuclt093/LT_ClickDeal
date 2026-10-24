/**
 * Test toàn luồng với Postgres thật chạy trong tiến trình (PGlite) và AccessTrade giả lập.
 * Chạy: npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { authenticator } from "otplib";
import { loadConfig } from "../src/config.js";
import { createPgliteDb } from "../src/db/db.js";
import { createDeps } from "../src/bootstrap.js";
import { buildApp } from "../src/app.js";
import type { Deps } from "../src/services/deps.js";
import { LocalKeyProvider, SecretBox } from "../src/security/crypto.js";
import { normalizeShopeeUrl } from "../src/services/shopee-url.js";

const GOOD_KEY = "at_live_key_ABCDEFGH1234";
const seen: { path: string; auth?: string; body?: any }[] = [];
let mockOrders: any[] = [];

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url!, "http://x");
    seen.push({ path: u.pathname, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Token ${GOOD_KEY}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ message: "unauthorized" }));
    }
    if (u.pathname === "/v1/product_link/create") {
      const b = JSON.parse(body);
      return res.end(
        JSON.stringify({
          success: true,
          data: {
            success_link: [{ aff_link: "https://go.isclix.com/deep_link/x", short_link: `https://shorten.asia/${b.utm_content}`, url_origin: b.urls[0] }],
            error_link: [],
            suspend_url: []
          }
        })
      );
    }
    if (u.pathname === "/v1/order-list") {
      return res.end(JSON.stringify({ data: mockOrders, total: mockOrders.length }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});

// fetch giả cho link rút gọn Shopee
const fakeFetch: typeof fetch = async (input: any, init?: any) => {
  const url = String(input);
  if (url.startsWith("https://s.shopee.vn/abc")) {
    return new Response(null, { status: 302, headers: { location: "https://shopee.vn/Vi-Da-i.301412525.28780427085?sp=1" } });
  }
  if (url.startsWith("https://s.shopee.vn/evil")) {
    return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
  }
  return fetch(input, init);
};

let deps: Deps;
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", () => r()));
  const port = (mock.address() as any).port;
  const config = loadConfig({
    MASTER_KEY: randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    AUTO_APPROVE_AFFILIATES: "true",
    ACCESSTRADE_BASE_URL: `http://127.0.0.1:${port}`,
    NETWORK_MIN_INTERVAL_MS: "0",
    PUBLIC_BASE_URL: "http://localhost:8080"
  } as any);
  deps = await createDeps(config, await createPgliteDb());
  deps.fetchImpl = fakeFetch;
  app = await buildApp(deps);
});

after(async () => {
  await app.close();
  await deps.db.close();
  mock.close();
});

function cookieOf(res: any) {
  const sc = res.headers["set-cookie"];
  const v = Array.isArray(sc) ? sc[0] : sc;
  return v ? v.split(";")[0] : "";
}

async function newAffiliate(code: string) {
  const email = `${code.toLowerCase()}@example.com`;
  const password = "mat-khau-rat-dai-123";
  let res = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password, displayName: `Aff ${code}`, code } });
  assert.equal(res.statusCode, 200, res.body);
  let cookie = cookieOf(res);

  // chưa bật 2FA → bị chặn
  res = await app.inject({ method: "GET", url: "/v1/aff/me", headers: { cookie } });
  assert.equal(res.statusCode, 403);

  res = await app.inject({ method: "POST", url: "/v1/auth/2fa/setup", headers: { cookie }, payload: {} });
  const { secret } = res.json();
  res = await app.inject({ method: "POST", url: "/v1/auth/2fa/enable", headers: { cookie }, payload: { code: authenticator.generate(secret) } });
  assert.equal(res.statusCode, 200, res.body);

  // đăng nhập lại cần mã 2FA
  res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  assert.equal(res.statusCode, 401);
  res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password, totp: authenticator.generate(secret) } });
  assert.equal(res.statusCode, 200, res.body);
  cookie = cookieOf(res);
  return { cookie, email, password, secret };
}

let A: Awaited<ReturnType<typeof newAffiliate>>;
let customerToken = "";
let refCode = "";

test("affiliate đăng ký, bắt buộc 2FA, đăng nhập lại bằng 2FA", async () => {
  A = await newAffiliate("PHUC");
  const who = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: A.cookie } });
  assert.deepEqual(
    { totp: who.json().totpEnabled, mfa: who.json().mfaPassed, aff: who.json().isAffiliate },
    { totp: true, mfa: true, aff: true }
  );
  const me = await app.inject({ method: "GET", url: "/v1/aff/me", headers: { cookie: A.cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().inviteUrl, "http://localhost:8080/j/PHUC");
});

test("khóa API sai bị từ chối; khóa đúng được mã hóa, không bao giờ trả lại", async () => {
  let res = await app.inject({
    method: "PUT", url: "/v1/aff/credentials", headers: { cookie: A.cookie },
    payload: { network: "accesstrade", accessKey: "khoa-sai-1234567", campaignId: "4751584435713464237" }
  });
  assert.equal(res.statusCode, 400);

  res = await app.inject({
    method: "PUT", url: "/v1/aff/credentials", headers: { cookie: A.cookie },
    payload: { network: "accesstrade", accessKey: GOOD_KEY, campaignId: "4751584435713464237" }
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().keyLast4, "1234");
  // mặc định là chế độ cổng nhận link; bật chế độ API (dự phòng) cho các test API
  res = await app.inject({ method: "PUT", url: "/v1/aff/settings", headers: { cookie: A.cookie }, payload: { linkMode: "api" } });
  assert.equal(res.statusCode, 200);

  const me = await app.inject({ method: "GET", url: "/v1/aff/me", headers: { cookie: A.cookie } });
  assert.ok(!me.body.includes(GOOD_KEY), "API không được trả lại khóa");

  const rows = await deps.db.ownerQuery("SELECT secret_enc FROM affiliate_credentials");
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].secret_enc.includes(GOOD_KEY), "DB chỉ chứa bản mã");
});

test("khách tham gia bằng mã mời, tạo link từ link rút gọn Shopee", async () => {
  let res = await app.inject({ method: "GET", url: "/v1/public/affiliates/phuc" });
  assert.equal(res.json().displayName, "Aff PHUC");

  res = await app.inject({ method: "POST", url: "/v1/ext/join", payload: { affiliateCode: "PHUC", nickname: "Lan", contact: "0901234567" } });
  assert.equal(res.statusCode, 200, res.body);
  customerToken = res.json().token;
  refCode = res.json().refCode;
  assert.match(customerToken, /^cdk_/);

  res = await app.inject({
    method: "POST", url: "/v1/ext/links", headers: { authorization: `Bearer ${customerToken}` },
    payload: { url: "Xem sản phẩm này trên Shopee https://s.shopee.vn/abc123", source: "pwa" }
  });
  // app Shopee chia sẻ cả đoạn chữ → server tự tách URL
  assert.equal(res.statusCode, 200, res.body);

  res = await app.inject({
    method: "POST", url: "/v1/ext/links", headers: { authorization: `Bearer ${customerToken}` },
    payload: { url: "https://s.shopee.vn/abc123", source: "pwa" }
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().affLink, `https://shorten.asia/${refCode}`);
  assert.equal(res.json().productUrl, "https://shopee.vn/product/301412525/28780427085");
  const call = seen.find((s) => s.path === "/v1/product_link/create")!;
  assert.equal(call.body.utm_content, refCode);
  assert.deepEqual(call.body.urls, ["https://shopee.vn/product/301412525/28780427085"]);
});

test("chặn link không phải Shopee và redirect độc hại (SSRF)", async () => {
  for (const url of ["https://evil.com/x", "http://127.0.0.1:22/", "https://s.shopee.vn/evil", "javascript:alert(1)"]) {
    const res = await app.inject({
      method: "POST", url: "/v1/ext/links", headers: { authorization: `Bearer ${customerToken}` }, payload: { url }
    });
    assert.equal(res.statusCode, 400, `${url} → ${res.body}`);
  }
  await assert.rejects(normalizeShopeeUrl("https://shopee.vn/cart"), /không phải link sản phẩm/);
});

test("token khách sai bị từ chối", async () => {
  const res = await app.inject({
    method: "POST", url: "/v1/ext/links", headers: { authorization: "Bearer cdk_" + "x".repeat(43) }, payload: { url: "https://shopee.vn/a-i.1.2" }
  });
  assert.equal(res.statusCode, 401);
});

test("đồng bộ đơn: ghép đơn với khách, tính tiền hoàn, ghi nhận đã trả", async () => {
  mockOrders = [
    { order_id: "250101AAA", merchant: "shopee", billing: 142388, pub_commission: 10000, order_pending: 0, order_approved: 1, order_reject: 0, is_confirmed: 1, utm_content: refCode, sales_time: "2026-10-20T10:00:00+07:00" },
    { order_id: "250101BBB", merchant: "shopee", billing: 50000, pub_commission: 4000, order_pending: 1, order_approved: 0, order_reject: 0, is_confirmed: 0, utm_content: refCode, sales_time: "2026-10-22T10:00:00+07:00" },
    { order_id: "250101CCC", merchant: "shopee", billing: 99000, pub_commission: 7000, order_pending: 1, order_approved: 0, order_reject: 0, is_confirmed: 0, utm_content: "KHACH-LA", sales_time: "2026-10-22T11:00:00+07:00" }
  ];
  let res = await app.inject({ method: "POST", url: "/v1/aff/sync", headers: { cookie: A.cookie }, payload: {} });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().upserted, 3);

  res = await app.inject({ method: "GET", url: "/v1/ext/history", headers: { authorization: `Bearer ${customerToken}` } });
  const h = res.json();
  assert.equal(h.orders.length, 2, "khách chỉ thấy đơn của mình");
  assert.equal(h.totals.approved, 5000); // 50% của 10.000
  assert.equal(h.totals.pending, 2000);
  assert.equal(h.links.length, 2);

  res = await app.inject({ method: "GET", url: "/v1/aff/customers", headers: { cookie: A.cookie } });
  const cust = res.json()[0];
  assert.equal(cust.contact, "0901234567", "affiliate xem được liên hệ đã giải mã");
  assert.equal(cust.owed, 5000);

  res = await app.inject({ method: "POST", url: "/v1/aff/payouts", headers: { cookie: A.cookie }, payload: { customerId: cust.id, amount: 5000, note: "MoMo" } });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: "GET", url: "/v1/ext/history", headers: { authorization: `Bearer ${customerToken}` } });
  assert.equal(res.json().totals.owed, 0);
  assert.equal(res.json().totals.paid, 5000);
});

test("cổng nhận link: chặn địa chỉ nguy hiểm, ghép link đúng, không cần khóa API", async () => {
  const G = await newAffiliate("GATE");
  for (const bad of [
    "http://site.vn/go?url={url}",
    "https://localhost/go?url={url}",
    "https://10.0.0.5/go?url={url}",
    "https://site.vn/go?u=1",
    "https://{url}.evil.com/x",
    "https://user:pass@site.vn/go?url={url}"
  ]) {
    const r = await app.inject({ method: "PUT", url: "/v1/aff/gateway", headers: { cookie: G.cookie }, payload: { template: bad } });
    assert.equal(r.statusCode, 400, bad);
  }
  let res = await app.inject({
    method: "PUT", url: "/v1/aff/gateway", headers: { cookie: G.cookie },
    payload: { template: "https://getlink.gate.vn/go?url={url}&sub={sub}" }
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.json().example, /^https:\/\/getlink\.gate\.vn\/go\?url=https%3A%2F%2Fshopee\.vn/);

  res = await app.inject({ method: "POST", url: "/v1/ext/join", payload: { affiliateCode: "GATE", nickname: "Minh" } });
  const t = res.json().token;
  const ref = res.json().refCode;
  const before = seen.length;
  res = await app.inject({
    method: "POST", url: "/v1/ext/links", headers: { authorization: `Bearer ${t}` },
    payload: { url: "https://shopee.vn/Ao-Thun-i.111.222?sp_atk=abc", source: "extension" }
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().network, "gateway");
  assert.equal(
    res.json().affLink,
    `https://getlink.gate.vn/go?url=${encodeURIComponent("https://shopee.vn/product/111/222")}&sub=${ref}`
  );
  assert.equal(seen.length, before, "chế độ cổng không gọi tới AccessTrade");
  const creds = await deps.db.ownerQuery("SELECT count(*)::int AS n FROM affiliate_credentials c JOIN affiliates a ON a.id = c.affiliate_id WHERE a.code = 'GATE'");
  assert.equal(creds[0].n, 0, "không lưu khóa API nào");
});

test("tách dữ liệu: affiliate B không thấy gì của A (API + RLS trong DB)", async () => {
  const B = await newAffiliate("BINH");
  let res = await app.inject({ method: "GET", url: "/v1/aff/customers", headers: { cookie: B.cookie } });
  assert.deepEqual(res.json(), []);
  res = await app.inject({ method: "GET", url: "/v1/aff/orders", headers: { cookie: B.cookie } });
  assert.deepEqual(res.json(), []);

  // gọi thẳng DB trong ngữ cảnh B: RLS trả 0 dòng dù không có WHERE
  const bId = (await deps.db.ownerQuery("SELECT id FROM affiliates WHERE code = 'BINH'"))[0].id;
  const counts = await deps.db.tx({ affiliateId: bId }, async (q) => ({
    customers: (await q.query("SELECT count(*)::int AS n FROM customers")).rows[0].n,
    orders: (await q.query("SELECT count(*)::int AS n FROM orders")).rows[0].n,
    creds: (await q.query("SELECT count(*)::int AS n FROM affiliate_credentials")).rows[0].n
  }));
  assert.deepEqual(counts, { customers: 0, orders: 0, creds: 0 });

  // B cũng không ghi được dữ liệu mang affiliate_id của A
  const aId = (await deps.db.ownerQuery("SELECT id FROM affiliates WHERE code = 'PHUC'"))[0].id;
  await assert.rejects(
    deps.db.tx({ affiliateId: bId }, (q) =>
      q.query("INSERT INTO customers (affiliate_id, ref_code, token_hash) VALUES ($1, 'CX', 'h')", [aId])
    ),
    /row-level security/
  );
});

test("nhật ký thao tác không sửa/xóa được", async () => {
  await assert.rejects(deps.db.tx({ system: true }, (q) => q.query("DELETE FROM audit_logs")), /permission denied/);
  const n = (await deps.db.ownerQuery("SELECT count(*)::int AS n FROM audit_logs"))[0].n;
  assert.ok(n >= 4);
});

test("mã hóa: bản mã gắn với chủ, chép sang chỗ khác không giải mã được", async () => {
  const box = new SecretBox(new LocalKeyProvider(randomBytes(32)));
  const c = await box.encrypt("bi-mat", "cred:A:accesstrade");
  assert.equal(await box.decrypt(c, "cred:A:accesstrade"), "bi-mat");
  await assert.rejects(box.decrypt(c, "cred:B:accesstrade"));
  const other = new SecretBox(new LocalKeyProvider(randomBytes(32)));
  await assert.rejects(other.decrypt(c, "cred:A:accesstrade"));
});

test("khách tự xóa dữ liệu → token vô hiệu", async () => {
  let res = await app.inject({ method: "DELETE", url: "/v1/ext/me", headers: { authorization: `Bearer ${customerToken}` } });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: "GET", url: "/v1/ext/me", headers: { authorization: `Bearer ${customerToken}` } });
  assert.equal(res.statusCode, 401);
});

test("chống CSRF: Origin lạ bị chặn, Origin đúng (tự nhận theo request) được qua", async () => {
  let res = await app.inject({ method: "PUT", url: "/v1/aff/settings", headers: { cookie: A.cookie, origin: "https://evil.example" }, payload: { defaultCashbackRate: 40 } });
  assert.equal(res.statusCode, 403);
  res = await app.inject({ method: "PUT", url: "/v1/aff/settings", headers: { cookie: A.cookie, origin: "http://localhost:8080" }, payload: { defaultCashbackRate: 50 } });
  assert.equal(res.statusCode, 200);
});

test("PWA: trang chủ, link mời, trang chia sẻ, manifest có share_target, có CSP", async () => {
  for (const u of ["/aff/", "/aff/aff.js", "/", "/j/PHUC", "/share?url=https://s.shopee.vn/abc", "/manifest.webmanifest", "/app.js", "/sw.js"]) {
    const res = await app.inject({ method: "GET", url: u });
    assert.equal(res.statusCode, 200, u);
  }
  const m = await app.inject({ method: "GET", url: "/manifest.webmanifest" });
  assert.equal(JSON.parse(m.body).share_target.action, "/share");
  const h = await app.inject({ method: "GET", url: "/" });
  assert.match(String(h.headers["content-security-policy"]), /script-src 'self'/);
});
