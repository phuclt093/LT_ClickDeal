// Service worker: lưu sẵn giao diện để mở nhanh; KHÔNG bao giờ lưu cache dữ liệu API hay ảnh bằng chứng.
const CACHE = "clickdeal-shell-v2";
const SHELL = ["/", "/index.html", "/app/", "/app/index.html", "/share.html", "/app.css", "/common.js", "/login.js", "/app/buyer.js", "/share.js", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/v1/")) return;
  // trang: mạng trước, lỗi mạng thì dùng bản đã lưu
  const key = url.pathname.startsWith("/j/") ? "/index.html" : url.pathname === "/share" ? "/share.html" : e.request;
  e.respondWith(fetch(e.request).catch(() => caches.match(key).then((r) => r || caches.match("/index.html"))));
});
