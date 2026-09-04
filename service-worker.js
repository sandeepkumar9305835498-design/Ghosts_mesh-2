const CACHE_NAME = "ghost-mesh-v5";

const urlsToCache = [
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  // External libraries the app depends on (PeerJS, map, QR generate/scan).
  // Without caching these, features like "Connect via WiFi"
  // silently fail the first time someone opens the app with no internet —
  // exactly the situation this app is meant to work in.
  "https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.js"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(urlsToCache.map(url =>
        cache.add(new Request(url, { mode: "cors" })).catch(err => {
          // Fall back to a no-cors "opaque" fetch — some CDNs don't send
          // CORS headers for cache.add's default request, but an opaque
          // cached response still lets fetch() serve it offline.
          return cache.add(new Request(url, { mode: "no-cors" })).catch(e2 =>
            console.log("SW skip:", url, e2)
          );
        })
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => k !== CACHE_NAME && caches.delete(k)))
    )
  );
  self.clients.claim();
});
