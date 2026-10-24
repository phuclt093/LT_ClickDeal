# Cổng nhận link ClickDeal (dành cho affiliate)

Cổng nhận link là một địa chỉ **trên tài khoản của chính bạn**. ClickDeal gửi link sản phẩm Shopee vào đó, cổng tạo link affiliate bằng khóa AccessTrade **của bạn** rồi chuyển người mua sang Shopee.

- **ClickDeal không giữ và không bao giờ thấy khóa API của bạn.** Khóa nằm trên Cloudflare hoặc hosting của bạn.
- Bạn tự dùng API của chính mình, không phải cấp quyền cho bên thứ ba.
- AccessTrade lỗi thì người mua vẫn mở được sản phẩm (chỉ là đơn đó không hoàn tiền), không bị kẹt ở trang lỗi.

Địa chỉ khai báo trong ClickDeal có dạng:

```
https://<cổng-của-bạn>/go?url={url}&sub={sub}&click={click}
```

`{url}` = link sản phẩm, `{sub}` = mã khách (đơn hàng trên AccessTrade sẽ có `utm_content` bằng mã này để bạn biết đơn của khách nào), `{click}` = mã lần bấm.

Nếu trang get link sẵn có của bạn đã nhận được link qua tham số trên địa chỉ (vd `?link=`), bạn chỉ cần khai báo địa chỉ đó với `{url}`, không phải cài gì thêm.

---

## Cách A: Cloudflare Worker (miễn phí, khoảng 10 phút, không cần hosting)

1. Đăng ký hoặc đăng nhập [dash.cloudflare.com](https://dash.cloudflare.com).
2. Vào **Workers & Pages** → **Create** → **Create Worker** → đặt tên, ví dụ `clickdeal-gateway` → **Deploy**.
3. Bấm **Edit code**, xóa code mẫu, dán toàn bộ nội dung file `worker.js` → **Deploy**.
4. Vào **Settings** → **Variables and Secrets** → **Add**:
   - `AT_ACCESS_KEY`: chọn loại **Secret**, dán khóa API AccessTrade (lấy trong tài khoản publisher AccessTrade).
   - `AT_CAMPAIGN_ID`: mã campaign Shopee trên AccessTrade.
5. Mở `https://clickdeal-gateway.<tên-bạn>.workers.dev/`: thấy chữ `ClickDeal gateway OK` là được.
6. Thử: `https://clickdeal-gateway.<tên-bạn>.workers.dev/go?url=https://shopee.vn/product/301412525/28780427085&sub=THU`. Phải chuyển sang Shopee qua link affiliate của bạn.
7. Trong ClickDeal, khai báo cổng: `https://clickdeal-gateway.<tên-bạn>.workers.dev/go?url={url}&sub={sub}&click={click}`

Có tên miền riêng thì gắn vào Worker ở **Settings → Domains & Routes** cho đẹp và đáng tin hơn.

## Cách B: PHP (affiliate đã có hosting hoặc WordPress)

1. Tải `go.php` lên hosting, ví dụ vào thư mục `clickdeal/`.
2. Cài biến môi trường `AT_ACCESS_KEY` và `AT_CAMPAIGN_ID` trong cPanel hoặc hosting. Nếu hosting không có chỗ cài, điền thẳng vào 2 dòng đầu file.
3. Thử: `https://trang-cua-ban.vn/clickdeal/go.php?url=https://shopee.vn/product/301412525/28780427085&sub=THU`
4. Khai báo trong ClickDeal: `https://trang-cua-ban.vn/clickdeal/go.php?url={url}&sub={sub}&click={click}`

Yêu cầu: PHP 7.4 trở lên, có cURL, chạy được HTTPS.

## Bảo mật

- Cổng chỉ nhận link Shopee, link rút gọn được kiểm tra từng bước chuyển hướng, nên không thể bị lợi dụng để mở trang khác.
- Không ghi log khóa API; mã khách và mã lần bấm chỉ được nhận chữ, số, `_` và `-`.
- Đổi khóa AccessTrade: chỉ cần sửa biến `AT_ACCESS_KEY`, không phải báo ClickDeal.
