// Service worker: receives Web Push alarms from the server and shows them,
// and keeps a copy of the app for when the phone is offline.
const SHELL = "stock-watch-shell-v1";
const ALARM_CACHE = "stock-watch-alarm";
const ALARM_KEY = "./last-alarm.json";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

// Network first, falling back to the last copy we saw.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) (await caches.open(SHELL)).put(e.request, res.clone());
      return res;
    } catch {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      return hit || Response.error();
    }
  })());
});

self.addEventListener("push", e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: "Stock alarm", body: e.data && e.data.text() }; }
  // Test alarms behave exactly like real ones, so you can check what an alarm feels like.
  const isAlarm = data.type === "alarm" || data.type === "test";
  e.waitUntil((async () => {
    if (isAlarm) {
      const cache = await caches.open(ALARM_CACHE);
      await cache.put(ALARM_KEY, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }));
    }
    await self.registration.showNotification(data.title || "Stock alarm", {
      body: data.body || "",
      tag: "stock-alarm",
      renotify: true,
      requireInteraction: isAlarm,          // stays until you dismiss it
      vibrate: [1000, 300, 1000, 300, 1000, 300, 1000, 300, 2000],
      icon: "icon-192.png",
      badge: "badge-96.png",
      timestamp: data.at ? Date.parse(data.at) : Date.now(),
      data: { url: isAlarm ? "./?alarm=1" : "./" },
    });
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    wins.forEach(w => w.postMessage({ kind: "push", data }));
  })());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        w.postMessage({ kind: "open-alarm" });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
