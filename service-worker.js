// ===== GHOST MESH SERVICE WORKER =====
// Strategy: network-first with a cache fallback.
//  - A cache-first strategy previously meant that once a device had cached
//    index.html/script.js, every later code change stayed invisible until the
//    cache name was bumped by hand — which looked exactly like "the bug is
//    still there even after it was fixed".
//  - It also precached ./images/*.png (Leaflet marker art) that this project
//    never shipped, so install logged 404s for six files every time.
// Network-first keeps the offline support while picking up changes instantly.

const CACHE_NAME = "ghost-mesh-v16";

const urlsToCache = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./gm-identity.js",
  "./bip39-wordlist.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./peerjs.min.js",
  "./leaflet.css",
  "./leaflet.js",
  "./three.min.js",
  "./qrcode.min.js",
  "./jsQR.js"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // One missing file must not abort the whole install.
      Promise.all(
        urlsToCache.map(url =>
          cache.add(url).catch(err => {
            console.warn("Cache add failed for:", url, err);
            return Promise.resolve();
          })
        )
      )
    )
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            console.log("Deleting old cache:", key);
            return caches.delete(key);
          }
          return undefined;
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  // Only handle our own files. Map tiles, the PeerJS broker and anything else
  // cross-origin must go straight to the network untouched.
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.status === 200 && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => cache.put(request, copy))
            .catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then(hit => {
          if (hit) return hit;
          // Navigation requests fall back to the cached shell when offline.
          if (request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});
