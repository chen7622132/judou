/* 网络优先、离线兜底：改了代码立刻生效，断网也能打开 */
const CACHE = 'judou-v1';
const SHELL = ['./', './index.html', './manifest.json', './src/style.css', './src/app.js', './src/core.js', './src/store.js', './src/ui.js', './src/db.js', './vendor/ts-fsrs.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return; // 第三方 API 直接放行，不缓存
  e.respondWith(
    fetch(req)
      .then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
  );
});
