// 엄마 노래 USB - 서비스 워커
// 항상 인터넷에서 최신 파일을 먼저 받고, 안 되면 저장해 둔 파일로 화면을 띄웁니다.
const CACHE = "usb-app-v3";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "firebase-config.js",
  "manifest.webmanifest",
  "help.html",
  "seed_songs.json",
  "covers.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // 같은 주소의 GET 요청만 다룸 (Firebase·멜론 이미지 등은 브라우저에 맡김)
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  const key = url.origin + url.pathname; // ?t=... 같은 꼬리표는 빼고 저장
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit || caches.match("index.html")))
  );
});
