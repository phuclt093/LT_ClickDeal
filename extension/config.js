/*
 * Cấu hình các trang hoàn tiền (provider).
 * Muốn thêm trang khác: thêm 1 mục vào CD_PROVIDERS, thêm domain vào manifest.json
 * (host_permissions + content_scripts thứ 2), không cần sửa code lõi.
 *
 * Trường có thể dùng:
 *   homeUrl          trang mở ra để tạo link; "{username}" sẽ được thay bằng username trong cài đặt
 *   needsUsername    trang cần username người nhận tiền
 *   usernameSelector ô username (tự điền từ cài đặt)
 *   platformSelector phần tử cần bấm để chọn sàn Shopee (radio…)
 *   inputSelector    ô dán link (biết chính xác) — hoặc inputSelectors: danh sách để dò
 *   submitSelector   nút tạo link (biết chính xác) — hoặc submitText: regex chữ trên nút
 *   resultSelector   ô chứa link kết quả (biết chính xác) — nếu không có sẽ tự dò link mới xuất hiện
 *   errorSelector    chỗ trang hiện thông báo lỗi
 */
var CD_PROVIDERS = {
  // Nền tảng ClickDeal của người giới thiệu: gọi thẳng API bằng mã kết nối, không cần mở trang khác
  clickdeal: {
    id: "clickdeal",
    name: "ClickDeal (người giới thiệu)",
    api: true,
    recommended: true,
    blurb: "Kết nối tài khoản ClickDeal của bạn. Bấm nút là có link hoàn tiền ngay (1–2 giây), không mở trang khác. Báo đơn và nhận tiền từ người giới thiệu.",
    signupTips: [
      "Mở <b>link mời</b> người giới thiệu gửi cho bạn (dạng https://…/j/MÃ) và tạo tài khoản bằng <b>số điện thoại</b>.",
      "Trong ClickDeal, vào tab <b>Tài khoản</b> → mục <b>Tiện ích trên máy tính</b> → bấm <b>Tạo mã kết nối</b> → <b>Copy</b>.",
      "Thêm luôn <b>tài khoản ngân hàng</b> trong tab Tài khoản để người giới thiệu chuyển tiền hoàn cho bạn."
    ],
    resultTimeoutMs: 20000
  },
  tietkiem360: {
    id: "tietkiem360",
    name: "TietKiem360",
    homeUrl: "https://tietkiem360.site/{username}",
    walletUrl: "https://tietkiem360.site/Home/Login",
    signupUrl: "https://tietkiem360.site/Home/SignUp",
    loginUrl: "https://tietkiem360.site/Home/Login",
    blurb: "Chỉ cần username là tạo được link, không cần đăng nhập mỗi lần. Tiền về MoMo/ngân hàng bạn khai khi đăng ký.",
    signupTips: [
      "<b>Tên đăng nhập</b>: chính là <b>username</b> bạn sẽ nhập vào tiện ích ở bước 3. Nên dùng chữ thường, không dấu, dễ nhớ.",
      "<b>Email</b> và <b>mật khẩu</b>: để đăng nhập xem đơn hàng và rút tiền.",
      "<b>Số điện thoại MoMo</b>, <b>ngân hàng</b>, <b>số tài khoản</b>: nơi nhận tiền hoàn. Ghi đúng tên chủ tài khoản.",
      "<b>Mã giới thiệu</b>: không bắt buộc{referral}."
    ],
    host: "tietkiem360.site",
    needsUsername: true,
    loginPath: /^\/home\/login/i,
    usernameSelector: "#username",
    platformSelector: "input[name='platform'][value='shopee']",
    inputSelector: "#urlbase",
    submitSelector: "#btnLuu",
    resultSelector: "#urlaff",
    errorSelector: "#err",
    resultTimeoutMs: 25000
  },
  hoantien: {
    id: "hoantien",
    name: "HoanTien.com",
    homeUrl: "https://hoantien.com/",
    walletUrl: "https://hoantien.com/dashboard",
    signupUrl: "https://hoantien.com/register",
    loginUrl: "https://hoantien.com/login",
    blurb: "Cần đăng nhập hoantien.com trên trình duyệt này, tiền vào ví của tài khoản đang đăng nhập.",
    signupTips: [
      "Đăng ký tài khoản rồi <b>đăng nhập ngay trên trình duyệt này</b> (Chrome/Firefox mà bạn cài tiện ích).",
      "Không đăng xuất: tiện ích dùng phiên đăng nhập đó để tiền về đúng ví của bạn."
    ],
    host: "hoantien.com",
    needsUsername: false,
    loginPath: /^\/(login|register)/i,
    inputSelectors: [
      "input[name*='link' i]",
      "input[name*='url' i]",
      "input[placeholder*='link' i]",
      "input[placeholder*='shopee' i]",
      "textarea[placeholder*='link' i]",
      "input[type='url']",
      "form input[type='text']",
      "textarea"
    ],
    submitText: /hoàn tiền|nhận link|lấy link|tạo link|get link|chuyển đổi|convert/i,
    // Đường dẫn của trang KHÔNG phải link kết quả (menu, trang tĩnh...)
    ignorePaths: /^\/($|login|register|logout|dashboard|ranking|blog|page\/|change-language|password|profile|faq|contact|lien-he|huong-dan)/i,
    resultTimeoutMs: 25000
  }
};

var CD_DEFAULT_SETTINGS = {
  provider: "clickdeal",
  username: "", // username nhận tiền của NGƯỜI DÙNG (tự nhập ở trang hướng dẫn)
  serverUrl: "", // ClickDeal: địa chỉ server, vd https://abc.trycloudflare.com
  connectKey: "", // ClickDeal: mã kết nối "cdk_…" tạo trong ứng dụng ClickDeal
  autoOpen: true // lấy được link xong thì tự mở link hoàn tiền để mua
};

var CD_KEY_RE = /^cdk_[A-Za-z0-9_-]{20,80}$/;

/** Địa chỉ gốc của server ClickDeal (chỉ https, hoặc http://localhost khi chạy thử). */
function cdOrigin(url) {
  try {
    var u = new URL(String(url || "").trim());
    if (u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return u.origin;
  } catch (e) { /* không hợp lệ */ }
  return "";
}

/**
 * Tách "chuỗi kết nối" ứng dụng ClickDeal đưa cho (vd https://abc.trycloudflare.com/#key=cdk_…).
 * Chấp nhận cả khi chỉ dán mã cdk_… hoặc chỉ dán địa chỉ.
 */
function cdParseConnect(text) {
  var s = String(text || "").trim();
  var key = (s.match(/cdk_[A-Za-z0-9_-]{20,80}/) || [])[0] || "";
  var url = (s.match(/https?:\/\/[^\s#"'<>]+/i) || [])[0] || "";
  return { serverUrl: cdOrigin(url), connectKey: key };
}

// Mã giới thiệu gợi ý khi người dùng đăng ký tài khoản mới (để trống "" nếu không muốn hiện)
var CD_REFERRAL_CODE = "phuclt093";

var CD_USERNAME_RE = /^[A-Za-z0-9_.@-]{3,50}$/;

// Đã thiết lập đủ để dùng chưa?
function cdIsSetupDone(settings) {
  var p = CD_PROVIDERS[settings.provider];
  if (!p) return false;
  if (p.api) return !!cdOrigin(settings.serverUrl) && CD_KEY_RE.test(settings.connectKey || "");
  if (p.needsUsername) return CD_USERNAME_RE.test(settings.username || "");
  return !!settings.providerConfirmed;
}

function cdProviderUrl(provider, settings) {
  if (provider.api) return cdOrigin(settings && settings.serverUrl) + "/app/";
  return provider.homeUrl.replace("{username}", encodeURIComponent((settings && settings.username) || ""));
}

// Nhận diện link affiliate Shopee
var CD_SHOPEE_SHORT = /^https?:\/\/(s\.shopee\.vn|shope\.ee|shp\.ee|vn\.shp\.ee|[a-z0-9-]+\.shp\.ee)\//i;
var CD_AFF_PARAMS = /[?&](utm_source|utm_medium|utm_campaign|af_siteid|af_sub_siteid|mmp_pid|smtt|uls_trackid|sub_id|aff_sub)=/i;

function cdShopeeProductIds(url) {
  try {
    var u = new URL(url);
    var m = u.pathname.match(/-i\.(\d+)\.(\d+)/) || u.pathname.match(/^\/product\/(\d+)\/(\d+)/);
    return m ? { shopId: m[1], itemId: m[2] } : null;
  } catch (e) {
    return null;
  }
}
