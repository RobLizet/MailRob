// MailRob – Service Worker v2026
const CACHE = "mailrob-v1";
const ASSETS = ["./index.html","./manifest.json","./icon-192.png","./icon-512.png","./icon-maskable-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", e => {
  const url = e.request.url;
  // Altijd live: Google OAuth, Gmail API, Anthropic, fonts
  if (url.includes("googleapis.com") || url.includes("anthropic.com") ||
      url.includes("accounts.google.com") || url.includes("fonts.gstatic.com")) return;
  e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
});
