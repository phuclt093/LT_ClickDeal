/* Trang quản lý cho affiliate. Phiên đăng nhập bằng cookie httpOnly (JS không đọc được). */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var sections = ["loading", "auth", "mfa", "dash"];
  function show(id) { sections.forEach(function (s) { $(s).hidden = s !== id; }); }

  function api(method, path, body) {
    var headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(path, { method: method, headers: headers, credentials: "same-origin", body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.error || "Lỗi kết nối"); e.status = r.status; throw e; }
          return j;
        });
      });
  }
  function msg(id, text, ok) { $(id).className = "msg " + (ok ? "ok" : "err"); $(id).textContent = text; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function vnd(n) { return Math.round(n || 0).toLocaleString("vi-VN") + "₫"; }
  function when(s) { return new Date(s).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }); }

  // ---------- Tab đăng nhập / đăng ký ----------
  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.toggle("active", x === t); });
      $("loginForm").hidden = t.dataset.tab !== "login";
      $("registerForm").hidden = t.dataset.tab !== "register";
    });
  });

  $("loginForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var b = { email: $("lEmail").value.trim(), password: $("lPass").value };
    if ($("lTotp").value.trim()) b.totp = $("lTotp").value.trim();
    api("POST", "/v1/auth/login", b).then(boot).catch(function (e) {
      msg("loginMsg", e.message);
      if (/2FA/.test(e.message)) $("lTotp").focus();
    });
  });

  $("registerForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    api("POST", "/v1/auth/register", {
      email: $("rEmail").value.trim(),
      password: $("rPass").value,
      displayName: $("rName").value.trim(),
      code: $("rCode").value.trim().toUpperCase()
    }).then(boot).catch(function (e) { msg("registerMsg", e.message); });
  });

  $("logoutBtn").addEventListener("click", function () {
    api("POST", "/v1/auth/logout", {}).finally(function () { location.reload(); });
  });

  // ---------- 2FA ----------
  function startMfa() {
    show("mfa");
    api("POST", "/v1/auth/2fa/setup", {}).then(function (r) {
      $("qrImg").src = r.qr;
      $("secretBox").textContent = "Mã bí mật: " + r.secret;
    }).catch(function (e) { msg("mfaMsg", e.message); });
  }
  $("mfaForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    api("POST", "/v1/auth/2fa/enable", { code: $("mfaCode").value.trim() }).then(boot).catch(function (e) { msg("mfaMsg", e.message); });
  });

  // ---------- Bảng điều khiển ----------
  function loadDash() {
    show("dash");
    api("GET", "/v1/aff/me").then(function (me) {
      $("who").textContent = me.displayName + " · " + me.code;
      $("pendingNote").hidden = me.status === "active";
      $("inviteBox").textContent = me.inviteUrl;
      $("rateInput").value = me.defaultCashbackRate;
      if (me.gatewayTemplate) {
        $("gwInput").value = me.gatewayTemplate;
        $("gwStatus").textContent = "✓ Đã khai báo cổng. Khách bấm mua sẽ đi qua cổng này.";
        $("gwStatus").className = "small msg ok";
      } else {
        $("gwStatus").textContent = "Chưa có cổng: khách chưa tạo được link. Làm bước này trước.";
        $("gwStatus").className = "small msg err";
      }
    });
    loadCustomers();
    loadLinks();
  }

  $("copyInvite").addEventListener("click", function () {
    navigator.clipboard.writeText($("inviteBox").textContent).then(function () { $("copyInvite").textContent = "Đã copy ✓"; });
  });

  $("gwForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    api("PUT", "/v1/aff/gateway", { template: $("gwInput").value.trim() }).then(function (r) {
      msg("gwMsg", "✓ Đã lưu cổng", true);
      $("gwTestLink").href = r.example;
      $("gwTest").hidden = false;
      $("gwStatus").textContent = "✓ Đã khai báo cổng. Khách bấm mua sẽ đi qua cổng này.";
      $("gwStatus").className = "small msg ok";
    }).catch(function (e) { msg("gwMsg", e.message); });
  });

  $("rateForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    api("PUT", "/v1/aff/settings", { defaultCashbackRate: Number($("rateInput").value) })
      .then(function () { msg("rateMsg", "✓ Đã lưu", true); })
      .catch(function (e) { msg("rateMsg", e.message); });
  });

  function loadCustomers() {
    api("GET", "/v1/aff/customers").then(function (list) {
      var body = $("custBody");
      body.textContent = "";
      $("custCount").textContent = list.length ? "· " + list.length : "";
      $("custEmpty").hidden = list.length > 0;
      list.forEach(function (c) {
        var tr = el("tr");
        tr.appendChild(el("td", "", (c.nickname || "(đã xóa)") + (c.removed ? " · đã rời" : "")));
        tr.appendChild(el("td", "", c.contact || "—"));
        tr.appendChild(el("td", "", c.refCode));
        tr.appendChild(el("td", "num", String(c.clicks)));
        tr.appendChild(el("td", "num", vnd(c.paid)));
        var td = el("td");
        var form = el("form", "pay");
        var inp = el("input");
        inp.type = "number"; inp.min = "1"; inp.placeholder = "Số tiền"; inp.required = true;
        var btn = el("button", "btn small", "Ghi nhận đã trả");
        btn.type = "submit";
        form.appendChild(inp); form.appendChild(btn);
        form.addEventListener("submit", function (ev) {
          ev.preventDefault();
          btn.disabled = true;
          api("POST", "/v1/aff/payouts", { customerId: c.id, amount: Number(inp.value) })
            .then(loadCustomers)
            .catch(function (e) { btn.disabled = false; alertRow(td, e.message); });
        });
        td.appendChild(form);
        tr.appendChild(td);
        body.appendChild(tr);
      });
    });
  }
  function alertRow(td, text) { var m = el("div", "msg err", text); td.appendChild(m); }

  function loadLinks() {
    api("GET", "/v1/aff/links").then(function (list) {
      var ul = $("linkList");
      ul.textContent = "";
      $("linkEmpty").hidden = list.length > 0;
      list.slice(0, 50).forEach(function (l) {
        var li = el("li");
        var t = el("div", "t");
        var a = el("a", "", l.productName || "Sản phẩm Shopee #" + String(l.productUrl).split("/").pop());
        a.href = l.productUrl; a.target = "_blank"; a.rel = "noopener";
        var b = el("b"); b.appendChild(a);
        t.appendChild(b);
        t.appendChild(el("span", "", when(l.at) + " · " + (l.customer || "?") + " (" + l.refCode + ") · " + l.source));
        li.appendChild(t);
        ul.appendChild(li);
      });
    });
  }

  // ---------- Khởi động: xem đang ở trạng thái nào ----------
  function boot() {
    api("GET", "/v1/auth/me").then(function (me) {
      $("logoutBtn").hidden = false;
      $("who").textContent = me.email;
      if (!me.totpEnabled) return startMfa();
      if (!me.mfaPassed) { show("auth"); return msg("loginMsg", "Đăng nhập lại kèm mã 2FA"); }
      if (!me.isAffiliate) { show("auth"); return msg("loginMsg", "Tài khoản này không phải affiliate"); }
      loadDash();
    }).catch(function () { show("auth"); });
  }
  boot();
})();
