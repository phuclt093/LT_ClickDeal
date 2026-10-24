/**
 * "Cổng nhận link": trang của affiliate nhận link sản phẩm và tự chuyển sang link affiliate.
 * Mẫu bắt buộc https, có {url}; tùy chọn {sub} (mã khách) và {click} (mã lần bấm).
 * ClickDeal chỉ ghép địa chỉ rồi cho người mua mở — không gọi tới cổng từ server (tránh SSRF),
 * không giữ khóa API của ai.
 */
import { AppError } from "./deps.js";

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

export function validateGatewayTemplate(template: string): string {
  const t = template.trim();
  if (t.length > 500) throw new AppError("Địa chỉ cổng quá dài");
  if (!t.includes("{url}")) throw new AppError("Địa chỉ cổng phải có {url} (chỗ ClickDeal chèn link sản phẩm)");
  const sample = buildGatewayUrl(t, { url: "https://shopee.vn/product/1/2", sub: "CTEST", click: "00000000-0000-0000-0000-000000000000" }, false);
  let u: URL;
  try {
    u = new URL(sample);
  } catch {
    throw new AppError("Địa chỉ cổng không hợp lệ");
  }
  if (u.protocol !== "https:") throw new AppError("Cổng phải dùng https://");
  if (PRIVATE_HOST.test(u.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || !u.hostname.includes(".")) {
    throw new AppError("Cổng phải là tên miền công khai");
  }
  if (u.username || u.password) throw new AppError("Địa chỉ cổng không được chứa tài khoản/mật khẩu");
  // {url} phải nằm trong phần tham số, không được thay host
  const hostPart = t.split("/").slice(0, 3).join("/");
  if (/[{}]/.test(hostPart)) throw new AppError("Không được đặt {url}/{sub} trong tên miền");
  return t;
}

export function buildGatewayUrl(template: string, v: { url: string; sub: string; click: string }, validate = true): string {
  const out = template
    .replace(/\{url\}/g, encodeURIComponent(v.url))
    .replace(/\{sub\}/g, encodeURIComponent(v.sub))
    .replace(/\{click\}/g, encodeURIComponent(v.click));
  if (validate && !/^https:\/\//i.test(out)) throw new AppError("Cổng của affiliate không hợp lệ", 502);
  return out;
}
