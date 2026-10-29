# ClickDeal Platform — Server

API + PWA điện thoại cho nền tảng hoàn tiền nhiều affiliate. Cách kết nối ưu tiên là **cổng nhận link** trên trang của chính affiliate (xem `../gateway`), nên ClickDeal không cần giữ khóa API và không cần AccessTrade/Shopee duyệt. Gọi API bằng khóa của affiliate chỉ là chế độ dự phòng (`linkMode: "api"`); người mua dùng tiện ích, PWA hoặc Phím tắt iPhone để mở sản phẩm qua link hoàn tiền. ClickDeal **không giữ tiền**: affiliate tự trả cho khách, hệ thống chỉ ghi nhận và đối soát.

## Chạy thử trên máy (không cần cài Postgres)

```bash
cd platform/server
npm install
npm test                 # 18 test toàn luồng: Postgres thật (PGlite) + AccessTrade giả lập
npx tsx scripts/demo-server.ts   # server mẫu ở http://localhost:8080, có sẵn dữ liệu đủ các trạng thái
```

Demo: người mua `0901234567` / `matkhau123`; affiliate `phuc@example.com` / `mat-khau-rat-dai-123` (mã 2FA: nhập secret in ra màn hình vào app xác thực).

## Luồng sử dụng (bản 0.2)

```
/            Trang đăng nhập chung: chọn vai trò Người mua hoặc Affiliate
/j/<mã>      Link mời: người mua tạo tài khoản bằng số điện thoại, thấy chỉ số uy tín của affiliate
/app/        Người mua: mở link hoàn tiền · báo đơn kèm ảnh · trao đổi/khiếu nại · tài khoản ngân hàng
/aff/        Affiliate: việc cần làm · duyệt đơn · trả tiền bằng VietQR · khách · cài đặt
/terms       Điều khoản sử dụng & miễn trừ trách nhiệm
```

1. Khách mở sản phẩm qua ClickDeal → đặt hàng trên Shopee → **Báo đơn** (mã đơn, ảnh chụp đơn).
2. Affiliate đối chiếu trên AccessTrade → **Ghi nhận** (nhập hoa hồng, tiền hoàn tự tính theo %) hoặc **Từ chối** (ghi lý do).
3. Sau số ngày cài đặt (mặc định 14), ClickDeal **nhắc affiliate tự kiểm tra**; quá 6 tuần thì cảnh báo đỏ. Có nút "Nhắc lại sau 7 ngày".
4. Affiliate **trả tiền**: chọn đơn, quét mã VietQR (tạo ngay trên server, không gửi số tài khoản ra ngoài), đính kèm biên lai.
5. Khách bấm **Đã nhận tiền**; không phản hồi sau 7 ngày thì đơn tự hoàn tất.
6. Có vấn đề: một trong hai bên **khiếu nại** và trao đổi kèm ảnh. ClickDeal **không phân xử**; mọi tin nhắn, ảnh, trạng thái được lưu chỉ-ghi-thêm (DB không cấp quyền sửa/xóa) để cung cấp trung thực khi cơ quan chức năng yêu cầu.

Đồng bộ đơn AccessTrade giờ là **tùy chọn** ("Tự đối chiếu", tắt mặc định): bật lên thì khi duyệt đơn thấy gợi ý đơn có khớp mã không, hoa hồng bao nhiêu.

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
| `POST /v1/auth/register-buyer` | Người mua tạo tài khoản bằng mã mời + số điện thoại |
| `POST /v1/auth/login` | Đăng nhập chung (`login` = email hoặc số điện thoại, `role` = buyer/affiliate) |
| `POST /v1/ext/links` | Tạo link hoàn tiền (nhận cả đoạn chữ app Shopee chia sẻ) |
| `GET/POST /v1/ext/claims`, `/v1/ext/claims/:id/messages`, `/actions` | Báo đơn, trao đổi, hủy / đã nhận tiền / khiếu nại |
| `PUT /v1/ext/bank`, `POST /v1/ext/extension-key` | Tài khoản nhận tiền (mã hóa); mã kết nối cho tiện ích |
| `GET /v1/aff/overview`, `/v1/aff/claims`, `POST /v1/aff/claims/:id/actions` | Việc cần làm, duyệt/từ chối/hoãn nhắc/đóng khiếu nại |
| `GET /v1/aff/payables`, `POST /v1/aff/payouts/qr`, `POST /v1/aff/payouts` | Cần trả theo khách, mã VietQR, ghi nhận đã trả kèm biên lai |
| `GET /v1/files/:id` | Ảnh bằng chứng (chỉ người mua chủ đơn và affiliate của họ) |

## Còn thiếu (các bước tiếp theo)

- Tiện ích trình duyệt: thêm chế độ gọi API ClickDeal (dán mã kết nối, server đã hỗ trợ).
- Quên mật khẩu (cần SMS hoặc email); thông báo đẩy/Telegram khi có đơn mới hoặc đến hạn trả.
- Điều khoản (`public/terms.html`) nên nhờ luật sư xem lại trước khi cho khách thật dùng.
- Kết nối Shopee Open API: code đã có nhưng **chưa kiểm chứng**, cần đối chiếu tài liệu chính thức khi Shopee cấp quyền.
- KMS, thu phí thuê bao, Redis/BullMQ khi chạy nhiều worker.
- Chưa build thử Docker image trong môi trường này.
