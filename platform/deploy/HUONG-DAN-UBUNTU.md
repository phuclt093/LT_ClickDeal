# Chạy thử ClickDeal trên máy Ubuntu ở nhà

Cài xong bạn sẽ có một địa chỉ `https://….trycloudflare.com` để mở trên điện thoại và máy tính. Máy nhà **không cần mở port modem**, IP nhà không bị lộ: Cloudflare Tunnel chỉ kết nối từ máy ra ngoài.

```
Điện thoại / máy tính ──https──▶ Cloudflare ◀──tunnel (máy kết nối ra)── Ubuntu ở nhà: API + Postgres (Docker)
                                    │
                                    └─ Cổng nhận link (Cloudflare Worker, chứa khóa AccessTrade của bạn)
```

## Bước 0: đưa code lên GitHub (làm trên máy Windows)

Repo `phuclt093/LT_ClickDeal` nên để **Private**. Code không chứa bí mật, vì file `.env` đã nằm trong `.gitignore`. Mở PowerShell:

```powershell
cd E:\Phuc\Projects\LT_ClickDeal
git add .
git commit -m "ClickDeal platform: server, PWA, cổng nhận link, bộ cài Ubuntu"
git push
```

## Bước 1: lấy code về máy Ubuntu

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/phuclt093/LT_ClickDeal.git
cd LT_ClickDeal
```

Repo Private thì Git sẽ hỏi đăng nhập. Dùng **Personal Access Token** của GitHub thay cho mật khẩu (GitHub → Settings → Developer settings → Fine-grained tokens, chỉ cấp quyền đọc repo này).

## Bước 2: cài đặt (1 lệnh)

```bash
bash platform/deploy/install.sh
```

Script tự làm:
1. Cài Docker.
2. Tạo file bí mật `platform/server/.env`: mật khẩu cơ sở dữ liệu và khóa mã hóa, đều sinh ngẫu nhiên.
3. Chạy Postgres, API và worker.
4. Cài Cloudflare Tunnel thành dịch vụ tự chạy khi bật máy.
5. Đặt lịch sao lưu cơ sở dữ liệu lúc 3 giờ sáng mỗi ngày.

Cuối cùng script in ra địa chỉ, ví dụ `https://abc-xyz.trycloudflare.com`.

> **Sao lưu ngay file `platform/server/.env`** sang chỗ an toàn (USB, trình quản lý mật khẩu). Mất `MASTER_KEY` trong file này là mất toàn bộ dữ liệu đã mã hóa.

## Bước 3: tạo tài khoản affiliate

1. Mở `https://<địa-chỉ>/` → chọn **Affiliate** → **Tạo tài khoản**.
2. Bật 2FA: quét mã QR bằng Google Authenticator hoặc Microsoft Authenticator.
3. Vào tab **Cài đặt** → **Cổng nhận link**, dán địa chỉ cổng Cloudflare Worker của bạn (xem `platform/gateway/README.md`). Bước này cần tài khoản publisher AccessTrade.
4. Tab **Khách** → copy **link mời**, gửi cho chính bạn qua Zalo để thử vai người mua.

## Bước 4: thử vai người mua trên điện thoại

1. Mở link mời trên điện thoại → nhập tên, số điện thoại, mật khẩu → **Tạo tài khoản người mua**. Vào **Tài khoản** thêm ngân hàng nhận tiền.
   - **Android (Chrome):** cài ClickDeal lên màn hình chính khi được hỏi, hoặc vào menu ⋮ → "Thêm vào Màn hình chính".
   - **iPhone:** mở link mời bằng **Safari**, rồi làm theo hướng dẫn Phím tắt hiện trên trang chủ ClickDeal.
2. Mở app Shopee → chọn sản phẩm → **Chia sẻ** → **ClickDeal**. Shopee sẽ mở lại sản phẩm qua link hoàn tiền.
3. Đặt thử một đơn nhỏ → trong ClickDeal vào **Đơn của tôi** → **Báo đơn** (mã đơn Shopee + ảnh chụp).
4. Đăng nhập vai trò affiliate → **Việc cần làm** thấy đơn mới → đối chiếu trên AccessTrade (đơn có `utm_content` bằng mã khách) → **Ghi nhận** → tab **Trả tiền** quét VietQR.

## Lệnh hay dùng

```bash
cd ~/LT_ClickDeal
platform/deploy/tunnel-url.sh                                   # xem địa chỉ hiện tại
sudo docker compose --project-directory platform/server logs -f api   # xem log API
sudo docker compose --project-directory platform/server restart       # khởi động lại
sudo systemctl restart clickdeal-tunnel                         # đổi địa chỉ tunnel mới
git pull && bash platform/deploy/install.sh                     # cập nhật code mới
sudo platform/deploy/backup.sh                                  # sao lưu ngay
```

## Lưu ý quan trọng

- **Địa chỉ `trycloudflare.com` đổi mỗi khi máy hoặc tunnel khởi động lại.** Link mời cũ sẽ hết hiệu lực, và PWA đã cài trên điện thoại phải tham gia lại. Chỉ dùng để thử. Khi cho khách thật dùng, mua tên miền (vài trăm nghìn đồng/năm) rồi chuyển sang tunnel có tên cố định, mình sẽ hướng dẫn.
- Bật cập nhật bảo mật tự động cho Ubuntu: `sudo apt-get install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades`.
- Không cần và **không nên** mở port 8080 trên modem: API chỉ nghe trong máy (`127.0.0.1`).
- `AUTO_APPROVE_AFFILIATES=true` trong `.env` để tự duyệt affiliate khi thử. Khi chạy thật, đổi thành `false` và duyệt bằng tài khoản admin.
- Máy nhà tắt hoặc mất mạng thì PWA và trang quản lý ngừng. Cổng nhận link trên Cloudflare vẫn chạy.
