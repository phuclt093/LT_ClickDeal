/* ClickDeal — ứng dụng cho người mua. */
(function () {
  "use strict";
  var $ = CD.$, el = CD.el, h = CD.h;
  var me = null;
  var hist = { links: [], totals: {} };
  var claims = [];

  function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }

  if (new URLSearchParams(location.search).get("welcome")) {
    $("welcome").hidden = false;
    window.history.replaceState(null, "", "/app/#buy");
  }

  // ---------- Dữ liệu ----------
  function loadMe() {
    return CD.api("GET", "/v1/ext/me").then(function (m) {
      me = m;
      $("who").textContent = (m.nickname || "") + " · qua " + m.affiliate.displayName;
      CD.badge("dotAccount", m.bank ? 0 : 1);
      renderAccount();
    });
  }
  function loadHistory() {
    return CD.api("GET", "/v1/ext/history").then(function (hs) {
      hist = hs;
      $("tWaiting").textContent = CD.vnd(hs.totals.waiting);
      $("tPaid").textContent = CD.vnd(hs.totals.paidUnconfirmed);
      $("tReceived").textContent = CD.vnd(hs.totals.received);
      renderLinks();
    });
  }
  function loadClaims() {
    return CD.api("GET", "/v1/ext/claims").then(function (list) {
      claims = list;
      // cần khách xử lý: affiliate báo đã trả, hoặc bị từ chối chưa khiếu nại
      CD.badge("dotOrders", list.filter(function (c) { return c.status === "paid"; }).length);
      renderClaims();
    });
  }
  function refresh() { return Promise.all([loadHistory(), loadClaims()]); }

  // ---------- Tab Mua ----------
  function renderLinks() {
    var ul = $("links");
    ul.textContent = "";
    if (!hist.links.length) {
      ul.appendChild(el("li")).appendChild(CD.empty("🛒", "Chưa có. Mở sản phẩm Shopee qua ClickDeal để bắt đầu."));
      return;
    }
    hist.links.slice(0, 20).forEach(function (l) {
      var li = el("li");
      if (l.image) { var img = el("img", "thumb"); img.src = l.image; img.alt = ""; img.loading = "lazy"; li.appendChild(img); }
      else li.appendChild(el("div", "ph", "🛍️"));
      var a = el("a", "", l.product_name || "Sản phẩm Shopee #" + (String(l.product_url).split("/").pop() || ""));
      a.href = l.aff_link;
      a.rel = "noopener";
      li.appendChild(h("div.t", [h("b", [a]), el("span", "", CD.ago(l.created_at) + (l.price ? " · " + l.price : ""))]));
      var r = el("div", "r");
      if (l.claim_no) r.appendChild(el("span", "badge completed", "Đã báo #" + l.claim_no));
      else {
        var b = el("button", "btn soft sm", "Báo đơn");
        b.type = "button";
        b.addEventListener("click", function () { openClaimForm(l.id); });
        r.appendChild(b);
      }
      li.appendChild(r);
      ul.appendChild(li);
    });
  }

  $("pasteForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var v = $("pasteInput").value;
    var m = String(v).match(/https?:\/\/[^\s"'<>]+/i);
    CD.msg($("pasteMsg"), "Đang tạo link…", true);
    CD.api("POST", "/v1/ext/links", { url: m ? m[0] : v.trim(), source: "web" })
      .then(function (r) { location.href = r.affLink; })
      .catch(function (e) { CD.msg($("pasteMsg"), e.message); });
  });

  function setupInstall() {
    var standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (isIOS()) {
      $("androidGuide").hidden = true;
      $("iosGuide").hidden = false;
      $("shortcutBox").appendChild(CD.copyRow(location.origin + "/share?src=shortcut&url="));
    } else if (standalone) {
      $("installHint").textContent = "✓ ClickDeal đã được cài. Chia sẻ sản phẩm từ app Shopee rồi chọn ClickDeal.";
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
  }

  // ---------- Tab Đơn ----------
  function renderClaims() {
    var ul = $("claims");
    ul.textContent = "";
    if (!claims.length) {
      ul.appendChild(el("li")).appendChild(CD.empty("🧾", "Chưa báo đơn nào. Mua xong hãy bấm \"Báo đơn đã mua\"."));
      return;
    }
    claims.forEach(function (c) {
      var li = el("li", "tap");
      li.appendChild(el("div", "ph", c.status === "completed" ? "✅" : c.status === "paid" ? "💸" : c.status === "rejected" ? "⚠️" : "🧾"));
      li.appendChild(h("div.t", [el("b", "", c.productName || "Đơn " + c.orderCode), el("span", "", "#" + c.no + " · " + c.orderCode + " · " + CD.date(c.submittedAt))]));
      var r = el("div", "r");
      if (c.cashback !== null) r.appendChild(el("b", "", CD.vnd(c.cashback)));
      CD.statusBadges(c, "buyer").forEach(function (b) { r.appendChild(b); });
      li.appendChild(r);
      li.addEventListener("click", function () { openClaim(c.id); });
      ul.appendChild(li);
    });
  }

  $("newClaimBtn").addEventListener("click", function () { openClaimForm(); });

  function openClaimForm(linkId) {
    var sh = CD.sheet("Báo đơn đã mua");
    var f = el("form");
    var sel = el("select");
    sel.appendChild(new Option("Không chọn / mua ở chỗ khác", ""));
    hist.links.filter(function (l) { return !l.claim_no; }).slice(0, 40).forEach(function (l) {
      sel.appendChild(new Option((l.product_name || "Sản phẩm #" + String(l.product_url).split("/").pop()).slice(0, 60) + " · " + CD.date(l.created_at), l.id));
    });
    if (linkId) sel.value = linkId;
    var code = el("input");
    code.required = true;
    code.maxLength = 40;
    code.placeholder = "vd: 251029ABCD1234";
    code.autocapitalize = "characters";
    var amount = el("input");
    amount.inputMode = "numeric";
    amount.placeholder = "vd: 259000";
    var day = el("input");
    day.type = "date";
    day.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    var note = el("textarea");
    note.maxLength = 1000;
    note.placeholder = "Ghi chú cho người giới thiệu (không bắt buộc)";
    var pic = CD.imageInput("📷 Chọn ảnh chụp đơn hàng");
    var msg = el("div", "msg");
    var go = el("button", "btn block", "Gửi báo đơn");
    go.type = "submit";

    function field(label, input, hint) {
      var l = el("label", "field");
      l.appendChild(el("span", "", label));
      l.appendChild(input);
      if (hint) l.appendChild(el("small", "", hint));
      return l;
    }
    f.appendChild(field("Sản phẩm đã mở qua ClickDeal", sel));
    f.appendChild(field("Mã đơn hàng Shopee", code, "Shopee → Tôi → Đơn mua → chọn đơn → kéo xuống phần \"Mã đơn hàng\" → Sao chép."));
    f.appendChild(h("div.grid2", [field("Tổng tiền đơn (₫)", amount), field("Ngày đặt", day)]));
    var picField = el("div", "field");
    picField.appendChild(el("span", "", "Ảnh chụp đơn hàng (nên có)"));
    picField.appendChild(pic.node);
    picField.appendChild(el("small", "", "Che địa chỉ và số điện thoại trước khi chụp. Ảnh chỉ bạn và người giới thiệu xem được."));
    f.appendChild(picField);
    f.appendChild(field("Ghi chú", note));
    f.appendChild(el("div", "note info small", "Tiền hoàn được trả sau khi đơn hoàn tất trên Shopee (thường 2–6 tuần). Đơn bị hủy hoặc trả hàng sẽ không được hoàn tiền."));
    f.appendChild(msg);
    f.appendChild(go);
    sh.body.appendChild(f);
    if (!linkId) code.focus();

    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var body = { orderCode: code.value };
      if (sel.value) body.linkId = sel.value;
      var amt = Number(String(amount.value).replace(/[^\d]/g, ""));
      if (amt) body.orderAmount = amt;
      if (day.value) body.orderedOn = day.value;
      if (note.value.trim()) body.note = note.value.trim();
      if (pic.get()) body.image = pic.get();
      go.disabled = true;
      CD.msg(msg, "Đang gửi…", true);
      CD.api("POST", "/v1/ext/claims", body)
        .then(function (r) {
          sh.close();
          CD.toast("Đã báo đơn #" + r.no);
          refresh();
          location.hash = "orders";
          openClaim(r.id);
        })
        .catch(function (e) { CD.msg(msg, e.message); go.disabled = false; });
    });
  }

  function openClaim(id) {
    var sh = CD.sheet("Đơn");
    function load() {
      return CD.api("GET", "/v1/ext/claims/" + id).then(function (d) { render(d); });
    }
    function act(action, extra) {
      return CD.api("POST", "/v1/ext/claims/" + id + "/actions", Object.assign({ action: action }, extra || {}))
        .then(function () { CD.toast("Đã cập nhật"); refresh(); return load(); })
        .catch(function (e) { CD.toast(e.message, true); });
    }
    function render(d) {
      var c = d.claim;
      var b = sh.body;
      b.textContent = "";
      sh.title.textContent = "Đơn #" + c.no;

      var info = el("div", "card");
      var badges = el("div", "btn-row");
      CD.statusBadges(c, "buyer").forEach(function (x) { badges.appendChild(x); });
      info.appendChild(badges);
      if (c.productName) info.appendChild(el("p", "", c.productName));
      info.appendChild(CD.kv([
        ["Mã đơn Shopee", c.orderCode],
        ["Tổng tiền đơn", c.orderAmount !== null ? CD.vnd(c.orderAmount) : null],
        ["Ngày đặt", c.orderedOn ? CD.date(c.orderedOn) : null],
        ["Ngày báo", CD.date(c.submittedAt, true)],
        ["Tiền hoàn", c.cashback !== null ? CD.vnd(c.cashback) : "Chờ người giới thiệu xác nhận"],
        ["Người giới thiệu", d.affiliate.displayName]
      ]));
      b.appendChild(info);

      if (c.status === "submitted")
        b.appendChild(el("div", "note info small", d.affiliate.displayName + " sẽ đối chiếu đơn với hệ thống affiliate rồi ghi nhận số tiền hoàn."));
      if (c.status === "accepted")
        b.appendChild(el("div", "note ok small", "Đơn đã được ghi nhận. Tiền hoàn sẽ được trả sau khi đơn hoàn tất trên Shopee (thường 2–6 tuần kể từ lúc đặt)."));
      if (c.status === "rejected") {
        var n = el("div", "note err small");
        n.appendChild(h("b", ["Bị từ chối: "]));
        n.appendChild(document.createTextNode(c.rejectReason || ""));
        n.appendChild(el("div", "", "Nếu bạn không đồng ý, hãy mở khiếu nại kèm bằng chứng (ảnh đơn hàng, lịch sử mua)."));
        b.appendChild(n);
      }
      if (d.payout) {
        var p = el("div", "card");
        p.appendChild(el("h3", "", "Thông tin trả tiền"));
        p.appendChild(CD.kv([["Số tiền", CD.vnd(d.payout.amount)], ["Hình thức", d.payout.method], ["Thời gian", CD.date(d.payout.paidAt, true)], ["Ghi chú", d.payout.note]]));
        if (d.payout.receipt) {
          var img = el("img", "proof");
          img.src = d.payout.receipt;
          img.alt = "Biên lai chuyển khoản";
          img.addEventListener("click", function () { CD.zoom(d.payout.receipt); });
          var wrap = el("div", "ev");
          wrap.appendChild(img);
          p.appendChild(wrap);
        }
        b.appendChild(p);
      }

      // Hành động
      var actions = el("div", "btn-row");
      if (c.status === "paid") {
        actions.appendChild(btn("✓ Tôi đã nhận tiền", "btn", function () { return act("confirm_received"); }));
      }
      if (c.disputed) {
        actions.appendChild(btn("Đóng khiếu nại", "btn ghost", function () { return act("close_dispute"); }));
      } else if (["submitted", "accepted", "rejected", "paid"].indexOf(c.status) >= 0) {
        actions.appendChild(btn(c.status === "paid" ? "Chưa nhận được tiền" : "Khiếu nại", "btn ghost", function () { disputeForm(); }));
      }
      if (c.status === "submitted") actions.appendChild(btn("Hủy báo đơn", "btn danger ghost", function () { return act("cancel"); }, true));
      if (actions.children.length) b.appendChild(actions);

      var disputeBox = el("div");
      b.appendChild(disputeBox);
      function disputeForm() {
        disputeBox.textContent = "";
        var f = el("form", "card mt");
        f.appendChild(el("h3", "", "Mở khiếu nại"));
        var ta = el("textarea");
        ta.required = true;
        ta.placeholder = "Mô tả vấn đề, vd: tôi mua qua link ClickDeal lúc 20h ngày 29/10, đơn đã giao thành công…";
        f.appendChild(ta);
        f.appendChild(el("p", "tiny muted", "Sau khi mở, hãy gửi ảnh bằng chứng trong khung trao đổi bên dưới. ClickDeal không phân xử: hai bên tự trao đổi; nội dung được lưu nguyên vẹn."));
        var go = el("button", "btn block", "Gửi khiếu nại");
        go.type = "submit";
        f.appendChild(go);
        f.addEventListener("submit", function (ev) {
          ev.preventDefault();
          go.disabled = true;
          act("dispute", { reason: ta.value.trim() }).finally(function () { go.disabled = false; });
        });
        disputeBox.appendChild(f);
        ta.focus();
      }

      if (c.disputed)
        b.appendChild(el("div", "note small", "Đơn đang khiếu nại. ClickDeal không phân xử và không chịu trách nhiệm nếu một bên cung cấp thông tin sai hoặc không thanh toán. Toàn bộ trao đổi được lưu lại, không sửa hay xóa được, và sẽ được cung cấp trung thực khi cơ quan chức năng yêu cầu."));

      b.appendChild(el("div", "section-title", "Trao đổi với " + d.affiliate.displayName));
      b.appendChild(CD.thread(d.events, "buyer", c.status === "cancelled" ? null : function (m) {
        return CD.api("POST", "/v1/ext/claims/" + id + "/messages", m).then(load);
      }));
    }
    function btn(text, cls, fn, confirm2) {
      var b = el("button", cls, text);
      b.type = "button";
      var armed = false;
      b.addEventListener("click", function () {
        if (confirm2 && !armed) { armed = true; b.textContent = "Bấm lần nữa để xác nhận"; return; }
        b.disabled = true;
        Promise.resolve(fn()).finally(function () { b.disabled = false; });
      });
      return b;
    }
    sh.body.appendChild(h("div.big-status", [el("div", "spinner")]));
    load().catch(function (e) { sh.body.textContent = e.message; });
  }

  // ---------- Tab Tài khoản ----------
  var banksLoaded = false;
  function renderAccount() {
    if (!me) return;
    var p = $("profile");
    p.textContent = "";
    p.appendChild(CD.kv([
      ["Tên", me.nickname],
      ["Số điện thoại", me.phone],
      ["Người giới thiệu", me.affiliate.displayName + " (" + me.affiliate.code + ")"],
      ["Tỉ lệ hoàn", me.cashbackRate + "% hoa hồng"],
      ["Mã khách", me.refCode]
    ]));
    if (!banksLoaded) {
      banksLoaded = true;
      CD.api("GET", "/v1/public/banks").then(function (list) {
        list.forEach(function (bk) { $("bankBin").appendChild(new Option(bk.name, bk.bin)); });
        fillBank();
      });
    } else fillBank();
    $("extKeyOff").hidden = !me.hasExtensionKey;
  }
  function fillBank() {
    if (!me.bank) return;
    $("bankBin").value = me.bank.bin;
    $("bankAcc").value = me.bank.account;
    $("bankHolder").value = me.bank.holder;
  }
  $("bankForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    CD.api("PUT", "/v1/ext/bank", { bin: $("bankBin").value, account: $("bankAcc").value.replace(/\s/g, ""), holder: $("bankHolder").value })
      .then(function () { CD.msg($("bankMsg"), "✓ Đã lưu", true); loadMe(); })
      .catch(function (e) { CD.msg($("bankMsg"), e.message); });
  });
  $("extKeyBtn").addEventListener("click", function () {
    CD.api("POST", "/v1/ext/extension-key", {}).then(function (r) {
      var box = $("extKeyBox");
      box.textContent = "";
      // chuỗi kết nối = địa chỉ ClickDeal + mã: tiện ích dán 1 lần là đủ
      box.appendChild(CD.copyRow(location.origin + "/#key=" + r.token, "Copy chuỗi kết nối"));
      box.appendChild(el("p", "tiny muted", "Chuỗi chỉ hiện 1 lần. Không chia sẻ cho người khác: ai có chuỗi này là tạo được link bằng tài khoản của bạn."));
      $("extKeyOff").hidden = false;
    }).catch(function (e) { CD.toast(e.message, true); });
  });
  $("extKeyOff").addEventListener("click", function () {
    CD.api("DELETE", "/v1/ext/extension-key").then(function () {
      $("extKeyBox").textContent = "";
      $("extKeyOff").hidden = true;
      CD.toast("Đã tắt mã kết nối");
    });
  });
  $("logoutBtn").addEventListener("click", CD.logout);
  var delArmed = false;
  $("deleteBtn").addEventListener("click", function () {
    if (!delArmed) { delArmed = true; $("deleteBtn").textContent = "Bấm lần nữa để xóa vĩnh viễn"; return; }
    CD.api("DELETE", "/v1/ext/me").finally(function () { location.replace("/"); });
  });

  // ---------- Khởi động ----------
  setupInstall();
  // Mở từ tiện ích trình duyệt: /app/#report=<mã lượt bấm> → mở form báo đơn cho đúng sản phẩm
  var report = (location.hash.match(/^#report=([0-9a-f-]{36})$/i) || [])[1];
  if (report) window.history.replaceState(null, "", "/app/#orders");
  CD.tabs(["buy", "orders", "account"], function (t) { if (t === "orders") loadClaims(); });
  loadMe().then(refresh).then(function () {
    if (!report) return;
    var l = hist.links.filter(function (x) { return x.id === report; })[0];
    if (l && l.claim_no) CD.toast("Sản phẩm này đã được báo đơn #" + l.claim_no);
    else openClaimForm(l ? report : undefined);
  }).catch(function () {});
})();
