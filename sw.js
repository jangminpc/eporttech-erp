// 오프라인에서도 앱 화면이 열리도록 파일을 저장해 둡니다 (자료는 IndexedDB에 따로 저장)
const CACHE = 'eporttech-erp-v3';
const FILES = ['./', './index.html', './app.css', './app.js', './manifest.webmanifest', './lib/xlsx.full.min.js', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // 구글 시트 동기화 요청은 그대로 통과
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request)));
});
