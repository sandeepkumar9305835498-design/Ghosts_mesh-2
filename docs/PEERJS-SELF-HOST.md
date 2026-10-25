# Running your own PeerJS server (Render / Railway / any Node host)

Ghost Mesh's **online mode** needs one thing from the internet: a signalling server.
Messages, calls and files are still peer-to-peer (WebRTC); the server only introduces
two phones to each other and then gets out of the way.

## What the free public broker can and cannot do

| Thing | `0.peerjs.com` (public cloud) | Your own PeerServer |
| --- | --- | --- |
| Register a Ghost ID, connect by ID | **Yes** (works today) | Yes |
| Relay signalling messages | Yes | Yes |
| List who is currently online (`/peers`) | **No — answers 404** | Yes, with `allow_discovery: true` |

That 404 was the console error in the issue: the app was calling
`GET https://0.peerjs.com/peerjs/peers` every 12 s. Listing peers on the public cloud
requires a special permission from the PeerJS team for your API key, so the app no
longer calls it. Discovery of *strangers* therefore only comes back when you host your
own server (or you always pair by Ghost ID / QR / Bluetooth / Wi-Fi Direct).

## 1. The server (one file)

`server.js`:

```js
// Minimal Ghost Mesh signalling server.
// Render/Railway give you PORT and terminate TLS for you.
const { PeerServer } = require("peerjs");

const port = Number(process.env.PORT || 9000);

const server = PeerServer({
    port,
    path: "/",
    key: "ghostmesh",          // any string; must match gm-peer-key
    allow_discovery: true,     // enables GET /ghostmesh/peers (the online list)
    proxied: true              // required behind Render/Railway/Fly TLS proxies
});

server.on("connection", client => console.log("peer connected:", client.getId()));
server.on("disconnect", client => console.log("peer left:", client.getId()));
console.log("Ghost Mesh peer server listening on", port);
```

`package.json`:

```json
{
  "name": "ghostmesh-peer-server",
  "private": true,
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": { "peerjs": "^1.5.4" }
}
```

## 2. Deploy on Render

1. Push those two files to a GitHub repo (public or private).
2. Render → **New → Web Service** → pick the repo.
3. Language: **Node**. Build command: `npm install`. Start command: `npm start`.
4. Instance type: the free one is fine for testing. Create the service.
5. Render gives you a URL like `ghostmesh-peer.onrender.com`. TLS is automatic, so the
   client connects with `wss://…:443`.

Free instances **sleep after ~15 minutes idle**; the first connection then takes a few
seconds (cold start). The app keeps showing `Connecting…` and retries by itself, but for
a public app use the paid instance or a small €4 VPS.

## 3. Deploy on Railway

1. Railway → **New Project → Deploy from GitHub repo** → pick the same repo.
2. Railway detects Node and runs `npm start`.
3. **Settings → Networking → Generate Domain** to get `ghostmesh-peer.up.railway.app`.
4. Nothing else to configure — `PORT` is injected by Railway and TLS is terminated for
   you (`proxied: true` handles the `wss://` upgrade).

## 4. Point the app at your server

In `index.html`, inside `<head>` (values must match `server.js`):

```html
<meta name="gm-peer-host" content="ghostmesh-peer.onrender.com">
<meta name="gm-peer-port" content="443">
<meta name="gm-peer-key" content="ghostmesh">
<!-- Only works on your OWN server with allow_discovery: true -->
<meta name="gm-peer-discovery" content="on">
```

`script.js` reads these at runtime (`gmMeshBrokerOpts()`), so no code change is needed.
Remove the tags to go back to the public cloud broker.

If the override cannot be reached, the app falls back to the public broker once and
keeps retrying with a 3 s → 30 s backoff instead of failing.

## 5. Check it

- Browser: `https://ghostmesh-peer.onrender.com/ghostmesh/peers` → JSON array of IDs.
  A 401 means `allow_discovery` is off; a 404 means the `key` or `path` is wrong.
- App console: `myPeerInstance.id` should be your Ghost ID, and the label must stop
  saying `connecting…`.
- Real devices: put both phones on different networks (one Wi-Fi, one mobile data) and
  send a message — that proves the TURN relay in `GM_ICE_SERVERS` is doing its job.

## Notes

- The server never sees message contents: only SDP/ICE handshake data passes through it.
- There is no account, no database and nothing to back up — restarting it is harmless.
- Keep `key` private-ish; it is not a strong secret (it ships in the page), it only
  separates your namespace from other apps on the same server.
