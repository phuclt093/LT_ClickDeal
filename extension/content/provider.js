/*
 * Chạy trên trang hoàn tiền (hoantien.com):
 * nếu tab này đang có "việc" do ClickDeal mở → tự dán link Shopee, bấm nút,
 * chờ trang trả về link hoàn tiền rồi gửi về background để lưu nhật ký.
 */
(function () {
  "use strict";

  var provider = null;
  var job = null;
  var done = false;

  // ---------- Banner thông báo ----------
  function banner(text, kind, actions) {
    var b = document.getElementById("cd-banner");
    if (!b) {
      b = document.createElement("div");
      b.id = "cd-banner";
      document.documentElement.appendChild(b);
    }
    b.className = kind ? "cd-banner--" + kind : "";
    b.textContent = "";
    var span = document.createElement("span");
    span.textContent = "ClickDeal: " + text;
    b.appendChild(span);
    (actions || []).forEach(function (a) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = a.label;
      btn.addEventListener("click", a.onClick);
      b.appendChild(btn);
    });
    var x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.title = "Đóng";
    x.addEventListener("click", function () { b.remove(); });
    b.appendChild(x);
  }

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          resolve(chrome.runtime.lastError ? null : res);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function visible(el) {
    if (!el || el.disabled || el.readOnly) return false;
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  }

  // ---------- Tìm ô dán link & nút gửi ----------
  function findInput() {
    if (provider.inputSelector) {
      var exact = document.querySelector(provider.inputSelector);
      return exact && !exact.disabled ? exact : null;
    }
    for (var i = 0; i < provider.inputSelectors.length; i++) {
      var list = document.querySelectorAll(provider.inputSelectors[i]);
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (visible(el) && !/search|email|password/i.test(el.type + " " + el.name + " " + el.id)) return el;
      }
    }
    return null;
  }

  function findSubmit(input) {
    if (provider.submitSelector) return document.querySelector(provider.submitSelector);
    var scope = input.form || input.closest("section, div") || document;
    var cands = Array.prototype.slice.call(
      document.querySelectorAll("button, input[type=submit], a[role=button], [onclick]")
    );
    // ưu tiên nút có chữ đúng, nằm gần ô nhập
    var byText = cands.filter(function (b) {
      var t = (b.innerText || b.value || "").trim();
      return visible(b) && provider.submitText.test(t);
    });
    var near = byText.filter(function (b) { return scope.contains(b); });
    if (near.length) return near[0];
    if (byText.length) return byText[0];
    if (input.form) {
      var s = input.form.querySelector("button[type=submit], input[type=submit], button:not([type])");
      if (s) return s;
    }
    return null;
  }

  function setValue(el, value) {
    var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, value); // dùng setter gốc để React/Vue nhận giá trị
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---------- Dò link kết quả ----------
  var URL_RE = /https?:\/\/[^\s"'<>()]+/g;
  var STATIC_RE = /\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)(\?|$)/i;
  var SKIP_HOST_RE = /(facebook|fb\.com|fb\.me|zalo|youtube|youtu\.be|tiktok\.com|google|gstatic|apple\.com|play\.google|twitter|x\.com|instagram|t\.me|telegram|messenger|cloudflare|jsdelivr|googletagmanager)/i;

  function allUrls() {
    var set = new Set();
    function add(u) {
      if (!u) return;
      try { set.add(new URL(u.trim(), location.href).href); } catch (e) { /* bỏ */ }
    }
    document.querySelectorAll("a[href]").forEach(function (a) { add(a.href); });
    document.querySelectorAll("input, textarea").forEach(function (i) {
      var v = i.value || "";
      if (/^https?:\/\//i.test(v.trim())) add(v);
    });
    document.querySelectorAll("[data-clipboard-text],[data-url],[data-link],[data-href]").forEach(function (el) {
      add(el.getAttribute("data-clipboard-text") || el.getAttribute("data-url") ||
          el.getAttribute("data-link") || el.getAttribute("data-href"));
    });
    var text = (document.body && document.body.innerText) || "";
    (text.match(URL_RE) || []).forEach(add);
    return set;
  }

  function stripQuery(u) {
    try { var x = new URL(u); return x.origin + x.pathname; } catch (e) { return u; }
  }

  function score(u) {
    if (STATIC_RE.test(u)) return 0;
    var x;
    try { x = new URL(u); } catch (e) { return 0; }
    if (!/^https?:$/.test(x.protocol)) return 0;
    var orig = job.product.productUrl;
    if (u === orig || stripQuery(u) === stripQuery(orig) && !CD_AFF_PARAMS.test(u)) return 0;
    if (CD_SHOPEE_SHORT.test(u)) return 3;
    if (/(^|\.)shopee\.vn$/i.test(x.hostname)) return CD_AFF_PARAMS.test(u) ? 3 : 0;
    var isProvider = x.hostname === provider.host || x.hostname.endsWith("." + provider.host);
    if (isProvider) {
      if ((provider.ignorePaths && provider.ignorePaths.test(x.pathname)) || x.pathname.length < 3) return 0;
      if (x.pathname === location.pathname) return 0;
      return 2;
    }
    if (SKIP_HOST_RE.test(x.hostname)) return 0;
    return 1;
  }

  function watchResult(snapshot, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var best = null;
      var bestSince = 0;
      var timer = setInterval(function () {
        if (done) { clearInterval(timer); return; }
        var found = null;
        var foundScore = 0;
        allUrls().forEach(function (u) {
          if (snapshot.has(u)) return;
          var s = score(u);
          if (s > foundScore) { found = u; foundScore = s; }
        });
        if (found && found !== best) { best = found; bestSince = Date.now(); }
        // chờ link ổn định 1 giây (trang có thể còn đang render)
        if (best && Date.now() - bestSince > 1000) {
          clearInterval(timer);
          resolve(best);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 500);
    });
  }

  // Trang biết chính xác ô kết quả (vd TietKiem360: #urlaff) → chờ ô đó có link
  function watchSelector(prevValue, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var timer = setInterval(function () {
        var el = document.querySelector(provider.resultSelector);
        var v = el ? (el.value || el.textContent || "").trim() : "";
        if (/^https?:\/\//i.test(v) && v !== prevValue) {
          clearInterval(timer);
          return resolve({ url: v });
        }
        if (provider.errorSelector) {
          var err = document.querySelector(provider.errorSelector);
          var et = err && visible(err) ? (err.innerText || "").trim() : "";
          if (et) { clearInterval(timer); return resolve({ error: et }); }
        }
        if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve({}); }
      }, 400);
    });
  }

  function prepare() {
    if (provider.platformSelector) {
      var radio = document.querySelector(provider.platformSelector);
      if (radio && !radio.checked) radio.click();
    }
    if (provider.usernameSelector && job.username) {
      var u = document.querySelector(provider.usernameSelector);
      if (u && u.value.trim() !== job.username) setValue(u, job.username);
    }
  }

  async function reportResult(url) {
    done = true;
    banner("Đã lấy link hoàn tiền và lưu vào lịch sử.", "", [
      { label: "Mở link để mua", onClick: function () { location.href = url; } }
    ]);
    await send({ type: "CD_RESULT", jobId: job.id, affiliateUrl: url });
  }

  async function fallbackManual(reason, snapshot) {
    try { await navigator.clipboard.writeText(job.product.productUrl); } catch (e) { /* có thể bị chặn */ }
    await send({ type: "CD_FAIL", jobId: job.id, reason: reason });
    banner("Chưa tự làm được (" + reason + "). Link Shopee đã được copy, hãy dán vào ô và bấm nút nhận hoàn tiền. ClickDeal vẫn đang chờ để lưu link.", "warn", [
      { label: "Copy link Shopee", onClick: function () { navigator.clipboard.writeText(job.product.productUrl); } }
    ]);
    // vẫn tiếp tục chờ người dùng tự thao tác thêm 3 phút
    var url = await watchResult(snapshot, 180000);
    if (url) reportResult(url);
  }

  // ---------- Luồng chính ----------
  async function run() {
    var res = await send({ type: "CD_GET_JOB" });
    if (!res || !res.job) return; // tab này không do ClickDeal mở
    job = res.job;
    provider = CD_PROVIDERS[job.provider] || CD_PROVIDERS.hoantien;

    if (provider.loginPath.test(location.pathname)) {
      banner("Hãy đăng nhập " + provider.name + " để tiền hoàn về đúng ví của bạn. Đăng nhập xong ClickDeal sẽ tự làm tiếp.", "info");
      return;
    }

    // Trang đã tải lại sau khi gửi form → chỉ cần dò kết quả
    if (job.phase === "submitted") {
      banner("Đang chờ link hoàn tiền…", "info");
      var u0 = await watchResult(new Set(), provider.resultTimeoutMs);
      if (u0) return reportResult(u0);
      return fallbackManual("không thấy link kết quả", allUrls());
    }

    banner("Đang dán link sản phẩm…", "info");
    var input = null;
    for (var i = 0; i < 20 && !input; i++) { input = findInput(); if (!input) await sleep(500); }
    if (!input) return fallbackManual("không tìm thấy ô dán link", allUrls());

    if (provider.needsUsername && !job.username) {
      return fallbackManual("chưa cài username nhận tiền trong tiện ích", allUrls());
    }
    prepare();
    await sleep(200);
    var snapshot = allUrls();
    var prevResult = "";
    if (provider.resultSelector) {
      var r0 = document.querySelector(provider.resultSelector);
      prevResult = r0 ? (r0.value || r0.textContent || "").trim() : "";
    }
    setValue(input, job.product.productUrl);
    await sleep(400);

    await send({ type: "CD_PHASE", jobId: job.id, phase: "submitted" });
    var btn = findSubmit(input);
    if (btn) {
      btn.click();
    } else if (input.form && input.form.requestSubmit) {
      input.form.requestSubmit();
    } else {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    }
    banner("Đã gửi link, đang chờ trang tạo link hoàn tiền…", "info");

    if (provider.resultSelector) {
      var r = await watchSelector(prevResult, provider.resultTimeoutMs);
      if (r.url) return reportResult(r.url);
      return fallbackManual(r.error || "không thấy link kết quả", snapshot);
    }

    var url = await watchResult(snapshot, provider.resultTimeoutMs);
    if (url) return reportResult(url);
    return fallbackManual("không thấy link kết quả", snapshot);
  }

  run();
})();
