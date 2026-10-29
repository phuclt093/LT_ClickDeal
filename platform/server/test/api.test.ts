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
import { crc16, vietQrPayload } from "../src/services/vietqr.js";

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
  let res = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password, displayName: `Aff ${code}`, code, acceptTerms: true } });
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
  // 2FA dùng lại cùng 1 mã trong 30 giây vẫn hợp lệ với otplib → dùng mã của cửa sổ hiện tại
  res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { login: email, password, totp: authenticator.generate(secret), role: "affiliate" } });
  assert.equal(res.statusCode, 200, res.body);
  cookie = cookieOf(res);
  return { cookie, email, password, secret };
}

let phoneSeq = 0;
async function newBuyer(inviteCode: string, name = "Lan") {
  const phone = `09${String(10000000 + ++phoneSeq).slice(-8)}`;
  const password = "matkhau123";
  const res = await app.inject({
    method: "POST", url: "/v1/auth/register-buyer",
    payload: { inviteCode, name, phone: phone.replace(/^0/, "+84 "), password, acceptTerms: true }
  });
  assert.equal(res.statusCode, 200, res.body);
  return { cookie: cookieOf(res), phone, password };
}

// ảnh JPEG nhỏ hợp lệ về chữ ký file
const JPEG = "data:image/jpeg;base64," + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(200)]).toString("base64");


let A: Awaited<ReturnType<typeof newAffiliate>>;
let L: Awaited<ReturnType<typeof newBuyer>>;
let refCode = "";
let linkId = "";
let claimId = "";

const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, cookie: string, payload: any, method: "POST" | "PUT" | "DELETE" = "POST") =>
  app.inject({ method, url, headers: { cookie }, payload });

test("affiliate đăng ký (phải đồng ý điều khoản), bắt buộc 2FA, đăng nhập lại bằng 2FA", async () => {
  const r = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "x@example.com", password: "mat-khau-rat-dai-123", displayName: "X", code: "XXXX" } });
  assert.equal(r.statusCode, 400, "thiếu đồng ý điều khoản");
  A = await newAffiliate("PHUC");
  const who = await get("/v1/auth/me", A.cookie);
  assert.deepEqual(
    { role: who.json().role, totp: who.json().totpEnabled, mfa: who.json().mfaPassed, aff: who.json().isAffiliate },
    { role: "affiliate", totp: true, mfa: true, aff: true }
  );
  const me = await get("/v1/aff/me", A.cookie);
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().inviteUrl, "http://localhost:8080/j/PHUC");
  assert.equal(me.json().remindAfterDays, 14);
  assert.equal(me.json().orderSyncEnabled, false, "tự đối chiếu tắt mặc định");
  const terms = await deps.db.ownerQuery("SELECT terms_version, terms_accepted_at FROM users WHERE email = 'phuc@example.com'");
  assert.ok(terms[0].terms_version && terms[0].terms_accepted_at);
});

test("người mua đăng ký bằng mã mời + số điện thoại, đăng nhập đúng vai trò", async () => {
  let res = await app.inject({ method: "POST", url: "/v1/auth/register-buyer", payload: { inviteCode: "KHONGCO", name: "A", phone: "0901111111", password: "matkhau123", acceptTerms: true } });
  assert.equal(res.statusCode, 404);
  L = await newBuyer("phuc");
  res = await get("/v1/auth/me", L.cookie);
  assert.equal(res.json().role, "buyer");
  assert.equal(res.json().phone, L.phone, "số +84 được chuẩn hóa về 0…");

  // trùng số điện thoại
  res = await app.inject({ method: "POST", url: "/v1/auth/register-buyer", payload: { inviteCode: "PHUC", name: "B", phone: L.phone, password: "matkhau123", acceptTerms: true } });
  assert.equal(res.statusCode, 409);

  // chọn nhầm vai trò → báo rõ
  res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { login: L.phone, password: L.password, role: "affiliate" } });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /người mua/);
  res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { login: L.phone, password: L.password, role: "buyer" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().role, "buyer");
  L.cookie = cookieOf(res);

  // người mua không vào được API affiliate và ngược lại
  assert.equal((await get("/v1/aff/me", L.cookie)).statusCode, 403);
  assert.equal((await get("/v1/ext/me", A.cookie)).statusCode, 403);

  res = await get("/v1/ext/me", L.cookie);
  assert.equal(res.json().affiliate.code, "PHUC");
  refCode = res.json().refCode;
});

test("khóa API sai bị từ chối; khóa đúng được mã hóa, không bao giờ trả lại", async () => {
  let res = await post("/v1/aff/credentials", A.cookie, { network: "accesstrade", accessKey: "khoa-sai-1234567", campaignId: "4751584435713464237" }, "PUT");
  assert.equal(res.statusCode, 400);
  res = await post("/v1/aff/credentials", A.cookie, { network: "accesstrade", accessKey: GOOD_KEY, campaignId: "4751584435713464237" }, "PUT");
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().keyLast4, "1234");
  // mặc định là chế độ cổng nhận link; bật chế độ API (dự phòng) cho các test API
  res = await post("/v1/aff/settings", A.cookie, { linkMode: "api" }, "PUT");
  assert.equal(res.statusCode, 200);
  const me = await get("/v1/aff/me", A.cookie);
  assert.ok(!me.body.includes(GOOD_KEY), "API không được trả lại khóa");
  const rows = await deps.db.ownerQuery("SELECT secret_enc FROM affiliate_credentials");
  assert.ok(!rows[0].secret_enc.includes(GOOD_KEY), "DB chỉ chứa bản mã");
});

test("người mua tạo link từ link rút gọn Shopee (cookie và mã kết nối tiện ích)", async () => {
  let res = await post("/v1/ext/links", L.cookie, { url: "Xem sản phẩm này trên Shopee https://s.shopee.vn/abc123", source: "pwa" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().affLink, `https://shorten.asia/${refCode}`);
  assert.equal(res.json().productUrl, "https://shopee.vn/product/301412525/28780427085");
  linkId = res.json().linkId;
  const call = seen.find((s) => s.path === "/v1/product_link/create")!;
  assert.equal(call.body.utm_content, refCode);

  // mã kết nối cho tiện ích trình duyệt (Bearer, không cần cookie, không bị chặn Origin)
  res = await post("/v1/ext/extension-key", L.cookie, {});
  const key = res.json().token;
  assert.match(key, /^cdk_/);
  res = await app.inject({
    method: "POST", url: "/v1/ext/links", headers: { authorization: `Bearer ${key}`, origin: "chrome-extension://abc" },
    payload: { url: "https://shopee.vn/a-i.301412525.28780427085", source: "extension" }
  });
  assert.equal(res.statusCode, 200, res.body);
  res = await app.inject({ method: "POST", url: "/v1/ext/links", headers: { authorization: "Bearer cdk_" + "x".repeat(43) }, payload: { url: "https://shopee.vn/a-i.1.2" } });
  assert.equal(res.statusCode, 401);
});

test("chặn link không phải Shopee và redirect độc hại (SSRF)", async () => {
  for (const url of ["https://evil.com/x", "http://127.0.0.1:22/", "https://s.shopee.vn/evil", "javascript:alert(1)"]) {
    const res = await post("/v1/ext/links", L.cookie, { url });
    assert.equal(res.statusCode, 400, `${url} → ${res.body}`);
  }
  await assert.rejects(normalizeShopeeUrl("https://shopee.vn/cart"), /không phải link sản phẩm/);
});

test("người mua lưu tài khoản ngân hàng (mã hóa) và báo đơn kèm ảnh", async () => {
  let res = await post("/v1/ext/bank", L.cookie, { bin: "970436", account: "0123456789", holder: "Nguyễn Thị Lan" }, "PUT");
  assert.equal(res.statusCode, 200, res.body);
  const raw = await deps.db.ownerQuery("SELECT bank_enc, bank_label FROM customers WHERE ref_code = $1", [refCode]);
  assert.ok(!raw[0].bank_enc.includes("0123456789"), "số tài khoản chỉ lưu bản mã");
  assert.equal(raw[0].bank_label, "Vietcombank ••• 6789");
  res = await get("/v1/ext/me", L.cookie);
  assert.equal(res.json().bank.holder, "NGUYEN THI LAN");

  // ảnh giả (không phải ảnh) bị từ chối
  res = await post("/v1/ext/claims", L.cookie, { orderCode: "251029ABCD1234", image: "data:image/png;base64," + Buffer.from("<svg>").toString("base64") });
  assert.equal(res.statusCode, 400);

  res = await post("/v1/ext/claims", L.cookie, { orderCode: "251029 abcd1234", orderAmount: 259000, linkId, note: "Đơn áo thun", image: JPEG });
  assert.equal(res.statusCode, 200, res.body);
  claimId = res.json().id;

  res = await post("/v1/ext/claims", L.cookie, { orderCode: "251029ABCD1234" });
  assert.equal(res.statusCode, 409, "không báo trùng đơn");

  res = await get(`/v1/ext/claims/${claimId}`, L.cookie);
  const d = res.json();
  assert.equal(d.claim.orderCode, "251029ABCD1234");
  assert.equal(d.claim.status, "submitted");
  assert.equal(d.events.length, 2);
  const img = d.events.find((e: any) => e.image).image;
  assert.equal((await get(img, L.cookie)).statusCode, 200);
  assert.equal((await get(img, A.cookie)).statusCode, 200, "affiliate xem được ảnh");
  const stored = await deps.db.ownerQuery("SELECT data_enc FROM attachments LIMIT 1");
  assert.ok(!stored[0].data_enc.includes(JPEG.split(",")[1].slice(0, 40)), "ảnh lưu dạng mã hóa");

  res = await get("/v1/ext/history", L.cookie);
  assert.equal(res.json().totals.submitted, 1);
  assert.equal(res.json().links.find((l: any) => l.id === linkId).claim_no, d.claim.no);
});

test("affiliate: việc cần làm, duyệt, nhắc kiểm tra, trả bằng VietQR, khách xác nhận", async () => {
  let res = await get("/v1/aff/overview", A.cookie);
  assert.equal(res.json().review, 1);

  res = await get("/v1/aff/claims?view=review", A.cookie);
  assert.equal(res.json().length, 1);
  res = await get(`/v1/aff/claims/${claimId}`, A.cookie);
  assert.equal(res.json().bank.account, "0123456789", "affiliate thấy STK để chuyển tiền");
  assert.equal(res.json().click.productUrl, "https://shopee.vn/product/301412525/28780427085");

  // khách không hủy được khi affiliate đã ghi nhận
  res = await post(`/v1/aff/claims/${claimId}/actions`, A.cookie, { action: "accept", commission: 18000, cashback: 9000 });
  assert.equal(res.statusCode, 200, res.body);
  res = await post(`/v1/ext/claims/${claimId}/actions`, L.cookie, { action: "cancel" });
  assert.equal(res.statusCode, 400);

  // chưa tới hạn nhắc (14 ngày) → giả lập đã qua 15 ngày
  res = await get("/v1/aff/overview", A.cookie);
  assert.equal(res.json().due, 0);
  assert.equal(res.json().owed, 9000);
  await deps.db.ownerExec(`UPDATE claims SET remind_at = now() - interval '1 day', submitted_at = now() - interval '15 days' WHERE id = '${claimId}'`);
  res = await get("/v1/aff/overview", A.cookie);
  assert.equal(res.json().due, 1, "tới hạn nhắc affiliate tự kiểm tra");
  // hoãn nhắc 7 ngày
  await post(`/v1/aff/claims/${claimId}/actions`, A.cookie, { action: "snooze", days: 7 });
  assert.equal((await get("/v1/aff/overview", A.cookie)).json().due, 0);

  res = await get("/v1/aff/payables", A.cookie);
  assert.equal(res.json()[0].total, 9000);

  res = await post("/v1/aff/payouts/qr", A.cookie, { customerId: res.json()[0].customer.id, claimIds: [claimId] });
  assert.equal(res.statusCode, 200, res.body);
  const qr = res.json();
  assert.equal(qr.amount, 9000);
  assert.match(qr.qr, /^data:image\/svg\+xml;base64,/);
  assert.match(qr.note, /^CLICKDEAL \d+$/);

  const custId = (await get("/v1/aff/payables", A.cookie)).json()[0].customer.id;
  res = await post("/v1/aff/payouts", A.cookie, { customerId: custId, claimIds: [claimId], method: "Chuyển khoản", receipt: JPEG });
  assert.equal(res.statusCode, 200, res.body);
  res = await post("/v1/aff/payouts", A.cookie, { customerId: custId, claimIds: [claimId] });
  assert.equal(res.statusCode, 409, "không trả 2 lần");

  res = await get(`/v1/ext/claims/${claimId}`, L.cookie);
  assert.equal(res.json().claim.status, "paid");
  assert.ok(res.json().payout.receipt, "khách thấy biên lai");
  res = await post(`/v1/ext/claims/${claimId}/actions`, L.cookie, { action: "confirm_received" });
  assert.equal(res.statusCode, 200);
  res = await get("/v1/ext/history", L.cookie);
  assert.equal(res.json().totals.received, 9000);

  // chỉ số uy tín công khai
  res = await app.inject({ method: "GET", url: "/v1/public/affiliates/PHUC" });
  assert.equal(res.json().stats.paidOrders, 1);
  assert.equal(res.json().stats.avgDaysToPay, 15);
});

test("khiếu nại kiểu P2P: từ chối → khách khiếu nại kèm ảnh → trao đổi → đóng", async () => {
  let res = await post("/v1/ext/claims", L.cookie, { orderCode: "251029XYZ999" });
  const id = res.json().id;
  res = await post(`/v1/aff/claims/${id}/actions`, A.cookie, { action: "reject", reason: "ngắn" });
  assert.equal(res.statusCode, 400, "lý do quá ngắn");
  res = await post(`/v1/aff/claims/${id}/actions`, A.cookie, { action: "reject", reason: "Không thấy đơn trên AccessTrade" });
  assert.equal(res.statusCode, 200);
  res = await post(`/v1/ext/claims/${id}/actions`, L.cookie, { action: "dispute" });
  assert.equal(res.statusCode, 400, "phải ghi lý do");
  res = await post(`/v1/ext/claims/${id}/actions`, L.cookie, { action: "dispute", reason: "Tôi mua qua link ClickDeal lúc 20h" });
  assert.equal(res.statusCode, 200);
  res = await post(`/v1/ext/claims/${id}/messages`, L.cookie, { body: "Ảnh lịch sử mua", image: JPEG });
  assert.equal(res.statusCode, 200);
  res = await post(`/v1/aff/claims/${id}/messages`, A.cookie, { body: "Mình kiểm tra lại nhé" });
  assert.equal(res.statusCode, 200);
  assert.equal((await get("/v1/aff/overview", A.cookie)).json().disputed, 1);
  res = await post(`/v1/aff/claims/${id}/actions`, A.cookie, { action: "accept", cashback: 5000 });
  assert.equal(res.statusCode, 200, "duyệt lại sau khi bị từ chối");
  res = await post(`/v1/ext/claims/${id}/actions`, L.cookie, { action: "close_dispute" });
  assert.equal(res.statusCode, 200);
  res = await get(`/v1/aff/claims/${id}`, A.cookie);
  assert.deepEqual(res.json().events.map((e: any) => e.actor), ["system", "affiliate", "buyer", "buyer", "affiliate", "affiliate", "buyer"]);

  // trao đổi và ảnh bằng chứng không sửa/xóa được
  await assert.rejects(deps.db.tx({ system: true }, (q) => q.query("DELETE FROM claim_events")), /permission denied/);
  await assert.rejects(deps.db.tx({ system: true }, (q) => q.query("UPDATE claim_events SET body = 'sửa'")), /permission denied/);
  await assert.rejects(deps.db.tx({ system: true }, (q) => q.query("DELETE FROM attachments")), /permission denied/);
});

test("đơn đã báo trả: tự hoàn tất sau 7 ngày nếu khách không phản hồi", async () => {
  const { autoComplete } = await import("../src/services/claims.js");
  let res = await post("/v1/ext/claims", L.cookie, { orderCode: "251029AUTO01" });
  const id = res.json().id;
  await post(`/v1/aff/claims/${id}/actions`, A.cookie, { action: "accept", cashback: 3000 });
  const custId = (await get(`/v1/aff/claims/${id}`, A.cookie)).json().customer.id;
  await post("/v1/aff/payouts", A.cookie, { customerId: custId, claimIds: [id] });
  assert.equal(await autoComplete(deps), 0);
  await deps.db.ownerExec(`UPDATE claims SET paid_at = now() - interval '8 days' WHERE id = '${id}'`);
  assert.equal(await autoComplete(deps), 1);
  res = await get(`/v1/ext/claims/${id}`, L.cookie);
  assert.equal(res.json().claim.status, "completed");
});

test("tự đối chiếu AccessTrade (tùy chọn): đơn đồng bộ khớp mã đơn được gợi ý khi duyệt", async () => {
  mockOrders = [
    { order_id: "251029SYNC01", merchant: "shopee", billing: 142388, pub_commission: 10000, order_pending: 0, order_approved: 1, order_reject: 0, is_confirmed: 1, utm_content: refCode, sales_time: "2026-10-20T10:00:00+07:00" }
  ];
  let res = await post("/v1/aff/sync", A.cookie, {});
  assert.equal(res.json().upserted, 1);
  res = await post("/v1/ext/claims", L.cookie, { orderCode: "251029SYNC01" });
  res = await get(`/v1/aff/claims/${res.json().id}`, A.cookie);
  assert.deepEqual(
    { status: res.json().synced.status, commission: res.json().synced.commission, ref: res.json().synced.refMatches },
    { status: "approved", commission: 10000, ref: true }
  );
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
    const r = await post("/v1/aff/gateway", G.cookie, { template: bad }, "PUT");
    assert.equal(r.statusCode, 400, bad);
  }
  let res = await post("/v1/aff/gateway", G.cookie, { template: "https://getlink.gate.vn/go?url={url}&sub={sub}" }, "PUT");
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.json().example, /^https:\/\/getlink\.gate\.vn\/go\?url=https%3A%2F%2Fshopee\.vn/);

  const M = await newBuyer("GATE", "Minh");
  const ref = (await get("/v1/ext/me", M.cookie)).json().refCode;
  const before = seen.length;
  res = await post("/v1/ext/links", M.cookie, { url: "https://shopee.vn/Ao-Thun-i.111.222?sp_atk=abc", source: "web" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().network, "gateway");
  assert.equal(res.json().affLink, `https://getlink.gate.vn/go?url=${encodeURIComponent("https://shopee.vn/product/111/222")}&sub=${ref}`);
  assert.equal(seen.length, before, "chế độ cổng không gọi tới AccessTrade");
});

test("tách dữ liệu: affiliate B và khách của B không thấy gì của A (API + RLS trong DB)", async () => {
  const B = await newAffiliate("BINH");
  const KB = await newBuyer("BINH", "Khách B");
  assert.deepEqual((await get("/v1/aff/customers", B.cookie)).json().map((c: any) => c.nickname), ["Khách B"], "B chỉ thấy khách của mình");
  assert.deepEqual((await get("/v1/aff/claims", B.cookie)).json(), []);
  assert.equal((await get(`/v1/aff/claims/${claimId}`, B.cookie)).statusCode, 404);
  assert.equal((await get(`/v1/ext/claims/${claimId}`, KB.cookie)).statusCode, 404, "khách khác không xem được đơn");
  const img = (await get(`/v1/ext/claims/${claimId}`, L.cookie)).json().events.find((e: any) => e.image).image;
  assert.equal((await get(img, KB.cookie)).statusCode, 404, "khách khác không xem được ảnh");
  assert.equal((await get(img, B.cookie)).statusCode, 404, "affiliate khác không xem được ảnh");
  // cùng affiliate nhưng khách khác cũng không xem được đơn của nhau
  const L2 = await newBuyer("PHUC", "Hoa");
  assert.equal((await get(`/v1/ext/claims/${claimId}`, L2.cookie)).statusCode, 404);
  assert.equal((await get(img, L2.cookie)).statusCode, 404);

  const bId = (await deps.db.ownerQuery("SELECT id FROM affiliates WHERE code = 'BINH'"))[0].id;
  const counts = await deps.db.tx({ affiliateId: bId }, async (q) => ({
    customers: (await q.query("SELECT count(*)::int AS n FROM customers")).rows[0].n,
    claims: (await q.query("SELECT count(*)::int AS n FROM claims")).rows[0].n,
    files: (await q.query("SELECT count(*)::int AS n FROM attachments")).rows[0].n,
    creds: (await q.query("SELECT count(*)::int AS n FROM affiliate_credentials")).rows[0].n
  }));
  assert.deepEqual(counts, { customers: 1, claims: 0, files: 0, creds: 0 });
  const aId = (await deps.db.ownerQuery("SELECT id FROM affiliates WHERE code = 'PHUC'"))[0].id;
  await assert.rejects(
    deps.db.tx({ affiliateId: bId }, (q) => q.query("INSERT INTO customers (affiliate_id, ref_code, token_hash) VALUES ($1, 'CX', 'h')", [aId])),
    /row-level security/
  );
});

test("VietQR: CRC đúng chuẩn, nội dung không dấu", () => {
  assert.equal(crc16("123456789"), "29B1");
  const p = vietQrPayload({ bin: "970436", account: "0123456789", amount: 9000, note: "Hoàn tiền đơn #12" });
  assert.ok(p.startsWith("000201010212"));
  assert.ok(p.includes("0010A000000727"));
  assert.ok(p.includes("54049000"));
  assert.ok(p.includes("0816Hoan tien don 12"));
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
});

test("nhật ký thao tác không sửa/xóa được", async () => {
  await assert.rejects(deps.db.tx({ system: true }, (q) => q.query("DELETE FROM audit_logs")), /permission denied/);
});

test("mã hóa: bản mã gắn với chủ, chép sang chỗ khác không giải mã được", async () => {
  const box = new SecretBox(new LocalKeyProvider(randomBytes(32)));
  const c = await box.encrypt("bi-mat", "cred:A:accesstrade");
  assert.equal(await box.decrypt(c, "cred:A:accesstrade"), "bi-mat");
  await assert.rejects(box.decrypt(c, "cred:B:accesstrade"));
});

test("chống CSRF: Origin lạ bị chặn với cả affiliate và người mua", async () => {
  let res = await app.inject({ method: "PUT", url: "/v1/aff/settings", headers: { cookie: A.cookie, origin: "https://evil.example" }, payload: { defaultCashbackRate: 40 } });
  assert.equal(res.statusCode, 403);
  res = await app.inject({ method: "POST", url: "/v1/ext/claims", headers: { cookie: L.cookie, origin: "https://evil.example" }, payload: { orderCode: "EVIL123456" } });
  assert.equal(res.statusCode, 403);
  res = await app.inject({ method: "PUT", url: "/v1/aff/settings", headers: { cookie: A.cookie, origin: "http://localhost:8080" }, payload: { defaultCashbackRate: 50 } });
  assert.equal(res.statusCode, 200);
});

test("người mua xóa tài khoản → không đăng nhập được, lịch sử báo đơn vẫn lưu", async () => {
  const X = await newBuyer("PHUC", "Xoa");
  await post("/v1/ext/claims", X.cookie, { orderCode: "251029DEL001" });
  let res = await app.inject({ method: "DELETE", url: "/v1/ext/me", headers: { cookie: X.cookie } });
  assert.equal(res.statusCode, 200);
  assert.equal((await get("/v1/ext/me", X.cookie)).statusCode, 401);
  res = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { login: X.phone, password: X.password } });
  assert.equal(res.statusCode, 401);
  const kept = await deps.db.ownerQuery("SELECT count(*)::int AS n FROM claims WHERE order_code = '251029DEL001'");
  assert.equal(kept[0].n, 1);
});

test("trang web: đăng nhập chung, app người mua, app affiliate, điều khoản, chia sẻ; có CSP", async () => {
  for (const u of ["/", "/j/PHUC", "/app/", "/aff/", "/terms", "/share?url=https://s.shopee.vn/abc", "/manifest.webmanifest", "/sw.js",
    "/common.js", "/login.js", "/app/buyer.js", "/aff/aff.js", "/share.js"]) {
    const res = await app.inject({ method: "GET", url: u });
    assert.equal(res.statusCode, 200, u);
  }
  const m = await app.inject({ method: "GET", url: "/manifest.webmanifest" });
  assert.equal(JSON.parse(m.body).share_target.action, "/share");
  const h = await app.inject({ method: "GET", url: "/" });
  assert.match(String(h.headers["content-security-policy"]), /script-src 'self'/);
});
