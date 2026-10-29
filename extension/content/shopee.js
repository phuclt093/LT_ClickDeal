/*
 * Chạy trên shopee.vn: chèn nút "Mua qua hoàn tiền" khi đang xem trang sản phẩm.
 *  - Ưu tiên đặt NGAY CẠNH nút "Mua Ngay" (cùng chiều cao).
 *  - Nếu không tìm thấy nút "Mua Ngay" (Shopee đổi giao diện) → hiện nút nổi ở góc phải dưới.
 * Shopee là SPA (đổi trang không tải lại, React vẽ lại liên tục) nên kiểm tra định kỳ.
 */
(function () {
  "use strict";
  var INLINE_ID = "cd-inline-btn";
  var FLOAT_ID = "cd-shopee-btn";
  var lastUrl = "";
  var floatClosedFor = ""; // URL mà người dùng đã bấm × ẩn nút nổi
  var busy = false;

  function cleanProductUrl() {
    // Bỏ query (có thể chứa tham số affiliate của người khác), giữ đường dẫn sản phẩm
    return location.origin + location.pathname;
  }

  function cameFromAffiliate() {
    return CD_AFF_PARAMS.test(location.search) ||
      /hoantien\.com|tietkiem360\.site|shp\.ee|shope\.ee|s\.shopee\.vn|trycloudflare\.com|isclix\.com|workers\.dev/i.test(document.referrer);
  }

  function readJsonLdProduct() {
    var nodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < nodes.length; i++) {
      try {
        var data = JSON.parse(nodes[i].textContent);
        var list = Array.isArray(data) ? data : [data];
        for (var j = 0; j < list.length; j++) {
          if (list[j] && /product/i.test(list[j]["@type"])) return list[j];
        }
      } catch (e) { /* bỏ qua */ }
    }
    return null;
  }

  function meta(prop) {
    var el = document.querySelector('meta[property="' + prop + '"], meta[name="' + prop + '"]');
    return el ? el.getAttribute("content") : "";
  }

  function findPriceText() {
    // Shopee dùng class bị mã hoá → tìm phần tử lá có dạng "₫123.000" hoặc "123.000₫"
    var els = document.querySelectorAll("main div, main span, div, span");
    for (var i = 0; i < els.length && i < 5000; i++) {
      var el = els[i];
      if (el.children.length) continue;
      var t = (el.textContent || "").trim();
      if (/^₫\s?[\d.,]+(\s?-\s?₫\s?[\d.,]+)?$/.test(t) || /^[\d.,]+\s?₫$/.test(t)) return t;
    }
    return "";
  }

  function collectProduct() {
    var ids = cdShopeeProductIds(location.href) || {};
    var ld = readJsonLdProduct();
    var name = (ld && ld.name) || "";
    if (!name) {
      var h1 = document.querySelector("h1");
      name = (h1 && h1.textContent.trim()) || document.title.replace(/\s*\|\s*Shopee.*$/i, "").trim();
    }
    var image = (ld && (Array.isArray(ld.image) ? ld.image[0] : ld.image)) || meta("og:image") || "";
    var price = "";
    if (ld && ld.offers) {
      var o = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
      var p = o.price || o.lowPrice;
      if (p) price = "₫" + Number(p).toLocaleString("vi-VN");
    }
    if (!price) price = findPriceText();
    return {
      shop: "shopee",
      shopId: ids.shopId || "",
      itemId: ids.itemId || "",
      name: name,
      image: image,
      price: price,
      productUrl: cleanProductUrl()
    };
  }

  // ---------- Nút ----------
  function label(btn) {
    if (busy) {
      btn.textContent = "Đang chuyển…";
    } else if (cameFromAffiliate()) {
      btn.classList.add("cd-btn--ok");
      btn.textContent = "✓ Đã qua link hoàn tiền";
      btn.title = "Trang này được mở từ link hoàn tiền, bạn có thể bấm Mua Ngay. Bấm nút này để tạo lại link.";
    } else {
      btn.classList.remove("cd-btn--ok");
      btn.textContent = "Mua qua hoàn tiền";
      btn.title = "Gửi sản phẩm này sang trang hoàn tiền để nhận hoa hồng";
    }
  }

  function onClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (busy) return;
    busy = true;
    refreshLabels();
    chrome.runtime.sendMessage({ type: "CD_START", product: collectProduct() }, function (res) {
      busy = false;
      refreshLabels();
      if (chrome.runtime.lastError || !res || !res.ok) {
        var err = (res && res.error) || "Không tạo được link";
        document.querySelectorAll(".cd-btn").forEach(function (b) { b.textContent = "⚠ Lỗi, thử lại"; b.title = err; });
        toast(err);
      } else if (res.setup) {
        document.querySelectorAll(".cd-btn").forEach(function (b) { b.textContent = "Cần thiết lập trước ↗"; });
        setTimeout(refreshLabels, 4000);
      }
    });
  }

  // Thông báo nhỏ ở góc màn hình (dùng khi tạo link lỗi)
  function toast(text) {
    var old = document.getElementById("cd-toast");
    if (old) old.remove();
    var t = document.createElement("div");
    t.id = "cd-toast";
    t.className = "cd-toast";
    t.textContent = "ClickDeal: " + text;
    document.documentElement.appendChild(t);
    setTimeout(function () { t.remove(); }, 8000);
  }

  function makeButton() {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cd-btn";
    btn.addEventListener("click", onClick, true);
    label(btn);
    return btn;
  }

  function refreshLabels() {
    document.querySelectorAll(".cd-btn").forEach(label);
  }

  function findBuyNow() {
    var cands = document.querySelectorAll("button, a, div[role=button]");
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (el.closest("#" + INLINE_ID + ", #" + FLOAT_ID)) continue;
      var t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      if (/^mua ngay$/i.test(t)) {
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return el;
      }
    }
    return null;
  }

  function ensureInline() {
    var existing = document.getElementById(INLINE_ID);
    var buy = findBuyNow();
    if (!buy) {
      if (existing) existing.remove();
      return false;
    }
    if (existing && existing.previousElementSibling === buy) return true; // đang đúng chỗ
    if (existing) existing.remove();

    var wrap = document.createElement("span");
    wrap.id = INLINE_ID;
    var btn = makeButton();
    var h = buy.getBoundingClientRect().height;
    if (h >= 28) btn.style.height = Math.round(h) + "px";
    wrap.appendChild(btn);
    buy.insertAdjacentElement("afterend", wrap);
    return true;
  }

  function removeFloat() {
    var f = document.getElementById(FLOAT_ID);
    if (f) f.remove();
  }

  function ensureFloat() {
    if (floatClosedFor === location.href) return;
    if (document.getElementById(FLOAT_ID)) return;
    var wrap = document.createElement("div");
    wrap.id = FLOAT_ID;
    wrap.className = "cd-float";
    wrap.appendChild(makeButton());
    var close = document.createElement("button");
    close.type = "button";
    close.className = "cd-close";
    close.textContent = "×";
    close.title = "Ẩn nút trên trang này";
    close.addEventListener("click", function () {
      floatClosedFor = location.href;
      removeFloat();
    });
    wrap.appendChild(close);
    document.documentElement.appendChild(wrap);
  }

  function tick() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      var old = document.getElementById(INLINE_ID);
      if (old) old.remove();
      removeFloat();
    }
    if (!cdShopeeProductIds(location.href)) {
      removeFloat();
      var i = document.getElementById(INLINE_ID);
      if (i) i.remove();
      return;
    }
    if (ensureInline()) removeFloat();
    else ensureFloat();
  }

  tick();
  setInterval(tick, 700);
})();
