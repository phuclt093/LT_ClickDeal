// Test cổng Worker với fetch giả: node --test worker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "./worker.js";

const env = { AT_ACCESS_KEY: "k_secret_123456", AT_CAMPAIGN_ID: "4751584435713464237" };
const calls = [];
const fakeFetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (String(url).startsWith("https://s.shopee.vn/ok")) return new Response(null, { status: 302, headers: { location: "https://shopee.vn/x-i.1.2?a=b" } });
  if (String(url).startsWith("https://s.shopee.vn/bad")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
  if (String(url).includes("product_link/create")) {
    const b = JSON.parse(init.body);
    if (b.urls[0].endsWith("/9/9")) return new Response("{}", { status: 500 });
    return Response.json({ success: true, data: { success_link: [{ short_link: `https://shorten.asia/${b.utm_content}` }] } });
  }
  throw new Error("unexpected " + url);
};
const go = (q) => handle(new Request("https://gw.example.vn/go?" + q), env, fakeFetch);

test("tạo link và chuyển hướng, gắn mã khách", async () => {
  const r = await go("url=" + encodeURIComponent("https://shopee.vn/Ao-i.111.222?x=1") + "&sub=CABC&click=k1");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "https://shorten.asia/CABC");
  const c = calls.find((x) => x.url.includes("product_link"));
  assert.equal(c.init.headers.Authorization, "Token k_secret_123456");
  assert.deepEqual(JSON.parse(c.init.body).urls, ["https://shopee.vn/product/111/222"]);
});
test("link rút gọn Shopee được mở ra", async () => {
  const r = await go("url=" + encodeURIComponent("https://s.shopee.vn/ok") + "&sub=C1");
  assert.equal(r.headers.get("location"), "https://shorten.asia/C1");
});
test("chặn link lạ và redirect độc hại", async () => {
  for (const u of ["https://evil.com/a-i.1.2", "https://s.shopee.vn/bad", "javascript:alert(1)"]) {
    const r = await go("url=" + encodeURIComponent(u));
    assert.equal(r.status, 400, u);
  }
  assert.equal((await go("url=x&sub=" + encodeURIComponent("<script>"))).status, 400);
});
test("AccessTrade lỗi → vẫn mở sản phẩm cho khách", async () => {
  const r = await go("url=" + encodeURIComponent("https://shopee.vn/product/9/9"));
  assert.equal(r.headers.get("location"), "https://shopee.vn/product/9/9");
  assert.equal(r.headers.get("x-clickdeal-fallback"), "1");
});
