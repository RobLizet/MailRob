// MailRob – Service Worker v2026 (met Push Meldingen)
const CACHE = "mailrob-v2";
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
  if (url.includes("googleapis.com") || url.includes("anthropic.com") ||
      url.includes("accounts.google.com") || url.includes("fonts.gstatic.com") ||
      url.includes("firebaseapp.com") || url.includes("fcm.googleapis.com")) return;
  e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
});

// ══════════════════════════════════
// PUSH MELDINGEN
// ══════════════════════════════════
self.addEventListener("push", e => {
  let data = { title: "MailRob", body: "Je hebt een nieuwe e-mail", icon: "./icon-192.png" };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch(err) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || "./icon-192.png",
      badge: "./icon-192.png",
      tag: "mailrob-email",
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: data.url || "/" }
    })
  );
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) { existing.focus(); return existing.navigate(e.notification.data.url || "/"); }
      return clients.openWindow(e.notification.data.url || "/");
    })
  );
});
