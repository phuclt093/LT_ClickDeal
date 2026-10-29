/**
 * Server chạy thử: Postgres trong bộ nhớ, dữ liệu mẫu đủ các trạng thái.
 *   npx tsx scripts/demo-server.ts
 * Affiliate: phuc@example.com / mat-khau-rat-dai-123 (mã 2FA in ra màn hình)
 * Người mua: 0901234567 / matkhau123
 * Ghi cookie đăng nhập sẵn vào DEMO_COOKIES (nếu đặt) để chụp màn hình tự động.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { authenticator } from "otplib";
import { loadConfig } from "../src/config.js";
import { createPgliteDb } from "../src/db/db.js";
import { createDeps } from "../src/bootstrap.js";
import { buildApp } from "../src/app.js";

const config = loadConfig({
  ...process.env,
  MASTER_KEY: randomBytes(32).toString("base64"),
  COOKIE_SECURE: "false",
  AUTO_APPROVE_AFFILIATES: "true",
  PUBLIC_BASE_URL: "http://localhost:8080"
} as any);
const deps = await createDeps(config, await createPgliteDb());
const app = await buildApp(deps);
const ck = (r: any) => String([].concat(r.headers["set-cookie"])[0]).split(";")[0];
const call = async (method: string, url: string, cookie: string, payload?: any) => {
  const r = await app.inject({ method: method as any, url, headers: { cookie }, payload });
  if (r.statusCode >= 400) throw new Error(`${method} ${url}: ${r.body}`);
  return r.json();
};

// Affiliate
let r = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "phuc@example.com", password: "mat-khau-rat-dai-123", displayName: "Phúc Deal", code: "PHUC", acceptTerms: true } });
const aff = ck(r);
const { secret } = await call("POST", "/v1/auth/2fa/setup", aff, {});
await call("POST", "/v1/auth/2fa/enable", aff, { code: authenticator.generate(secret) });
await call("PUT", "/v1/aff/gateway", aff, { template: "https://clickdeal-gateway.phuc.workers.dev/go?url={url}&sub={sub}&click={click}" });

const JPEG = "data:image/jpeg;base64," + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]).toString("base64");
const products = [
  ["Áo thun cotton unisex form rộng", "129.000₫", "https://shopee.vn/product/111/1001"],
  ["Tai nghe Bluetooth chống ồn ANC", "459.000₫", "https://shopee.vn/product/111/1002"],
  ["Nồi chiên không dầu 5L", "1.290.000₫", "https://shopee.vn/product/111/1003"],
  ["Bình giữ nhiệt inox 750ml", "189.000₫", "https://shopee.vn/product/111/1004"],
  ["Sạc dự phòng 20000mAh", "359.000₫", "https://shopee.vn/product/111/1005"]
];

async function buyer(name: string, phone: string) {
  const res = await app.inject({ method: "POST", url: "/v1/auth/register-buyer", payload: { inviteCode: "PHUC", name, phone, password: "matkhau123", acceptTerms: true } });
  const c = ck(res);
  await call("PUT", "/v1/ext/bank", c, { bin: "970436", account: "10" + phone.slice(-8), holder: name });
  return c;
}
const lan = await buyer("Lan Nguyễn", "0901234567");
const minh = await buyer("Minh Trần", "0912345678");
const hoa = await buyer("Hoa", "0987654321");

const links: string[] = [];
for (const [name, price, url] of products) {
  const l = await call("POST", "/v1/ext/links", lan, { url, source: "pwa", product: { name, price } });
  links.push(l.linkId);
}
const mk = async (c: string, code: string, extra: any = {}) => (await call("POST", "/v1/ext/claims", c, { orderCode: code, ...extra })).id;
const act = (id: string, body: any) => call("POST", `/v1/aff/claims/${id}/actions`, aff, body);

const c1 = await mk(lan, "251001AAA111", { linkId: links[2], orderAmount: 1290000, orderedOn: "2026-10-01", image: JPEG, note: "Nồi chiên giao rồi nha" });
await act(c1, { action: "accept", commission: 64500, cashback: 32250 });
const c2 = await mk(lan, "251015BBB222", { linkId: links[1], orderAmount: 459000, orderedOn: "2026-10-15" });
await act(c2, { action: "accept", commission: 22950, cashback: 11475 });
const c3 = await mk(lan, "251028CCC333", { linkId: links[0], orderAmount: 129000, image: JPEG });
const c4 = await mk(minh, "250920DDD444", { orderAmount: 359000 });
await act(c4, { action: "accept", commission: 17950, cashback: 8975 });
const c5 = await mk(minh, "251027EEE555", { orderAmount: 99000 });
await act(c5, { action: "reject", reason: "Không thấy đơn này trên AccessTrade sau 3 ngày." });
await call("POST", `/v1/ext/claims/${c5}/actions`, minh, { action: "dispute", reason: "Mình mua qua link ClickDeal tối 27/10, đơn đã giao thành công." });
await call("POST", `/v1/ext/claims/${c5}/messages`, minh, { body: "Ảnh lịch sử mua hàng đây ạ", image: JPEG });
const c6 = await mk(hoa, "250901FFF666", { orderAmount: 250000 });
await act(c6, { action: "accept", commission: 15000, cashback: 7500 });
const hoaId = (await call("GET", `/v1/aff/claims/${c6}`, aff)).customer.id;
await call("POST", "/v1/aff/payouts", aff, { customerId: hoaId, claimIds: [c6], method: "Chuyển khoản ngân hàng", receipt: JPEG });
await mk(hoa, "251029GGG777", { orderAmount: 175000 });

// đơn cũ: đến hạn kiểm tra / quá 6 tuần
await deps.db.ownerExec(`UPDATE claims SET submitted_at = now() - interval '28 days', remind_at = now() - interval '14 days' WHERE id = '${c1}'`);
await deps.db.ownerExec(`UPDATE claims SET submitted_at = now() - interval '45 days', remind_at = now() - interval '31 days' WHERE id = '${c4}'`);
await deps.db.ownerExec(`UPDATE claims SET submitted_at = now() - interval '58 days', paid_at = now() - interval '2 days' WHERE id = '${c6}'`);
void c2; void c3;

// đăng nhập lại affiliate (đã qua 2FA) cho cookie chụp màn hình
r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { login: "phuc@example.com", password: "mat-khau-rat-dai-123", totp: authenticator.generate(secret) } });
const affCookie = ck(r);
if (process.env.DEMO_COOKIES) writeFileSync(process.env.DEMO_COOKIES, JSON.stringify({ aff: affCookie, lan, hoa, claim: c1, dispute: c5, paid: c6 }));

await app.listen({ port: 8080, host: "127.0.0.1" });
console.log("Demo sẵn sàng: http://localhost:8080  ·  2FA secret affiliate:", secret);
