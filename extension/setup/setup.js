(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var settings = Object.assign({}, CD_DEFAULT_SETTINGS);
  var hasPerm = false;

  function provider() { return CD_PROVIDERS[settings.provider] || CD_PROVIDERS[CD_DEFAULT_SETTINGS.provider]; }

  // Các trang tiện ích cần quyền (lấy từ manifest)
  var ORIGINS = chrome.runtime.getManifest().host_permissions || [];

  async function save(patch) {
    Object.assign(settings, patch);
    var r = await chrome.storage.local.get("cd_settings");
    await chrome.storage.local.set({ cd_settings: Object.assign({}, r.cd_settings || {}, patch) });
    render();
  }

  // ---------- Bước 1: chọn trang ----------
  function renderProviders() {
    var box = $("providers");
    box.textContent = "";
    Object.keys(CD_PROVIDERS).forEach(function (k) {
      var p = CD_PROVIDERS[k];
      var lab = document.createElement("label");
      lab.className = "prov";
      var input = document.createElement("input");
      input.type = "radio";
      input.name = "prov";
      input.value = k;
      input.checked = settings.provider === k;
      input.addEventListener("change", function () { save({ provider: k }); });
      var b = document.createElement("b");
      b.textContent = p.name;
      if (p.recommended) {
        var badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "Khuyên dùng";
        b.appendChild(badge);
      }
      var d = document.createElement("span");
      d.className = "desc";
      d.textContent = p.blurb || "";
      lab.append(input, b, d);
      box.appendChild(lab);
    });
  }

  // ---------- Bước 2: tài khoản ----------
  function renderAccount() {
    var p = provider();
    document.querySelectorAll(".pname").forEach(function (el) { el.textContent = p.name; });
    $("signupBtn").href = p.signupUrl || p.homeUrl.replace("{username}", "");
    $("signupBtn").textContent = "Mở trang đăng ký " + p.name;
    $("loginBtn").href = p.loginUrl || p.walletUrl;
    var tips = $("tips");
    tips.textContent = "";
    (p.signupTips || []).forEach(function (t) {
      var li = document.createElement("li");
      // tip trong config.js chỉ dùng thẻ <b>…</b> → dựng DOM thay vì innerHTML
      var text = t.replace("{referral}", CD_REFERRAL_CODE ? ", có thể nhập mã bên dưới" : "");
      text.split(/(<b>[\s\S]*?<\/b>)/).forEach(function (part) {
        var m = part.match(/^<b>([\s\S]*)<\/b>$/);
        if (m) {
          var b = document.createElement("b");
          b.textContent = m[1];
          li.appendChild(b);
        } else if (part) {
          li.appendChild(document.createTextNode(part));
        }
      });
      tips.appendChild(li);
    });
    var showRef = !!CD_REFERRAL_CODE && p.id === "tietkiem360";
    $("referral").hidden = !showRef;
    $("refCode").textContent = CD_REFERRAL_CODE;
    $("confirmRow").hidden = p.needsUsername;
    $("confirmLogin").checked = !!settings.providerConfirmed;
  }

  // ---------- Bước 3: username ----------
  function renderUsername() {
    var p = provider();
    $("step3").classList.toggle("is-hidden", !p.needsUsername);
    if (document.activeElement !== $("username")) $("username").value = settings.username || "";
  }

  // ---------- Bước 4: quyền ----------
  async function checkPerm() {
    try {
      hasPerm = await chrome.permissions.contains({ origins: ORIGINS });
    } catch (e) {
      hasPerm = true; // trình duyệt không hỗ trợ kiểm tra → coi như đã có
    }
    render();
  }

  function renderPerm() {
    $("permBtn").hidden = hasPerm;
    $("permMsg").textContent = hasPerm ? "✓ Đã có quyền, không cần làm gì thêm." : "";
    $("permMsg").className = "msg" + (hasPerm ? " ok" : "");
  }

  // ---------- Tổng ----------
  function render() {
    var p = provider();
    renderAccount();
    renderUsername();
    renderPerm();

    var userOk = !p.needsUsername || CD_USERNAME_RE.test(settings.username || "");
    var accountOk = p.needsUsername ? userOk : !!settings.providerConfirmed;
    $("step1").classList.add("is-done");
    $("step2").classList.toggle("is-done", accountOk);
    $("step3").classList.toggle("is-done", userOk && p.needsUsername);
    $("step4").classList.toggle("is-done", hasPerm);

    // đánh số lại khi bước 3 bị ẩn
    var n = 1;
    document.querySelectorAll(".step").forEach(function (s) {
      if (!s.classList.contains("is-hidden")) s.querySelector(".num").textContent = n++;
    });

    var done = cdIsSetupDone(settings) && hasPerm;
    $("allDone").hidden = !done;
    $("needSetup").hidden = done || !/reason=need-setup/.test(location.search);
  }

  // ---------- Sự kiện ----------
  $("userForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var v = $("username").value.trim();
    var msg = $("userMsg");
    if (!CD_USERNAME_RE.test(v)) {
      msg.className = "msg err";
      msg.textContent = "Username không hợp lệ: cần ít nhất 3 ký tự, chỉ gồm chữ không dấu, số và các ký tự _ . - @";
      return;
    }
    save({ username: v }).then(function () {
      msg.className = "msg ok";
      msg.textContent = "✓ Đã lưu. Tiền hoàn sẽ về tài khoản \"" + v + "\".";
    });
  });

  $("confirmLogin").addEventListener("change", function () {
    save({ providerConfirmed: $("confirmLogin").checked });
  });

  $("copyRef").addEventListener("click", function () {
    navigator.clipboard.writeText(CD_REFERRAL_CODE).then(function () {
      $("copyRef").textContent = "Đã copy ✓";
      setTimeout(function () { $("copyRef").textContent = "Copy"; }, 1200);
    });
  });

  $("permBtn").addEventListener("click", function () {
    // phải gọi ngay trong sự kiện click (không await trước) thì trình duyệt mới cho hỏi quyền
    chrome.permissions.request({ origins: ORIGINS }).then(function (ok) {
      hasPerm = !!ok;
      if (!ok) {
        $("permMsg").className = "msg err";
        $("permMsg").textContent = "Bạn chưa đồng ý cấp quyền. Bấm lại và chọn Cho phép (Allow).";
      }
      render();
    }).catch(function (e) {
      $("permMsg").className = "msg err";
      $("permMsg").textContent = "Không xin được quyền: " + e.message;
    });
  });

  chrome.storage.onChanged.addListener(function (ch, area) {
    if (area === "local" && ch.cd_settings) {
      settings = Object.assign({}, CD_DEFAULT_SETTINGS, ch.cd_settings.newValue || {});
      render();
    }
  });

  chrome.storage.local.get("cd_settings").then(function (r) {
    settings = Object.assign({}, CD_DEFAULT_SETTINGS, r.cd_settings || {});
    if (!CD_PROVIDERS[settings.provider]) settings.provider = CD_DEFAULT_SETTINGS.provider;
    renderProviders();
    render();
    checkPerm();
  });
})();
