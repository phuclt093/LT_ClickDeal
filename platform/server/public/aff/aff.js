/* ClickDeal — ứng dụng cho affiliate. Phiên đăng nhập bằng cookie httpOnly (JS không đọc được). */
(function () {
  "use strict";
  var $ = CD.$, el = CD.el, h = CD.h;
  var me = null;
  var ov = null;
  var claimView = "review";
  var showTab;

  // ---------- Khởi động ----------
  CD.api("GET", "/v1/auth/me").then(function (u) {
    if (u.role === "buyer") return location.replace("/app/");
    if (!u.totpEnabled || !u.mfaPassed || !u.isAffiliate) return CD.toLogin();
    showTab = CD.tabs(["todo", "claims", "pay", "customers", "settings"], onTab);
    loadMe();
  }).catch(function () {});

  function onTab(t) {
    if (t === "todo") loadOverview();
    if (t === "claims") { loadOverview(); loadClaims(); }
    if (t === "pay") loadPay();
    if (t === "customers") loadCustomers();
    if (t === "settings") renderSettings();
  }
  function reloadCurrent() { onTab(location.hash.slice(1) || "todo"); }

  $("logoutBtn").addEventListener("click", CD.logout);
  document.querySelectorAll("[data-go]").forEach(function (b) {
    b.addEventListener("click", function () { go(b.getAttribute("data-go")); });
  });
  function go(target) {
    var p = target.split(":");
    if (p[1]) claimView = p[1];
    if (location.hash.slice(1) === p[0]) onTab(p[0]);
    else showTab(p[0]);
  }

  function loadMe() {
    return CD.api("GET", "/v1/aff/me").then(function (m) {
      me = m;
      $("who").textContent = m.displayName + " · " + m.code;
      $("pendingNote").hidden = m.status === "active";
      CD.badge("dotSettings", m.gatewayTemplate || m.linkMode === "api" ? 0 : 1);
      var box = $("inviteBox");
      box.textContent = "";
      box.appendChild(CD.copyRow(m.inviteUrl, "Copy link mời"));
      if (navigator.share) {
        $("shareInvite").hidden = false;
        $("shareInvite").onclick = function () {
          navigator.share({ title: "ClickDeal", text: "Mua Shopee nhận hoàn tiền qua " + m.displayName + ":", url: m.inviteUrl }).catch(function () {});
        };
      }
      if (location.hash.slice(1) === "settings") renderSettings();
      renderSetup();
    });
  }

  // ---------- Việc cần làm ----------
  function loadOverview() {
    return CD.api("GET", "/v1/aff/overview").then(function (o) {
      ov = o;
      $("sReview").textContent = o.review;
      $("sDue").textContent = o.due;
      $("sOwed").textContent = CD.vnd(o.owed);
      $("sDisputed").textContent = o.disputed;
      $("sDueCard").className = "stat" + (o.overdue ? " red" : o.due ? " orange" : "");
      $("sDispCard").className = "stat" + (o.disputed ? " red" : "");
      CD.badge("dotTodo", o.review + o.disputed);
      CD.badge("dotPay", o.due);
      var k = $("kpis");
      k.textContent = "";
      k.appendChild(CD.kv([
        ["Khách đang dùng", String(o.customers)],
        ["Lượt bấm mua 7 ngày qua", String(o.clicks7)],
        ["Đơn đã ghi nhận chưa trả", o.accepted + " đơn · " + CD.vnd(o.owed)],
        ["Chờ khách xác nhận đã nhận", o.awaiting_confirm + " đơn"],
        ["Đã trả tháng này", CD.vnd(o.paid_month)]
      ]));
      renderReminders();
      renderSetup();
      if (claimView) renderChips();
      return Promise.all([
        CD.api("GET", "/v1/aff/claims?view=review").then(function (l) { fillClaimList($("todoReview"), l.slice(0, 6), "Không có đơn mới. 👍"); }),
        o.disputed
          ? CD.api("GET", "/v1/aff/claims?view=disputed").then(function (l) {
              $("todoDispTitle").hidden = $("todoDispCard").hidden = false;
              fillClaimList($("todoDisputed"), l, "");
            })
          : (($("todoDispTitle").hidden = $("todoDispCard").hidden = true), null)
      ]);
    });
  }

  function renderReminders() {
    var r = $("reminders");
    r.textContent = "";
    if (!ov) return;
    if (ov.overdue) {
      r.appendChild(reminder("err", "⛔ " + ov.overdue + " đơn đã quá 6 tuần kể từ lúc khách báo mà chưa trả.",
        "Khách đang chờ lâu. Kiểm tra trạng thái trên AccessTrade, rồi trả tiền hoặc nhắn rõ lý do cho khách.", "claims:due", "Xem ngay"));
    }
    if (ov.due) {
      r.appendChild(reminder("", "⏰ " + ov.due + " đơn đến hạn kiểm tra (" + CD.vnd(ov.owed_due) + ").",
        "Vào AccessTrade → Báo cáo đơn hàng, xem các đơn này đã được duyệt chưa. Đã duyệt thì trả tiền cho khách; chưa thì bấm \"Nhắc lại sau 7 ngày\".", "pay", "Trả tiền"));
    }
    if (ov.review) {
      r.appendChild(reminder("info", "🧾 " + ov.review + " đơn mới khách vừa báo.", "Đối chiếu mã đơn trên AccessTrade rồi bấm Ghi nhận hoặc Từ chối.", "claims:review", "Duyệt đơn"));
    }
  }
  function reminder(kind, title, text, target, label) {
    var n = el("div", "note " + kind);
    n.appendChild(el("b", "", title));
    n.appendChild(el("div", "small", text));
    var b = el("button", "btn sm mt", label);
    b.type = "button";
    b.addEventListener("click", function () { go(target); });
    n.appendChild(b);
    return n;
  }

  function renderSetup() {
    if (!me) return;
    var hasGw = !!me.gatewayTemplate || me.linkMode === "api";
    var hasCust = ov ? ov.customers > 0 : true;
    $("setupCard").hidden = hasGw && hasCust;
    var ul = $("setupList");
    ul.textContent = "";
    [
      [hasGw, "Khai báo cổng nhận link", "Để link khách bấm có hoa hồng của bạn.", "settings"],
      [hasCust, "Gửi link mời cho khách", "Khách tạo tài khoản bằng số điện thoại.", "customers"],
      [false, "Duyệt đơn khách báo, trả tiền bằng VietQR", "ClickDeal nhắc bạn kiểm tra sau " + me.remindAfterDays + " ngày.", null]
    ].forEach(function (s, i) {
      var li = el("li", s[0] ? "done" : i === 2 ? "" : "todo");
      li.appendChild(el("span", "i", s[0] ? "✓" : String(i + 1)));
      var t = h("div", [el("b", "", s[1]), el("div", "small muted", s[2])]);
      if (!s[0] && s[3]) {
        var b = el("button", "btn link", "Làm ngay →");
        b.type = "button";
        b.addEventListener("click", function () { go(s[3]); });
        t.appendChild(b);
      }
      li.appendChild(t);
      ul.appendChild(li);
    });
  }

  // ---------- Danh sách đơn ----------
  var CHIPS = [
    ["review", "Chờ duyệt", "review"],
    ["due", "Đến hạn kiểm tra", "due"],
    ["accepted", "Chờ trả", "accepted"],
    ["disputed", "Khiếu nại", "disputed"],
    ["paid", "Đã trả", null],
    ["closed", "Từ chối/Hủy", null],
    ["all", "Tất cả", null]
  ];
  function renderChips() {
    var box = $("claimChips");
    box.textContent = "";
    CHIPS.forEach(function (c) {
      var b = el("button", "chip" + (claimView === c[0] ? " on" : ""), c[1]);
      b.type = "button";
      if (c[2] && ov && ov[c[2]]) b.appendChild(el("span", "n", String(ov[c[2]])));
      b.addEventListener("click", function () { claimView = c[0]; renderChips(); loadClaims(); });
      box.appendChild(b);
    });
  }
  function loadClaims() {
    renderChips();
    return CD.api("GET", "/v1/aff/claims?view=" + claimView).then(function (l) {
      var msgs = { review: "Không có đơn chờ duyệt.", due: "Chưa có đơn đến hạn kiểm tra.", disputed: "Không có khiếu nại." };
      fillClaimList($("claimList"), l, msgs[claimView] || "Chưa có đơn.");
    });
  }
  function fillClaimList(ul, list, emptyText) {
    ul.textContent = "";
    if (!list.length) {
      if (emptyText) ul.appendChild(el("li")).appendChild(CD.empty("🗂️", emptyText));
      return;
    }
    list.forEach(function (c) {
      var li = el("li", "tap");
      li.appendChild(h("div.t", [
        el("b", "", (c.customer ? c.customer.nickname || "(khách đã xóa)" : "") + " · " + (c.productName || "Đơn " + c.orderCode)),
        el("span", "", "#" + c.no + " · " + c.orderCode + " · báo " + CD.ago(c.submittedAt) + (c.orderAmount ? " · đơn " + CD.vnd(c.orderAmount) : ""))
      ]));
      var r = el("div", "r");
      if (c.cashback !== null) r.appendChild(el("b", "", CD.vnd(c.cashback)));
      var bw = h("div.btn-row", CD.statusBadges(c, "affiliate"));
      r.appendChild(bw);
      li.appendChild(r);
      li.addEventListener("click", function () { openClaim(c.id); });
      ul.appendChild(li);
    });
  }

  // ---------- Chi tiết đơn ----------
  function openClaim(id) {
    var sh = CD.sheet("Đơn", reloadCurrent);
    function load() { return CD.api("GET", "/v1/aff/claims/" + id).then(render); }
    function act(body) {
      return CD.api("POST", "/v1/aff/claims/" + id + "/actions", body)
        .then(function () { CD.toast("Đã cập nhật"); return load(); })
        .catch(function (e) { CD.toast(e.message, true); throw e; });
    }
    function render(d) {
      var c = d.claim, cu = d.customer;
      var b = sh.body;
      b.textContent = "";
      sh.title.textContent = "Đơn #" + c.no + " · " + (cu.nickname || "khách đã xóa");

      var info = el("div", "card");
      info.appendChild(h("div.btn-row", CD.statusBadges(c, "affiliate")));
      if (c.productName) info.appendChild(el("p", "", c.productName));
      info.appendChild(CD.kv([
        ["Mã đơn Shopee", copyInline(c.orderCode)],
        ["Tổng tiền đơn", c.orderAmount !== null ? CD.vnd(c.orderAmount) : "Khách không ghi"],
        ["Ngày đặt", c.orderedOn ? CD.date(c.orderedOn) : null],
        ["Khách báo lúc", CD.date(c.submittedAt, true) + " (" + c.ageDays + " ngày trước)"],
        ["Hoa hồng", c.commission !== null ? CD.vnd(c.commission) : null],
        ["Tiền hoàn cho khách", c.cashback !== null ? CD.vnd(c.cashback) : null],
        ["Nhắc kiểm tra", c.status === "accepted" && c.remindAt ? CD.date(c.remindAt) : null]
      ]));
      b.appendChild(info);
      if (c.status === "rejected" && c.rejectReason) b.appendChild(el("div", "note err small", "Bạn đã từ chối: " + c.rejectReason));

      // Đối chiếu
      var chk = el("div", "card");
      chk.appendChild(el("h3", "", "Đối chiếu"));
      if (d.click) {
        chk.appendChild(el("div", "note ok small", "✓ Khách đã mở sản phẩm qua ClickDeal lúc " + CD.date(d.click.at, true) + "."));
        var a = el("a", "small", d.click.productName || d.click.productUrl);
        a.href = d.click.productUrl;
        a.target = "_blank";
        a.rel = "noopener";
        chk.appendChild(a);
      } else {
        chk.appendChild(el("div", "note small", "Khách không chọn lượt mua qua ClickDeal. Kiểm tra kỹ trên AccessTrade."));
      }
      if (d.synced) {
        var st = { approved: "Đã duyệt", pending: "Chờ duyệt", rejected: "Bị hủy" }[d.synced.status] || d.synced.status;
        chk.appendChild(el("div", "note " + (d.synced.status === "rejected" ? "err" : "ok") + " small",
          "AccessTrade: đơn " + st + " · hoa hồng " + CD.vnd(d.synced.commission) + (d.synced.refMatches ? " · đúng mã khách ✓" : " · KHÁC mã khách")));
      }
      chk.appendChild(el("p", "small muted mb0", "Trên AccessTrade: Báo cáo → Đơn hàng, tìm mã đơn trên hoặc utm_content = " + cu.refCode + "."));
      b.appendChild(chk);

      // Khách
      var kc = el("div", "card");
      kc.appendChild(el("h3", "", "Khách"));
      var tel = null;
      if (cu.contact) { tel = el("a", "", cu.contact); tel.href = "tel:" + cu.contact.replace(/[^\d+]/g, ""); }
      kc.appendChild(CD.kv([
        ["Tên", cu.nickname || "(đã xóa tài khoản)"],
        ["Điện thoại", tel],
        ["Mã khách", cu.refCode],
        ["Tỉ lệ hoàn", cu.cashbackRate + "%"],
        ["Đơn khác", cu.otherClaims + " đơn" + (cu.otherDisputes ? " · " + cu.otherDisputes + " lần khiếu nại" : "")],
        ["Nhận tiền", d.bank ? d.bank.bankName + " ••• " + d.bank.account.slice(-4) : "Chưa thêm ngân hàng"]
      ]));
      b.appendChild(kc);

      // Hành động
      if (["submitted", "accepted", "rejected"].indexOf(c.status) >= 0) b.appendChild(acceptForm(c, cu));
      var row = el("div", "btn-row");
      if (c.status === "accepted") {
        row.appendChild(button("💸 Trả tiền đơn này", "btn", function () {
          sh.close();
          openPay({ id: cu.id, nickname: cu.nickname }, [c]);
        }));
        row.appendChild(button("Nhắc lại sau 7 ngày", "btn ghost", function () { return act({ action: "snooze", days: 7 }); }));
      }
      if (c.disputed) row.appendChild(button("Đóng khiếu nại", "btn ghost", function () { return act({ action: "close_dispute" }); }));
      if (row.children.length) b.appendChild(row);
      if (["submitted", "accepted"].indexOf(c.status) >= 0) b.appendChild(rejectForm());

      if (c.disputed)
        b.appendChild(el("div", "note small mt", "Khách đang khiếu nại. Hãy trao đổi rõ ràng kèm bằng chứng (ảnh AccessTrade, biên lai). Nội dung được lưu nguyên vẹn, không sửa hay xóa được."));

      b.appendChild(el("div", "section-title", "Trao đổi với khách"));
      b.appendChild(CD.thread(d.events, "affiliate", c.status === "cancelled" ? null : function (m) {
        return CD.api("POST", "/v1/aff/claims/" + id + "/messages", m).then(load);
      }));
    }

    function acceptForm(c, cu) {
      var f = el("form", "card");
      f.appendChild(el("h3", "", c.status === "accepted" ? "Cập nhật số tiền hoàn" : "Ghi nhận đơn hợp lệ"));
      var com = el("input");
      com.inputMode = "numeric";
      com.placeholder = "vd: 18000";
      if (c.commission !== null) com.value = String(c.commission);
      var cb = el("input");
      cb.inputMode = "numeric";
      cb.required = true;
      if (c.cashback !== null) cb.value = String(c.cashback);
      com.addEventListener("input", function () {
        var v = Number(com.value.replace(/[^\d]/g, ""));
        cb.value = v ? String(Math.floor((v * cu.cashbackRate) / 100)) : "";
      });
      function field(label, input, hint) {
        var l = el("label", "field");
        l.appendChild(el("span", "", label));
        l.appendChild(input);
        if (hint) l.appendChild(el("small", "", hint));
        return l;
      }
      f.appendChild(h("div.grid2", [
        field("Hoa hồng bạn nhận (₫)", com, "Xem trên AccessTrade."),
        field("Tiền hoàn cho khách (₫)", cb, "Tự tính theo " + cu.cashbackRate + "%, sửa được.")
      ]));
      var note = el("input");
      note.placeholder = "Ghi chú cho khách (không bắt buộc)";
      note.maxLength = 300;
      f.appendChild(note);
      var go = el("button", "btn block mt", c.status === "accepted" ? "Cập nhật" : "✓ Ghi nhận đơn hợp lệ");
      go.type = "submit";
      f.appendChild(go);
      f.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var body = { action: "accept", cashback: Number(cb.value.replace(/[^\d]/g, "")) || 0 };
        var cv = Number(com.value.replace(/[^\d]/g, ""));
        if (com.value.trim()) body.commission = cv;
        if (note.value.trim()) body.note = note.value.trim();
        go.disabled = true;
        act(body).catch(function () {}).finally(function () { go.disabled = false; });
      });
      return f;
    }
    function rejectForm() {
      var d = el("details", "card mt");
      d.appendChild(el("summary", "", "Từ chối đơn này"));
      var f = el("form");
      var ta = el("textarea");
      ta.required = true;
      ta.placeholder = "Lý do, vd: không thấy đơn trên AccessTrade sau 3 ngày; đơn bị hủy…";
      f.appendChild(ta);
      var go = el("button", "btn danger block mt", "Từ chối");
      go.type = "submit";
      f.appendChild(go);
      f.addEventListener("submit", function (ev) {
        ev.preventDefault();
        go.disabled = true;
        act({ action: "reject", reason: ta.value.trim() }).catch(function () {}).finally(function () { go.disabled = false; });
      });
      d.appendChild(f);
      return d;
    }
    sh.body.appendChild(h("div.big-status", [el("div", "spinner")]));
    load().catch(function (e) { sh.body.textContent = e.message; });
  }

  function button(text, cls, fn) {
    var b = el("button", cls, text);
    b.type = "button";
    b.addEventListener("click", function () {
      b.disabled = true;
      Promise.resolve(fn()).catch(function () {}).finally(function () { b.disabled = false; });
    });
    return b;
  }
  function copyInline(text) {
    var s = el("span");
    s.appendChild(document.createTextNode(text + " "));
    var b = el("button", "btn link", "Copy");
    b.type = "button";
    b.addEventListener("click", function () { CD.copy(text); });
    s.appendChild(b);
    return s;
  }

  // ---------- Trả tiền ----------
  function loadPay() {
    loadOverview();
    return CD.api("GET", "/v1/aff/payables").then(function (groups) {
      var box = $("payGroups");
      box.textContent = "";
      if (!groups.length) {
        var c = el("div", "card");
        c.appendChild(CD.empty("🎉", "Không còn khoản nào cần trả."));
        box.appendChild(c);
        return;
      }
      groups.forEach(function (g) { box.appendChild(payGroup(g)); });
    });
  }
  function payGroup(g) {
    var card = el("div", "card pay-group");
    var head = el("div", "card-head");
    head.appendChild(h("div", [el("h2", "", g.customer.nickname || "(khách đã xóa)"), el("div", "tiny muted", g.customer.bankLabel || "⚠ Chưa thêm tài khoản ngân hàng")]));
    if (g.dueTotal) {
      var due = el("span", "badge due right", "Đến hạn " + CD.vnd(g.dueTotal));
      head.appendChild(due);
    }
    card.appendChild(head);
    var list = el("div", "claims");
    var anyDue = g.claims.some(function (c) { return c.due || c.overdue; });
    var boxes = [];
    g.claims.forEach(function (c) {
      var l = el("label", "check");
      var cb = el("input");
      cb.type = "checkbox";
      cb.checked = anyDue ? c.due || c.overdue : true;
      cb.addEventListener("change", update);
      boxes.push({ cb: cb, c: c });
      l.appendChild(cb);
      l.appendChild(h("div.t", [
        el("b", "", "#" + c.no + " · " + (c.productName || c.orderCode)),
        el("span", "", "báo " + CD.date(c.submittedAt) + " · " + c.ageDays + " ngày" + (c.overdue ? " · quá 6 tuần" : c.due ? " · đến hạn" : ""))
      ]));
      l.appendChild(el("b", "num", CD.vnd(c.cashback)));
      list.appendChild(l);
    });
    card.appendChild(list);
    var foot = el("div", "pay-total");
    var total = el("b");
    var go = el("button", "btn", "Trả tiền");
    go.type = "button";
    foot.appendChild(total);
    foot.appendChild(go);
    card.appendChild(foot);
    function picked() { return boxes.filter(function (x) { return x.cb.checked; }).map(function (x) { return x.c; }); }
    function update() {
      var p = picked();
      total.textContent = CD.vnd(p.reduce(function (s, c) { return s + (c.cashback || 0); }, 0)) + " · " + p.length + " đơn";
      go.disabled = !p.length;
    }
    update();
    go.addEventListener("click", function () { openPay(g.customer, picked()); });
    return card;
  }

  function openPay(customer, claims) {
    var sh = CD.sheet("Trả tiền cho " + (customer.nickname || "khách"), reloadCurrent);
    var ids = claims.map(function (c) { return c.id; });
    sh.body.appendChild(h("div.big-status", [el("div", "spinner")]));
    CD.api("POST", "/v1/aff/payouts/qr", { customerId: customer.id, claimIds: ids }).then(function (q) {
      var b = sh.body;
      b.textContent = "";
      var card = el("div", "card");
      if (q.qr) {
        card.appendChild(el("p", "small muted center mb0", "Mở app ngân hàng → Quét QR. Số tiền và nội dung đã điền sẵn."));
        var qr = el("div", "qr");
        var img = el("img");
        img.src = q.qr;
        img.alt = "Mã VietQR";
        qr.appendChild(img);
        card.appendChild(qr);
        card.appendChild(CD.kv([
          ["Ngân hàng", q.bank.bankName],
          ["Số tài khoản", copyInline(q.bank.account)],
          ["Chủ tài khoản", q.bank.holder],
          ["Số tiền", copyInline(String(q.amount))],
          ["Nội dung", copyInline(q.note)]
        ]));
      } else {
        card.appendChild(el("div", "note small", "Khách chưa thêm tài khoản ngân hàng. Hãy nhắn khách trong khung trao đổi của đơn, hoặc trả bằng cách khác rồi ghi nhận bên dưới."));
        card.appendChild(CD.kv([["Số tiền", CD.vnd(q.amount)], ["Nội dung gợi ý", copyInline(q.note)]]));
      }
      b.appendChild(card);

      var f = el("form", "card");
      f.appendChild(el("h3", "", "Sau khi chuyển xong"));
      var method = el("select");
      ["Chuyển khoản ngân hàng", "Ví MoMo", "Ví ZaloPay", "Tiền mặt", "Khác"].forEach(function (m) { method.appendChild(new Option(m, m)); });
      var lm = el("label", "field");
      lm.appendChild(el("span", "", "Hình thức"));
      lm.appendChild(method);
      f.appendChild(lm);
      var pic = CD.imageInput("📷 Đính kèm ảnh biên lai (nên có)");
      var lp = el("div", "field");
      lp.appendChild(el("span", "", "Biên lai chuyển khoản"));
      lp.appendChild(pic.node);
      f.appendChild(lp);
      var note = el("input");
      note.placeholder = "Ghi chú cho khách (không bắt buộc)";
      note.maxLength = 300;
      f.appendChild(note);
      var msg = el("div", "msg");
      f.appendChild(msg);
      var go = el("button", "btn block", "✓ Tôi đã chuyển " + CD.vnd(q.amount));
      go.type = "submit";
      f.appendChild(go);
      f.appendChild(el("p", "tiny muted mb0", "Khách sẽ được báo để xác nhận đã nhận. Sau 7 ngày khách không phản hồi, đơn tự hoàn tất."));
      f.addEventListener("submit", function (ev) {
        ev.preventDefault();
        go.disabled = true;
        var body = { customerId: customer.id, claimIds: ids, method: method.value };
        if (note.value.trim()) body.note = note.value.trim();
        if (pic.get()) body.receipt = pic.get();
        CD.api("POST", "/v1/aff/payouts", body)
          .then(function () { CD.toast("Đã ghi nhận trả " + CD.vnd(q.amount)); sh.close(); })
          .catch(function (e) { CD.msg(msg, e.message); go.disabled = false; });
      });
      b.appendChild(f);
    }).catch(function (e) { sh.body.textContent = e.message; });
  }

  // ---------- Khách ----------
  function loadCustomers() {
    return CD.api("GET", "/v1/aff/customers").then(function (list) {
      var ul = $("custList");
      ul.textContent = "";
      $("custCount").textContent = list.length ? list.length + " khách" : "";
      if (!list.length) { ul.appendChild(el("li")).appendChild(CD.empty("👥", "Chưa có khách. Gửi link mời ở trên cho khách nhé.")); return; }
      list.forEach(function (c) {
        var li = el("li", "tap");
        li.appendChild(el("div", "ph", (c.nickname || "?").charAt(0).toUpperCase()));
        li.appendChild(h("div.t", [
          el("b", "", (c.nickname || "(đã xóa)") + (c.removed ? " · đã rời" : "")),
          el("span", "", (c.contact || "—") + " · " + c.clicks + " lượt bấm · " + c.claims + " đơn" + (c.customRate ? " · hoàn riêng " + c.cashbackRate + "%" : ""))
        ]));
        var r = el("div", "r");
        if (c.owed) r.appendChild(el("span", "badge accepted", "Nợ " + CD.vnd(c.owed)));
        r.appendChild(el("span", "tiny muted", "Đã trả " + CD.vnd(c.paid)));
        li.appendChild(r);
        li.addEventListener("click", function () { openCustomer(c); });
        ul.appendChild(li);
      });
    });
  }
  function openCustomer(c) {
    var sh = CD.sheet(c.nickname || "Khách", reloadCurrent);
    var b = sh.body;
    var info = el("div", "card");
    info.appendChild(CD.kv([
      ["Điện thoại", c.contact],
      ["Mã khách", c.refCode],
      ["Tham gia", CD.date(c.joinedAt)],
      ["Hoạt động gần nhất", c.lastSeenAt ? CD.ago(c.lastSeenAt) : "—"],
      ["Nhận tiền", c.bankLabel || "Chưa thêm ngân hàng"],
      ["Đang nợ", CD.vnd(c.owed)],
      ["Đã trả", CD.vnd(c.paid)]
    ]));
    b.appendChild(info);
    var f = el("form", "card");
    f.appendChild(el("h3", "", "Tỉ lệ hoàn riêng cho khách này"));
    var inp = el("input");
    inp.type = "number";
    inp.min = "0";
    inp.max = "100";
    inp.placeholder = "Để trống = theo mặc định (" + (me ? me.defaultCashbackRate : "") + "%)";
    if (c.customRate) inp.value = String(c.cashbackRate);
    var go = el("button", "btn", "Lưu");
    go.type = "submit";
    f.appendChild(h("div.inline", [inp, go]));
    f.addEventListener("submit", function (ev) {
      ev.preventDefault();
      CD.api("PUT", "/v1/aff/customers/" + c.id + "/rate", { cashbackRate: inp.value === "" ? null : Number(inp.value) })
        .then(function () { CD.toast("Đã lưu"); })
        .catch(function (e) { CD.toast(e.message, true); });
    });
    b.appendChild(f);
    b.appendChild(el("div", "section-title", "Đơn của khách"));
    var card = el("div", "card");
    var ul = el("ul", "list");
    card.appendChild(ul);
    b.appendChild(card);
    CD.api("GET", "/v1/aff/claims?view=all&customer=" + c.id).then(function (l) { fillClaimList(ul, l, "Khách chưa báo đơn nào."); });
  }

  // ---------- Cài đặt ----------
  function renderSettings() {
    if (!me) return;
    var gw = $("gwStatus");
    if (me.gatewayTemplate) {
      $("gwInput").value = me.gatewayTemplate;
      gw.className = "note ok small";
      gw.textContent = "✓ Đã khai báo cổng. Khách bấm mua sẽ đi qua cổng này.";
    } else if (me.linkMode === "api") {
      gw.className = "note info small";
      gw.textContent = "Đang dùng chế độ gọi API (dự phòng).";
    } else {
      gw.className = "note err small";
      gw.textContent = "Chưa có cổng: khách chưa tạo được link hoàn tiền. Làm bước này trước.";
    }
    $("rateInput").value = me.defaultCashbackRate;
    $("remindInput").value = me.remindAfterDays;
    $("syncToggle").checked = me.orderSyncEnabled;
    $("credForm").hidden = !me.orderSyncEnabled;
    var at = (me.credentials || []).filter(function (c) { return c.network === "accesstrade"; })[0];
    $("credStatus").textContent = at
      ? "✓ Đã lưu khóa ••••" + at.keyLast4 + (me.lastSyncedAt ? " · đồng bộ lần cuối " + CD.ago(me.lastSyncedAt) : "") + ". Nhập lại để thay khóa."
      : "Chưa có khóa.";
    $("atKey").required = !at;
    if (at && at.campaignId) $("atCamp").value = at.campaignId;
  }

  $("gwForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    CD.api("PUT", "/v1/aff/gateway", { template: $("gwInput").value.trim() }).then(function (r) {
      CD.msg($("gwMsg"), "✓ Đã lưu cổng", true);
      $("gwTestLink").href = r.example;
      $("gwTest").hidden = false;
      loadMe();
    }).catch(function (e) { CD.msg($("gwMsg"), e.message); });
  });
  $("prefForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    CD.api("PUT", "/v1/aff/settings", { defaultCashbackRate: Number($("rateInput").value), remindAfterDays: Number($("remindInput").value) })
      .then(function () { CD.msg($("prefMsg"), "✓ Đã lưu", true); loadMe(); })
      .catch(function (e) { CD.msg($("prefMsg"), e.message); });
  });
  $("syncToggle").addEventListener("change", function () {
    var on = $("syncToggle").checked;
    CD.api("PUT", "/v1/aff/settings", { orderSyncEnabled: on }).then(function () {
      me.orderSyncEnabled = on;
      $("credForm").hidden = !on;
      CD.toast(on ? "Đã bật tự đối chiếu" : "Đã tắt tự đối chiếu");
    }).catch(function (e) { CD.toast(e.message, true); $("syncToggle").checked = !on; });
  });
  $("credForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!$("atKey").value.trim()) return CD.msg($("credMsg"), "Nhập khóa API mới để lưu");
    CD.msg($("credMsg"), "Đang kiểm tra khóa…", true);
    CD.api("PUT", "/v1/aff/credentials", { network: "accesstrade", accessKey: $("atKey").value.trim(), campaignId: $("atCamp").value.trim() })
      .then(function () { $("atKey").value = ""; CD.msg($("credMsg"), "✓ Khóa hợp lệ, đã lưu (mã hóa)", true); loadMe(); })
      .catch(function (e) { CD.msg($("credMsg"), e.message); });
  });
  $("syncNow").addEventListener("click", function () {
    CD.msg($("credMsg"), "Đang đồng bộ…", true);
    CD.api("POST", "/v1/aff/sync", {})
      .then(function (r) { CD.msg($("credMsg"), "✓ Đã lấy " + r.upserted + " đơn", true); loadMe(); })
      .catch(function (e) { CD.msg($("credMsg"), e.message); });
  });
})();
