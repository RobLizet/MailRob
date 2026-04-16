// MailRob – Service Worker v2026 + NOTIFICATIES
const CACHE = "mailrob-v2";
const ASSETS = ["./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
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
  // Altijd live voor API’s
  if (url.includes("googleapis.com") || url.includes("anthropic.com") ||
      url.includes("accounts.google.com") || url.includes("fonts.gstatic.com")) {
    return;
  }
  e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
});

// ──────────────────────────────────────
// NOTIFICATIES
// ──────────────────────────────────────
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(location.origin + location.pathname + "#inbox")
  );
});

// Periodic Background Sync (elke \~15-30 min)
self.addEventListener("periodicsync", async event => {
  if (event.tag === "mailrob-email-check") {
    // Voor nu tonen we een algemene melding (echte check is complex zonder token in SW)
    // Je kunt later uitbreiden met postMessage naar open clients
    self.registration.showNotification("📧 MailRob", {
      body: "Er zijn mogelijk nieuwe e-mails. Tik om te openen.",
      icon: "./icon-512.png",
      badge: "./icon-192.png",
      tag: "new-mail",
      vibrate: [200, 100, 200]
    });
  }
});

// Klaar voor echte push-meldingen (later met backend)
self.addEventListener("push", event => {
  const data = event.data ? event.data.json() : { title: "MailRob", body: "Nieuwe e-mail" };
  event.waitUntil(
    self.registration.showNotification(data.title || "📧 MailRob", {
      body: data.body || "Je hebt een nieuwe e-mail.",
      icon: "./icon-512.png",
      badge: "./icon-192.png",
      tag: "push-mail",
      vibrate: [300, 100, 300]
    })
  );
});