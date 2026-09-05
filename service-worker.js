const CACHE_NAME = "ghost-mesh-v8";

const urlsToCache = [
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  // All external libraries are hosted locally in this repo — no CDN
  // dependency, so the app works fully offline from the very first cache.
  "./peerjs.min.js",
  "./leaflet.css",
  "./leaflet.js",
  "./three.min.js",
  "./qrcode.min.js",
  "./jsQR.js",
  // Leaflet's CSS references these marker/layer icons by relative path —
  // without caching them, the Radar Map's pins render broken offline.
  "./images/marker-icon.png",
  "./images/marker-icon-2x.png",
  "./images/marker-shadow.png",
  "./images/layers.png",
  "./images/layers-2x.png"
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
