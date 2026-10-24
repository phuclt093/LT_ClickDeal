# ClickDeal Platform — Server

API + PWA điện thoại cho nền tảng hoàn tiền nhiều affiliate. Cách kết nối ưu tiên là **cổng nhận link** trên trang của chính affiliate (xem `../gateway`), nên ClickDeal không cần giữ khóa API và không cần AccessTrade/Shopee duyệt. Gọi API bằng khóa của affiliate chỉ là chế độ dự phòng (`linkMode: "api"`); người mua dùng tiện ích, PWA hoặc Phím tắt iPhone để mở sản phẩm qua link hoàn tiền. ClickDeal **không giữ tiền**: affiliate tự trả cho khách, hệ thống chỉ ghi nhận và đối soát.

## Chạy thử trên máy (không cần cài Postgres)

```bash
cd platform/server
npm install
npm test                 # 13 test toàn luồng: Postgres thật (PGlite) + AccessTrade giả lập
npx tsx scripts/demo-server.ts   # server mẫu ở http://localhost:8080 với affiliate "PHUC"
```

Mở `http://localhost:8080/j/PHUC` để thử luồng tham gia của người mua.

## Chạy trên máy Ubuntu ở nhà (khuyên dùng để thử)

Xem [`../deploy/HUONG-DAN-UBUNTU.md`](../deploy/HUONG-DAN-UBUNTU.md): một lệnh `bash platform/deploy/install.sh` cài Docker, cơ sở dữ liệu, API, Cloudflare Tunnel (HTTPS, không mở port modem) và sao lưu hằng ngày.

Trang quản lý cho affiliate: `/aff/`.

## Triển khai (VPS hoặc dịch vụ container)

1. `cp .env.example .env`, rồi điền:
   - `MASTER_KEY`: chạy `openssl rand -base64 32`. **Giữ bí mật, mất khóa này là mất toàn bộ khóa API đã lưu.**
   - `POSTGRES_PASSWORD`, `DATABASE_URL`, `PUBLIC_BASE_URL` (tên miền thật, bắt buộc HTTPS).
2. `docker compose up -d --build`: chạy Postgres, API và worker đồng bộ đơn.
3. Tạo admin: `docker compose exec api sh -c 'ADMIN_EMAIL=ban@email.com ADMIN_PASSWORD=... node dist/create-admin.js'`, sau đó đăng nhập và bật 2FA ngay.
4. Đặt HTTPS phía trước (Caddy, Nginx hoặc Cloudflare).

Khi lên production thật: chuyển `MASTER_KEY` sang KMS (viết `KmsKeyProvider` thay cho `LocalKeyProvider` trong `src/security/crypto.ts`), bật sao lưu Postgres tự động, giám sát lỗi.

## Bảo mật đã có

| Mục | Cách làm | File |
| --- | --- | --- |
| Khóa API của affiliate | Envelope encryption AES-256-GCM, AAD gắn với (affiliate, mạng); API không bao giờ trả lại khóa | `src/security/crypto.ts`, `src/services/credentials.ts` |
| Tách dữ liệu affiliate | Row Level Security của Postgres + app chạy bằng role không phải chủ bảng | `migrations/001_init.sql`, `src/db/db.ts` |
| Đăng nhập affiliate/admin | Argon2id, **bắt buộc 2FA (TOTP)**, khóa 15 phút sau 5 lần sai, cookie httpOnly + Secure + SameSite=Strict | `src/routes/auth.ts` |
| Token người mua | Ngẫu nhiên 32 byte, DB chỉ lưu SHA-256; khách tự xóa dữ liệu được | `src/routes/ext.ts` |
| Link người dùng gửi | Chỉ nhận link Shopee; link rút gọn mở theo redirect thủ công, kiểm tra host từng bước (chống SSRF) | `src/services/shopee-url.ts` |
| Web | CSP chặt (không script inline), HSTS, chống CSRF (Origin + JSON), giới hạn tần suất, ẩn bí mật khỏi log | `src/app.ts` |
| Nhật ký thao tác | Chỉ ghi thêm, ứng dụng không sửa/xóa được | `migrations/001_init.sql` |

## API chính

| API | Dùng để |
| --- | --- |
| `POST /v1/auth/register`, `/login`, `/2fa/setup`, `/2fa/enable` | Affiliate đăng ký, đăng nhập, bật 2FA |
| `PUT /v1/aff/gateway` | **Ưu tiên:** khai báo cổng nhận link, vd `https://.../go?url={url}&sub={sub}` |
| `PUT /v1/aff/credentials` | Dự phòng: lưu và kiểm tra khóa AccessTrade / Shopee |
| `GET /v1/aff/me`, `/customers`, `/orders` | Thông tin, link mời, khách, đơn, số tiền cần trả |
| `POST /v1/aff/payouts`, `PUT /v1/aff/settings`, `POST /v1/aff/sync` | Ghi nhận đã trả, tỉ lệ hoàn, đồng bộ đơn ngay |
| `POST /v1/ext/join` | Người mua tham gia bằng mã mời → nhận token |
| `POST /v1/ext/links` | Tạo link hoàn tiền (nhận cả đoạn chữ app Shopee chia sẻ) |
| `GET /v1/ext/history`, `DELETE /v1/ext/me` | Lịch sử, tiền hoàn; tự xóa dữ liệu |
| `/j/<mã>`, `/share`, `/` | PWA: link mời, nhận chia sẻ từ app Shopee, trang chủ |

## Còn thiếu (các bước tiếp theo)

- Tiện ích trình duyệt: thêm chế độ gọi API ClickDeal (dán mã kết nối).
- Kết nối Shopee Open API: code đã có nhưng **chưa kiểm chứng**, cần đối chiếu tài liệu chính thức khi Shopee cấp quyền.
- KMS, thu phí thuê bao, Redis/BullMQ khi chạy nhiều worker.
- Chưa build thử Docker image trong môi trường này.
