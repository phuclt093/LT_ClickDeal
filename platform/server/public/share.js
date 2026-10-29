/* Nhận link chia sẻ từ app Shopee (Android: PWA share target, iPhone: Phím tắt) → mở lại qua link hoàn tiền. */
(function () {
  "use strict";
  var $ = CD.$;
  function extractUrl(text) {
    var m = String(text || "").match(/https?:\/\/[^\s"'<>]+/i);
    return m ? m[0].replace(/[).,;!?]+$/, "") : null;
  }
  var q = new URLSearchParams(location.search);
  var raw = q.get("url") || extractUrl(q.get("text")) || extractUrl(q.get("title"));
  var source = q.get("src") === "shortcut" ? "shortcut" : "pwa";
  if (raw && !/^https?:\/\//i.test(raw)) raw = extractUrl(raw);

  function fail(msg) {
    $("working").hidden = true;
    $("failed").hidden = false;
    $("failMsg").textContent = msg;
    if (raw && /^https:\/\/([a-z0-9-]+\.)*(shopee\.vn|shope\.ee|shp\.ee)\//i.test(raw)) {
      $("plainLink").href = raw;
      $("plainLink").hidden = false;
    }
  }
  function go() {
    $("working").hidden = false;
    $("failed").hidden = true;
    // chưa đăng nhập: CD.api tự chuyển sang trang đăng nhập rồi quay lại đây
    CD.api("POST", "/v1/ext/links", { url: raw, source: source })
      .then(function (r) { location.replace(r.affLink); })
      .catch(function (e) { if (e.status !== 401) fail(e.message); });
  }
  $("retryBtn").addEventListener("click", go);
  if (!raw) fail("Không thấy link sản phẩm trong nội dung được chia sẻ.");
  else go();
})();
