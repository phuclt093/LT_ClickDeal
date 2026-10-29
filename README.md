# LT_ClickDeal

Tiện ích Chrome/Firefox: thêm nút **💰 Mua qua hoàn tiền** ngay cạnh nút "Mua Ngay" trên trang sản phẩm Shopee.

## Chế độ ClickDeal (khuyên dùng, từ bản 0.3)

Kết nối thẳng với nền tảng ClickDeal của người giới thiệu (`platform/`):

1. Người mua mở link mời, tạo tài khoản ClickDeal, vào **Tài khoản → Tiện ích trên máy tính → Tạo mã kết nối**, copy chuỗi dạng `https://…/#key=cdk_…`.
2. Trong tiện ích: trang **Thiết lập** → chọn **ClickDeal** → dán chuỗi vào bước 3 → **Kết nối** (trình duyệt hỏi quyền truy cập đúng địa chỉ đó).
3. Trên Shopee bấm nút: tiện ích gọi API ClickDeal, có link hoàn tiền trong 1–2 giây và mở lại sản phẩm ngay trong tab, không mở trang khác.
4. Đặt hàng xong: bấm icon tiện ích → **📝 Báo đơn** ở sản phẩm vừa mua → ứng dụng ClickDeal mở sẵn form báo đơn cho đúng sản phẩm.

Địa chỉ `trycloudflare.com` đổi thì chỉ cần sửa ô **Địa chỉ ClickDeal** trong popup rồi bấm **Lưu & kiểm tra**; mã kết nối giữ nguyên.

Hai chế độ cũ (TietKiem360, HoanTien.com: tự điền form trên trang hoàn tiền) vẫn giữ nguyên như bên dưới.
Bấm một lần là tiện ích tự đẩy link sang trang hoàn tiền (mặc định **TietKiem360** với username của bạn, hoặc **hoantien.com**),
lấy link hoàn tiền, lưu lịch sử mua và mở link đó để bạn mua như bình thường.

## Cách hoạt động

1. Mở sản phẩm trên `shopee.vn` → cạnh nút **Mua Ngay** có nút xanh **💰 Mua qua hoàn tiền**
   (nếu Shopee đổi giao diện không tìm thấy nút Mua Ngay thì nút hiện nổi ở góc phải dưới).
2. Bấm nút → tiện ích lấy tên, giá, ảnh, link sản phẩm (đã bỏ tham số theo dõi lạ) và mở trang hoàn tiền ở tab mới.
3. Tiện ích tự chọn sàn Shopee, điền username, dán link, bấm "Tạo link" và chờ link mua.
4. Link được lưu vào lịch sử, rồi tab tự chuyển sang link hoàn tiền để mua.
5. Bấm icon tiện ích để xem **lịch sử**: món đồ, giá, thời gian, link Shopee gốc, link hoàn tiền, ví hoàn tiền. Có **Xuất CSV** (mở bằng Excel).

Nếu chưa đăng nhập hoantien.com, tiện ích nhắc bạn đăng nhập và tự làm tiếp sau đó.
Nếu không tự lấy được link, tiện ích copy sẵn link Shopee để bạn dán tay. Nó vẫn chờ 3 phút để bắt link kết quả.
Bạn cũng có thể dán link hoàn tiền thủ công vào mục đó trong lịch sử.

## Thiết lập lần đầu (trang hướng dẫn)

Cài xong, tiện ích tự mở trang **Thiết lập ClickDeal** để hướng dẫn người dùng từng bước:
1. Chọn trang hoàn tiền (TietKiem360 được khuyên dùng).
2. Tạo tài khoản: có nút mở trang đăng ký, giải thích từng ô cần điền, kèm mã giới thiệu (`CD_REFERRAL_CODE` trong `config.js`, để `""` nếu không muốn hiện).
3. Nhập **username nhận tiền**: không có giá trị mặc định, mỗi người dùng nhập username của chính họ.
4. Cấp quyền truy cập Shopee và trang hoàn tiền (bấm 1 nút, dùng được cả Firefox).
5. Cách mua để không bị mất hoàn tiền, kèm phần câu hỏi thường gặp.

Nếu người dùng bấm nút mua khi chưa thiết lập xong, tiện ích mở lại trang này thay vì tạo link.
Muốn mở lại trang: bấm icon ClickDeal rồi bấm **Hướng dẫn**.

## Cài đặt (chế độ nhà phát triển)

1. Mở Chrome, vào `chrome://extensions`.
2. Bật **Developer mode** (góc phải trên).
3. Bấm **Load unpacked** và chọn thư mục `extension` trong repo này.
4. Ghim icon ClickDeal lên thanh công cụ.

Sửa code xong thì bấm nút ↻ (Reload) của tiện ích trong `chrome://extensions`.

### Firefox (bản 128 trở lên)

1. Mở `about:debugging#/runtime/this-firefox`.
2. Bấm **Load Temporary Add-on…** và chọn file `extension/manifest.json`.
3. Trang hướng dẫn tự mở ra. Ở bước 4, bấm **Cấp quyền** rồi chọn **Allow**. Firefox không tự cấp quyền truy cập trang cho tiện ích.
   Nếu trang hướng dẫn không tự mở: bấm icon ClickDeal rồi bấm **Hướng dẫn**.
4. Tiện ích kiểu "Temporary" sẽ mất khi tắt Firefox. Muốn cài lâu dài thì đóng gói và ký qua addons.mozilla.org (có thể chọn "Unlisted" để chỉ mình dùng).

## Cấu trúc

```
extension/
  manifest.json        Khai báo tiện ích (Manifest V3)
  config.js            Cấu hình trang hoàn tiền (selector ô nhập, nút, đường dẫn bỏ qua…)
  background.js        Điều phối job giữa tab Shopee ↔ tab hoàn tiền, lưu nhật ký
  content/shopee.js    Chèn nút trên Shopee, đọc thông tin sản phẩm
  content/provider.js  Tự điền form trên trang hoàn tiền, dò link kết quả
  content/ui.css       Giao diện nút và banner chèn vào trang
  popup/               Màn hình lịch sử + cài đặt nhanh
  setup/               Trang hướng dẫn thiết lập lần đầu
  icons/
```

## Thêm trang hoàn tiền khác

1. Thêm một mục vào `CD_PROVIDERS` trong `config.js`.
2. Thêm domain đó vào `host_permissions` và `matches` của content script thứ 2 trong `manifest.json`.
3. Trang đó sẽ tự xuất hiện trong ô chọn "Trang hoàn tiền" của tiện ích.

Nếu biết chính xác id của các ô (như TietKiem360: `#urlbase`, `#btnLuu`, `#urlaff`) thì khai báo `inputSelector`, `submitSelector`, `resultSelector`. Cách này chạy ổn định nhất.

## Lưu ý

- Dữ liệu lịch sử chỉ lưu trên máy (chrome.storage.local), chưa đồng bộ server.
- Giao diện Shopee và hoantien.com có thể thay đổi. Nếu nút không tự điền được, chỉnh selector trong `config.js`.
- Hãy đọc điều khoản của trang hoàn tiền và của Shopee Affiliate trước khi phát hành rộng.
