# Ghost Mesh — UI/UX audit

Audit date: 2026-10-02 · Scope: the web app (`index.html`, `style.css`, `script.js`,
`gm-identity.js`) and the Android WebView shell that packages it.

**Method.** Every claim below was checked against the code, not the screenshots.
Findings that could be checked automatically are now part of the project's own
suites — `npm run verify` (20 static checks + 305 jsdom runtime checks) — so they
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
| Map / privacy | a hidden Leaflet map was built at login and fetched OpenStreetMap tiles (IP + approximate area) before the user opened anything | built only when the map is opened — and it is a full-screen destination now (bottom nav → **Map**), with no location read until "Use my location" is tapped |
| WebGL fallback | a WebGL-less WebView threw inside an async theme switch (looked frozen) | checked up front, falls back to the default theme with a message |
| Reply QR | could report "QR data too large" when the library simply had not loaded yet | `renderOfflineQR()` loads its own library |
| Status bar | `theme-color` was hard-coded purple for all 7 themes | follows the active theme (a static check ties it to each CSS `--accent`) |
| Duplicate navigation | Chats / WiFi were reachable twice — from the top tab bar **and** the bottom pill nav | top tab bar removed at the user's request; the pill nav is the single switcher, the panels and the swipe gesture stay (three of them now: Chats / WiFi / Bluetooth), and `#main-tabs-scroller[data-active-tab]` carries the state |
| Bluetooth tab | Bluetooth existed only as a tag inside one mixed peer list, so there was no place to see (or start) a Bluetooth pairing | each radio owns its list via `gmPeersByTransport()`: the **Bluetooth** panel shows BLE phones with their own toggle/refresh, the **WiFi** panel shows Wi-Fi Direct phones, and the Chats strip still lists every transport. Tapping Connect on a BLE phone explains that the chat link opens over the shared hotspot and drops the user on the WiFi tab's QR handshake, instead of firing a Wi-Fi Direct join at a BLE address |
| Profile editing | the name was editable but the phone number was display-only — "there is no way to edit it" | both are inputs with their own Save button, stored device-only (never part of the Ghost ID); Settings → My Profile says so |
| Profile photo | a picked photo was saved as-is, so tall pictures were cropped blind by CSS and the face could land outside the circle | a drag-and-zoom adjuster (`#dp-crop-modal`, pinch or slider) previews the exact circle and saves a 512 px square JPEG |
| Daily bonus | one tap paid 5 credits, which made the credit economy nearly free | `BONUS_AMOUNT = 2`; the bigger earn is the sponsor break, which is a real view with a daily cap |
| Nav destinations | pill nav was Chats / WiFi / Profile / Settings, and the reachable-ghosts list sat inside the WiFi panel | pill nav is **Chats / WiFi / Bluetooth / Map**: Profile lives in Settings, Settings itself moved into the header 3-dot menu (it only ever opened a sheet), and its old slot is the full-screen map. **Bluetooth** replaced Online as a real transport panel (BLE-discovered phones only), while the every-transport list (`#online-screen`) opens from the header menu's "Nearby Ghosts" |
| Incoming call | the answer buttons were a thin strip pinned to the bottom of the call screen — easy to miss, and nothing else on screen said who was calling | the whole screen rings, dialer style: app name, caller name, "Incoming video/voice call", the caller's avatar and two labelled answers (Accept / Decline). `#incoming-call-overlay` is a real layer (`inset: 0`) and a static check fails if it collapses back to a strip |
| Call buttons | six identical circles in one row (mute, video, switch camera, battery saver, end, speaker) — "bahut sare button aate hai" | the row is the short dialer set **Mute · Camera · End(red, centre) · Speaker · More**, each with a label; switch camera and the battery saver moved into the `⋮` More sheet |
| Answering without a camera | if the receiver's video capture failed (camera refused, busy, single-camera device), `acceptIncomingCall()` logged it and **rejected the call** — the caller just never connected | video is tried first, then the app answers **audio-only** and says so ("Camera unavailable — answering with voice only"), so the call is still received. Only a missing mic rejects it, and then the caller is told |
| Placing a video call | a refused camera ended the attempt with a toast | the app asks once ("Call with voice only instead?") and places the voice call on confirm |
| Unanswered calls | the caller's screen rang forever — there was no "no answer" state | a 45 s timeout (receiver's `showIncomingCallUI` already had one) ends the attempt with "No answer — the call was not picked up" |
| Empty-state buttons | `.cancel-btn { flex: 1 }` inside the empty state's column flex box stretched "Scan a friend's QR" into a tall block (the giant button in the screenshots) | the two actions sit in `.empty-actions` with `flex: 0 0 auto`, compact padding and auto width; a static check pins the rule |
| Account privacy | any Ghost ID that knew yours could open a chat — there was no "request" gate to switch off either way | Settings → **Account Privacy** (device-local, `gm_privacy`): **Private** is the default — a new person sends a request the user accepts before any chat opens or a call can ring; **Public** (opt-in, reversible) approves the connection straight away. Blocked Ghosts are still rejected before the gate, and the QR/Wi-Fi handshake is unchanged because pairing in person is already consent |
| Map chrome vanishing | the screen carried a permanent `transform` (screen animations used `animation-fill-mode: both`) and the top bar/bottom card were absolutely positioned **over** the map, so panning, a stray tap or an Android repaint could leave them painted away — the owner reported "after a while, or tapping the middle, the top and bottom disappear" | `#map-screen` is a fixed full-screen flex column with three flow children (slim bar → map `flex: 1` → compact bar); nothing overlays the map, the long privacy note moved behind a ⓘ toggle, and the animations no longer leave a transform behind. A resize/rotation listener re-measures Leaflet |
| Where Wi-Fi peers live | the WiFi panel lists Wi-Fi Direct devices only, which left people asking why the person they message over the internet is not on the WiFi tab | unchanged by design — each radio keeps its own list and **Chats is the all-transport list** (WebRTC + Wi-Fi Direct + Bluetooth). The WiFi panel now says so in one line (`#wifi-others-caption`) instead of leaving it to be discovered |

Files touched: `index.html`, `style.css`, `script.js`,
`scripts/verify-static.mjs`, `scripts/run-runtime-checks.mjs`.

---

## 2. A. UI/UX

**Home / hierarchy** — Chats tab = search, online-now strip (every transport: internet,
Bluetooth, Wi-Fi Direct), chat list, one empty state; WiFi tab = radar toggle, two
small icon actions, the Wi-Fi Direct phones that radio found, the offline QR flow;
Bluetooth tab = the same shape over BLE (toggle, refresh, phones near you); Map =
a full-screen Leaflet surface; Profile = identity, editable name **and phone**, one
compact credits row, backup/logout. Settings is a sheet with real rows (feedback,
daily bonus, referral) and no "coming soon" text. *The duplicate "Online Nearby"
block was removed in an earlier pass and a runtime check keeps it out.*

**Navigation** — one switcher: the bottom floating pill (Chats / WiFi / Bluetooth /
Map), hidden on screens that should not show it, reserving space via `--gm-nav-h`.
The top tab bar was removed because it duplicated two of those destinations; the
three panels still sit side by side and still respond to the horizontal swipe, and
`setActiveMainTab()` keeps the nav highlight and the scroller's `data-active-tab` in
step. **Profile** is the first row of the Settings sheet; **Settings** itself is now
inside the header 3-dot menu (nothing was lost — the sheet is unchanged), and its
old nav slot is **Map**, a full-screen screen (`#map-screen`) that plots only real
positions. **Bluetooth** took the slot Online used to hold and lists only
BLE-discovered phones, so each radio has its own list and the Chats tab still shows
every peer regardless of transport; the every-transport list (`#online-screen`)
opens from the header menu's "Nearby Ghosts".

**Buttons / tap targets** — icon buttons are 44×44, call controls 54×54 (the red End
button 64×64), answer buttons 68×68, scanner buttons 48×48, chat rows ≥72 px.
Comfortably above the 24 px accessibility floor. The in-call row carries five
labelled controls instead of six unlabelled circles, and the empty-state actions
size to their text instead of stretching to fill the column.

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
call failures ("No answer", "Mic unavailable — call rejected", "Camera unavailable —
answering with voice only"), plus a global crash guard (`safeToastOnce`). No error
leaves the user without a message.

**Empty states** — no chats, no reachable peers, no Bluetooth/Wi-Fi-Direct phones, no search results, no phrase-setup
skip. Consistent shape and copy.

**Confirmation dialogs** — `gmConfirm()` is the themed in-app replacement for
`window.confirm`; used for the destructive actions (logout, clear chat, clear all,
block, leave group, delete-for-everyone, disconnect) plus the two opt-ins (live
location, opening a chat link to a Bluetooth-discovered phone). No native
`alert`/`confirm`/`prompt` remains in the code.

---

## 3. B. User flow

Real flow today: **first launch** → name (optional) → 12-word recovery phrase with
confirmation **or "Skip for now"** (the words stay in Profile → Recovery Phrase) →
Chats → the bottom nav's Chats / WiFi / Bluetooth panels plus the full-screen Map.
**Pairing** has three real paths: (1) WiFi tab → show QR / scan QR (reply-QR
handshake, no internet), (2) internet → Ghost ID via the PeerJS broker, (3)
Bluetooth tab → BLE finds the phone nearby, then the chat link opens over Wi-Fi
Direct or the shared hotspot. **Chat → calls → files** all exist; groups require
every member to stay directly connected (stated in the dialog). **Disconnect** lives
in the chat menu.

Dead ends / friction found:

1. **QR camera scanning still does not complete** on at least one device pair
   (reported; the loop now has autofocus, crop+full-frame passes, inversion and stats
   — needs an on-device diagnostic run, see §7).
2. **Incoming-call error** was reported without a stack trace. The three paths that
   could swallow a received call are now handled explicitly: a refused camera
   answers audio-only instead of rejecting, an online call without the signalling
   socket says so instead of throwing inside a promise, and the caller gets a "No
   answer" timeout. The WebView still has to be *open* to ring — a backgrounded app
   cannot receive a call, because the ringing happens in the page (§7.2).
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
| Live Map | **REAL, internet-dependent** | Leaflet + OpenStreetMap tiles (`tile.openstreetmap.org`); your own fix only after "Use my location", plus pins from location cards people chose to share — no simulated positions |
| Groups | **REAL, constrained** | fan-out over existing direct connections; no relay |
| Calls (voice/video) | **REAL** | WebRTC over the same connection; needs the mic/camera permission |
| Credits / Premium | **MOCK** | local counters in `safeStorage`; `PREMIUM_PLANS` is a table for a future Play Billing integration |
| Sponsor break (ad surface) | **REAL slot, house advert by default** | `#gm-ad-screen` + `gm-ad-slot`; `gmAdNetwork()` serves Google AdSense when `gm-ad-network`/`gm-ad-client`/`gm-ad-slot` meta tags are set, a custom URL slot for `gm-ad-html-url`, and otherwise the app's own Premium advert labelled "House ad". It opens from the 3-dot menu (rewarded, +2) and on a theme change — nowhere else. Daily cap: 10 views |
| Notifications | **UNAVAILABLE in WebView** | `new Notification()` is not implemented by Android WebView; the app guards it and falls back to in-app banners + vibration |

---

## 5. D. Security & privacy — claim audit

| Claim (in UI) | Reality | Required to make it fully true |
| --- | --- | --- |
| "End-to-End Encrypted" (login + profile) | Transport encryption only: WebRTC DTLS. There is **no app-level key exchange**, no key fingerprint, and the connection's identity is not verified against the Ghost ID. A malicious signalling broker could MITM the online path. | Derive a key pair from the seed (`gm-identity.js` already derives the Ghost ID this way), exchange public keys in the QR/handshake, show a safety number, and encrypt payloads with the shared secret |
| "Privacy-first · End-to-end encrypted · Direct device-to-device" (current UI) | Accurate about identity/recovery (local SHA-256) and the QR/Wi-Fi path; online pairing still uses the public PeerJS broker to exchange metadata and the radar map still fetches tiles | Keep this wording; describe the broker in the privacy page (done). App-level payload encryption (ECDH + AES-GCM) is still outstanding |
| ~~"No Server" / "No Trace" / "Untraceable"~~ | Removed from the UI, the manifest and the store copy — they overstated the model (the online broker and tile server exist) | — (no longer claimed) |
| Chat storage at rest | Messages, contacts and profile are still stored **in plaintext in localStorage** until cleared | Encrypt local storage with a key derived from the seed — largest remaining privacy gap |
| Recovery phrase | Genuinely local: random seed → Ghost ID + BIP-39 words, verified locally with a checksum; nothing is transmitted | — (this one holds up) |
| Logs / analytics / tracking | None: no analytics, no telemetry, the only `fetch` in `script.js` is the PeerJS id-list utility | — |
| Ads | One ad surface (`#gm-ad-screen`), shown from the 3-dot menu and on a theme change only. With no ad-network meta tag configured it serves the app's own house advert — no third-party script, no ad tracker. Adding `gm-ad-network="adsense"` + client/slot tags swaps in AdSense, or `gm-ad-html-url` a sandboxed custom slot | Decide the network (if any) and add the tags — the rewarded flow, the 15s gate and the daily cap already work |
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
2. **Incoming call while the app is not in the foreground (P1, by design).** The ring
   lives in the page, so a WebView that Android has paused (app closed, or swiped
   away) cannot show it — the caller sees the new "No answer" timeout. Receiving in
   the background needs the native shell to take over (a data-channel event reaching
   Java, then a full-screen-intent notification); until then, both phones keep the
   app open. When the app *is* open, `chrome://inspect` (tag `GhostMeshWeb`) shows
   every call log line.
3. WebRTC and camera behaviour cannot be verified from this workspace — it needs two
   real Android devices (or one device + one desktop). Everything else in this report
   was verified by the automated suites.

---

## 8. G. Suggested priorities

**P0** — on-device QR diagnostic (§7.1); decide on the native background-call
notification for §7.2 (it is the only way an incoming call can reach a closed app).

**P1** — re-word or implement the security claims (§5); encrypt localStorage with a
seed-derived key; modal focus trapping (move focus in on open, restore on close);
Play Billing before charging for Premium.

**P2** — collapse the offline QR flow into the two radar icon buttons; add a
spinner for >300 ms operations; `aria-current` on the active nav item;
tablet/desktop layout beyond the single 600 px breakpoint.

---

## 9. How to verify this pass

```bash
npm run verify      # 20 static checks + 305 runtime (jsdom) checks, all passing
```

The new checks cover: accessible names on icon-only buttons, the toast live region,
modal dialog roles, decorative alt text, Enter/Space activation of `role="button"`,
the search empty state (shown, quoted, hidden again), and `--text3` contrast on all
four surfaces.
