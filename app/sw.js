// Offline support. Network first (so updates show up right away), cache as the fallback.
const CACHE = "paper-to-goodnotes-v2";
const FILES = ["./", "index.html", "app.js", "worker.js", "template.json", "manifest.webmanifest",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon.svg",
  "../src/extract.js", "../src/goodnotes.js", "../src/layout.js", "../src/page.js"];
self.addEventListener("install", (e) => e.waitUntil(
  caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const r = await fetch(e.request, { cache: "no-cache" });
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch {
      return (await c.match(e.request)) || Response.error();
    }
  })());
});
