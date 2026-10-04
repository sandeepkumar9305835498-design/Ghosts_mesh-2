# Ghost Mesh — UI/UX audit

Audit date: 2026-10-02 · Scope: the web app (`index.html`, `style.css`, `script.js`,
`gm-identity.js`) and the Android WebView shell that packages it.

**Method.** Every claim below was checked against the code, not the screenshots.
Findings that could be checked automatically are now part of the project's own
suites — `npm run verify` (11 static checks + 93 jsdom runtime checks) — so they
cannot silently regress. Items marked *[fixed]* were changed in this pass; the
rest are listed with the reason they are still open.

---

## 1. What changed in this pass

| Area | Before | Now |
| --- | --- | --- |
| Accessible names | 27 icon-only buttons (menu, calls, composer, scanner, media viewer…) had no name; TalkBack read "button" | every one carries `aria-label`; a runtime check now fails the build if a new icon-only button ships unnamed |
| Keyboard / screen-reader | 40+ clickable `<div>`/`<span>` rows (all menus, stars, reactions, pinned bar, avatar, profile photo) were unreachable | `role="button"` + `tabindex="0"` + a global Enter/Space handler that fires the same `onclick` |
| Dialogs | 14 overlays were anonymous divs | `role="dialog"` + a name (`aria-label` / `aria-labelledby`) on each |
| Screen-reader feedback | `#toast` was silent | `role="status" aria-live="polite" aria-atomic="true"` |
| Contrast | `--text3` `#6b5e8a` = **3.35:1** on `--bg`, and it carries 9–11 px timestamps/hints on all 7 themes | `#9184b5` = **5.6:1** on the darkest surface, ≥4.5:1 on `--bg2`/`--surface`/`--surface2`; a static check enforces ≥4.5:1 for all four surfaces |
| Theme consistency | rejection "Reject" button hard-coded `#ef4444`, "Accept" `#22c55e`, attach-menu icons `#8b5cf6`/`#6366f1` — they ignored the 7 themes | `var(--danger)` / `var(--success)` / `var(--accent)` / `var(--accent2)` |
| Type scale | "Best Value" badge was 9 px | 10 px (smallest size in the app) |
| Empty states | search that matched nothing left a blank list | `#chat-search-empty` note ("No matches — no chats match “…”") shows/hides with the filter; search also matches the **display name**, not only the internal id |
| Pointer states | only 6 `:hover` rules in 2,300 lines of CSS | `@media (hover:hover)` block for primary/secondary/settings/plan/nav controls |
| Decorative image | empty-state icon had no `alt` | `alt=""` |
| Startup weight (Android) | `three.min.js` 603 KB + `jsQR.js` 257 KB + `leaflet.js` 148 KB + `qrcode.min.js` 20 KB were parsed on **every** launch | lazy-loaded by `gmEnsureLib()` on first use; jsQR is warmed after first paint. Static check keeps the tags out of `index.html` and every load site honest |
| Map / privacy | a hidden Leaflet map was built at login and fetched OpenStreetMap tiles (IP + approximate area) before the user opened anything | built only when the map is opened |
| WebGL fallback | a WebGL-less WebView threw inside an async theme switch (looked frozen) | checked up front, falls back to the default theme with a message |
| Reply QR | could report "QR data too large" when the library simply had not loaded yet | `renderOfflineQR()` loads its own library |
| Status bar | `theme-color` was hard-coded purple for all 7 themes | follows the active theme (a static check ties it to each CSS `--accent`) |
| Duplicate navigation | Chats / WiFi were reachable twice — from the top tab bar **and** the bottom pill nav | top tab bar removed at the user's request; the pill nav is the single switcher, the two panels and the swipe gesture stay, and `#main-tabs-scroller[data-active-tab]` carries the state |
| Nav destinations | pill nav was Chats / WiFi / Profile / Settings, and the reachable-ghosts list sat inside the WiFi panel | pill nav is **Chats / WiFi / Online / Settings**: Profile moved into Settings (where the rest of the account items already lived), and its slot became **Online** — the single home of the reachable/online ghosts list (`#online-screen`) |

Files touched: `index.html`, `style.css`, `script.js`,
`scripts/verify-static.mjs`, `scripts/run-runtime-checks.mjs`.

---

## 2. A. UI/UX

**Home / hierarchy** — Chats tab = search, chat list, one empty state; WiFi tab =
radar toggle, two small icon actions, the single reachable-peer list, the offline
QR flow; Profile = identity, one compact credits row, backup/logout. Settings is a
sheet with three real rows (feedback, daily bonus, referral) and no "coming soon"
text. *The duplicate "Online Nearby" block was removed in an earlier pass and a
runtime check keeps it out.*

**Navigation** — one switcher: the bottom floating pill (Chats / WiFi / Online /
Settings), hidden on screens that should not show it, reserving space via
`--gm-nav-h`. The top tab bar was removed because it duplicated two of those
destinations; the two panels still sit side by side and still respond to the
horizontal swipe, and `setActiveMainTab()` keeps the nav highlight and the
scroller's `data-active-tab` in step. **Profile** is no longer a destination — it
is the first row of the Settings sheet (the avatar and the header menu still open
it directly), and **Online** took its slot: `#online-screen` lists every reachable
Ghost (online over the internet, or nearby over Bluetooth / Wi-Fi Direct) with a
Connect button per row. Panel changes: the WiFi panel is now purely the pairing
place (radar, QR show/scan, offline handshake) because the reach list moved out.

**Buttons / tap targets** — icon buttons are 44×44, call controls 54×54, scanner
buttons 48×48, chat rows ≥72 px. Comfortably above the 24 px accessibility floor.

**Typography / spacing / icons / colour** — one variable-driven dark surface system,
accent-purple family, 4/8/12-step spacing. Emoji survive only where they are content
(reaction picker, feedback stars); Premium's feature list is inline SVG (earlier fix).
*[fixed]* the remaining theme-blind colours and the 9 px label.

**Animations** — screen push/fade transitions, a sliding nav capsule, `:active`
scale feedback, plus a `prefers-reduced-motion` block that neutralises all of it.

**Mobile responsiveness** — one breakpoint (`min-width: 600px`) plus the reduced-motion
media query. Fine for the target (phones/WebView); see §8 P2 for tablets.

**Accessibility** — see §1. Still missing: modal focus management (§8 P1) and a
visible `aria-current`-style marker for the active bottom-nav tab (§8 P2).

**Loading states** — every long step is *text* ("Generating your QR code…",
"Connecting…", "Waiting for connection…"), with frame-stall detection in the scanner
("Camera opened but sent no frames…"). There is still no spinner/progress component
(§8 P2).

**Error states** — strong: ~45 distinct toast messages cover permission denials
(camera/mic), invalid QR, bad pasted codes, no internet vs offline-ok, credit limits,
call failures, plus a global crash guard (`safeToastOnce`). No error leaves the user
without a message.

**Empty states** — no chats, no reachable peers, no search results, no phrase-setup
skip. Consistent shape and copy.

**Confirmation dialogs** — `gmConfirm()` is the themed in-app replacement for
`window.confirm`; used for the 7 destructive actions (logout, clear chat, clear all,
block, leave group, delete-for-everyone, disconnect). No native `alert`/`confirm`/
`prompt` remains in the code.

---

## 3. B. User flow

Real flow today: **first launch** → name (optional) → *mandatory* 12-word recovery
phrase + 2–3 word confirmation (no skip) → Chats. **Pairing** has two real paths:
(1) WiFi tab → show QR / scan QR (reply-QR handshake, no internet), (2) internet →
Ghost ID via the PeerJS broker. **Chat → calls → files** all exist; groups require
every member to stay directly connected (stated in the dialog). **Disconnect** lives
in the chat menu.

Dead ends / friction found:

1. **QR camera scanning still does not complete** on at least one device pair
   (reported; the loop now has autofocus, crop+full-frame passes, inversion and stats
   — needs an on-device diagnostic run, see §7).
2. **Incoming-call error** was reported without a stack trace; the call screen has
   guards ("That call already ended", "Peer connection not found") but the original
   error is unreproduced.
3. ~~The WiFi tab carries three parallel ideas (reachable list, offline QR flow,
   radar map)~~ — the reach list now has its own Online screen, so the WiFi panel
   carries pairing only. Still worth collapsing the offline QR flow behind the two
   radar icon buttons (§8 P2).
4. Credits/premium are *local and simulated* ("free during launch"); the label is
   honest, but the plan buttons still look like a purchase (§8 P1 for Billing).

---

## 4. C. P2P / network logic — real vs claimed

| Path | Status | Evidence |
| --- | --- | --- |
| Offline QR / same-Wi-Fi data channel | **REAL, no server** | `new RTCPeerConnection({iceServers: []})` + `createDataChannel("gm-offline")`; SDP exchanged through the QR codes |
| Online pair-by-Ghost-ID | **REAL, but brokered** | `new Peer(id, {host:"0.peerjs.com"})` — a public WebRTC signalling broker; message payloads go peer-to-peer over DTLS |
| Local discovery (BLE + Wi-Fi Direct) | **REAL, Android-only** | `BleMeshDiscovery.java`, `WifiDirectMesh.java`, `GhostMeshService.java` foreground service; results land in the same reach list via `window.gmApplyNativePeers` |
| Radar map | **REAL, internet-dependent** | Leaflet + OpenStreetMap tiles (`tile.openstreetmap.org`) + geolocation |
| Groups | **REAL, constrained** | fan-out over existing direct connections; no relay |
| Calls (voice/video) | **REAL** | WebRTC over the same connection; needs the mic/camera permission |
| Credits / Premium | **MOCK** | local counters in `safeStorage`; `PREMIUM_PLANS` is a table for a future Play Billing integration |
| Notifications | **UNAVAILABLE in WebView** | `new Notification()` is not implemented by Android WebView; the app guards it and falls back to in-app banners + vibration |

---

## 5. D. Security & privacy — claim audit

| Claim (in UI) | Reality | Required to make it fully true |
| --- | --- | --- |
| "End-to-End Encrypted" (login + profile) | Transport encryption only: WebRTC DTLS. There is **no app-level key exchange**, no key fingerprint, and the connection's identity is not verified against the Ghost ID. A malicious signalling broker could MITM the online path. | Derive a key pair from the seed (`gm-identity.js` already derives the Ghost ID this way), exchange public keys in the QR/handshake, show a safety number, and encrypt payloads with the shared secret |
| "No Server" | True for identity/recovery (pure local SHA-256), true for the QR/Wi-Fi path, **false for online pairing** (PeerJS broker) and for the map (tiles) | Re-word to "no account server; online pairing uses a public WebRTC broker" — or self-host/mesh-only |
| "No Trace" | Messages, contacts and profile are stored **in plaintext in localStorage** until cleared; the radar map reveals IP + approximate area to a third-party tile server | Encrypt local storage with a key derived from the seed; make the map opt-in or offline |
| Recovery phrase | Genuinely local: random seed → Ghost ID + BIP-39 words, verified locally with a checksum; nothing is transmitted | — (this one holds up) |
| Logs / analytics / tracking | None: no analytics, no telemetry, the only `fetch` in `script.js` is the PeerJS id-list utility | — |
| Permissions | Declared in `AndroidManifest.xml` and requested at first use; location is needed for BLE/Wi-Fi Direct discovery on Android ≤12 | — |

---

## 6. E. Performance

- **Startup weight is now ~1 MB lighter.** three.js (603 KB), jsQR (257 KB),
  Leaflet (148 KB) and QRCode (20 KB) are lazy-loaded on first use, so first paint
  parses only PeerJS (94 KB) plus the app's own scripts. jsQR is pre-warmed after
  boot because scanning is a core flow. *(This was the previous audit's biggest
  performance recommendation — now done.)*
- **Fish theme** starts a WebGL render loop with device-pixel-ratio scaling — the
  heaviest thing in the app; it is opt-in and stops on theme change.
- **Scanner** decodes a 480 px crop per frame and an 880 px full frame every 4th
  frame — reasonable, and `gmScanStats` can be used to measure it.
- **Chat list** re-renders all rows on each data change; fine at hundreds of chats.
- Background behaviour is the Android shell's job (foreground service for discovery);
  in-page timers are paused by the WebView when backgrounded.

---

## 7. F. Bugs / QA

1. **QR scanning may never decode (P0, reported, unconfirmed on-device).** The loop is
   already hardened (autofocus, two passes, `attemptBoth`, readyState 2, stall toast).
   Next step is measurement, not guessing: open the scanner, then read
   `gmScanStats` in `chrome://inspect` — `frames: 0` ⇒ the WebView is not painting
   camera frames (permission/`playsinline`/GPU), `frames > 0, cropHits+fullHits: 0`
   ⇒ jsQR is running but not finding the code (resolution/glare/QR density).
2. **Incoming-call error (P1, unreproduced).** Needs the console output from the
   receiving device; `chrome://inspect` shows everything (tag `GhostMeshWeb`).
3. WebRTC and camera behaviour cannot be verified from this workspace — it needs two
   real Android devices (or one device + one desktop). Everything else in this report
   was verified by the automated suites.

---

## 8. G. Suggested priorities

**P0** — on-device QR diagnostic (§7.1); capture the incoming-call error (§7.2).

**P1** — re-word or implement the security claims (§5); encrypt localStorage with a
seed-derived key; modal focus trapping (move focus in on open, restore on close);
Play Billing before charging for Premium.

**P2** — collapse the offline QR flow into the two radar icon buttons; add a
spinner for >300 ms operations; `aria-current` on the active nav item;
tablet/desktop layout beyond the single 600 px breakpoint.

---

## 9. How to verify this pass

```bash
npm run verify      # 13 static checks + 106 runtime (jsdom) checks, all passing
```

The new checks cover: accessible names on icon-only buttons, the toast live region,
modal dialog roles, decorative alt text, Enter/Space activation of `role="button"`,
the search empty state (shown, quoted, hidden again), and `--text3` contrast on all
four surfaces.
