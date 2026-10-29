/* Trang đăng nhập chung: người mua / affiliate. Mở bằng / hoặc link mời /j/<mã>. */
(function () {
  "use strict";
  var $ = CD.$;
  var role = "buyer";
  var mode = "login";
  var inviteCode = null;

  var m = location.pathname.match(/^\/j\/([^/]+)/);
  if (m) inviteCode = decodeURIComponent(m[1]).toUpperCase();

  function nextUrl(r) {
    var n = new URLSearchParams(location.search).get("next");
    var ok = n && /^\/(?!\/)/.test(n) && !/^\/(j\/|\?|$)/.test(n);
    if (r === "buyer") return ok && !/^\/aff\//.test(n) ? n : "/app/";
    return ok && /^\/aff\//.test(n) ? n : "/aff/";
  }

  function show(ids) {
    ["loading", "auth", "mfa", "already"].forEach(function (id) { $(id).hidden = ids.indexOf(id) < 0; });
  }

  function render() {
    document.querySelectorAll("[data-role]").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-role") === role); });
    document.querySelectorAll("[data-mode]").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-mode") === mode); });
    $("loginForm").hidden = mode !== "login";
    $("regBuyer").hidden = !(mode === "register" && role === "buyer");
    $("regAff").hidden = !(mode === "register" && role === "affiliate");
    $("loginLabel").textContent = role === "buyer" ? "Số điện thoại" : "Email";
    $("lLogin").type = role === "buyer" ? "tel" : "email";
    $("lLogin").placeholder = role === "buyer" ? "09xx xxx xxx" : "ban@email.com";
    $("totpField").hidden = role !== "affiliate";
    $("forgotHint").textContent =
      role === "buyer" ? "Quên mật khẩu? Liên hệ người đã mời bạn để được hỗ trợ." : "Affiliate đăng nhập cần mã 6 số từ ứng dụng xác thực.";
    $("loginMsg").textContent = "";
  }
  document.querySelectorAll("[data-role]").forEach(function (b) {
    b.addEventListener("click", function () { role = b.getAttribute("data-role"); render(); });
  });
  document.querySelectorAll("[data-mode]").forEach(function (b) {
    b.addEventListener("click", function () { mode = b.getAttribute("data-mode"); render(); });
  });

  function busy(form, on) { form.querySelectorAll("button[type=submit]").forEach(function (b) { b.disabled = on; }); }

  $("loginForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var f = ev.target;
    var body = { login: $("lLogin").value.trim(), password: $("lPass").value, role: role };
    if (role === "affiliate" && $("lTotp").value.trim()) body.totp = $("lTotp").value.trim();
    busy(f, true);
    CD.api("POST", "/v1/auth/login", body)
      .then(function (r) { afterAuth(r.role); })
      .catch(function (e) {
        CD.msg($("loginMsg"), e.message);
        if (/2FA/.test(e.message)) $("lTotp").focus();
        if (/vai trò Affiliate/.test(e.message)) { role = "affiliate"; render(); CD.msg($("loginMsg"), e.message); }
        if (/vai trò Người mua/.test(e.message)) { role = "buyer"; render(); CD.msg($("loginMsg"), e.message); }
      })
      .finally(function () { busy(f, false); });
  });

  $("regBuyer").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var f = ev.target;
    busy(f, true);
    CD.api("POST", "/v1/auth/register-buyer", {
      inviteCode: (inviteCode || $("bInvite").value).trim().toUpperCase(),
      name: $("bName").value.trim(),
      phone: $("bPhone").value.trim(),
      password: $("bPass").value,
      acceptTerms: $("bTerms").checked
    })
      .then(function () { location.replace("/app/?welcome=1"); })
      .catch(function (e) { CD.msg($("bMsg"), e.message); })
      .finally(function () { busy(f, false); });
  });

  $("regAff").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var f = ev.target;
    busy(f, true);
    CD.api("POST", "/v1/auth/register", {
      displayName: $("aName").value.trim(),
      code: $("aCode").value.trim().toUpperCase(),
      email: $("aEmail").value.trim(),
      password: $("aPass").value,
      acceptTerms: $("aTerms").checked
    })
      .then(function () { startMfa(); })
      .catch(function (e) { CD.msg($("aMsg"), e.message); })
      .finally(function () { busy(f, false); });
  });

  function startMfa() {
    show(["mfa"]);
    CD.api("POST", "/v1/auth/2fa/setup", {}).then(function (r) {
      $("qrImg").src = r.qr;
      $("secretBox").textContent = "Mã bí mật: " + r.secret;
    }).catch(function (e) { CD.msg($("mfaMsg"), e.message); });
  }
  $("mfaForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    CD.api("POST", "/v1/auth/2fa/enable", { code: $("mfaCode").value.trim() })
      .then(function () { location.replace(nextUrl("affiliate")); })
      .catch(function (e) { CD.msg($("mfaMsg"), e.message); });
  });

  function afterAuth(r) {
    if (r === "buyer") return location.replace(nextUrl("buyer"));
    CD.api("GET", "/v1/auth/me").then(function (me) {
      if (!me.totpEnabled) return startMfa();
      location.replace(nextUrl("affiliate"));
    });
  }

  $("alreadyOut").addEventListener("click", function () {
    CD.api("POST", "/v1/auth/logout", {}).finally(function () { location.reload(); });
  });

  function loadInvite() {
    if (!inviteCode) return Promise.resolve(null);
    $("inviteField").hidden = true;
    return CD.api("GET", "/v1/public/affiliates/" + encodeURIComponent(inviteCode)).then(
      function (a) {
        $("invAv").textContent = (a.displayName || "?").trim().charAt(0).toUpperCase();
        $("invName").textContent = a.displayName;
        $("invName2").textContent = a.displayName;
        $("invRate").textContent = a.cashbackRate + "%";
        $("repPaid").textContent = String(a.stats.paidOrders);
        $("repDays").textContent = a.stats.avgDaysToPay === null ? "—" : String(a.stats.avgDaysToPay);
        $("repDispute").textContent = a.stats.disputeRate + "%";
        $("inviter").hidden = false;
        return a;
      },
      function (e) {
        inviteCode = null;
        $("inviteField").hidden = false;
        $("badInviteMsg").textContent = e.message + ". Bạn vẫn có thể nhập mã mời khác bên dưới.";
        $("badInvite").hidden = false;
        return null;
      }
    );
  }

  // Server có affiliate mặc định → mã mời không bắt buộc
  CD.api("GET", "/v1/public/signup-info").then(function (r) {
    if (!r.defaultAffiliate) return;
    $("inviteLabel").textContent = "Mã mời (không bắt buộc)";
    $("inviteHint").textContent = "Để trống: bạn nhận hoàn tiền qua " + r.defaultAffiliate.displayName + ".";
  }).catch(function () {});

  // Khởi động: đã đăng nhập thì chuyển thẳng vào ứng dụng
  CD.api("GET", "/v1/auth/me").then(
    function (me) {
      if (me.role === "buyer") {
        if (inviteCode) {
          loadInvite();
          $("alreadyMsg").textContent = "Bạn đang đăng nhập tài khoản người mua " + (me.name || me.phone) + ". Mỗi tài khoản đi theo 1 người giới thiệu. Muốn tham gia qua link này, hãy đăng xuất rồi tạo tài khoản bằng số điện thoại khác.";
          $("alreadyGo").href = "/app/";
          return show(["already"]);
        }
        return location.replace(nextUrl("buyer"));
      }
      if (!me.totpEnabled) return startMfa();
      if (me.mfaPassed) return location.replace(nextUrl("affiliate"));
      role = "affiliate";
      render();
      show(["auth"]);
    },
    function () {
      loadInvite().then(function (a) {
        if (a) mode = "register";
        render();
        show(["auth"]);
        if (a) $("bName").focus();
      });
    }
  );
})();
