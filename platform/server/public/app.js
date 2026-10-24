/* ClickDeal PWA — một file cho cả 3 trang (home, join, share). Không dùng thư viện ngoài. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var KEY = "cd_token";
  var AFF = "cd_aff";

  function store(k, v) {
    try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* chế độ riêng tư */ }
  }
  function load(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function token() { return load(KEY); }

  function api(method, path, body) {
    var headers = { Accept: "application/json" };
    var t = token();
    if (t) headers.Authorization = "Bearer " + t;
    if (body) headers["Content-Type"] = "application/json";
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: "omit" })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) {
            var err = new Error(j.error || "Lỗi kết nối, thử lại");
            err.status = r.status;
            throw err;
          }
          return j;
        });
      });
  }

  function vnd(n) { return Math.round(n || 0).toLocaleString("vi-VN") + "₫"; }
  function fmtDate(s) {
    if (!s) return "";
    return new Date(s).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function extractUrl(text) {
    var m = String(text || "").match(/https?:\/\/[^\s"'<>]+/i);
    return m ? m[0].replace(/[).,;!?]+$/, "") : null;
  }
  function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  }

  // ---------------- Trang tham gia /j/<mã> ----------------
  function pageJoin() {
    var code = decodeURIComponent(location.pathname.split("/")[2] || "").toUpperCase();
    var show = function (id) { ["loading", "bad", "form", "already"].forEach(function (x) { $(x).hidden = x !== id; }); };
    if (!/^[A-Z0-9]{3,20}$/.test(code)) return show("bad");

    var current = null;
    try { current = JSON.parse(load(AFF) || "null"); } catch (e) { current = null; }

    api("GET", "/v1/public/affiliates/" + code).then(function (a) {
      if (token() && current && current.code === a.code) {
        $("alreadyMsg").textContent = "Bạn đang nhận hoàn tiền qua " + a.displayName + ".";
        return show("already");
      }
      $("affName").textContent = a.displayName;
      $("affName2").textContent = a.displayName;
      $("affNameShort").textContent = a.displayName;
      $("affRate").textContent = a.cashbackRate + "%";
      if (token() && current) {
        $("joinMsg").className = "msg err";
        $("joinMsg").textContent = "Bạn đang tham gia qua " + current.displayName + ". Tham gia ở đây sẽ chuyển sang " + a.displayName + ".";
      }
      show("form");
      $("joinForm").addEventListener("submit", function (ev) {
        ev.preventDefault();
        var btn = ev.target.querySelector("button");
        btn.disabled = true;
        api("POST", "/v1/ext/join", {
          affiliateCode: code,
          nickname: $("nickname").value.trim(),
          contact: $("contact").value.trim() || undefined
        }).then(function (r) {
          store(KEY, r.token);
          store(AFF, JSON.stringify(r.affiliate));
          location.replace("/?welcome=1");
        }).catch(function (e) {
          btn.disabled = false;
          $("joinMsg").className = "msg err";
          $("joinMsg").textContent = e.message;
        });
      });
    }).catch(function (e) {
      $("badMsg").textContent = e.message;
      show("bad");
    });
  }

  // ---------------- Trang nhận link chia sẻ /share ----------------
  function pageShare() {
    var q = new URLSearchParams(location.search);
    var raw = q.get("url") || extractUrl(q.get("text")) || extractUrl(q.get("title"));
    var source = q.get("src") === "shortcut" ? "shortcut" : "pwa";
    // Phím tắt iPhone có thể gửi cả đoạn chữ vào ?url=
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
    if (!token()) {
      return fail("Bạn chưa tham gia ClickDeal. Hãy mở link mời của người giới thiệu trước.");
    }
    if (!raw) return fail("Không thấy link sản phẩm trong nội dung được chia sẻ.");

    function go() {
      $("working").hidden = false;
      $("failed").hidden = true;
      api("POST", "/v1/ext/links", { url: raw, source: source })
        .then(function (r) { location.replace(r.affLink); })
        .catch(function (e) {
          if (e.status === 401) { store(KEY, null); store(AFF, null); }
          fail(e.message);
        });
    }
    $("retryBtn").addEventListener("click", go);
    go();
  }

  // ---------------- Trang chủ ----------------
  function pageHome() {
    if (!token()) {
      $("notJoined").hidden = false;
      $("codeForm").addEventListener("submit", function (ev) {
        ev.preventDefault();
        var c = $("codeInput").value.trim().toUpperCase();
        if (c) location.href = "/j/" + encodeURIComponent(c);
      });
      return;
    }
    $("joined").hidden = false;

    var aff = null;
    try { aff = JSON.parse(load(AFF) || "null"); } catch (e) { aff = null; }
    api("GET", "/v1/ext/me").then(function (me) {
      $("who").textContent = (me.nickname || "") + " · qua " + me.affiliate.displayName;
      store(AFF, JSON.stringify(me.affiliate));
    }).catch(function (e) {
      if (e.status === 401) { store(KEY, null); store(AFF, null); location.reload(); }
    });

    function loadHistory() {
      api("GET", "/v1/ext/history").then(function (h) {
        $("tPending").textContent = vnd(h.totals.pending);
        $("tOwed").textContent = vnd(h.totals.owed);
        $("tPaid").textContent = vnd(h.totals.paid);
        $("rateLine").textContent = "Bạn được hoàn " + h.cashbackRate + "% hoa hồng của mỗi đơn. Tiền được duyệt sau khi đơn giao thành công.";
        var ul = $("orders");
        ul.textContent = "";
        h.orders.forEach(function (o) {
          var li = el("li");
          var t = el("div", "t");
          t.appendChild(el("b", "", "Đơn " + o.orderId + " · " + vnd(o.billing)));
          t.appendChild(el("span", "", fmtDate(o.salesTime) + " · hoàn " + vnd(o.cashback)));
          var label = { pending: "Chờ duyệt", approved: "Đã duyệt", rejected: "Bị hủy" }[o.status] || o.status;
          li.appendChild(t);
          li.appendChild(el("span", "badge " + o.status, label));
          ul.appendChild(li);
        });
        $("ordersEmpty").hidden = h.orders.length > 0;
        var ll = $("links");
        ll.textContent = "";
        h.links.slice(0, 15).forEach(function (l) {
          var li = el("li");
          var img = el("img");
          img.alt = "";
          if (l.image) img.src = l.image;
          var t = el("div", "t");
          var a = el("a", "", l.product_name || "Sản phẩm Shopee #" + (String(l.product_url).split("/").pop() || ""));
          a.href = l.aff_link;
          a.rel = "noopener";
          var b = el("b");
          b.appendChild(a);
          t.appendChild(b);
          t.appendChild(el("span", "", fmtDate(l.created_at) + (l.price ? " · " + l.price : "")));
          li.appendChild(img);
          li.appendChild(t);
          ll.appendChild(li);
        });
        $("linksEmpty").hidden = h.links.length > 0;
      }).catch(function () {});
    }
    loadHistory();

    $("pasteForm").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var url = extractUrl($("pasteInput").value) || $("pasteInput").value.trim();
      $("pasteMsg").className = "msg";
      $("pasteMsg").textContent = "Đang tạo link…";
      api("POST", "/v1/ext/links", { url: url, source: "web" })
        .then(function (r) { location.href = r.affLink; })
        .catch(function (e) { $("pasteMsg").className = "msg err"; $("pasteMsg").textContent = e.message; });
    });

    // Hướng dẫn cài theo thiết bị
    var standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (isIOS()) {
      $("androidGuide").hidden = true;
      $("iosGuide").hidden = false;
      $("shortcutUrl").textContent = location.origin + "/share?src=shortcut&url=";
      $("copyShortcut").addEventListener("click", function () {
        navigator.clipboard.writeText(location.origin + "/share?src=shortcut&url=").then(function () {
          $("copyShortcut").textContent = "Đã copy ✓";
        });
      });
    } else if (standalone) {
      $("installBtn").hidden = true;
      $("installHint").textContent = "✓ ClickDeal đã được cài. Chia sẻ sản phẩm từ app Shopee và chọn ClickDeal.";
    }
    var deferred = null;
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferred = e;
      $("installBtn").hidden = false;
    });
    $("installBtn").addEventListener("click", function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.finally(function () { deferred = null; $("installBtn").hidden = true; });
    });

    $("showToken").addEventListener("click", function () {
      $("tokenBox").textContent = token();
      $("tokenBox").hidden = false;
    });
    var armed = false;
    $("leaveBtn").addEventListener("click", function () {
      if (!armed) {
        armed = true;
        $("leaveBtn").textContent = "Bấm lần nữa để xác nhận xóa";
        return;
      }
      api("DELETE", "/v1/ext/me").finally(function () {
        store(KEY, null);
        store(AFF, null);
        location.replace("/");
      });
    });
  }

  var page = document.body.getAttribute("data-page");
  if (page === "join") pageJoin();
  else if (page === "share") pageShare();
  else pageHome();
})();
