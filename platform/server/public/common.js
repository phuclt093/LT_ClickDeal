/* ClickDeal — hàm dùng chung cho trang đăng nhập, app người mua và app affiliate. Không dùng thư viện ngoài. */
(function () {
  "use strict";
  var CD = (window.CD = {});

  CD.$ = function (id) { return document.getElementById(id); };

  CD.el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };
  /** Tạo cây phần tử gọn: CD.h("div.card", [CD.h("b", "Tiêu đề")]) */
  CD.h = function (sel, kids) {
    var m = sel.split(".");
    var e = document.createElement(m[0] || "div");
    if (m.length > 1) e.className = m.slice(1).join(" ");
    [].concat(kids === undefined ? [] : kids).forEach(function (k) {
      if (k === null || k === undefined || k === false) return;
      e.appendChild(typeof k === "string" || typeof k === "number" ? document.createTextNode(String(k)) : k);
    });
    return e;
  };

  CD.api = function (method, path, body) {
    var headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(path, { method: method, headers: headers, credentials: "same-origin", body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) {
            var e = new Error(j.error || "Lỗi kết nối, thử lại");
            e.status = r.status;
            if (r.status === 401 && !/^\/(j\/|$|\?)/.test(location.pathname)) CD.toLogin();
            throw e;
          }
          return j;
        });
      });
  };
  CD.toLogin = function () {
    location.replace("/?next=" + encodeURIComponent(location.pathname + location.search));
  };
  CD.logout = function () {
    CD.api("POST", "/v1/auth/logout", {}).finally(function () { location.replace("/"); });
  };

  CD.vnd = function (n) { return n === null || n === undefined ? "—" : Math.round(n).toLocaleString("vi-VN") + "₫"; };
  CD.date = function (s, withTime) {
    if (!s) return "";
    var d = new Date(s);
    var o = { day: "2-digit", month: "2-digit", year: "numeric" };
    if (withTime) { o.hour = "2-digit"; o.minute = "2-digit"; o.year = undefined; }
    return d.toLocaleString("vi-VN", o);
  };
  CD.ago = function (s) {
    var m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
    if (m < 1) return "vừa xong";
    if (m < 60) return m + " phút trước";
    var h = Math.round(m / 60);
    if (h < 24) return h + " giờ trước";
    var d = Math.round(h / 24);
    return d + " ngày trước";
  };
  CD.msg = function (node, text, ok) { node.className = "msg " + (ok ? "ok" : "err"); node.textContent = text || ""; };

  var toastTimer;
  CD.toast = function (text, isErr) {
    var t = document.querySelector(".toast");
    if (!t) { t = CD.el("div", "toast"); document.body.appendChild(t); }
    t.textContent = text;
    t.className = "toast" + (isErr ? " err" : "");
    requestAnimationFrame(function () { t.classList.add("show"); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  };
  CD.copy = function (text, btn) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(
      function () {
        CD.toast("Đã copy");
        if (btn) { var o = btn.textContent; btn.textContent = "Đã copy ✓"; setTimeout(function () { btn.textContent = o; }, 1500); }
      },
      function () { CD.toast("Không copy được, hãy chọn và copy thủ công", true); }
    );
  };
  CD.copyRow = function (text, label) {
    var b = CD.el("button", "btn ghost sm", label || "Copy");
    b.type = "button";
    b.addEventListener("click", function () { CD.copy(text, b); });
    return CD.h("div.copyable", [CD.el("code", "box", text), b]);
  };

  // ---------- Tấm trượt ----------
  var openSheet = null;
  CD.sheet = function (title, onClose) {
    CD.closeSheet();
    var back = CD.el("div", "sheet-back");
    var sh = CD.el("div", "sheet");
    sh.setAttribute("role", "dialog");
    sh.setAttribute("aria-modal", "true");
    var head = CD.el("div", "sheet-head");
    var h = CD.el("h2", "", title);
    var x = CD.el("button", "x", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Đóng");
    head.appendChild(h);
    head.appendChild(x);
    var body = CD.el("div", "sheet-body");
    sh.appendChild(head);
    sh.appendChild(body);
    document.body.appendChild(back);
    document.body.appendChild(sh);
    document.body.classList.add("locked");
    requestAnimationFrame(function () { back.classList.add("show"); sh.classList.add("show"); });
    var api = {
      body: body,
      title: h,
      close: function () {
        if (openSheet !== api) return;
        openSheet = null;
        back.classList.remove("show");
        sh.classList.remove("show");
        document.body.classList.remove("locked");
        setTimeout(function () { back.remove(); sh.remove(); }, 230);
        if (onClose) onClose();
      }
    };
    x.addEventListener("click", api.close);
    back.addEventListener("click", api.close);
    openSheet = api;
    return api;
  };
  CD.closeSheet = function () { if (openSheet) openSheet.close(); };
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") CD.closeSheet(); });

  CD.zoom = function (src) {
    var z = CD.el("div", "zoom");
    var img = CD.el("img");
    img.src = src;
    img.alt = "Ảnh bằng chứng";
    z.appendChild(img);
    z.addEventListener("click", function () { z.remove(); });
    document.body.appendChild(z);
  };

  // ---------- Ảnh: nén trên máy trước khi gửi (≤1600px, JPEG) ----------
  CD.pickImage = function () {
    return new Promise(function (resolve, reject) {
      var inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "image/*";
      inp.addEventListener("change", function () {
        var f = inp.files && inp.files[0];
        if (!f) return reject(new Error("Chưa chọn ảnh"));
        CD.compress(f).then(resolve, reject);
      });
      inp.click();
    });
  };
  CD.compress = function (file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) return reject(new Error("File không phải ảnh"));
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error("Không đọc được ảnh")); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error("Không mở được ảnh")); };
        img.onload = function () {
          var max = 1600;
          var s = Math.min(1, max / Math.max(img.width, img.height));
          var c = document.createElement("canvas");
          c.width = Math.round(img.width * s);
          c.height = Math.round(img.height * s);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          var q = 0.82;
          var out = c.toDataURL("image/jpeg", q);
          while (out.length > 1900000 && q > 0.4) { q -= 0.12; out = c.toDataURL("image/jpeg", q); }
          if (out.length > 1990000) return reject(new Error("Ảnh quá lớn"));
          resolve(out);
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  };
  /** Ô chọn ảnh kèm xem trước. Trả về { node, get(), clear() } */
  CD.imageInput = function (label) {
    var data = null;
    var wrap = CD.el("div");
    var btn = CD.el("button", "btn ghost sm", label || "📷 Chọn ảnh");
    btn.type = "button";
    var prev = CD.el("div");
    function render() {
      prev.textContent = "";
      if (!data) return;
      var p = CD.el("div", "preview");
      var img = CD.el("img");
      img.src = data;
      img.alt = "Ảnh đã chọn";
      var x = CD.el("button", "", "×");
      x.type = "button";
      x.setAttribute("aria-label", "Bỏ ảnh");
      x.addEventListener("click", function () { data = null; render(); });
      p.appendChild(img);
      p.appendChild(x);
      prev.appendChild(p);
    }
    btn.addEventListener("click", function () {
      CD.pickImage().then(function (d) { data = d; render(); }, function (e) { if (e.message !== "Chưa chọn ảnh") CD.toast(e.message, true); });
    });
    wrap.appendChild(btn);
    wrap.appendChild(prev);
    return { node: wrap, get: function () { return data; }, clear: function () { data = null; render(); } };
  };

  // ---------- Trạng thái đơn ----------
  CD.statusBadges = function (c, role) {
    var out = [];
    var label = c.statusLabel;
    if (role === "buyer" && c.status === "accepted") label = "Đã ghi nhận · chờ trả";
    out.push(CD.el("span", "badge " + c.status, label));
    if (c.disputed) out.push(CD.el("span", "badge dispute", "Đang khiếu nại"));
    if (role === "affiliate" && c.overdue) out.push(CD.el("span", "badge overdue", "Quá 6 tuần"));
    else if (role === "affiliate" && c.due) out.push(CD.el("span", "badge due", "Đến hạn kiểm tra"));
    return out;
  };

  /** Dòng thời gian trao đổi + ô soạn tin nhắn (dùng cho cả 2 vai trò). */
  CD.thread = function (events, role, send) {
    var box = CD.el("div");
    var tl = CD.el("div", "timeline");
    var who = { buyer: "Khách", affiliate: "Affiliate", system: "ClickDeal" };
    events.forEach(function (e) {
      var mine = e.actor === role;
      var cls = e.actor === "system" ? "sys" : e.kind === "status" ? (mine ? "status-me" : "status-them") : mine ? "me" : "them";
      var ev = CD.el("div", "ev " + cls);
      var bubble = CD.el("div", "bubble");
      if (e.body) bubble.appendChild(document.createTextNode(e.body));
      if (e.image) {
        var img = CD.el("img", "proof");
        img.src = e.image;
        img.alt = "Ảnh bằng chứng";
        img.loading = "lazy";
        img.addEventListener("click", function () { CD.zoom(e.image); });
        bubble.appendChild(img);
      }
      ev.appendChild(bubble);
      ev.appendChild(CD.el("div", "meta", (mine ? "Bạn" : who[e.actor]) + " · " + CD.date(e.at, true)));
      tl.appendChild(ev);
    });
    box.appendChild(tl);
    if (!send) return box;

    var img = null;
    var prev = CD.el("div");
    var comp = CD.el("form", "composer");
    var attach = CD.el("button", "attach", "📷");
    attach.type = "button";
    attach.title = "Gửi ảnh bằng chứng";
    attach.setAttribute("aria-label", "Gửi ảnh");
    var ta = CD.el("textarea");
    ta.rows = 1;
    ta.maxLength = 2000;
    ta.placeholder = "Nhắn cho " + (role === "buyer" ? "affiliate" : "khách") + "…";
    var go = CD.el("button", "btn send", "Gửi");
    go.type = "submit";
    comp.appendChild(attach);
    comp.appendChild(ta);
    comp.appendChild(go);
    function renderPrev() {
      prev.textContent = "";
      if (!img) return;
      var p = CD.el("div", "preview");
      var i = CD.el("img");
      i.src = img;
      i.alt = "";
      var x = CD.el("button", "", "×");
      x.type = "button";
      x.addEventListener("click", function () { img = null; renderPrev(); });
      p.appendChild(i);
      p.appendChild(x);
      prev.appendChild(p);
    }
    attach.addEventListener("click", function () {
      CD.pickImage().then(function (d) { img = d; renderPrev(); }, function (e) { if (e.message !== "Chưa chọn ảnh") CD.toast(e.message, true); });
    });
    comp.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!ta.value.trim() && !img) return;
      go.disabled = true;
      send({ body: ta.value.trim() || undefined, image: img || undefined })
        .catch(function (e) { CD.toast(e.message, true); })
        .finally(function () { go.disabled = false; });
    });
    box.appendChild(prev);
    box.appendChild(comp);
    box.appendChild(CD.el("p", "tiny muted", "Ảnh có địa chỉ hoặc số điện thoại: hãy che đi trước khi gửi. Nội dung trao đổi được lưu lại, không sửa hay xóa được."));
    return box;
  };

  CD.kv = function (pairs) {
    var dl = CD.el("dl", "kv");
    pairs.forEach(function (p) {
      if (!p || p[1] === null || p[1] === undefined || p[1] === "") return;
      dl.appendChild(CD.el("dt", "", p[0]));
      var dd = CD.el("dd");
      if (typeof p[1] === "object") dd.appendChild(p[1]);
      else dd.textContent = p[1];
      dl.appendChild(dd);
    });
    return dl;
  };

  CD.empty = function (icon, text) {
    var d = CD.el("div", "empty");
    d.appendChild(CD.el("span", "ic", icon));
    d.appendChild(document.createTextNode(text));
    return d;
  };

  /** Điều hướng bằng thanh tab, nhớ tab qua #hash */
  CD.tabs = function (names, onShow) {
    var btns = document.querySelectorAll("[data-tab]");
    function show(name) {
      if (names.indexOf(name) < 0) name = names[0];
      names.forEach(function (n) { var s = CD.$("tab-" + n); if (s) s.hidden = n !== name; });
      btns.forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === name); });
      if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
      window.scrollTo(0, 0);
      onShow(name);
    }
    btns.forEach(function (b) { b.addEventListener("click", function () { show(b.getAttribute("data-tab")); }); });
    window.addEventListener("hashchange", function () { show(location.hash.slice(1)); });
    show(location.hash.slice(1));
    return show;
  };
  CD.badge = function (id, n) {
    var b = CD.$(id);
    if (!b) return;
    b.textContent = n > 99 ? "99+" : String(n);
    b.hidden = !n;
  };

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {});
})();
