(function () {
  "use strict";
  var LOGS = "cd_logs";
  var STATUS = { ready: "Đã có link", pending: "Đang xử lý", manual: "Cần dán tay" };

  var $list = document.getElementById("list");
  var $tpl = document.getElementById("row");
  var $count = document.getElementById("count");
  var $auto = document.getElementById("autoOpen");

  function fmtTime(ts) {
    return new Date(ts).toLocaleString("vi-VN", {
      hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric"
    });
  }

  async function getLogs() {
    var r = await chrome.storage.local.get(LOGS);
    return r[LOGS] || [];
  }

  async function saveLogs(logs) {
    await chrome.storage.local.set({ [LOGS]: logs });
  }

  function render(logs) {
    $count.textContent = logs.length ? "· " + logs.length + " lượt" : "";
    $list.textContent = "";
    if (!logs.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.innerHTML = "Chưa có lượt mua nào.<br>Mở một sản phẩm trên Shopee và bấm nút <b>🛒 Mua qua hoàn tiền</b>.";
      $list.appendChild(e);
      return;
    }
    logs.forEach(function (l) {
      var n = $tpl.content.firstElementChild.cloneNode(true);
      var p = l.product || {};
      var img = n.querySelector(".thumb");
      img.addEventListener("error", function () { img.style.visibility = "hidden"; });
      if (p.image) img.src = p.image; else img.style.visibility = "hidden";
      var name = n.querySelector(".name");
      name.textContent = p.name || p.productUrl || "(không rõ tên)";
      name.href = p.productUrl || "#";
      name.title = "Mở trang Shopee gốc";
      n.querySelector(".price").textContent = p.price || "";
      n.querySelector(".time").textContent = fmtTime(l.createdAt);
      var st = n.querySelector(".status");
      st.textContent = STATUS[l.status] || l.status;
      st.classList.add(l.status);

      var aff = n.querySelector(".aff");
      var copy = n.querySelector(".copy");
      if (l.affiliateUrl) {
        aff.href = l.affiliateUrl;
        aff.title = l.affiliateUrl;
        copy.addEventListener("click", function () {
          navigator.clipboard.writeText(l.affiliateUrl);
          copy.textContent = "Đã copy ✓";
          setTimeout(function () { copy.textContent = "Copy link"; }, 1200);
        });
      } else {
        aff.hidden = true;
        copy.hidden = true;
      }
      var wallet = n.querySelector(".wallet");
      if (l.provider === "clickdeal") {
        // Chế độ ClickDeal: mua xong thì báo đơn để nhận hoàn tiền
        var origin = (l.walletUrl || "").replace(/\/app\/.*$/, "");
        wallet.textContent = l.linkId ? "📝 Báo đơn" : "Mở ClickDeal";
        wallet.classList.add("report");
        wallet.href = l.linkId ? origin + "/app/#report=" + l.linkId : l.walletUrl || "#";
        wallet.title = "Đặt hàng xong, báo mã đơn Shopee để nhận hoàn tiền";
      } else {
        wallet.textContent = "Ví " + (l.providerName || "hoàn tiền");
        wallet.href = l.walletUrl || "#";
      }

      n.querySelector(".del").addEventListener("click", async function () {
        var all = await getLogs();
        await saveLogs(all.filter(function (x) { return x.id !== l.id; }));
      });

      n.querySelector(".note").textContent = l.note || "";

      var form = n.querySelector("form.manual");
      if (l.status === "ready" || l.provider === "clickdeal") form.hidden = true;
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var v = form.querySelector("input").value.trim();
        if (!v) return;
        chrome.runtime.sendMessage({ type: "CD_SET_LINK", id: l.id, affiliateUrl: v });
      });
      $list.appendChild(n);
    });
  }

  function csvCell(v) {
    v = v == null ? "" : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  document.getElementById("export").addEventListener("click", async function () {
    var logs = await getLogs();
    var rows = [["Thời gian", "Sản phẩm", "Giá", "Link Shopee gốc", "Link hoàn tiền", "Trang hoàn tiền", "Trạng thái", "Ghi chú"]];
    logs.forEach(function (l) {
      var p = l.product || {};
      rows.push([fmtTime(l.createdAt), p.name, p.price, p.productUrl, l.affiliateUrl,
        l.providerName, STATUS[l.status] || l.status, l.note]);
    });
    var csv = "﻿" + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
    var url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    var a = document.createElement("a");
    a.href = url;
    a.download = "clickdeal-lich-su-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  });

  var $clear = document.getElementById("clear");
  var armed = false;
  $clear.addEventListener("click", async function () {
    if (!armed) {
      armed = true;
      $clear.textContent = "Bấm lần nữa để xoá";
      setTimeout(function () { armed = false; $clear.textContent = "Xoá hết"; }, 3000);
      return;
    }
    await saveLogs([]);
  });

  // ---------- Cài đặt ----------
  var $provider = document.getElementById("provider");
  var $username = document.getElementById("username");
  var $userRow = document.getElementById("usernameRow");
  var $saved = document.getElementById("saved");
  Object.keys(CD_PROVIDERS).forEach(function (k) {
    var o = document.createElement("option");
    o.value = k;
    o.textContent = CD_PROVIDERS[k].name;
    $provider.appendChild(o);
  });

  function syncUserRow() {
    var p = CD_PROVIDERS[$provider.value];
    $userRow.hidden = !(p && p.needsUsername);
    document.getElementById("connectBox").hidden = !(p && p.api);
  }

  // ---------- ClickDeal: địa chỉ + mã kết nối ----------
  var $server = document.getElementById("serverUrl");
  var $key = document.getElementById("connectKey");
  var $cmsg = document.getElementById("connectMsg");
  function cmsg(text, kind) { $cmsg.textContent = text; $cmsg.className = "muted conn-msg " + (kind || ""); }
  // dán cả chuỗi kết nối vào 1 ô → tự tách địa chỉ và mã
  [$server, $key].forEach(function (inp) {
    inp.addEventListener("input", function () {
      var c = cdParseConnect(inp.value);
      if (c.serverUrl && c.connectKey) { $server.value = c.serverUrl; $key.value = c.connectKey; }
    });
  });
  function setOpenApp(origin) {
    var a = document.getElementById("openApp");
    a.hidden = !origin;
    a.href = origin ? origin + "/app/" : "#";
  }
  document.getElementById("connectSave").addEventListener("click", function () {
    var origin = cdOrigin($server.value) || cdParseConnect($server.value).serverUrl;
    var key = cdParseConnect($key.value).connectKey || $key.value.trim();
    if (!origin) return cmsg("Địa chỉ phải bắt đầu bằng https://", "err");
    if (!CD_KEY_RE.test(key)) return cmsg("Mã kết nối phải bắt đầu bằng cdk_ (tạo trong ClickDeal → Tài khoản)", "err");
    // xin quyền gọi tới địa chỉ này — phải gọi ngay trong lúc bấm nút
    chrome.permissions.request({ origins: [origin + "/*"] }).then(function (ok) {
      if (!ok) return cmsg("Bạn cần bấm Cho phép (Allow) để tiện ích gọi được ClickDeal.", "err");
      cmsg("Đang kiểm tra…");
      saveSettings({ serverUrl: origin, connectKey: key }).then(function () {
        $server.value = origin;
        setOpenApp(origin);
        chrome.runtime.sendMessage({ type: "CD_TEST_CONNECT" }, function (r) {
          if (r && r.ok) cmsg("✓ Đã kết nối: " + (r.me.nickname || "") + " · qua " + r.me.affiliate + (r.me.hasBank ? "" : " · nhớ thêm ngân hàng trong ClickDeal"), "ok");
          else cmsg((r && r.error) || "Không kiểm tra được", "err");
        });
      });
    }).catch(function (e) { cmsg("Không xin được quyền: " + e.message, "err"); });
  });

  function updateWarn(s) {
    document.getElementById("setupWarn").hidden = cdIsSetupDone(s);
  }
  function openSetup() {
    chrome.runtime.sendMessage({ type: "CD_OPEN_SETUP" });
    window.close();
  }
  document.getElementById("guide").addEventListener("click", openSetup);
  document.getElementById("setupBtn").addEventListener("click", openSetup);

  async function saveSettings(patch) {
    var r = await chrome.storage.local.get("cd_settings");
    var s = Object.assign({}, CD_DEFAULT_SETTINGS, r.cd_settings || {}, patch);
    if (patch.username !== undefined && patch.username && !CD_USERNAME_RE.test(patch.username)) {
      $username.style.borderColor = "#d32f2f";
      return;
    }
    $username.style.borderColor = "";
    await chrome.storage.local.set({ cd_settings: s });
    updateWarn(s);
    $saved.hidden = false;
    clearTimeout(saveSettings.t);
    saveSettings.t = setTimeout(function () { $saved.hidden = true; }, 1500);
  }

  chrome.storage.local.get("cd_settings").then(function (r) {
    var s = Object.assign({}, CD_DEFAULT_SETTINGS, r.cd_settings || {});
    if (!CD_PROVIDERS[s.provider]) s.provider = CD_DEFAULT_SETTINGS.provider;
    $provider.value = s.provider;
    $username.value = s.username || "";
    $server.value = s.serverUrl || "";
    $key.value = s.connectKey || "";
    setOpenApp(cdOrigin(s.serverUrl));
    $auto.checked = !!s.autoOpen;
    syncUserRow();
    updateWarn(s);
  });
  $provider.addEventListener("change", function () {
    syncUserRow();
    saveSettings({ provider: $provider.value });
  });
  $username.addEventListener("change", function () {
    saveSettings({ username: $username.value.trim() });
  });
  $auto.addEventListener("change", function () {
    saveSettings({ autoOpen: $auto.checked });
  });

  chrome.storage.onChanged.addListener(function (ch, area) {
    if (area === "local" && ch[LOGS]) render(ch[LOGS].newValue || []);
  });
  getLogs().then(render);
})();
