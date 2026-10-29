/*
 * Service worker: điều phối "việc" (job) giữa tab Shopee và tab trang hoàn tiền,
 * và lưu nhật ký mua hàng vào chrome.storage.local.
 *
 * Nhật ký (cd_logs) mỗi mục:
 * { id, createdAt, updatedAt, provider, providerName, walletUrl,
 *   product: {shop, shopId, itemId, name, image, price, productUrl},
 *   affiliateUrl, status: "pending" | "ready" | "manual", note }
 */
// Chrome: service worker → tự nạp config.js. Firefox: manifest đã nạp config.js trước.
if (typeof importScripts === "function" && typeof CD_PROVIDERS === "undefined") {
  importScripts("config.js");
}

var LOGS = "cd_logs";
var JOBS = "cd_jobs"; // { [tabId]: {id, provider, phase, product} } — lưu trong storage.session

async function getSettings() {
  var r = await chrome.storage.local.get("cd_settings");
  return Object.assign({}, CD_DEFAULT_SETTINGS, r.cd_settings || {});
}

async function getLogs() {
  var r = await chrome.storage.local.get(LOGS);
  return r[LOGS] || [];
}

async function updateLog(id, patch) {
  var logs = await getLogs();
  var i = logs.findIndex(function (l) { return l.id === id; });
  if (i < 0) return null;
  logs[i] = Object.assign({}, logs[i], patch, { updatedAt: Date.now() });
  await chrome.storage.local.set({ [LOGS]: logs });
  return logs[i];
}

async function getJobs() {
  var r = await chrome.storage.session.get(JOBS);
  return r[JOBS] || {};
}

async function setJob(tabId, job) {
  var jobs = await getJobs();
  if (job) jobs[tabId] = job; else delete jobs[tabId];
  await chrome.storage.session.set({ [JOBS]: jobs });
}

async function findTabByJob(jobId) {
  var jobs = await getJobs();
  for (var k in jobs) if (jobs[k].id === jobId) return Number(k);
  return null;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function openSetup(reason) {
  var url = chrome.runtime.getURL("setup/setup.html") + (reason ? "?reason=" + reason : "");
  // đã mở sẵn thì chuyển tới tab đó
  var tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("setup/setup.html") + "*" });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true, url: url });
    if (tabs[0].windowId != null) chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: url });
  }
}

// Cài lần đầu → mở trang hướng dẫn
chrome.runtime.onInstalled.addListener(async function (details) {
  if (details.reason === "install") {
    openSetup("");
  } else if (details.reason === "update" && !cdIsSetupDone(await getSettings())) {
    openSetup("need-setup");
  }
});

function updateBadge(logs) {
  var pending = logs.filter(function (l) { return l.status !== "ready"; }).length;
  chrome.action.setBadgeText({ text: pending ? String(pending) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#e37400" });
}

// ---------- Chế độ ClickDeal: gọi thẳng API bằng mã kết nối ----------
async function clickdealApi(settings, method, path, body) {
  var origin = cdOrigin(settings.serverUrl);
  if (!origin) throw new Error("Chưa nhập địa chỉ ClickDeal");
  var res;
  try {
    res = await fetch(origin + path, {
      method: method,
      headers: Object.assign(
        { Accept: "application/json", Authorization: "Bearer " + settings.connectKey },
        body ? { "Content-Type": "application/json" } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
      credentials: "omit"
    });
  } catch (e) {
    throw new Error("Không kết nối được ClickDeal (" + origin + "). Địa chỉ có thể đã đổi: lấy địa chỉ mới rồi cập nhật trong tiện ích.");
  }
  var j = await res.json().catch(function () { return {}; });
  if (res.status === 401) throw new Error("Mã kết nối hết hiệu lực. Vào ClickDeal → Tài khoản → Tạo mã kết nối mới.");
  if (!res.ok) throw new Error(j.error || "ClickDeal báo lỗi " + res.status);
  return j;
}

async function startClickdeal(settings, provider, product, sender) {
  var origin = cdOrigin(settings.serverUrl);
  var entry = {
    id: newId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    provider: provider.id,
    providerName: "ClickDeal",
    walletUrl: origin + "/app/#orders",
    username: "",
    product: product,
    affiliateUrl: "",
    status: "pending",
    note: ""
  };
  var logs = await getLogs();
  logs.unshift(entry);
  await chrome.storage.local.set({ [LOGS]: logs.slice(0, 1000) });
  updateBadge(logs);
  var clip = function (v, n) { return v ? String(v).slice(0, n) : undefined; };
  try {
    var r = await clickdealApi(settings, "POST", "/v1/ext/links", {
      url: product.productUrl,
      source: "extension",
      product: {
        name: clip(product.name, 480),
        price: clip(product.price, 60),
        image: /^https:\/\//i.test(product.image || "") ? clip(product.image, 1000) : undefined
      }
    });
    await updateLog(entry.id, { affiliateUrl: r.affLink, linkId: r.linkId, status: "ready", note: "" });
    updateBadge(await getLogs());
    if (settings.autoOpen && sender.tab) chrome.tabs.update(sender.tab.id, { url: r.affLink });
    return { ok: true, id: entry.id, affLink: r.affLink };
  } catch (e) {
    await updateLog(entry.id, { status: "manual", note: e.message });
    return { ok: false, error: e.message };
  }
}

async function handle(msg, sender) {
  switch (msg.type) {
    case "CD_OPEN_SETUP": {
      await openSetup(msg.reason);
      return { ok: true };
    }

    case "CD_START": {
      var settings = await getSettings();
      var provider = CD_PROVIDERS[settings.provider] || CD_PROVIDERS.tietkiem360;
      // Chưa thiết lập (chưa có username…) → mở trang hướng dẫn thay vì tạo link
      if (!cdIsSetupDone(settings)) {
        await openSetup("need-setup");
        return { ok: true, setup: true };
      }
      if (provider.api) return startClickdeal(settings, provider, msg.product, sender);
      var entry = {
        id: newId(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provider: provider.id,
        providerName: provider.name,
        walletUrl: provider.walletUrl,
        username: provider.needsUsername ? settings.username || "" : "",
        product: msg.product,
        affiliateUrl: "",
        status: "pending",
        note: ""
      };
      var logs = await getLogs();
      logs.unshift(entry);
      await chrome.storage.local.set({ [LOGS]: logs.slice(0, 1000) });
      updateBadge(logs);

      var tab = await chrome.tabs.create({
        url: cdProviderUrl(provider, settings),
        index: sender.tab ? sender.tab.index + 1 : undefined,
        openerTabId: sender.tab ? sender.tab.id : undefined
      });
      await setJob(tab.id, {
        id: entry.id, provider: provider.id, phase: "new",
        product: msg.product, username: settings.username || ""
      });
      return { ok: true, id: entry.id };
    }

    // Trang hướng dẫn / popup: kiểm tra mã kết nối ClickDeal
    case "CD_TEST_CONNECT": {
      var s0 = Object.assign({}, await getSettings(), msg.settings || {});
      try {
        var me = await clickdealApi(s0, "GET", "/v1/ext/me");
        return { ok: true, me: { nickname: me.nickname, affiliate: me.affiliate.displayName, hasBank: !!me.bank } };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case "CD_GET_JOB": {
      if (!sender.tab) return { job: null };
      var jobs = await getJobs();
      return { job: jobs[sender.tab.id] || null };
    }

    case "CD_PHASE": {
      var tabId = await findTabByJob(msg.jobId);
      if (tabId != null) {
        var jobs2 = await getJobs();
        jobs2[tabId].phase = msg.phase;
        await chrome.storage.session.set({ [JOBS]: jobs2 });
      }
      return { ok: true };
    }

    case "CD_RESULT": {
      await updateLog(msg.jobId, { affiliateUrl: msg.affiliateUrl, status: "ready", note: "" });
      var tId = await findTabByJob(msg.jobId);
      if (tId != null) await setJob(tId, null);
      updateBadge(await getLogs());
      var s = await getSettings();
      if (s.autoOpen && sender.tab) {
        chrome.tabs.update(sender.tab.id, { url: msg.affiliateUrl });
      }
      return { ok: true };
    }

    case "CD_FAIL": {
      await updateLog(msg.jobId, { status: "manual", note: msg.reason || "" });
      return { ok: true };
    }

    // Từ popup: dán link hoàn tiền thủ công cho 1 mục
    case "CD_SET_LINK": {
      var e = await updateLog(msg.id, { affiliateUrl: msg.affiliateUrl, status: "ready", note: "Nhập thủ công" });
      updateBadge(await getLogs());
      return { ok: !!e };
    }
  }
  return { ok: false };
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  handle(msg, sender).then(sendResponse, function (err) {
    sendResponse({ ok: false, error: String(err) });
  });
  return true; // trả lời bất đồng bộ
});

// Đóng tab hoàn tiền giữa chừng → bỏ job (mục nhật ký vẫn giữ trạng thái chờ)
chrome.tabs.onRemoved.addListener(function (tabId) {
  setJob(tabId, null);
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local" && changes[LOGS]) updateBadge(changes[LOGS].newValue || []);
});
