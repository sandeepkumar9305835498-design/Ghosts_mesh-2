// ===== GHOST MESH V3 - COMPLETE SCRIPT =====

// ===== STATE =====
let userPhoneNumber = "", userGhostID = "", userDisplayName = "", userCurrentDP = null;
let myPeerInstance = null;
let activeConnections = [];
let chatData = {};
let currentChatPeer = null;
let typingTimeout = null;
let pendingIncomingConnection = null;
let isViewOnceEnabled = false;
let selfDestructSeconds = 0;
let mediaRecorderInstance = null, recordedAudioChunks = [], isRecordingAudio = false;
let selectedMsgIdForContext = null;
let replyToMsgId = null, replyText = "";
let localMediaStream = null, activeP2PCallInstance = null, pendingIncomingCallEvent = null;
let isUsingFrontCamera = true;
let radarMapInstance = null;
let userLat = 20.5937, userLng = 78.9629;
let hasRealLocation = false; // true only once a real GPS fix is obtained — the values above are just a placeholder
let pinBuffer = "";
let liveLocationInterval = null;
let callTimerInterval = null;
let callSeconds = 0;
let isMuted = false, isSpeaker = false;
let isGhostMode = false;
let notificationsEnabled = true;
let currentTheme = "default";
let fishAnimId = null;
let fishes = [];
let editMessageId = null;
let onlineUsers = {};
let discoveredPeers = {}; // Ghost IDs seen on the public lobby broker but not yet connected
let lobbyPollInterval = null;
let safeZone = null;
let chatMuted = {};

// ===== GROUP CHAT =====
// groupId -> { id, name, members: [peerId,...] (does NOT include self), createdBy }
let groups = {};
function isGroupChat(id) { return !!(id && groups[id]); }

// THE CORE FIX: every per-chat action (message, typing, reaction, delete,
// destruct, location) must go ONLY to the relevant peer(s) — never to
// every connection the app happens to have open. For a 1:1 chat that's a
// single sendToPeer(); for a group it's a controlled fan-out to that
// group's member list only.
function sendToChat(chatId, payload) {
    if (!chatId) return;
    if (isGroupChat(chatId)) {
        groups[chatId].members.forEach(peerId => sendToPeer(peerId, payload));
    } else {
        sendToPeer(chatId, payload);
    }
}

// ===== OFFLINE (QR/WiFi) CALL SUPPORT =====
// Every offline peer's live RTCPeerConnection, keyed by Ghost ID, so voice/video
// calls can be added to the SAME connection used for offline chat via SDP
// renegotiation — no signaling server needed, the offer/answer/ICE just travel
// over the already-open data channel.
let offlinePeerConnections = {};
let activeOfflineCallPeer = null, activeOfflineCallType = null;

const bannedWords = ["blackmail","paisa do","rupay do","video leak","threat","leak"];

// ===== SAFE STORAGE =====
const safeStorage = {
    _memory: {},
    _ok: (() => { try { localStorage.setItem('__t','1'); localStorage.removeItem('__t'); return true; } catch(e){ return false; } })(),
    get(k){ if(this._ok){ try{ return localStorage.getItem(k); }catch(e){} } return this._memory[k]||null; },
    set(k,v){ if(this._ok){ try{ localStorage.setItem(k,v); return; }catch(e){} } this._memory[k]=v; },
    del(k){ if(this._ok){ try{ localStorage.removeItem(k); return; }catch(e){} } delete this._memory[k]; }
};

// ===== GLOBAL CRASH GUARD =====
// A single unexpected error anywhere (a null element, a bad message,
// a WebRTC hiccup) should never freeze or white-screen the whole app.
// Log it for debugging and let the person keep using everything else.
let lastCrashToastTime = 0;
function safeToastOnce(msg) {
    const now = Date.now();
    if (now - lastCrashToastTime < 4000) return; // avoid spamming toasts if errors repeat rapidly
    lastCrashToastTime = now;
    try { showToast(msg); } catch(e) { /* even the toast failed — nothing more we can safely do */ }
}
window.addEventListener("error", event => {
    console.error("Uncaught error:", event.error || event.message);
    safeToastOnce("Something went wrong — the app is still running, please try again");
});
window.addEventListener("unhandledrejection", event => {
    console.error("Unhandled promise rejection:", event.reason);
    safeToastOnce("Something went wrong — the app is still running, please try again");
    event.preventDefault();
});

// ===== MEDIA CAPTURE (safe wrapper) =====
// navigator.mediaDevices does not exist outside a secure context (file://,
// and some Android WebView wrappers). Touching it directly throws a
// TypeError *before* any .catch() can run, so every camera/mic entry point
// goes through this helper instead and gets a clear, actionable message.
function gmGetUserMedia(constraints) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const err = new Error("Camera/Mic are blocked outside a secure context");
        err.name = "InsecureContextError";
        err.insecureContext = true;
        showToast("Camera/Mic need https:// or a local server — a plain file:// won't work");
        return Promise.reject(err);
    }
    return navigator.mediaDevices.getUserMedia(constraints);
}
function isInsecureMediaError(e) { return !!(e && e.insecureContext); }

// ===== INIT =====
function gmEnsureIdentityThen(done) {
    // GMIdentity lives in gm-identity.js. If it failed to load we still let the
    // app run — but say so instead of pretending recovery exists.
    if (typeof GMIdentity === "undefined") {
        console.error("gm-identity.js did not load — identity recovery unavailable");
        if (typeof done === "function") done();
        return;
    }
    GMIdentity.ensureIdentityThen(done);
}

function initApp() {
    const pin = safeStorage.get("gm_pin");
    if (pin) { renderPinDots(); showEl("lock-screen"); }
    else {
        const phone = safeStorage.get("gm_phone");
        // A brand-new install has no seed yet: create one and make the person
        // confirm their 12-word phrase BEFORE the app opens (no skip).
        if (phone) gmEnsureIdentityThen(() => executeLogin(phone, safeStorage.get("gm_name")||""));
        else showEl("login-screen");
    }
    loadTheme();
    requestPermissions();
}

function requestPermissions() {
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(()=>{}, ()=>{});
}

// ===== PERMISSIONS =====
// Permissions are declared in manifest.json and requested on demand
// Camera/Mic: requested on call initiation
// Location: requested on map open
// Notifications: requested below
function requestNotificationPermission() {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
        try { Notification.requestPermission(); } catch(e) {}
    }
}

// ===== PIN LOCK =====
// PIN length is dynamic (4-digit free, 6-digit costs credits — set up from
// Settings, not at signup) so the dots and keypad logic read the saved
// length instead of hardcoding 4.
function getPinLength() {
    return parseInt(safeStorage.get("gm_pin_length") || "4", 10);
}
function renderPinDots() {
    const wrap = document.getElementById("pin-dots");
    if (!wrap) return;
    const len = getPinLength();
    wrap.innerHTML = "<span></span>".repeat(len);
}
function pinPress(d) {
    const len = getPinLength();
    if (pinBuffer.length >= len) return;
    pinBuffer += d;
    updatePinDots();
    if (pinBuffer.length === len) setTimeout(checkPin, 150);
}
function pinBackspace() { pinBuffer = pinBuffer.slice(0,-1); updatePinDots(); }
function updatePinDots() {
    document.querySelectorAll("#pin-dots span").forEach((s,i) => s.classList.toggle("filled", i < pinBuffer.length));
}
function checkPin() {
    if (pinBuffer === safeStorage.get("gm_pin")) {
        pinBuffer = "";
        updatePinDots();
        hideEl("lock-screen");
        const phone = safeStorage.get("gm_phone");
        if (phone) gmEnsureIdentityThen(() => executeLogin(phone, safeStorage.get("gm_name")||""));
        else showEl("login-screen");
    } else {
        pinBuffer = "";
        updatePinDots();
        showToast("Wrong PIN. Try again.");
    }
}

// ===== LOGIN =====
function verifyAndLogin() {
    const name = document.getElementById("user-display-name").value.trim();
    const phoneEl = document.getElementById("phone-number");
    const phone = phoneEl ? phoneEl.value.trim() : "";
    const pin = document.getElementById("set-pin-input").value.trim();
    if (!name) { showToast("Enter the name your contacts will see"); return; }
    // The phone number is optional and is NEVER used to build the Ghost ID —
    // that comes from the random seed, so nothing personal is guessable.
    if (phone && phone.replace(/\D/g, "").length < 6) { showToast("That phone number looks incomplete"); return; }
    if (pin.length === 4) safeStorage.set("gm_pin", pin);
    if (phone) safeStorage.set("gm_phone", phone); else safeStorage.del("gm_phone");
    safeStorage.set("gm_name", name);
    // Creates the seed on first run and shows the mandatory recovery phrase.
    gmEnsureIdentityThen(() => executeLogin(phone, name));
}

function executeLogin(phone, name) {
    userPhoneNumber = phone || "";
    // Ghost ID comes from the local seed (GMIdentity), never from the phone
    // number — so it is random, unguessable, and recoverable from the phrase.
    const identity = (typeof GMIdentity !== "undefined") ? GMIdentity.current() : null;
    userGhostID = identity ? identity.ghostId : ("Ghost-" + Math.floor(100000 + Math.random() * 899999));
    if (!identity) console.warn("No seed on this device — using a temporary Ghost ID");
    userDisplayName = name || safeStorage.get("gm_name") || "Ghost User";

    // One-time welcome bonus: brand-new Ghost ID (no credits key ever set
    // for it before) gets 10 free starter credits.
    if (safeStorage.get("gm_credits_" + userGhostID) === null) {
        safeStorage.set("gm_credits_" + userGhostID, "10");
    }

    const savedDP = safeStorage.get("gm_dp");
    userCurrentDP = savedDP || null;

    hideEl("login-screen"); hideEl("lock-screen");
    showEl("app-shell");
    showScreen("chatlist-screen");
    initMainTabsScroller();
    gmInitBottomNav();

    updateHeaderDisplay();
    updateProfileScreen();
    loadBlockedPeers();
    initMesh();
    initRadarMap();
    setupTypingListener();
    loadTheme();
    requestNotificationPermission();
    startOnlinePresenceBroadcast();
    gmStartNativeDiscovery();

    // FIX: app must be fully usable with zero internet. If there's no
    // connection, Online mode (PeerJS cloud) simply can't reach its
    // signaling server — that's expected. Send the person straight to the
    // WiFi tab, where offline connect (QR + direct WebRTC, no server at
    // all) works regardless of internet.
    if (!navigator.onLine) {
        setTimeout(() => {
            scrollToMainTab(1);
            showToast("No internet — use WiFi tab to chat, call & share files with nearby devices");
        }, 400);
    }
}

window.addEventListener("online", () => showToast("Back online"));
window.addEventListener("offline", () => showToast("No internet — WiFi tab still works fully offline"));

function updateHeaderDisplay() {
    // The Ghost ID comes from the local seed, so it is valid before any network
    // is reachable — show it straight away instead of "Connecting...".
    const label = document.getElementById("my-ghost-id-label");
    if (label) label.innerText = userGhostID;
    document.getElementById("my-name-display").innerText = userDisplayName;
    setAvatarDisplay("my-avatar-display", userCurrentDP);
}

function updateProfileScreen() {
    const nameInput = document.getElementById("profile-name-input");
    if (nameInput) nameInput.value = userDisplayName;
    const gid = document.getElementById("profile-ghost-id");
    if (gid) gid.innerText = userGhostID;
    const ph = document.getElementById("profile-phone");
    if (ph) ph.innerText = userPhoneNumber || "not set (optional)";
    setAvatarDisplay("profile-avatar-big", userCurrentDP);
    renderCreditsUI();
}

function setAvatarDisplay(elId, dpData) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (dpData) {
        el.innerHTML = `<img src="${dpData}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    } else {
        el.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="${el.classList.contains('big') ? 48 : el.classList.contains('call-size') ? 52 : 22}" height="${el.classList.contains('big') ? 48 : el.classList.contains('call-size') ? 52 : 22}"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>`;
    }
}

function logoutApp() {
    closeAllMenus();
    const hasSeed = (typeof GMIdentity !== "undefined") && GMIdentity.exists();
    const msg = hasSeed
        ? "Log out of Ghost Mesh?\n\nYour Ghost ID and its 12-word recovery phrase stay on this device, so you can log back in without them."
        : "Log out of Ghost Mesh?";
    if (!confirm(msg)) return;
    // The seed is the identity — logging out must NOT throw it away. Only the
    // device-local profile (name/phone/PIN) is cleared.
    gmStopNativeDiscovery();
    safeStorage.del("gm_phone"); safeStorage.del("gm_pin"); safeStorage.del("gm_name");
    location.reload();
}

// ===== SCREENS =====
// Pushed screens (chat / profile / themes) slide in from the right — the
// Android convention — while the root screen cross-fades. Both animations are
// pure CSS (see the POLISH PASS block in style.css) and are skipped entirely
// when the OS asks for reduced motion.
const GM_PUSH_SCREENS = { "chat-screen": true, "profile-screen": true, "theme-screen": true };
const GM_SCREEN_ANIM_MS = 340;
// BOTH the element and its class are remembered: navigating again before the
// timer fires used to orphan the class on the previous screen (leaving it stuck
// with a finished animation and unable to replay one later).
let gmScreenAnimEl = null;
let gmScreenAnimClass = null;
let gmScreenAnimTimer = null;

function gmPrefersReducedMotion() {
    try {
        return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) { return false; }
}

function gmAnimateScreen(el, id) {
    if (!el) return;
    clearTimeout(gmScreenAnimTimer);
    // Always clean up the previous screen first, whether or not its timer ran.
    if (gmScreenAnimEl && gmScreenAnimClass) gmScreenAnimEl.classList.remove(gmScreenAnimClass);
    gmScreenAnimEl = null;
    gmScreenAnimClass = null;
    if (gmPrefersReducedMotion()) return;
    const cls = GM_PUSH_SCREENS[id] ? "gm-screen-push" : "gm-screen-fade";
    // A class that is already on the element cannot replay its keyframes, so
    // force one reflow first — that is what makes re-entering a screen animate.
    void el.offsetWidth;
    el.classList.add(cls);
    gmScreenAnimEl = el;
    gmScreenAnimClass = cls;
    gmScreenAnimTimer = setTimeout(() => {
        el.classList.remove(cls);
        if (gmScreenAnimEl === el) { gmScreenAnimEl = null; gmScreenAnimClass = null; }
    }, GM_SCREEN_ANIM_MS);
}

// tabIndex lets a caller open the chat list straight onto a panel, so the pill
// nav can go to WiFi in one step instead of scrolling to Chats and back.
function showScreen(id, tabIndex) {
    document.querySelectorAll(".app-screen").forEach(s => s.classList.add("hidden"));
    const t = document.getElementById(id);
    if (t) t.classList.remove("hidden");
    gmAnimateScreen(t, id);
    gmSyncBottomNav(id);
    if (id === "chatlist-screen") scrollToMainTab(tabIndex === undefined ? 0 : tabIndex);
}
function showEl(id) { const e = document.getElementById(id); if(e) e.classList.remove("hidden"); }
function hideEl(id) { const e = document.getElementById(id); if(e) e.classList.add("hidden"); }

// Scrolls a container smoothly, falling back to an instant jump where
// Element.scrollTo({behavior}) is not implemented (a few older WebViews).
function gmScrollContainerTo(el, left) {
    if (!el) return;
    if (typeof el.scrollTo === "function") {
        try {
            el.scrollTo({ left, behavior: "smooth" });
            return;
        } catch (e) { /* fall through to the plain assignment below */ }
    }
    el.scrollLeft = left;
}

// ===== MAIN TABS (Chats / WiFi) =====
// The separate "Online" tab is gone: online peers now live in the Chats tab's
// "Online Nearby" list and in the WiFi tab's "Ghosts You Can Reach" list, both
// rendered from the same shared function so they can never disagree.
const GM_TABS = ["Chats", "WiFi"];

function scrollToMainTab(index) {
    const scroller = document.getElementById("main-tabs-scroller");
    const clamped = Math.max(0, Math.min(GM_TABS.length - 1, index));
    if (!scroller) return;
    // An explicit tab tap is the only time we deliberately align a panel:
    // a gentle smooth scroll, never a hard jump to the last page.
    gmScrollContainerTo(scroller, clamped * scroller.clientWidth);
    setActiveMainTab(clamped);
}

function setActiveMainTab(index) {
    const clamped = Math.max(0, Math.min(GM_TABS.length - 1, index));
    GM_TABS.forEach((_, i) => {
        document.getElementById("main-tab-btn-" + i)?.classList.toggle("active", i === clamped);
    });
    const indicator = document.getElementById("main-tab-indicator");
    if (indicator) {
        indicator.style.width = (100 / GM_TABS.length) + "%";
        indicator.style.transform = `translateX(${clamped * 100}%)`;
    }
    // Keep the bottom pill nav's highlight in step with the tab bar. This runs
    // on every scroll tick, so gmSetBottomNavActive() bails out early when the
    // answer has not changed instead of touching the DOM each time.
    gmSetBottomNavActive(clamped === 1 ? "wifi" : "chats", true);
    // Both tabs show reachable peers, so refresh whichever is on screen.
    renderPeerLists();
}

// Swipe physics: the panels are no longer scroll-snap at all (see style.css).
// A browser snap point is exactly what let a fast flick skip every panel and
// land on the last one. Snapping now happens here, once, after the gesture and
// its momentum have actually stopped — and only ever to the NEAREST panel, so
// a quick flick still travels through the panels naturally instead of jumping.
function initMainTabsScroller() {
    const scroller = document.getElementById("main-tabs-scroller");
    if (!scroller) return;
    let settleTimer = null;
    let dragging = false;

    scroller.addEventListener("scroll", () => {
        // Keep the tab highlight in sync while the finger is still moving...
        const active = Math.round(scroller.scrollLeft / (scroller.clientWidth || 1));
        if (active >= 0 && active < GM_TABS.length) setActiveMainTab(active);
        // ...and settle only after the scrolling has genuinely stopped.
        scheduleSettle();
    }, { passive: true });

    function scheduleSettle() {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(settle, 110);
    }

    function settle() {
        if (dragging || !scroller.isConnected) return;
        const width = scroller.clientWidth || 1;
        const nearest = Math.max(0, Math.min(GM_TABS.length - 1, Math.round(scroller.scrollLeft / width)));
        if (Math.abs(scroller.scrollLeft - nearest * width) < 1.5) return; // already aligned
        gmScrollContainerTo(scroller, nearest * width);
        setActiveMainTab(nearest);
    }

    // A fresh touch always wins over a pending settle, so a panel is never
    // yanked out from under a finger that just started dragging.
    scroller.addEventListener("touchstart", () => {
        dragging = true;
        clearTimeout(settleTimer);
    }, { passive: true });
    ["touchend", "touchcancel"].forEach(evt => scroller.addEventListener(evt, () => {
        dragging = false;
        scheduleSettle();
    }, { passive: true }));
    scroller.addEventListener("mousedown", () => { dragging = true; clearTimeout(settleTimer); });
    window.addEventListener("mouseup", () => { if (dragging) { dragging = false; scheduleSettle(); } });
}

// ===== BOTTOM FLOATING PILL NAV =====
// The swipeable tab bar at the top is untouched — this is a second, faster way
// to reach the same places (plus "New connection" and the profile). Both stay
// in agreement because the tab bar drives the highlight through
// setActiveMainTab(), and this drives the tab bar through showScreen().
const GM_NAV_SCREENS = { "chatlist-screen": true, "profile-screen": true };
let gmNavActiveKey = "";
let gmNavReady = false;

function gmInitBottomNav() {
    const nav = document.getElementById("gm-bottom-nav");
    if (!nav) return;
    if (gmNavReady) return;                 // listeners are registered once
    gmNavReady = true;
    // Rotation, the on-screen keyboard and a window resize all change the
    // geometry, so the capsule is re-measured once the layout settles.
    window.addEventListener("resize", () => gmMoveNavPill(true), { passive: true });
    window.addEventListener("orientationchange", () => setTimeout(() => gmMoveNavPill(true), 260));
    gmSetBottomNavActive(gmNavActiveKey || "chats", false);
}

function gmSetBottomNavVisible(visible) {
    const nav = document.getElementById("gm-bottom-nav");
    if (nav) nav.classList.toggle("hidden", !visible);
}

// Runs on every screen change, so the nav can never sit on top of a pushed
// screen (chat, themes) where it would only be in the way.
function gmSyncBottomNav(screenId) {
    const visible = GM_NAV_SCREENS[screenId] === true;
    gmSetBottomNavVisible(visible);
    if (!visible) return;
    if (screenId === "profile-screen") gmSetBottomNavActive("profile", true);
    gmMoveNavPill(true);
}

function gmSetBottomNavActive(key, animate) {
    const nav = document.getElementById("gm-bottom-nav");
    // Hot path: called on every scroll tick, so leave the DOM alone when the
    // highlight is already on the right item.
    if (key === gmNavActiveKey && nav && !nav.classList.contains("hidden")) return;
    gmNavActiveKey = key;
    if (!nav) return;
    const items = nav.querySelectorAll(".gm-nav-item");
    for (let i = 0; i < items.length; i++) {
        const on = items[i].getAttribute("data-nav") === key;
        items[i].classList.toggle("active", on);
        if (on) items[i].setAttribute("aria-current", "page");
        else items[i].removeAttribute("aria-current");
    }
    gmMoveNavPill(animate);
}

// Slides the highlight capsule onto the active item. The geometry is measured
// from the live DOM instead of being hard-coded, so it stays correct on every
// screen size, and it is themed (accent-tinted) rather than fixed-coloured.
function gmMoveNavPill(animate) {
    const nav = document.getElementById("gm-bottom-nav");
    const pill = document.getElementById("gm-nav-pill");
    if (!nav || !pill || !gmNavActiveKey) return;
    const btn = nav.querySelector('.gm-nav-item[data-nav="' + gmNavActiveKey + '"]');
    if (!btn) return;
    const btnRect = btn.getBoundingClientRect();
    if (!btnRect.width) return;             // nav is hidden / not laid out yet
    const navRect = nav.getBoundingClientRect();
    if (animate === false || pill.style.opacity !== "1") {
        // First paint (or an explicitly instant move): place it directly
        // instead of animating in from zero width.
        pill.style.transition = "none";
        requestAnimationFrame(() => { pill.style.transition = ""; });
    }
    // An absolutely positioned box is offset from its containing block's
    // padding box, so the nav's own border width has to come off the delta.
    const border = parseFloat(getComputedStyle(nav).borderLeftWidth) || 0;
    pill.style.width = btnRect.width + "px";
    pill.style.transform = "translateX(" + (btnRect.left - navRect.left - border) + "px)";
    pill.style.opacity = "1";
}

// Single entry point for every nav item, so the highlight and the destination
// can never drift apart (and the markup stays free of class juggling).
function gmNavGo(key) {
    closeAllMenus();
    if (key === "profile") { openProfile(); return; }
    if (key === "connect") { openNewConnect(); return; }
    showScreen("chatlist-screen", key === "wifi" ? 1 : 0);
}

function openProfile() { closeAllMenus(); updateProfileScreen(); showScreen("profile-screen"); }
function closeProfile() { showScreen("chatlist-screen"); }
function openThemePicker() { closeAllMenus(); buildThemeGrid(); showScreen("theme-screen"); }
function openOnlineUsers() {
    // "Nearby Ghosts" now lives inside the Chats tab — no third tab to switch to.
    closeAllMenus();
    showScreen("chatlist-screen");
    scrollToMainTab(0);
    const section = document.getElementById("nearby-section");
    if (section) {
        section.classList.add("flash");
        setTimeout(() => section.classList.remove("flash"), 900);
    }
}
// ===== LOBBY DISCOVERY =====
// No dedicated backend: PeerJS's own free cloud broker (the same one myPeerInstance
// already talks to for signaling) exposes a "who's currently connected" list for its
// default key. We poll that list so ANY two people with the app open can see and
// connect to each other, not just people who already know each other's Ghost ID.
function pollLobbyDiscovery() {
    if (!myPeerInstance || !myPeerInstance.id) return;
    const opts = myPeerInstance.options || {};
    const host = opts.host || "0.peerjs.com";
    const port = opts.port ? (":" + opts.port) : "";
    const key = opts.key || "peerjs";
    const url = `https://${host}${port}/${key}/peers`;
    fetch(url).then(r => r.ok ? r.json() : []).then(ids => {
        if (!Array.isArray(ids)) return;
        ids.forEach(id => {
            if (id && id !== userGhostID && !blockedPeers.has(id)) {
                discoveredPeers[id] = true;
            }
        });
        // Drop stale entries no longer reported by the broker (and not already an
        // active chat/connection, which we always want to keep visible)
        Object.keys(discoveredPeers).forEach(id => {
            if (!ids.includes(id) && !activeConnections.some(c => c.peer === id)) {
                delete discoveredPeers[id];
            }
        });
        renderOnlineUsers();
    }).catch(() => { /* broker discovery unavailable — silently skip, mesh presence still works */ });
}

function startLobbyDiscovery() {
    if (lobbyPollInterval) return;
    pollLobbyDiscovery();
    lobbyPollInterval = setInterval(pollLobbyDiscovery, 12000);
}

function refreshOnlineUsers() {
    // Refresh: make sure all open connections are in onlineUsers
    activeConnections.forEach(c => {
        if (c.open && !onlineUsers[c.peer]) {
            onlineUsers[c.peer] = { displayName: chatData[c.peer]?.displayName || c.peer, online: true };
        }
    });
    // Also surface people we've chatted with before but aren't connected
    // to right now, so the screen isn't empty for returning users.
    Object.keys(chatData).forEach(peerId => {
        if (isGroupChat(peerId)) return; // groups aren't individual peers
        if (!onlineUsers[peerId]) {
            onlineUsers[peerId] = { displayName: chatData[peerId]?.displayName || peerId, online: false };
        }
    });
    renderOnlineUsers();
}

function goBackToList() {
    currentChatPeer = null;
    stopFishAnimation();
    showScreen("chatlist-screen");
    renderChatList();
}

// ===== PROFILE ACTIONS =====
function saveDisplayName() {
    const n = document.getElementById("profile-name-input").value.trim();
    if (!n) { showToast("Enter a name"); return; }
    userDisplayName = n;
    safeStorage.set("gm_name", n);
    updateHeaderDisplay();
    broadcastToMesh({ type: "name-update", sender: userGhostID, displayName: n });
    showToast("Name saved!");
}

function saveStatus() {
    const s = document.getElementById("profile-status").value;
    broadcastToMesh({ type: "status-update", sender: userGhostID, status: s });
    if (s === "invisible") { isGhostMode = true; document.getElementById("ghost-mode-label").innerText = "Ghost Mode: On"; }
}

function copyGhostID() {
    navigator.clipboard?.writeText(userGhostID).then(() => showToast("Ghost ID copied!")).catch(() => showToast(userGhostID));
}

function triggerDPUpload() { document.getElementById("dp-file-input").click(); }

function handleDPChange(event) {
    const file = event.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        userCurrentDP = e.target.result;
        safeStorage.set("gm_dp", userCurrentDP);
        updateHeaderDisplay();
        updateProfileScreen();
        broadcastToMesh({ type: "dp-update", sender: userGhostID, dpData: userCurrentDP });
        showToast("Profile photo updated!");
    };
    reader.readAsDataURL(file);
}

// ===== GHOST MODE =====
function toggleGhostMode() {
    closeAllMenus();
    isGhostMode = !isGhostMode;
    const label = document.getElementById("ghost-mode-label");
    if (label) label.innerText = `Ghost Mode: ${isGhostMode ? "On" : "Off"}`;
    showToast(isGhostMode ? "Ghost Mode ON — you are invisible" : "Ghost Mode OFF — you are visible");
}

// ===== NOTIFICATIONS =====
function toggleNotifications() {
    closeAllMenus();
    notificationsEnabled = !notificationsEnabled;
    const label = document.getElementById("notif-label");
    if (label) label.innerText = `Notifications: ${notificationsEnabled ? "On" : "Off"}`;
    showToast(`Notifications ${notificationsEnabled ? "enabled" : "disabled"}`);
}

function toggleChatNotif() {
    closeAllMenus();
    if (!currentChatPeer) return;
    chatMuted[currentChatPeer] = !chatMuted[currentChatPeer];
    const label = document.getElementById("chat-notif-label");
    if (label) label.innerText = chatMuted[currentChatPeer] ? "Unmute Notifications" : "Mute Notifications";
    showToast(chatMuted[currentChatPeer] ? "Chat muted" : "Chat unmuted");
}

// ===== THEMES =====
const themes = [
    { id: "default", name: "Purple (Default)", bg: "#9b59f7" },
    { id: "ocean", name: "Ocean Blue", bg: "#2196f3" },
    { id: "amoled", name: "Pure Black", bg: "#bb86fc" },
    { id: "forest", name: "Forest Green", bg: "#4caf50" },
    { id: "whatsapp", name: "WhatsApp Green", bg: "#00a884" },
    { id: "sunset", name: "Sunset Orange", bg: "#ff6b35" },
    { id: "fish", name: "3D Fish (Live)", bg: "linear-gradient(135deg,#0a3d6b,#1a6b3a)" },
];

function buildThemeGrid() {
    const grid = document.getElementById("theme-grid");
    if (!grid) return;
    grid.innerHTML = "";
    themes.forEach(t => {
        const card = document.createElement("div");
        card.className = "theme-card" + (currentTheme === t.id ? " active" : "");
        card.style.background = t.bg;
        card.innerHTML = `<div style="font-size:13px;font-weight:700;text-shadow:0 1px 4px rgba(0,0,0,0.5);">${t.name}</div>`;
        card.onclick = () => applyTheme(t.id);
        grid.appendChild(card);
    });
}

function applyTheme(themeId) {
    const classes = ["theme-ocean","theme-amoled","theme-forest","theme-whatsapp","theme-sunset","theme-fish"];
    classes.forEach(c => document.body.classList.remove(c));
    currentTheme = themeId;
    safeStorage.set("gm_theme", themeId);
    if (themeId !== "default") document.body.classList.add("theme-" + themeId);
    if (themeId === "fish") startFishAnimation();
    else stopFishAnimation();
    buildThemeGrid();
    showToast("Theme applied!");
}

function loadTheme() {
    const saved = safeStorage.get("gm_theme");
    if (saved) applyTheme(saved);
}

// ===== 3D FISH ANIMATION (Three.js) =====
function startFishAnimation() {
    const wrap = document.getElementById("fish-canvas-wrap");
    const canvas = document.getElementById("fish-canvas");
    if (!wrap || !canvas || typeof THREE === "undefined") return;
    wrap.classList.remove("hidden");

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x0a1a2a, 0.85);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a1a2a, 8, 20);

    const camera = new THREE.PerspectiveCamera(60, canvas.offsetWidth / canvas.offsetHeight, 0.1, 100);
    camera.position.z = 8;

    const resize = () => {
        const w = wrap.offsetWidth, h = wrap.offsetHeight;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    };
    resize();

    // Ambient + directional light
    scene.add(new THREE.AmbientLight(0x9b59f7, 0.6));
    const dLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dLight.position.set(5, 5, 5);
    scene.add(dLight);

    // Create fish meshes
    fishes = [];
    const fishColors = [0xff6b9d, 0xffd700, 0x00d4ff, 0xff8c42, 0x96f7d2];

    for (let i = 0; i < 8; i++) {
        const fishGroup = new THREE.Group();

        // Body
        const bodyGeo = new THREE.SphereGeometry(0.25, 8, 8);
        bodyGeo.scale(1.8, 1, 1);
        const mat = new THREE.MeshPhongMaterial({ color: fishColors[i % fishColors.length], shininess: 80 });
        const body = new THREE.Mesh(bodyGeo, mat);
        fishGroup.add(body);

        // Tail
        const tailGeo = new THREE.ConeGeometry(0.18, 0.35, 4);
        tailGeo.rotateZ(Math.PI / 2);
        const tail = new THREE.Mesh(tailGeo, new THREE.MeshPhongMaterial({ color: fishColors[i % fishColors.length] }));
        tail.position.x = -0.48;
        fishGroup.add(tail);

        // Eye
        const eyeGeo = new THREE.SphereGeometry(0.05, 6, 6);
        const eye = new THREE.Mesh(eyeGeo, new THREE.MeshPhongMaterial({ color: 0x000000 }));
        eye.position.set(0.3, 0.1, 0.18);
        fishGroup.add(eye);

        fishGroup.position.set((Math.random()-0.5)*10, (Math.random()-0.5)*6, (Math.random()-0.5)*3);
        fishGroup.rotation.y = Math.random() * Math.PI * 2;

        scene.add(fishGroup);
        fishes.push({
            mesh: fishGroup,
            speed: 0.01 + Math.random() * 0.02,
            wobble: Math.random() * Math.PI * 2,
            wobbleSpeed: 1 + Math.random(),
            dirX: (Math.random()-0.5)*0.02,
            dirY: (Math.random()-0.5)*0.01,
            fleeing: false,
            fleeTimer: 0
        });
    }

    // Touch/click flee
    canvas.addEventListener("click", e => {
        const rect = canvas.getBoundingClientRect();
        const mx = ((e.clientX-rect.left)/rect.width)*2-1;
        const my = -((e.clientY-rect.top)/rect.height)*2+1;
        fishes.forEach(f => {
            const fx = f.mesh.position.x / 6;
            const fy = f.mesh.position.y / 4;
            if (Math.abs(fx-mx) < 0.4 && Math.abs(fy-my) < 0.4) {
                f.fleeing = true;
                f.fleeTimer = 60;
                f.dirX = (fx-mx) * 0.08;
                f.dirY = (fy-my) * 0.06;
            }
        });
    });

    let frameId;
    function animate() {
        frameId = requestAnimationFrame(animate);
        const t = Date.now() * 0.001;
        fishes.forEach(f => {
            f.wobble += f.wobbleSpeed * 0.04;
            f.mesh.rotation.z = Math.sin(f.wobble) * 0.15;
            // tail animation — rotate tail child
            const tail = f.mesh.children[1];
            if (tail) tail.rotation.z = Math.sin(f.wobble * 2) * 0.3;

            if (f.fleeing && f.fleeTimer > 0) {
                f.mesh.position.x += f.dirX * 3;
                f.mesh.position.y += f.dirY * 3;
                f.fleeTimer--;
                if (f.fleeTimer <= 0) f.fleeing = false;
            } else {
                f.mesh.position.x += f.dirX + Math.sin(t * f.wobbleSpeed + f.wobble) * 0.003;
                f.mesh.position.y += f.dirY + Math.cos(t * f.wobbleSpeed) * 0.002;
            }

            // Wrap around bounds
            if (f.mesh.position.x > 7) f.mesh.position.x = -7;
            if (f.mesh.position.x < -7) f.mesh.position.x = 7;
            if (f.mesh.position.y > 5) f.mesh.position.y = -5;
            if (f.mesh.position.y < -5) f.mesh.position.y = 5;

            // Face direction of movement
            const angle = Math.atan2(f.dirY, f.dirX);
            f.mesh.rotation.y = -angle + Math.PI;
        });
        renderer.render(scene, camera);
    }
    animate();
    fishAnimId = frameId;

    window.addEventListener("resize", resize);
    wrap._renderer = renderer;
    wrap._frameId = frameId;
}

function stopFishAnimation() {
    const wrap = document.getElementById("fish-canvas-wrap");
    if (wrap) {
        if (wrap._frameId) cancelAnimationFrame(wrap._frameId);
        if (wrap._renderer) wrap._renderer.dispose();
        wrap.classList.add("hidden");
    }
    fishes = [];
}

// ===== NATIVE MESH (BLE + Wi-Fi Direct, Android shell only) =====
// Inside the APK, window.GhostNative is injected by MainActivity; in a plain
// browser it does not exist and these calls quietly do nothing, so the web app
// keeps working exactly as before on the web.
function gmNativeMeshAvailable() {
    return !!(window.GhostNative && typeof window.GhostNative.startDiscovery === "function");
}

function gmStartNativeDiscovery() {
    if (!gmNativeMeshAvailable()) return;
    try {
        if (typeof window.GhostNative.isSupported === "function" && !window.GhostNative.isSupported()) return;
        if (typeof window.GhostNative.setGhostId === "function") window.GhostNative.setGhostId(userGhostID);
        if (typeof window.GhostNative.setDisplayName === "function") window.GhostNative.setDisplayName(userDisplayName);
        window.GhostNative.startDiscovery();
    } catch (e) {
        console.warn("Native mesh discovery unavailable:", e);
    }
}

function gmStopNativeDiscovery() {
    if (!gmNativeMeshAvailable()) return;
    try {
        window.GhostNative.stopDiscovery();
    } catch (e) {
        /* nothing to do — the browser/older shell has no native layer */
    }
}

// Status line pushed by the native layer (permission denied, scan started …).
window.gmApplyNativeStatus = function (message) {
    if (message) showToast(message);
};

// ===== MESH NETWORK =====
// How many times the broker reported our Ghost ID as taken (see the error
// handler below) — used to pick a deterministic fallback suffix.
let peerIdRetries = 0;

function initMesh() {
    try {
        myPeerInstance = new Peer(userGhostID, {
            config: {
                iceServers: [
                    { urls: "stun:stun.l.google.com:19302" },
                    { urls: "stun:stun1.l.google.com:19302" },
                    { urls: "stun:global.stun.twilio.com:3478" }
                ]
            },
            debug: 0
        });
        myPeerInstance.on('open', id => {
            document.getElementById("my-ghost-id-label").innerText = id;
            showToast("Ghost Mesh Live: " + id);
            startAutoReconnectKnownPeers();
            startLobbyDiscovery();
        });
        myPeerInstance.on('connection', conn => {
            // FIX 8: Reject blocked peers immediately
            if (blockedPeers.has(conn.peer)) { conn.close(); return; }
            handleIncomingRequest(conn); setupConn(conn);
        });
        myPeerInstance.on('call', call => handleIncomingCall(call));
        myPeerInstance.on('error', err => {
            if (err.type === 'unavailable-id') {
                // A Ghost ID is now derived from the recovery seed, so it must
                // NOT be replaced with a random one (that would silently break
                // the promise that the phrase restores this identity). Retry the
                // same id a few times — broker registrations expire — and only
                // then register a deterministic suffixed variant, keeping the
                // canonical id for display, chat keys and QR pairing.
                peerIdRetries++;
                if (peerIdRetries <= 3) {
                    setTimeout(() => initMesh(), peerIdRetries * 1500);
                } else {
                    const identity = (typeof GMIdentity !== "undefined") ? GMIdentity.current() : null;
                    if (identity) userGhostID = identity.ghostId + "-" + peerIdRetries;
                    updateHeaderDisplay();
                    initMesh();
                }
            } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || !navigator.onLine) {
                // Online (PeerJS cloud) signaling couldn't be reached — normal
                // when offline. Offline WiFi/QR mode is unaffected by this.
                document.getElementById("my-ghost-id-label").innerText = userGhostID + " · offline (use WiFi tab)";
            }
        });
    } catch(e) { console.error(e); }
}

// ===== AUTO-RECONNECT TO KNOWN CONTACTS =====
// True "discover any random stranger online" isn't possible on PeerJS's
// free public broker (listing all peers needs special permission from
// PeerJS — see 401 errors otherwise). What IS achievable without any
// extra permission: silently retry connecting to every Ghost ID you've
// chatted with before, so the moment they're online too you connect
// automatically — no manual re-entry of their ID needed.
let autoReconnectInFlight = new Set();
function autoReconnectKnownPeers() {
    if (!myPeerInstance || isGhostMode) return;
    Object.keys(chatData).forEach(peerId => {
        if (isGroupChat(peerId)) return;
        if (blockedPeers.has(peerId)) return;
        if (activeConnections.some(c => c.peer === peerId && c.open)) return;
        if (autoReconnectInFlight.has(peerId)) return;
        autoReconnectInFlight.add(peerId);
        try {
            const conn = myPeerInstance.connect(peerId);
            const clear = () => autoReconnectInFlight.delete(peerId);
            conn.on('open', clear);
            conn.on('error', clear);
            conn.on('close', clear);
            setTimeout(clear, 8000); // safety net in case none of the above fire
            setupConn(conn);
        } catch (e) { autoReconnectInFlight.delete(peerId); }
    });
}
function startAutoReconnectKnownPeers() {
    autoReconnectKnownPeers(); // try immediately, then every 15s
    setInterval(autoReconnectKnownPeers, 15000);
}

function startOnlinePresenceBroadcast() {
    // Broadcast presence to all active connections every 30s
    setInterval(() => {
        if (!isGhostMode) {
            broadcastToMesh({ type: "presence", sender: userGhostID, displayName: userDisplayName, online: true });
        }
    }, 30000);
}

function setupConn(conn) {
    conn.on('open', () => {
        conn.send({ type: "dp-update", sender: userGhostID, dpData: userCurrentDP, displayName: userDisplayName });
        conn.send({ type: "presence", sender: userGhostID, displayName: userDisplayName, online: true });
        if (!chatData[conn.peer]) initChatData(conn.peer);
        // Immediately show peer as online when connection opens (before handshake)
        updateOnlineUsers(conn.peer, chatData[conn.peer]?.displayName || conn.peer, true);
        if (!activeConnections.some(c => c.peer === conn.peer)) activeConnections.push(conn);
        renderChatList();
    });

    conn.on('data', data => {
        if (!data || !data.type) return;
        try {
        switch(data.type) {
            case "handshake-status":
                if (data.approved) {
                    if (!activeConnections.some(c => c.peer === conn.peer)) activeConnections.push(conn);
                    if (!chatData[conn.peer]) initChatData(conn.peer);
                    addSystemMsg(conn.peer, "Connected with " + conn.peer);
                    renderChatList();
                    showToast("Connected with " + conn.peer);
                    updateOnlineUsers(conn.peer, data.displayName || conn.peer, true);
                } else {
                    showToast(conn.peer + " rejected your request");
                    conn.close();
                }
                break;

            case "chat": {
                if (blockedPeers.has(data.sender)) break; // FIX 8: ignore blocked
                const chatId = data.groupId || data.sender;
                if (data.groupId && !groups[data.groupId]) break; // unknown group — ignore
                if (!chatData[chatId]) initChatData(chatId);
                const msg = {
                    id: data.msgId, sender: data.sender, text: data.text,
                    direction: "incoming", dp: data.senderDP, displayName: data.senderName,
                    contentType: data.contentType, mediaPayload: data.mediaPayload,
                    viewOnce: data.viewOnce, time: nowTime(),
                    replyTo: data.replyTo, replyText: data.replyText,
                    selfDestruct: data.selfDestruct
                };
                chatData[chatId].messages.push(msg);
                chatData[chatId].lastMsg = (data.groupId ? (data.senderName || data.sender) + ": " : "") + (data.text || "Media");
                chatData[chatId].lastTime = msg.time;
                if (currentChatPeer !== chatId) {
                    chatData[chatId].unread = (chatData[chatId].unread || 0) + 1;
                } else {
                    renderMessage(msg);
                    if (data.selfDestruct > 0) scheduleDestruct(data.msgId, data.selfDestruct, chatId);
                }
                renderChatList();
                if (conn.open) conn.send({ type: "ack", msgId: data.msgId });
                if (navigator.vibrate && notificationsEnabled && !chatMuted[chatId]) navigator.vibrate(50);
                sendPushNotif(data.senderName || data.sender, data.text || "sent a message");
                break;
            }

            case "typing": {
                const chatId = data.groupId || data.sender;
                if (currentChatPeer === chatId) {
                    const ind = document.getElementById("typing-indicator");
                    if (data.isTyping) { ind.innerText = (data.displayName || data.sender) + " is typing..."; ind.classList.remove("hidden"); }
                    else ind.classList.add("hidden");
                }
                break;
            }

            case "edit-message": {
                const chatId = data.groupId || data.sender;
                const msgObj = chatData[chatId]?.messages.find(m => m.id === data.msgId);
                if (msgObj) { msgObj.text = data.text; msgObj.edited = true; }
                if (currentChatPeer === chatId) renderEditLocal(data.msgId, data.text);
                break;
            }

            case "group-invite":
                groups[data.groupId] = {
                    id: data.groupId,
                    name: data.name,
                    members: data.members.filter(m => m !== userGhostID),
                    createdBy: conn.peer
                };
                if (!chatData[data.groupId]) {
                    chatData[data.groupId] = { messages: [], unread: 0, lastMsg: "You were added to the group", lastTime: nowTime(), dp: null, displayName: data.name, isGroup: true };
                } else {
                    chatData[data.groupId].displayName = data.name;
                    chatData[data.groupId].isGroup = true;
                }
                renderChatList();
                showToast(`Added to group "${data.name}"`);
                break;

            case "ack":
                const tick = document.getElementById("tick-" + data.msgId);
                if (tick) { tick.innerText = "✓✓"; tick.className = "msg-tick read"; }
                break;

            case "dp-update":
                if (chatData[data.sender]) { chatData[data.sender].dp = data.dpData; chatData[data.sender].displayName = data.displayName; }
                window["dp_" + data.sender] = data.dpData;
                window["name_" + data.sender] = data.displayName;
                document.querySelectorAll(".msg-dp-" + data.sender).forEach(el => {
                    if (data.dpData) el.innerHTML = `<img src="${data.dpData}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
                });
                renderChatList();
                break;

            case "name-update":
                window["name_" + data.sender] = data.displayName;
                if (chatData[data.sender]) chatData[data.sender].displayName = data.displayName;
                renderChatList();
                break;

            case "reaction": renderReactionLocal(data.msgId, data.emoji); break;
            case "delete": renderDeleteLocal(data.msgId); break;
            case "destruct": renderDeleteLocal(data.msgId); break;

            case "credit-gift": {
                addCredits(data.amount || 0);
                if (chatData[data.sender]) {
                    addSystemMsg(data.sender, `👻 ${data.senderName || data.sender} sent you ${data.amount} credits!`);
                }
                showToast(`👻 +${data.amount} credits from ${data.senderName || data.sender}!`);
                break;
            }
            case "location": {
                const chatId = data.groupId || data.sender;
                showToast((data.senderName || data.sender) + " shared location");
                if (currentChatPeer === chatId) {
                    const lm = { id: "loc-"+Date.now(), sender: data.sender, text: "", direction: "incoming", dp: data.senderDP, contentType: "location", mediaPayload: { lat: data.lat, lng: data.lng }, time: nowTime() };
                    if (chatData[chatId]) chatData[chatId].messages.push(lm);
                    renderMessage(lm);
                }
                break;
            }

            case "presence":
                // Always track peer who sent presence; add to activeConnections if not already there
                updateOnlineUsers(data.sender, data.displayName || data.sender, data.online !== false);
                if (conn.open && !activeConnections.some(c => c.peer === conn.peer)) {
                    activeConnections.push(conn);
                }
                break;

            case "status-update":
                if (chatData[data.sender]) chatData[data.sender].status = data.status;
                break;

            // ----- Offline (QR/WiFi) call signaling — no server involved,
            // this all rides over the already-open offline data channel -----
            case "voip-offer": {
                // A malformed/stale offer used to blow up the whole message
                // handler (caught below) and could leave the caller ringing
                // forever — answer it with an explicit end instead.
                if (!data.sdp || !data.sdp.type) {
                    sendToPeer(conn.peer, { type: "voip-end" });
                    showToast("Ignored a broken call offer");
                    break;
                }
                const busy = !!(pendingIncomingCallEvent || activeP2PCallInstance || activeOfflineCallPeer);
                if (busy) {
                    sendToPeer(conn.peer, { type: "voip-end" });
                    showToast("Already on a call — rejected " + conn.peer);
                    break;
                }
                if (!offlinePeerConnections[conn.peer]) {
                    sendToPeer(conn.peer, { type: "voip-end" });
                    showToast("Call ignored — connection is gone");
                    break;
                }
                pendingIncomingCallEvent = { offline: true, peerId: conn.peer, sdp: data.sdp, callType: data.callType, open: true };
                showIncomingCallUI(conn.peer, data.callType);
                break;
            }

            case "voip-answer":
                (async () => {
                    const pc = offlinePeerConnections[conn.peer];
                    if (pc) {
                        try {
                            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                            updateCallStatusLabel("Connected");
                            startCallTimer();
                        } catch(e) { console.error(e); }
                    }
                })();
                break;

            case "voip-ice":
                { const pc = offlinePeerConnections[conn.peer];
                  if (pc && data.candidate) pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(()=>{}); }
                break;

            case "voip-end":
                if (activeOfflineCallPeer === conn.peer || pendingIncomingCallEvent?.peerId === conn.peer) endCallFlow();
                break;
        }
        } catch(e) {
            console.error("Error handling incoming message from " + conn.peer + ":", e, data);
        }
    });

    conn.on('close', () => {
        activeConnections = activeConnections.filter(c => c.peer !== conn.peer);
        if (chatData[conn.peer]) addSystemMsg(conn.peer, conn.peer + " disconnected");
        updateOnlineUsers(conn.peer, conn.peer, false);
        renderChatList();
        if (activeOfflineCallPeer === conn.peer) endCallFlow();
        delete offlinePeerConnections[conn.peer];
    });
}

function initChatData(peerId) {
    if (!chatData[peerId]) {
        chatData[peerId] = { messages: [], unread: 0, lastMsg: "", lastTime: "", dp: null, displayName: peerId };
    }
}

function addSystemMsg(peerId, text) {
    if (!chatData[peerId]) initChatData(peerId);
    const sm = { id: "sys-"+Date.now(), type: "system", text };
    chatData[peerId].messages.push(sm);
    if (currentChatPeer === peerId) {
        const c = document.getElementById("messages-container");
        const d = document.createElement("div");
        d.className = "date-chip"; d.innerHTML = `<span>${text}</span>`;
        c.appendChild(d); c.scrollTop = c.scrollHeight;
    }
}

// ===== ONLINE USERS =====
function updateOnlineUsers(peerId, displayName, isOnline) {
    if (isOnline) onlineUsers[peerId] = { displayName, online: true };
    else delete onlineUsers[peerId];
    renderOnlineUsers();
}

// Every place that needs "who can I reach" data: connected peers, peers seen
// on the lobby broker, and — once the native Android build is running — peers
// discovered over BLE/Wi-Fi Direct (gmNativePeers, fed by the JS bridge).
function gmReachablePeers() {
    const ids = new Set([
        ...Object.keys(onlineUsers),
        ...Object.keys(discoveredPeers),
        ...activeConnections.map(c => c.peer),
        ...Object.keys(window.gmNativePeers || {})
    ]);
    ids.delete(userGhostID);
    return Array.from(ids);
}

// Single shared renderer: the Chats tab's "Online Nearby" list and the WiFi
// tab's "Ghosts You Can Reach" list are both drawn by this, so they always
// show the same peers and the same state.
function renderPeopleListInto(containerId, peers) {
    const list = document.getElementById(containerId);
    if (!list) return 0;
    if (!peers.length) {
        list.innerHTML = '<div class="peer-empty">Nobody reachable yet — open WiFi tab to pair with a nearby Ghost.</div>';
        return 0;
    }
    list.innerHTML = "";
    peers.forEach(peerId => {
        const alreadyConnected = activeConnections.some(c => c.peer === peerId && c.open);
        const known = onlineUsers[peerId];
        const native = (window.gmNativePeers || {})[peerId];
        const isFreshDiscovery = (!known && !!discoveredPeers[peerId]) || !!native;
        const displayName = known ? known.displayName : (native && native.name ? native.name : peerId);
        let transport = "";
        if (native) transport = native.transport === "wifi-direct" ? " · Wi-Fi Direct" : " · Bluetooth";
        else if (isFreshDiscovery) transport = " · online now";
        else if (!alreadyConnected) transport = " · offline";

        const item = document.createElement("div");
        item.className = "online-user-item";
        let btnHtml;
        if (alreadyConnected) {
            btnHtml = `<button class="online-user-connect" style="background:var(--success);" onclick="openChat('${peerId}')">Open Chat</button>`;
        } else if (native) {
            btnHtml = `<button class="online-user-connect" onclick="connectViaNativeTransport('${peerId}')">Connect</button>`;
        } else {
            btnHtml = `<button class="online-user-connect" onclick="connectToPeer('${peerId}');showToast('Connecting...')">${isFreshDiscovery ? "Connect" : "Reconnect"}</button>`;
        }
        item.innerHTML = `
            <div class="online-user-dot" style="${alreadyConnected || isFreshDiscovery ? '' : 'background:var(--text3);'}"></div>
            <div class="online-user-name">${displayName}<br><span style="font-size:11px;color:var(--text3);">${peerId}${transport}</span></div>
            ${btnHtml}
        `;
        list.appendChild(item);
    });
    return peers.length;
}

// Draws BOTH lists and updates their counters.
function renderPeerLists() {
    const peers = gmReachablePeers();
    renderPeopleListInto("nearby-ghosts-list", peers);
    renderPeopleListInto("wifi-reach-list", peers);
    const n = peers.length;
    const a = document.getElementById("nearby-count");
    const b = document.getElementById("wifi-reach-count");
    if (a) a.innerText = n;
    if (b) b.innerText = n;
    return n;
}

function renderOnlineUsers() {
    return renderPeerLists();
}

// ===== CONNECT =====
function openNewConnect() { closeAllMenus(); showEl("connect-modal"); }

// Connect to a peer the native layer discovered over BLE or Wi-Fi Direct.
// The Android shell exposes window.gmNativePeers; outside the APK this simply
// explains the limitation instead of silently doing nothing.
function connectViaNativeTransport(peerId) {
    const peer = (window.gmNativePeers || {})[peerId];
    if (!peer) { connectToPeer(peerId); return; }
    const bridge = window.GhostNative;
    if (!bridge || typeof bridge.connect !== "function") {
        showToast("Native Wi-Fi Direct connect needs the Android app");
        return;
    }
    try {
        bridge.connect(peer.address || peerId);
        showToast(peer.transport === "wifi-direct" ? "Requesting Wi-Fi Direct connection…" : "Opening Bluetooth link…");
    } catch (e) {
        console.error("Native connect failed:", e);
        showToast("Could not start that native connection");
    }
}

// Called from the Android side (GhostNative.onPeersChanged) with the current
// BLE / Wi-Fi-Direct peer table, so both reach lists pick the peers up.
window.gmNativePeers = window.gmNativePeers || {};
window.gmApplyNativePeers = function (peers) {
    window.gmNativePeers = {};
    (peers || []).forEach(p => { if (p && p.ghostId) window.gmNativePeers[p.ghostId] = p; });
    renderPeerLists();
};

// ===== GROUP CHAT: creation =====
function openNewGroupModal() {
    closeAllMenus();
    const list = document.getElementById("new-group-member-list");
    const connected = activeConnections.filter(c => c.open);
    if (connected.length === 0) {
        list.innerHTML = `<p class="sub" style="text-align:center;padding:14px 0;">Connect to some peers first (via WiFi or Online Users), then come back to create a group.</p>`;
    } else {
        list.innerHTML = connected.map(c => `
            <label class="group-member-row">
                <input type="checkbox" value="${c.peer}">
                <span>${chatData[c.peer]?.displayName || c.peer}</span>
            </label>
        `).join("");
    }
    document.getElementById("new-group-name").value = "";
    showEl("new-group-modal");
}

function closeNewGroupModal() { hideEl("new-group-modal"); }

function createGroup() {
    const nameInp = document.getElementById("new-group-name");
    const name = nameInp.value.trim();
    if (!name) { showToast("Enter a group name"); return; }
    const checked = [...document.querySelectorAll("#new-group-member-list input:checked")].map(el => el.value);
    if (checked.length === 0) { showToast("Select at least one member"); return; }

    const groupId = "grp-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
    groups[groupId] = { id: groupId, name, members: checked, createdBy: userGhostID };
    chatData[groupId] = {
        messages: [{ id: "sys-" + Date.now(), type: "system", text: "Group created" }],
        unread: 0, lastMsg: "Group created", lastTime: nowTime(),
        dp: null, displayName: name, isGroup: true
    };

    // Tell each member about the group — they add it locally on receipt
    checked.forEach(peerId => sendToPeer(peerId, { type: "group-invite", groupId, name, members: checked.concat(userGhostID) }));

    closeNewGroupModal();
    renderChatList();
    openChat(groupId);
    showToast("Group created!");
}

function leaveCurrentGroup() {
    closeAllMenus();
    if (!isGroupChat(currentChatPeer)) return;
    const groupId = currentChatPeer;
    if (!confirm(`Leave "${groups[groupId].name}"?`)) return;
    delete groups[groupId];
    delete chatData[groupId];
    goBackToList();
    showToast("Left group");
}
function closeNewConnect() { hideEl("connect-modal"); document.getElementById("peer-id-input").value = ""; }

// ===== FEEDBACK SYSTEM =====
let feedbackRating = 0;

function openFeedbackModal() {
    closeAllMenus();
    feedbackRating = 0;
    document.querySelectorAll("#feedback-star-row .feedback-star").forEach(s => s.classList.remove("active"));
    document.getElementById("feedback-text").value = "";
    showEl("feedback-modal");
}

function closeFeedbackModal() { hideEl("feedback-modal"); }

function setFeedbackRating(n) {
    feedbackRating = n;
    document.querySelectorAll("#feedback-star-row .feedback-star").forEach(s => {
        s.classList.toggle("active", Number(s.getAttribute("data-star")) <= n);
    });
}

function submitFeedback() {
    const text = document.getElementById("feedback-text").value.trim();
    if (feedbackRating === 0 && !text) { showToast("Add a rating or a note first"); return; }

    // No server to send this to — Ghost Mesh stays "No Server, No Trace".
    // Keep a local copy, and hand the person off to their own email app to
    // actually deliver it if they want to.
    try {
        const stored = JSON.parse(localStorage.getItem("gm-feedback") || "[]");
        stored.push({ rating: feedbackRating, text, time: new Date().toISOString() });
        localStorage.setItem("gm-feedback", JSON.stringify(stored));
    } catch (e) { console.error("Could not save feedback locally:", e); }

    const subject = encodeURIComponent("Ghost Mesh Feedback (" + feedbackRating + "/5)");
    const body = encodeURIComponent(
        "Rating: " + feedbackRating + "/5\n\n" + (text || "(no additional comments)")
    );
    window.location.href = "mailto:?subject=" + subject + "&body=" + body;

    closeFeedbackModal();
    showToast("Thanks! Opening your email app to send it...");
}

function connectFromUI() {
    const id = document.getElementById("peer-id-input").value.trim();
    if (!id || id === userGhostID) { showToast("Enter a valid Ghost ID"); return; }
    connectToPeer(id); closeNewConnect();
}

function connectToPeer(targetID) {
    if (!myPeerInstance) { showToast("Not connected yet"); return; }
    if (isGhostMode) { showToast("Turn off Ghost Mode first"); return; }
    const conn = myPeerInstance.connect(targetID);
    setupConn(conn);
}

// ===== ACCEPT/REJECT =====
function handleIncomingRequest(conn) {
    if (notificationsEnabled === false) return;
    pendingIncomingConnection = conn;
    document.getElementById("request-modal-text").innerText = conn.peer + " wants to connect with you.";
    showEl("request-modal");
}

function acceptConnectionRequest() {
    hideEl("request-modal");
    if (!pendingIncomingConnection) return;
    if (!activeConnections.some(c => c.peer === pendingIncomingConnection.peer)) activeConnections.push(pendingIncomingConnection);
    initChatData(pendingIncomingConnection.peer);
    pendingIncomingConnection.send({ type: "handshake-status", approved: true, sender: userGhostID, displayName: userDisplayName });
    addSystemMsg(pendingIncomingConnection.peer, "Connected with " + pendingIncomingConnection.peer);
    updateOnlineUsers(pendingIncomingConnection.peer, pendingIncomingConnection.peer, true);
    renderChatList(); showToast("Accepted " + pendingIncomingConnection.peer);
    pendingIncomingConnection = null;
}

function rejectConnectionRequest() {
    hideEl("request-modal");
    if (!pendingIncomingConnection) return;
    pendingIncomingConnection.send({ type: "handshake-status", approved: false, sender: userGhostID });
    setTimeout(() => { if(pendingIncomingConnection) pendingIncomingConnection.close(); pendingIncomingConnection = null; }, 500);
}

// ===== OFFLINE WIFI CONNECT (Serverless WebRTC, no internet needed) =====
// Two devices exchange a WebRTC offer/answer via QR codes and connect
// directly over the local network (same WiFi/hotspot). No signaling
// server, no PeerJS cloud, no internet required once both devices are
// on the same network.

let offlinePC = null;
let offlineDC = null;
let offlineCameraStream = null;
let offlineScanLoopId = null;

function openOfflineConnect() {
    closeAllMenus();
    showScreen("chatlist-screen");
    scrollToMainTab(1);
    resetOfflinePanels();
}

function closeOfflineConnect() {
    stopOfflineCamera();
    if (offlinePC && (!offlineDC || offlineDC.readyState !== "open")) {
        try { offlinePC.close(); } catch(e){}
        offlinePC = null; offlineDC = null;
    }
    scrollToMainTab(0);
}

function resetOfflinePanels() {
    switchOfflineTab("create");
    hideEl("offline-flow-wrap");
    document.getElementById("offline-create-step1").classList.remove("hidden");
    document.getElementById("offline-create-step2").classList.add("hidden");
    document.getElementById("offline-create-step3").classList.add("hidden");
    document.getElementById("offline-create-step4").classList.add("hidden");
    document.getElementById("offline-create-step5").classList.add("hidden");
    document.getElementById("offline-join-step1").classList.remove("hidden");
    document.getElementById("offline-join-step1").querySelector(".primary-btn")?.classList.remove("hidden");
    document.getElementById("offline-join-step2").classList.add("hidden");
    document.getElementById("offline-join-step3").classList.add("hidden");
    document.getElementById("offline-qr-host").innerHTML = "";
    document.getElementById("offline-qr-join").innerHTML = "";
    const msgEl = document.getElementById("offline-status-msg");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        msgEl.innerText = "⚠️ You're opening this file directly, so the camera (QR scan) is blocked by the browser. Serve it over https:// or http://localhost for scanning to work.";
    } else {
        msgEl.innerText = "";
    }
}

// The "Create Chat / Join Chat" split button row is gone — the two small QR
// icons drive these flows now, so the old tab buttons no longer exist.
function switchOfflineTab(tab) {
    const createPanel = document.getElementById("offline-create-panel");
    const joinPanel = document.getElementById("offline-join-panel");
    if (createPanel) createPanel.classList.toggle("hidden", tab !== "create");
    if (joinPanel) joinPanel.classList.toggle("hidden", tab !== "join");
    const flow = document.getElementById("offline-flow-wrap");
    if (flow) flow.classList.toggle("hidden", false);
}

function offlineIceConfig() {
    // No STUN/TURN — we only want local network (host) candidates since
    // this feature is specifically for "no internet" same-WiFi use.
    return { iceServers: [] };
}

// Real-world phones often have several active network interfaces (WiFi,
// hotspot, VPN, mobile data) — each one adds its own ICE candidate line to
// the SDP. That bloats the QR payload into a very dense/small code that
// phone cameras genuinely struggle to scan reliably, even though the QR
// technically "generates" fine. Since we only need ONE working candidate
// for same-WiFi connections, we keep just the first few candidates before
// encoding into the QR — the local RTCPeerConnection itself still has its
// FULL candidate list internally, only what we transmit gets trimmed.
function trimSdpForQR(sdp, maxCandidates = 3) {
    let kept = 0;
    return sdp.split("\r\n").filter(line => {
        if (line.startsWith("a=candidate")) return ++kept <= maxCandidates;
        return true;
    }).join("\r\n");
}
function slimSessionDescription(desc) {
    return { type: desc.type, sdp: trimSdpForQR(desc.sdp) };
}

// Wait for ICE gathering to finish so the SDP we encode into the QR
// already contains all local candidates (no separate trickle needed).
function waitForIceGatheringComplete(pc) {
    return new Promise(resolve => {
        if (pc.iceGatheringState === "complete") { resolve(); return; }
        function check() {
            if (pc.iceGatheringState === "complete") {
                pc.removeEventListener("icegatheringstatechange", check);
                resolve();
            }
        }
        pc.addEventListener("icegatheringstatechange", check);
        // Safety timeout in case gathering stalls
        setTimeout(resolve, 3000);
    });
}

// Wraps a raw RTCDataChannel so it looks like a PeerJS DataConnection
// (peer, open, on(), send()) — lets us reuse setupConn() unchanged.
function wrapOfflineChannel(dc, peerId) {
    const listeners = {};
    const wrapped = {
        peer: peerId,
        open: false,
        on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); },
        send(data) { if (dc.readyState === "open") dc.send(JSON.stringify(data)); },
        close() { try { dc.close(); } catch(e){} }
    };
    dc.onopen = () => { wrapped.open = true; (listeners.open || []).forEach(f => f()); };
    dc.onmessage = e => {
        let data; try { data = JSON.parse(e.data); } catch(err) { return; }
        (listeners.data || []).forEach(f => f(data));
    };
    dc.onclose = () => { wrapped.open = false; (listeners.close || []).forEach(f => f()); };
    return wrapped;
}

function renderOfflineQR(elId, payloadObj) {
    const container = document.getElementById(elId);
    container.innerHTML = "";
    const text = JSON.stringify(payloadObj);
    container.dataset.rawPayload = text;
    try {
        new QRCode(container, {
            text,
            width: 260,
            height: 260,
            correctLevel: QRCode.CorrectLevel.L
        });
        // Same-device testing (two browser tabs/windows) makes camera
        // scanning genuinely hard — laptop webcams especially struggle to
        // focus that close on another screen. A one-tap "copy code" lets
        // testers skip the camera entirely and paste it on the other side.
        // Each render used to append another copy button, so they piled up
        // under the QR after every retry.
        container.parentElement.querySelectorAll(".qr-copy-code-btn").forEach(b => b.remove());
        const copyBtn = document.createElement("button");
        copyBtn.className = "qr-copy-code-btn";
        copyBtn.innerText = "📋 Copy code (for testing without camera)";
        copyBtn.onclick = () => {
            navigator.clipboard?.writeText(text).then(() => showToast("Code copied — paste it on the other device"));
        };
        container.parentElement.appendChild(copyBtn);
    } catch (e) {
        // The QR library throws (rather than degrading gracefully) once the
        // payload is too big for a single QR code — this happens if the SDP
        // picked up extra ICE candidates (e.g. VPN/hotspot adds more network
        // interfaces). Surface this clearly instead of leaving a blank box.
        console.error("QR generation failed, payload length:", text.length, e);
        container.innerHTML = `<p style="color:var(--danger);font-size:13px;text-align:center;padding:20px;">
            QR data too large to generate (${text.length} chars). Try turning off
            VPN/extra network adapters and reconnecting.</p>`;
        showToast("QR too large — try disabling VPN or extra network adapters");
    }
}

// Manual fallback for when camera scanning isn't working/available — lets
// testers paste the raw code (copied via the "📋 Copy code" button on the
// other device) instead of relying on the camera at all.
function pasteCodeManually() {
    const text = prompt("Paste the code you copied from the other device:");
    if (!text || !text.trim()) return;
    if (typeof window.__qrManualDecodeHandler === "function") {
        Promise.resolve(window.__qrManualDecodeHandler(text.trim())).then(ok => {
            if (!ok) showToast("Invalid code — check you copied the whole thing");
        });
    } else {
        showToast("Nothing is waiting for a code right now");
    }
}

// ----- HOST (creator) side -----
async function startOfflineHost() {
    gmCloseOfflineFlowSoonIfIdle();
    showEl("offline-flow-wrap");
    if (typeof QRCode === "undefined") {
        showToast("QR library not loaded — connect to internet once, then this works offline forever after");
        return;
    }
    try {
        offlinePC = new RTCPeerConnection(offlineIceConfig());
        offlineDC = offlinePC.createDataChannel("gm-offline");
        setupOfflineDataChannel(offlineDC, null, offlinePC); // peerId filled in once we scan their answer

        const offer = await offlinePC.createOffer();
        await offlinePC.setLocalDescription(offer);
        await waitForIceGatheringComplete(offlinePC);

        const payload = { gid: userGhostID, name: userDisplayName, sdp: slimSessionDescription(offlinePC.localDescription) };
        renderOfflineQR("offline-qr-host", payload);

        document.getElementById("offline-create-step1").classList.add("hidden");
        document.getElementById("offline-create-step2").classList.remove("hidden");
    } catch(e) {
        console.error(e);
        showToast("Could not start offline connection");
    }
}

function switchToScanAnswer() {
    document.getElementById("offline-create-step2").classList.add("hidden");
    document.getElementById("offline-create-step3").classList.remove("hidden");
    startCameraScan(async decoded => {
        try {
            const answer = JSON.parse(decoded);
            if (!answer.sdp || !answer.gid) { showToast("Invalid QR — try again"); return false; }
            stopOfflineCamera();
            document.getElementById("offline-create-step3").classList.add("hidden");
            document.getElementById("offline-create-step4").classList.remove("hidden");

            if (offlineDC) offlineDC.__peerId = answer.gid;
            await offlinePC.setRemoteDescription(new RTCSessionDescription(answer.sdp));
            offlinePendingPeerInfo = { gid: answer.gid, name: answer.name };
            // Patch the peer id in eagerly, well before the channel actually
            // opens (ICE/DTLS handshake still takes a bit after this) — see
            // the BUG FIX note in setupOfflineDataChannel for why this can't
            // wait until the 'open' event.
            if (offlineWrapped) offlineWrapped.peer = answer.gid;
            return true;
        } catch(e) {
            console.error(e);
            showToast("Could not read QR — try again");
            return false;
        }
    }, "Scan Their Reply QR");
}

let offlinePendingPeerInfo = null;
let offlineWrapped = null; // the currently-in-progress wrapped offline channel, so its peer id can be patched the moment we learn it (see startOfflineHost/switchToScanAnswer)

function setupOfflineDataChannel(dc, knownPeerId, pcRef) {
    const wrapped = wrapOfflineChannel(dc, knownPeerId || "offline-pending");
    // BUG FIX: setupConn() registers the 'open'/'data' listeners that
    // actually add this connection to activeConnections[] (which is what
    // sendToChat/sendToPeer search through). It used to be called from
    // INSIDE a separate dc.addEventListener("open", ...) callback — but
    // wrapOfflineChannel's own dc.onopen (assigned above, inside
    // wrapOfflineChannel) already fires the 'open' event to any listeners
    // BEFORE that second callback even runs, so setupConn's listener was
    // registered too late and never actually fired. Net effect: the
    // connection object never made it into activeConnections, so nothing
    // could ever be sent after connecting — this is why offline chat broke
    // right after "Connected!". Fix: register setupConn's listeners
    // synchronously, right here, before the channel can possibly open.
    setupConn(wrapped);
    offlineWrapped = wrapped;
    dc.addEventListener("open", () => {
        if (pcRef) offlinePeerConnections[wrapped.peer] = pcRef;
        stopOfflineCamera();
        finishOfflineConnectPeerId = wrapped.peer;
        showOfflineConnectedScreen(offlinePendingPeerInfo?.name || wrapped.peer);
    });
    return wrapped;
}

let finishOfflineConnectPeerId = null;

// Shows a "Connected!" success screen instead of jumping straight into the
// chat — the user taps "Open Chat" themselves when ready.
function showOfflineConnectedScreen(peerName) {
    const isCreateFlow = !document.getElementById("offline-create-panel").classList.contains("hidden");
    if (isCreateFlow) {
        ["offline-create-step1", "offline-create-step2", "offline-create-step3", "offline-create-step4"].forEach(id => {
            document.getElementById(id)?.classList.add("hidden");
        });
        document.getElementById("offline-create-step5").classList.remove("hidden");
        document.getElementById("offline-create-connected-name").innerText = "Connected with " + peerName;
    } else {
        ["offline-join-step1", "offline-join-step2"].forEach(id => {
            document.getElementById(id)?.classList.add("hidden");
        });
        document.getElementById("offline-join-step3").classList.remove("hidden");
        document.getElementById("offline-join-connected-name").innerText = "Connected with " + peerName;
    }
}

function finishOfflineConnect() {
    const peerId = finishOfflineConnectPeerId;
    scrollToMainTab(0);
    resetOfflinePanels();
    hideEl("offline-flow-wrap");
    if (peerId) openChat(peerId);
}

// ----- JOIN (scanner) side -----
function startOfflineJoinScan() {
    showEl("offline-flow-wrap");
    document.getElementById("offline-join-step1").querySelector(".primary-btn")?.classList.add("hidden");
    startCameraScan(async decoded => {
        try {
            const offer = JSON.parse(decoded);
            if (!offer.sdp || !offer.gid) { showToast("Invalid QR — try again"); return false; }
            stopOfflineCamera();

            offlinePC = new RTCPeerConnection(offlineIceConfig());
            offlinePC.addEventListener("datachannel", ev => {
                offlineDC = ev.channel;
                offlinePendingPeerInfo = { gid: offer.gid, name: offer.name };
                setupOfflineDataChannel(offlineDC, offer.gid, offlinePC);
            });

            await offlinePC.setRemoteDescription(new RTCSessionDescription(offer.sdp));
            const answer = await offlinePC.createAnswer();
            await offlinePC.setLocalDescription(answer);
            await waitForIceGatheringComplete(offlinePC);

            const payload = { gid: userGhostID, name: userDisplayName, sdp: slimSessionDescription(offlinePC.localDescription) };
            document.getElementById("offline-join-step1").classList.add("hidden");
            document.getElementById("offline-join-step2").classList.remove("hidden");
            renderOfflineQR("offline-qr-join", payload);
            return true;
        } catch(e) {
            console.error(e);
            showToast("Could not read QR — try again");
            return false;
        }
    }, "Scan Their QR");
}

// ----- Scanning geometry (pure, so it can be unit-tested) -----
// Two windows are decoded per pass, both downscaled before jsQR ever sees
// them: the centre square (what the on-screen scan frame shows) and, every Nth
// frame, the whole frame at a lower resolution.
const GM_SCAN = { cropSize: 480, fullSize: 880, fullEvery: 4 };
function gmScanRects(vw, vh) {
    const side = Math.max(1, Math.min(vw, vh));
    const crop = Math.max(1, Math.min(GM_SCAN.cropSize, side));
    const scale = Math.min(1, GM_SCAN.fullSize / Math.max(vw, vh, 1));
    return [
        { label: "crop", sx: Math.round((vw - side) / 2), sy: Math.round((vh - side) / 2), sw: side, sh: side, dw: crop, dh: crop },
        { label: "full", sx: 0, sy: 0, sw: vw, sh: vh, dw: Math.max(1, Math.round(vw * scale)), dh: Math.max(1, Math.round(vh * scale)) }
    ];
}
// Exposed for tests/diagnostics: how many frames were decoded and by which pass.
let gmScanStats = { frames: 0, cropHits: 0, fullHits: 0, width: 0, height: 0 };

// ----- Shared fullscreen camera scanning helper -----
function startCameraScan(onDecoded, title) {
    if (typeof jsQR === "undefined") {
        showToast("QR scanner library not loaded — connect to internet once, then this works offline forever after");
        return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        // This is the file:// case — camera APIs are blocked by the
        // browser outside a secure context (https:// or localhost).
        showToast("Camera blocked: open this app via https:// or a local server (not by double-clicking the file) for QR scan to work");
        const msgEl = document.getElementById("offline-status-msg");
        if (msgEl) msgEl.innerText = "⚠️ Camera needs the app served over https:// or http://localhost — double-clicking the file won't work for scanning. \"New Chat\" (enter Ghost ID) still works fine.";
        return;
    }
    stopOfflineCamera();
    document.getElementById("qr-scan-title").innerText = title || "Find a QR code";
    document.getElementById("qr-scan-overlay").classList.remove("hidden");
    window.__qrManualDecodeHandler = onDecoded;
    const video = document.getElementById("qr-scan-video");
    const canvas = document.getElementById("qr-scan-canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    function beginScanLoop(stream) {
        offlineCameraStream = stream;
        video.srcObject = stream;
        // CRITICAL for Android: without muted, browsers silently block
        // autoplay — the stream gets granted but the video never actually
        // renders any frames, so the screen looks like nothing happened.
        video.muted = true;
        video.setAttribute("muted", "");
        video.playsInline = true;
        video.setAttribute("playsinline", "");
        video.play().catch(() => {});
        video.onloadedmetadata = () => video.play().catch(() => {});

        // A slightly soft frame is the single most common reason a QR "never
        // scans" on a phone: ask for continuous autofocus when the camera
        // supports it (silently ignored everywhere else).
        try {
            const track = stream.getVideoTracks && stream.getVideoTracks()[0];
            const caps = track && track.getCapabilities ? track.getCapabilities() : null;
            if (caps && Array.isArray(caps.focusMode) && caps.focusMode.indexOf("continuous") !== -1) {
                track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
            }
        } catch (e) { /* focus control is a bonus, never a blocker */ }

        gmScanStats = { frames: 0, cropHits: 0, fullHits: 0, width: 0, height: 0 };
        let frameNo = 0, waitingFrames = 0;

        function schedule() {
            if (offlineCameraStream) offlineScanLoopId = requestAnimationFrame(tick);
        }

        function tick() {
            if (!offlineCameraStream) return;
            // readyState 2 (HAVE_CURRENT_DATA) is enough to draw — requiring
            // exactly 4 stalled the loop on some Android WebView builds.
            if (video.readyState < 2 || !video.videoWidth) {
                waitingFrames++;
                if (waitingFrames === 150) {
                    showToast("Camera opened but sent no frames — close other camera apps and try again");
                }
                schedule();
                return;
            }
            waitingFrames = 0;
            frameNo++;
            gmScanStats.frames++;
            gmScanStats.width = video.videoWidth;
            gmScanStats.height = video.videoHeight;

            const rects = gmScanRects(video.videoWidth, video.videoHeight);
            const passes = (frameNo % GM_SCAN.fullEvery === 0) ? rects : [rects[0]];
            let found = null;
            try {
                for (const r of passes) {
                    canvas.width = r.dw;
                    canvas.height = r.dh;
                    ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, r.dw, r.dh);
                    const imgData = ctx.getImageData(0, 0, r.dw, r.dh);
                    // "attemptBoth" tries normal and inverted scans — costs a
                    // bit more CPU but survives glare far better than
                    // "dontInvert".
                    const code = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "attemptBoth" });
                    if (code && code.data) {
                        if (r.label === "crop") gmScanStats.cropHits++; else gmScanStats.fullHits++;
                        found = code.data;
                        break;
                    }
                }
            } catch (e) {
                console.error("Scan frame failed:", e);
            }

            if (!found) { schedule(); return; }
            // Stop decoding while the handler runs; resume only if it says the
            // code was not usable (e.g. another app's QR, not a Ghost Mesh one).
            Promise.resolve(onDecoded(found)).then(ok => {
                if (ok) return;
                gmScanStats.frames = 0;
                schedule();
            });
        }

        tick();
    }

    gmGetUserMedia({
        // A modest resolution focuses better and decodes faster than the
        // sensor maximum on almost every phone camera.
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }
    })
        .then(beginScanLoop)
        .catch(err => {
            console.error("Rear camera request failed:", err);
            if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
                showToast("Camera permission denied — allow camera access in your browser/app settings");
                document.getElementById("qr-scan-overlay").classList.add("hidden");
                return;
            }
            if (err.name === "NotReadableError" || err.name === "TrackStartError") {
                showToast("Camera is busy — close any other app using the camera and try again");
                document.getElementById("qr-scan-overlay").classList.add("hidden");
                return;
            }
            // Rear-camera constraint not satisfiable — fall back to any available camera.
            gmGetUserMedia({ video: true })
                .then(beginScanLoop)
                .catch(err2 => {
                    console.error("Fallback camera request failed:", err2);
                    document.getElementById("qr-scan-overlay").classList.add("hidden");
                    if (err2.name === "NotFoundError" || err2.name === "DevicesNotFoundError") {
                        showToast("No camera found on this device");
                    } else {
                        showToast("Could not access camera: " + (err2.name || "unknown error"));
                    }
                });
        });
}

// Hides the offline flow panel when no camera/QR step is active, so the WiFi
// tab stays a clean list of reachable Ghosts by default.
function gmCloseOfflineFlowSoonIfIdle() {
    const scanning = !!(offlineCameraStream || document.getElementById("offline-qr-host")?.innerHTML);
    if (!scanning) hideEl("offline-flow-wrap");
}

function cancelCameraScan() {
    stopOfflineCamera();
    const wasJoinTab = !document.getElementById("offline-join-panel").classList.contains("hidden");
    document.getElementById("offline-create-step1").classList.remove("hidden");
    document.getElementById("offline-create-step2").classList.add("hidden");
    document.getElementById("offline-create-step3").classList.add("hidden");
    document.getElementById("offline-create-step4").classList.add("hidden");
    document.getElementById("offline-join-step1").classList.remove("hidden");
    document.getElementById("offline-join-step1").querySelector(".primary-btn")?.classList.remove("hidden");
    document.getElementById("offline-join-step2").classList.add("hidden");
    switchOfflineTab(wasJoinTab ? "join" : "create");
    hideEl("offline-flow-wrap");
}

function stopOfflineCamera() {
    if (offlineScanLoopId) { cancelAnimationFrame(offlineScanLoopId); offlineScanLoopId = null; }
    if (offlineCameraStream) {
        offlineCameraStream.getTracks().forEach(t => t.stop());
        offlineCameraStream = null;
    }
    window.__qrManualDecodeHandler = null;
    const video = document.getElementById("qr-scan-video");
    if (video) video.srcObject = null;
    const overlay = document.getElementById("qr-scan-overlay");
    if (overlay) overlay.classList.add("hidden");
}

// ===== CHAT LIST =====
function renderChatList() {
    const container = document.getElementById("chat-list-container");
    const empty = document.getElementById("empty-state");
    const peers = Object.keys(chatData);
    if (peers.length === 0) { if(empty) empty.style.display = "flex"; return; }
    if (empty) empty.style.display = "none";
    container.querySelectorAll(".chat-item").forEach(e => e.remove());

    peers.sort((a,b) => (chatData[b].lastTime||"").localeCompare(chatData[a].lastTime||""));
    peers.forEach(peerId => {
        const d = chatData[peerId];
        const isGroup = isGroupChat(peerId);
        const isOnline = isGroup
            ? groups[peerId].members.some(m => activeConnections.some(c => c.peer === m && c.open))
            : activeConnections.some(c => c.peer === peerId && c.open);
        const item = document.createElement("div");
        item.className = "chat-item";
        item.id = "chatitem-" + peerId;
        item.onclick = () => openChat(peerId);

        const groupIconSvg = `<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`;
        const dpHtml = isGroup
            ? `<div class="default-avatar" style="width:50px;height:50px;">${groupIconSvg}</div>`
            : (d.dp
                ? `<img src="${d.dp}" class="chat-item-dp msg-dp-${peerId}">`
                : `<div class="default-avatar" style="width:50px;height:50px;" id="chatdp-${peerId}"><svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg></div>`);

        item.innerHTML = `
            <div class="chat-item-avatar">
                ${dpHtml}
                ${isOnline ? '<span class="online-dot"></span>' : ''}
            </div>
            <div class="chat-item-body">
                <div class="chat-item-top">
                    <span class="chat-item-name">${d.displayName || peerId}</span>
                    <span class="chat-item-time">${d.lastTime||''}</span>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span class="chat-item-preview">${d.lastMsg||'Tap to chat'}</span>
                    ${d.unread > 0 ? `<span class="unread-badge">${d.unread}</span>` : ''}
                </div>
            </div>`;
        container.appendChild(item);
    });
}

function filterChats(q) {
    document.querySelectorAll(".chat-item").forEach(item => {
        item.style.display = item.id.toLowerCase().includes(q.toLowerCase()) ? "" : "none";
    });
}

function openChat(peerId) {
    currentChatPeer = peerId;
    if (!chatData[peerId]) initChatData(peerId);
    chatData[peerId].unread = 0;

    // FIX: an in-progress Reply or Edit from a previous chat must not
    // carry over — it was leaving its preview bar stuck open, making the
    // composer look "grown" even though nothing new was typed.
    editMessageId = null;
    hideEl("edit-preview");
    cancelReply();

    const d = chatData[peerId];
    const isGroup = isGroupChat(peerId);
    document.getElementById("chat-peer-name").innerText = d.displayName || peerId;

    const peerAvatar = document.getElementById("chat-peer-avatar");
    const peerDot = document.getElementById("peer-online-dot");

    if (isGroup) {
        const group = groups[peerId];
        const onlineCount = group.members.filter(m => activeConnections.some(c => c.peer === m && c.open)).length;
        document.getElementById("chat-peer-status").innerText = `${group.members.length + 1} members · ${onlineCount} online`;
        if (peerDot) peerDot.style.display = onlineCount > 0 ? "" : "none";
        if (peerAvatar) peerAvatar.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`;
        // Calling & block/disconnect don't apply to a group — only 1:1 features
        document.getElementById("chat-voice-call-btn")?.classList.add("hidden");
        document.getElementById("chat-video-call-btn")?.classList.add("hidden");
        document.getElementById("block-peer-menu-item")?.classList.add("hidden");
        document.getElementById("disconnect-peer-menu-item")?.classList.add("hidden");
        document.getElementById("leave-group-menu-item")?.classList.remove("hidden");
    } else {
        const isOnline = activeConnections.some(c => c.peer === peerId && c.open);
        document.getElementById("chat-peer-status").innerText = isOnline ? "P2P Connected" : "Offline";
        if (peerDot) peerDot.style.display = isOnline ? "" : "none";
        if (peerAvatar) {
            if (d.dp) peerAvatar.innerHTML = `<img src="${d.dp}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
            else peerAvatar.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>`;
        }
        document.getElementById("chat-voice-call-btn")?.classList.remove("hidden");
        document.getElementById("chat-video-call-btn")?.classList.remove("hidden");
        document.getElementById("block-peer-menu-item")?.classList.remove("hidden");
        document.getElementById("disconnect-peer-menu-item")?.classList.remove("hidden");
        document.getElementById("leave-group-menu-item")?.classList.add("hidden");
    }

    showScreen("chat-screen");
    if (currentTheme === "fish") startFishAnimation();
    renderAllMessages(peerId);
    renderPinnedBar(peerId);
    const msgInp = document.getElementById("msg-input");
    if (msgInp) { msgInp.value = ""; updateComposerButtons(); msgInp.focus(); }
}

function renderAllMessages(peerId) {
    const c = document.getElementById("messages-container");
    c.innerHTML = '<div class="date-chip"><span>Today</span></div>';
    (chatData[peerId]?.messages || []).forEach(msg => {
        if (msg.type === "system") {
            const d = document.createElement("div");
            d.className = "date-chip"; d.innerHTML = `<span>${msg.text}</span>`;
            c.appendChild(d);
        } else renderMessage(msg);
    });
    c.scrollTop = c.scrollHeight;
}

// ===== MESSAGE COMPOSER (WhatsApp-style mic<->send + auto-resize) =====
function autoResizeComposer(el) {
    el.style.height = "auto";
    const maxHeight = 130; // ~5-6 lines, then it scrolls internally
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = next + "px";
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
}

function updateComposerButtons() {
    const inp = document.getElementById("msg-input");
    const cameraBtn = document.getElementById("camera-btn");
    const actionBtn = document.getElementById("voice-record-btn");
    if (!inp || !actionBtn) return;
    const hasText = inp.value.trim().length > 0;

    if (isRecordingAudio) { autoResizeComposer(inp); return; } // don't fight the recording icon

    cameraBtn?.classList.toggle("hidden", hasText);
    actionBtn.innerHTML = hasText
        ? `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>`;
    autoResizeComposer(inp);
}

function handleComposerAction() {
    const inp = document.getElementById("msg-input");
    if (inp && inp.value.trim().length > 0) sendMessage();
    else toggleVoiceRecord();
}

function triggerCameraCapture() {
    document.getElementById("camera-file-input")?.click();
}

// Small, dependency-free emoji picker — inserts at cursor position
const EMOJI_SET = ["😀","😂","🥹","😍","😘","😉","😎","🤔","😢","😭","😡","😱","👍","👎","🙏","👏","💪","🔥","❤️","💜","💯","🎉","✅","❌","😴","🤗","😅","🙄","😏","🥳","👀","✨"];
function toggleEmojiPicker() {
    const picker = document.getElementById("emoji-picker");
    if (!picker) return;
    if (picker.classList.contains("hidden")) {
        picker.innerHTML = EMOJI_SET.map(e => `<span onclick="insertEmoji('${e}')">${e}</span>`).join("");
        picker.classList.remove("hidden");
    } else {
        picker.classList.add("hidden");
    }
}
function insertEmoji(emoji) {
    const inp = document.getElementById("msg-input");
    if (!inp) return;
    const start = inp.selectionStart ?? inp.value.length;
    const end = inp.selectionEnd ?? inp.value.length;
    inp.value = inp.value.slice(0, start) + emoji + inp.value.slice(end);
    inp.focus();
    inp.selectionStart = inp.selectionEnd = start + emoji.length;
    updateComposerButtons();
}

// ===== MESSAGING =====
function sendMessage() {
    const inp = document.getElementById("msg-input");
    if (!inp) return;
    const txt = inp.value.trim();
    if (!txt) return;

    if (editMessageId) { saveEditedMessage(editMessageId, txt); return; }

    for (const w of bannedWords) {
        if (txt.toLowerCase().includes(w)) {
            showToast("Message blocked by safety filter");
            inp.value = "";
            updateComposerButtons();
            return;
        }
    }

    if (!currentChatPeer) {
        showToast("Connect to a peer first!");
        return;
    }

    sendBundle("text", txt);
    inp.value = "";
    updateComposerButtons();
    inp.focus();
}

function sendBundle(contentType, payload) {
    const msgId = "msg-" + Date.now();
    const time = nowTime();
    const text = contentType === "text" ? payload : "";
    // FIX 1: Capture reply data BEFORE any cancelReply() can clear them
    const capturedReplyToMsgId = replyToMsgId;
    const capturedReplyText = replyText;
    const chatId = currentChatPeer;
    const groupId = isGroupChat(chatId) ? chatId : null;
    const msg = {
        id: msgId, sender: userGhostID, text, direction: "outgoing",
        dp: userCurrentDP, displayName: userDisplayName,
        contentType, mediaPayload: payload,
        viewOnce: isViewOnceEnabled,
        selfDestruct: selfDestructSeconds,
        time, replyTo: capturedReplyToMsgId, replyText: capturedReplyText
    };

    if (chatId) {
        if (!chatData[chatId]) initChatData(chatId);
        chatData[chatId].messages.push(msg);
        chatData[chatId].lastMsg = text || "Media";
        chatData[chatId].lastTime = time;
        renderMessage(msg);
        if (selfDestructSeconds > 0) scheduleDestruct(msgId, selfDestructSeconds, chatId);
    }

    // Reset reply state before sending
    cancelReply();

    // FIX: send ONLY to this specific chat (one peer, or this group's
    // members) — NOT to broadcastToMesh(), which used to fan every
    // message out to every open connection regardless of which chat you
    // were actually looking at.
    sendToChat(chatId, {
        type: "chat", msgId, sender: userGhostID, text,
        senderDP: userCurrentDP, senderName: userDisplayName,
        contentType, mediaPayload: payload,
        viewOnce: isViewOnceEnabled, selfDestruct: selfDestructSeconds,
        replyTo: capturedReplyToMsgId, replyText: capturedReplyText,
        groupId
    });

    if (isViewOnceEnabled) toggleViewOnceMode();
    renderChatList();
}

function renderMessage(msg) {
    const c = document.getElementById("messages-container");
    const card = document.createElement("div");
    card.id = msg.id;
    card.setAttribute("data-sender", msg.sender);
    card.className = "card " + (msg.direction === "outgoing" ? "outgoing" : "incoming");
    card.onclick = () => openReactionModal(msg.id);

    if (msg.direction === "incoming") {
        const av = document.createElement("div");
        av.className = "msg-avatar-sm msg-dp-" + msg.sender;
        if (msg.dp) av.innerHTML = `<img src="${msg.dp}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
        else av.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>`;
        card.appendChild(av);
    }

    const body = document.createElement("div");
    body.style.flex = "1";
    body.style.minWidth = "0";

    if (msg.direction === "incoming") {
        const sn = document.createElement("div");
        sn.className = "sender";
        sn.innerText = msg.displayName || msg.sender;
        body.appendChild(sn);
    }

    // Reply quote
    if (msg.replyText) {
        const rq = document.createElement("div");
        rq.className = "reply-quote";
        rq.innerText = msg.replyText;
        body.appendChild(rq);
    }

    const txtNode = document.createElement("div");
    txtNode.className = "msg-text-content";

    if (msg.viewOnce && msg.direction === "incoming") {
        txtNode.innerText = "Tap to view (disappears after opening)";
        txtNode.style.cssText = "color:var(--accent);font-style:italic;cursor:pointer;";
        txtNode.onclick = e => {
            e.stopPropagation();
            txtNode.innerText = msg.text;
            txtNode.style.cssText = "";
            renderMedia(txtNode, msg.contentType, msg.mediaPayload);
        };
    } else {
        txtNode.innerText = msg.text;
        renderMedia(txtNode, msg.contentType, msg.mediaPayload);
    }
    body.appendChild(txtNode);

    if (msg.selfDestruct > 0 && msg.direction === "incoming") {
        const badge = document.createElement("div");
        badge.style.cssText = "font-size:10px;color:var(--danger);margin-top:2px;";
        badge.innerText = "Self-destructs in " + msg.selfDestruct + "s";
        body.appendChild(badge);
    }

    const tr = document.createElement("div");
    tr.className = "msg-time-row";
    const te = document.createElement("span");
    te.className = "msg-time"; te.innerText = msg.time || "";
    tr.appendChild(te);
    if (msg.direction === "outgoing") {
        const tick = document.createElement("span");
        tick.id = "tick-" + msg.id; tick.className = "msg-tick"; tick.innerText = " ✓";
        tr.appendChild(tick);
    }
    body.appendChild(tr);
    card.appendChild(body);
    c.appendChild(card);
    c.scrollTop = c.scrollHeight;
}

// Tracks what's currently open in the fullscreen viewer, so its Save button knows what to download
let currentViewerMedia = null; // { dataUrl, fileName }

function humanFileSize(dataUrl) {
    try {
        const base64 = dataUrl.split(",")[1] || "";
        const bytes = base64.length * 0.75; // rough base64 -> bytes estimate
        if (bytes < 1024) return bytes.toFixed(0) + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    } catch (e) { return ""; }
}

function isValidDataUrl(dataUrl) {
    return typeof dataUrl === "string" && /^data:[a-zA-Z0-9.+/-]+;base64,/.test(dataUrl) && dataUrl.length > 30;
}

function fileIconSvg() {
    return `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm0 6V3.5L18.5 8H14z"/></svg>`;
}
function brokenIconSvg() {
    return `<svg class="media-broken-icon" viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;
}

function downloadMedia(dataUrl, filename) {
    try {
        // Converting to a Blob URL is far more reliable than a raw data: URI
        // for triggering an actual save on Android Chrome, especially for
        // larger files.
        const parts = dataUrl.split(",");
        const mimeMatch = parts[0].match(/data:(.*?);base64/);
        const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
        const byteChars = atob(parts[1]);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename || "ghostmesh-file";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        showToast("Saved!");
    } catch (e) {
        console.error("Download failed:", e);
        showToast("Couldn't save this file");
    }
}

function openMediaViewer(dataUrl, fileType, fileName) {
    currentViewerMedia = { dataUrl, fileName };
    const content = document.getElementById("media-viewer-content");
    if (fileType?.startsWith("video/")) {
        content.innerHTML = `<video src="${dataUrl}" controls autoplay playsinline></video>`;
    } else {
        content.innerHTML = `<img src="${dataUrl}" alt="">`;
    }
    showEl("media-viewer");
}
function closeMediaViewer() {
    document.getElementById("media-viewer-content").innerHTML = "";
    currentViewerMedia = null;
    hideEl("media-viewer");
}
function downloadCurrentViewerMedia() {
    if (!currentViewerMedia) return;
    downloadMedia(currentViewerMedia.dataUrl, currentViewerMedia.fileName);
}

function renderMedia(node, type, payload) {
    if (!type || !payload) return;

    if (type === "location" && payload.lat != null && payload.lng != null) {
        const wrap = document.createElement("div");
        wrap.className = "location-card";
        wrap.innerHTML = `
            <div class="location-card-map">📍</div>
            <div class="location-card-coords">${payload.lat.toFixed(4)}, ${payload.lng.toFixed(4)}</div>
            <div class="location-card-btns">
                <button class="location-btn" onclick="openLocationInMaps(${payload.lat},${payload.lng})">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>
                    Google Maps
                </button>
                <button class="location-btn location-btn-radar" onclick="openLocationOnRadar(${payload.lat},${payload.lng})">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/></svg>
                    Radar Map
                </button>
            </div>`;
        node.appendChild(wrap);
        return;
    }

    if (type === "media" && payload.fileData) {
        const wrap = document.createElement("div");
        wrap.style.marginTop = "6px";

        if (!isValidDataUrl(payload.fileData)) {
            // Corrupt/broken media — never show a silent blank box.
            wrap.innerHTML = `
                <div class="media-broken">
                    ${brokenIconSvg()}
                    <span class="media-broken-text">This file couldn't be loaded (may be corrupted)</span>
                    <button class="media-save-btn" onclick="event.stopPropagation();downloadMedia('${payload.fileData || ''}','${payload.fileName || 'file'}')">Try Download Anyway</button>
                </div>`;
            node.appendChild(wrap);
            return;
        }

        const safeFileName = (payload.fileName || "file").replace(/'/g, "");
        if (payload.fileType?.startsWith("image/")) {
            wrap.innerHTML = `
                <img src="${payload.fileData}" class="shared-img" onclick="event.stopPropagation();openMediaViewer(this.src,'${payload.fileType}','${safeFileName}')" onerror="this.parentElement.innerHTML='<div class=&quot;media-broken&quot;>${brokenIconSvg()}<span class=&quot;media-broken-text&quot;>Image couldn\\'t load</span></div>'">
                <button class="media-save-btn" onclick="event.stopPropagation();downloadMedia('${payload.fileData}','${safeFileName}')">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> Save
                </button>`;
        } else if (payload.fileType?.startsWith("video/")) {
            wrap.innerHTML = `
                <video src="${payload.fileData}" controls class="shared-video" onclick="event.stopPropagation()"></video>
                <button class="media-save-btn" onclick="event.stopPropagation();downloadMedia('${payload.fileData}','${safeFileName}')">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> Save
                </button>`;
        } else {
            // Generic document — proper file card (icon + name + size + round download button)
            wrap.innerHTML = `
                <div class="file-card">
                    <div class="file-card-icon">${fileIconSvg()}</div>
                    <div class="file-card-info">
                        <div class="file-card-name">${safeFileName}</div>
                        <div class="file-card-size">${humanFileSize(payload.fileData)}</div>
                    </div>
                    <button class="file-card-download" onclick="event.stopPropagation();downloadMedia('${payload.fileData}','${safeFileName}')">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                    </button>
                </div>`;
        }
        node.appendChild(wrap);
    } else if (type === "audio" && payload) {
        const wrap = document.createElement("div");
        wrap.style.marginTop = "6px";
        if (!isValidDataUrl(payload)) {
            wrap.innerHTML = `<div class="media-broken">${brokenIconSvg()}<span class="media-broken-text">Voice note couldn't load</span></div>`;
        } else {
            wrap.innerHTML = `<audio src="${payload}" controls onclick="event.stopPropagation()"></audio>`;
        }
        node.appendChild(wrap);
    }
}

function scheduleDestruct(msgId, seconds, chatId) {
    setTimeout(() => {
        renderDeleteLocal(msgId);
        sendToChat(chatId, { type: "destruct", msgId, groupId: isGroupChat(chatId) ? chatId : undefined });
    }, seconds * 1000);
}

function setSelfDestruct(s) {
    selfDestructSeconds = s;
    hideEl("destruct-overlay");
    showToast(s > 0 ? `Self-destruct: ${s < 60 ? s + " sec" : "1 min"}` : "Self-destruct off");
}

function broadcastToMesh(obj) {
    const dead = [];
    activeConnections.forEach(c => {
        try {
            if (c?.open) c.send(obj);
        } catch (e) {
            // One bad connection must never stop the message reaching
            // everyone else.
            console.error("Send failed to", c?.peer, e);
            dead.push(c);
        }
    });
    // Prune connections that just proved themselves dead so future
    // broadcasts don't keep failing on them.
    if (dead.length) {
        activeConnections = activeConnections.filter(c => !dead.includes(c));
    }
}

// ===== TYPING =====
let lastTypingPingAt = 0;
let typingListenerAttached = false;
function setupTypingListener() {
    const inp = document.getElementById("msg-input");
    if (!inp) return;
    // initApp() and the DOMContentLoaded handler both call this — without the
    // guard the listener attached twice, so every keystroke sent two typing
    // packets down the same data channel.
    if (typingListenerAttached) return;
    typingListenerAttached = true;
    inp.addEventListener("input", () => {
        updateComposerButtons();
        // FIX: sending an "isTyping" packet on every single keystroke floods
        // the data channel and was adding real delay before actual messages
        // got through. Throttle to at most once every 1.2s while typing.
        const now = Date.now();
        if (now - lastTypingPingAt > 1200) {
            lastTypingPingAt = now;
            sendToChat(currentChatPeer, { type: "typing", sender: userGhostID, displayName: userDisplayName, isTyping: true, groupId: isGroupChat(currentChatPeer) ? currentChatPeer : undefined });
        }
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => sendToChat(currentChatPeer, { type: "typing", sender: userGhostID, isTyping: false, groupId: isGroupChat(currentChatPeer) ? currentChatPeer : undefined }), 2000);
    });
}

// ===== REPLY =====
function replyToSelected() {
    closeReactionModal();
    if (!selectedMsgIdForContext) return;
    const card = document.getElementById(selectedMsgIdForContext);
    if (!card) return;
    const txt = card.querySelector(".msg-text-content")?.innerText || "";
    replyToMsgId = selectedMsgIdForContext;
    replyText = txt.substring(0, 60);
    document.getElementById("reply-preview-text").innerText = replyText;
    showEl("reply-preview");
    document.getElementById("msg-input").focus();
}

function cancelReply() {
    replyToMsgId = null; replyText = "";
    hideEl("reply-preview");
}

// ===== REACTIONS + DELETE =====
function openReactionModal(msgId) {
    selectedMsgIdForContext = msgId;
    const chat = chatData[currentChatPeer];
    const msgObj = chat?.messages.find(m => m.id === msgId);
    const editBtn = document.getElementById("edit-msg-btn");
    const pinBtn = document.getElementById("pin-msg-btn");
    if (editBtn) {
        const canEdit = msgObj && msgObj.direction === "outgoing" && msgObj.contentType === "text" && !msgObj.viewOnce;
        editBtn.classList.toggle("hidden", !canEdit);
    }
    if (pinBtn) pinBtn.innerText = (chat?.pinnedMsgId === msgId) ? "Unpin Message" : "Pin Message";
    showEl("reaction-modal");
}
function closeReactionModal() { hideEl("reaction-modal"); }

function sendReaction(emoji) {
    closeReactionModal();
    if (!selectedMsgIdForContext) return;
    renderReactionLocal(selectedMsgIdForContext, emoji);
    sendToChat(currentChatPeer, { type: "reaction", msgId: selectedMsgIdForContext, emoji, groupId: isGroupChat(currentChatPeer) ? currentChatPeer : undefined });
}

function renderReactionLocal(msgId, emoji) {
    const card = document.getElementById(msgId); if (!card) return;
    let badge = card.querySelector(".reaction-badge");
    if (!badge) { badge = document.createElement("span"); badge.className = "reaction-badge"; card.appendChild(badge); }
    badge.innerText = emoji;
}

// ===== MESSAGE EDITING =====
function startEditMessage() {
    closeReactionModal();
    const chat = chatData[currentChatPeer];
    const msgObj = chat?.messages.find(m => m.id === selectedMsgIdForContext);
    if (!msgObj) return;
    editMessageId = msgObj.id;
    cancelReply(); // editing and replying don't mix
    const inp = document.getElementById("msg-input");
    if (inp) {
        inp.value = msgObj.text;
        updateComposerButtons();
        inp.focus();
    }
    showEl("edit-preview");
}

function cancelEditMessage() {
    editMessageId = null;
    hideEl("edit-preview");
    const inp = document.getElementById("msg-input");
    if (inp) { inp.value = ""; updateComposerButtons(); }
}

function saveEditedMessage(msgId, newText) {
    const chatId = currentChatPeer;
    const msgObj = chatData[chatId]?.messages.find(m => m.id === msgId);
    if (!msgObj) { cancelEditMessage(); return; }
    msgObj.text = newText;
    msgObj.edited = true;
    if (chatData[chatId].pinnedMsgId === msgId) renderPinnedBar(chatId); // pinned preview text may need updating
    renderEditLocal(msgId, newText);
    sendToChat(chatId, { type: "edit-message", msgId, text: newText, groupId: isGroupChat(chatId) ? chatId : undefined });
    cancelEditMessage();
}

function renderEditLocal(msgId, newText) {
    const card = document.getElementById(msgId);
    if (!card) return;
    const txtNode = card.querySelector(".msg-text-content");
    if (txtNode) txtNode.innerText = newText;
    if (!card.querySelector(".edited-label")) {
        const label = document.createElement("span");
        label.className = "edited-label";
        label.innerText = "(edited)";
        card.querySelector(".msg-time-row")?.prepend(label);
    }
}

// ===== PIN MESSAGE (free: 1 per chat, unlimited = Premium) =====
function togglePinMessage() {
    closeReactionModal();
    const chatId = currentChatPeer;
    const chat = chatData[chatId];
    if (!chat) return;

    if (chat.pinnedMsgId === selectedMsgIdForContext) {
        chat.pinnedMsgId = null;
        renderPinnedBar(chatId);
        showToast("Message unpinned");
        return;
    }
    if (chat.pinnedMsgId) {
        showToast("Free plan allows 1 pin per chat — unpin it first, or go Premium for unlimited pins");
        return;
    }
    chat.pinnedMsgId = selectedMsgIdForContext;
    renderPinnedBar(chatId);
    showToast("Message pinned");
}

function renderPinnedBar(chatId) {
    const bar = document.getElementById("pinned-bar");
    if (!bar) return;
    if (chatId !== currentChatPeer) return; // only reflect the chat that's actually open
    const chat = chatData[chatId];
    const msgObj = chat?.messages.find(m => m.id === chat.pinnedMsgId);
    if (!chat?.pinnedMsgId || !msgObj) { bar.classList.add("hidden"); return; }
    document.getElementById("pinned-bar-text").innerText = msgObj.text || (msgObj.contentType === "audio" ? "Voice note" : "Media message");
    bar.classList.remove("hidden");
}

function jumpToPinnedMessage() {
    const chat = chatData[currentChatPeer];
    if (!chat?.pinnedMsgId) return;
    const card = document.getElementById(chat.pinnedMsgId);
    if (!card) { showToast("Pinned message is above — scroll up"); return; }
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("highlight-flash");
    setTimeout(() => card.classList.remove("highlight-flash"), 1200);
}

function unpinCurrentMessage() {
    const chat = chatData[currentChatPeer];
    if (chat) chat.pinnedMsgId = null;
    renderPinnedBar(currentChatPeer);
}

function triggerDeleteForEveryone() {
    closeReactionModal();
    const card = document.getElementById(selectedMsgIdForContext);
    if (!card) return;
    if (card.getAttribute("data-sender") !== userGhostID) { showToast("Can only delete your own messages"); return; }
    renderDeleteLocal(selectedMsgIdForContext);
    sendToChat(currentChatPeer, { type: "delete", msgId: selectedMsgIdForContext, groupId: isGroupChat(currentChatPeer) ? currentChatPeer : undefined });
}

function renderDeleteLocal(msgId) {
    const card = document.getElementById(msgId); if (!card) return;
    const txt = card.querySelector(".msg-text-content");
    if (txt) { txt.innerText = "Message deleted"; txt.style.cssText = "font-style:italic;opacity:0.5;"; }
    card.querySelector(".media-container")?.remove();
}

// ===== CHAT MENU ACTIONS =====
function shareLiveLocation() {
    closeAllMenus();
    navigator.geolocation?.getCurrentPosition(pos => {
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        sendToChat(currentChatPeer, { type: "location", sender: userGhostID, senderName: userDisplayName, lat, lng, senderDP: userCurrentDP, groupId: isGroupChat(currentChatPeer) ? currentChatPeer : undefined });
        // Show it on our own side too — sendToChat only transmits, it never
        // renders locally.
        if (currentChatPeer) {
            const lm = { id: "loc-"+Date.now(), sender: userGhostID, text: "", direction: "outgoing", dp: userCurrentDP, contentType: "location", mediaPayload: { lat, lng }, time: nowTime() };
            if (!chatData[currentChatPeer]) initChatData(currentChatPeer);
            chatData[currentChatPeer].messages.push(lm);
            renderMessage(lm);
        }
        showToast("Live location shared for 15 min");
    }, () => showToast("Location permission denied"));
}
function clearCurrentChat() {
    closeAllMenus();
    if (!currentChatPeer || !confirm("Clear all messages?")) return;
    chatData[currentChatPeer].messages = [];
    renderAllMessages(currentChatPeer);
    showToast("Chat cleared");
}
function clearAllChats() { closeAllMenus(); if(confirm("Clear all chats?")){ Object.keys(chatData).forEach(k => chatData[k].messages = []); showToast("All chats cleared"); renderChatList(); } }
let blockedPeers = new Set();

function blockCurrentPeer() {
    closeAllMenus();
    if (!currentChatPeer || !confirm("Block " + currentChatPeer + "?")) return;
    const peerId = currentChatPeer;
    // FIX 8: Add to blocked set, close connection, remove from chat
    blockedPeers.add(peerId);
    safeStorage.set("gm_blocked", JSON.stringify([...blockedPeers]));
    const conn = activeConnections.find(c => c.peer === peerId);
    if (conn) { try { conn.close(); } catch(e){} }
    activeConnections = activeConnections.filter(c => c.peer !== peerId);
    delete chatData[peerId];
    delete onlineUsers[peerId];
    goBackToList();
    showToast(peerId + " blocked");
}

function loadBlockedPeers() {
    try {
        const saved = safeStorage.get("gm_blocked");
        if (saved) blockedPeers = new Set(JSON.parse(saved));
    } catch(e) { blockedPeers = new Set(); }
}
function disconnectCurrentPeer() { closeAllMenus(); const conn=activeConnections.find(c=>c.peer===currentChatPeer); if(conn) conn.close(); goBackToList(); showToast("Disconnected"); }

// ===== FIX 7: QUICK THEME CYCLE BUTTON =====
const themeOrder = ["default", "whatsapp", "ocean", "amoled", "forest", "sunset"];
function cycleThemeQuick() {
    const idx = themeOrder.indexOf(currentTheme);
    const next = themeOrder[(idx + 1) % themeOrder.length];
    applyTheme(next);
    const btn = document.getElementById("quick-theme-btn");
    if (btn) {
        btn.style.color = "var(--accent)";
        setTimeout(() => { if(btn) btn.style.color = ""; }, 600);
    }
    showToast("Theme: " + (themes.find(t=>t.id===next)?.name || next));
}

// ===== THEME TOGGLE (from header) =====
function toggleAppTheme() { closeAllMenus(); openThemePicker(); }

// ===== DP UPLOAD =====
function toggleAttachMenu() {
    document.getElementById("attach-menu")?.classList.toggle("hidden");
}
function triggerFileAttachment(kind) {
    const input = document.getElementById("attachment-file-input");
    if (!input) return;
    input.accept = kind === "photo" ? "image/*,video/*" : "";
    hideEl("attach-menu");
    input.click();
}
function handleFileAttachment(event) {
    const file = event.target.files[0]; if (!file) return;
    // FIX 4: Check peer connected before sending file
    if (!currentChatPeer) { showToast("Connect to a peer first!"); event.target.value = ""; return; }
    if (file.size > 10*1024*1024) { showToast("File too large — max 10MB"); event.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = e => {
        sendBundle("media", { fileData: e.target.result, fileName: file.name, fileType: file.type });
        event.target.value = "";
    };
    reader.readAsDataURL(file);
}

// ===== VIEW ONCE =====
function toggleViewOnceMode() {
    isViewOnceEnabled = !isViewOnceEnabled;
    document.getElementById("view-once-btn").style.color = isViewOnceEnabled ? "var(--accent)" : "";
    document.getElementById("view-once-badge").classList.toggle("hidden", !isViewOnceEnabled);
}

// ===== VOICE RECORD =====
function getSupportedAudioMime() {
    const types = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'];
    for (const t of types) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) return t;
    return '';
}

function toggleVoiceRecord() {
    const btn = document.getElementById("voice-record-btn");
    if (!isRecordingAudio) {
        gmGetUserMedia({ audio: true }).then(stream => {
            recordedAudioChunks = [];
            const mime = getSupportedAudioMime();
            try { mediaRecorderInstance = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
            catch(e) { mediaRecorderInstance = new MediaRecorder(stream); }
            const usedType = mediaRecorderInstance.mimeType || 'audio/webm';
            mediaRecorderInstance.ondataavailable = e => { if(e.data?.size > 0) recordedAudioChunks.push(e.data); };
            mediaRecorderInstance.onstop = () => {
                const blob = new Blob(recordedAudioChunks, { type: usedType });
                const reader = new FileReader();
                reader.onload = e => sendBundle("audio", e.target.result);
                reader.readAsDataURL(blob);
                stream.getTracks().forEach(t => t.stop());
            };
            mediaRecorderInstance.start();
            isRecordingAudio = true;
            btn.style.color = "var(--danger)";
            btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>`;
        }).catch(e => { if (isInsecureMediaError(e)) return; showToast("Mic permission denied"); });
    } else {
        mediaRecorderInstance.stop();
        isRecordingAudio = false;
        btn.style.color = "";
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>`;
    }
}

// ===== RINGTONE =====
function playRingtone(type) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const playBeep = (freq, start, dur) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = type === 'ring' ? 'sine' : 'triangle';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.3, ctx.currentTime + start);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
            osc.start(ctx.currentTime + start);
            osc.stop(ctx.currentTime + start + dur);
        };
        if (type === 'ring') {
            for (let i = 0; i < 3; i++) { playBeep(880, i*0.5, 0.3); playBeep(660, i*0.5+0.15, 0.15); }
        } else if (type === 'connect') {
            playBeep(660, 0, 0.1); playBeep(880, 0.12, 0.15);
        } else if (type === 'end') {
            playBeep(440, 0, 0.1); playBeep(330, 0.12, 0.2);
        }
        return ctx;
    } catch(e) { return null; }
}

let ringtoneCtx = null;
function startRingtone() { ringtoneCtx = playRingtone('ring'); }
function stopRingtone() { try { ringtoneCtx?.close(); } catch(e){} ringtoneCtx = null; }

// ===== CALLS =====
// ----- Shared call-screen UI helpers (used by both online and offline calls) -----
function openCallUI(peerId, type, statusText) {
    showEl("call-screen");
    hideEl("incoming-call-overlay");
    const isVideo = type === 'video';
    document.getElementById("call-peer-label").innerText = chatData[peerId]?.displayName || peerId;
    document.getElementById("call-status-label").innerText = statusText;
    document.getElementById("call-timer").classList.add("hidden");
    document.getElementById("call-video-toggle-btn").classList.toggle("hidden", !isVideo);
    document.getElementById("call-camera-switch-btn").classList.toggle("hidden", !isVideo);
    document.getElementById("call-video-toggle-btn").classList.remove("video-off");
    document.getElementById("local-video").classList.toggle("hidden", !isVideo);
    document.getElementById("remote-video").classList.add("hidden");
    document.getElementById("call-dp-fallback").classList.remove("hidden");
    setAvatarDisplay("call-peer-avatar-big", chatData[peerId]?.dp || null);
    if (isVideo && localMediaStream) document.getElementById("local-video").srcObject = localMediaStream;
}

// Info about the call currently ringing on this device. Kept separate from
// pendingIncomingCallEvent (which holds the PeerJS/offline object itself) so
// the UI can time out and clean up even if the caller vanishes.
let pendingIncomingCallInfo = null;
let incomingCallTimeout = null;

function showIncomingCallUI(peerId, type) {
    pendingIncomingCallInfo = { peerId, type, startedAt: Date.now() };
    // A caller that gives up must not leave this screen ringing forever.
    clearTimeout(incomingCallTimeout);
    incomingCallTimeout = setTimeout(() => {
        if (!pendingIncomingCallInfo) return;
        console.warn("Incoming call timed out after 45s");
        rejectIncomingCall();
        showToast("Missed call");
    }, 45000);
    showEl("call-screen");
    document.getElementById("call-peer-label").innerText = chatData[peerId]?.displayName || peerId;
    document.getElementById("call-status-label").innerText = type === 'video' ? "Incoming Video Call" : "Incoming Voice Call";
    document.getElementById("call-timer").classList.add("hidden");
    document.getElementById("remote-video").classList.add("hidden");
    document.getElementById("call-dp-fallback").classList.remove("hidden");
    document.getElementById("local-video").classList.add("hidden");
    document.getElementById("call-video-toggle-btn").classList.add("hidden");
    document.getElementById("call-camera-switch-btn").classList.add("hidden");
    setAvatarDisplay("call-peer-avatar-big", chatData[peerId]?.dp || null);
    showEl("incoming-call-overlay");
    startRingtone();
    if (navigator.vibrate) navigator.vibrate([500,200,500]);
}

function updateCallStatusLabel(text) {
    const el = document.getElementById("call-status-label");
    if (el) el.innerText = text;
}

// Toggles between full-screen remote video and the DP fallback avatar.
function toggleCallVideoUI(hasVideo) {
    document.getElementById("remote-video").classList.toggle("hidden", !hasVideo);
    document.getElementById("call-dp-fallback").classList.toggle("hidden", hasVideo);
}

function sendToPeer(peerId, payload) {
    const conn = activeConnections.find(c => c.peer === peerId);
    if (conn && conn.open) conn.send(payload);
}

// ----- Entry point: routes to online (PeerJS) or offline (raw WebRTC) calling ----
function initiateP2PCall(type) {
    if (activeConnections.length === 0) { showToast("Connect to a peer first!"); return; }
    const target = currentChatPeer || activeConnections[0].peer;
    if (offlinePeerConnections[target]) { startOfflineCall(target, type); return; }

    gmGetUserMedia({ audio: true, video: type === 'video' }).then(stream => {
        localMediaStream = stream;
        openCallUI(target, type, type === 'video' ? "Video Calling..." : "Voice Calling...");
        if (type === 'video') document.getElementById("local-video").srcObject = stream;
        activeP2PCallInstance = myPeerInstance.call(target, stream, { metadata: { type } });
        listenCallStream(activeP2PCallInstance, type);
        playRingtone('ring');
    }).catch(e => { if (isInsecureMediaError(e)) return; showToast("Camera/Mic access denied"); });
}

function listenCallStream(callObj, type) {
    callObj.on('stream', remoteStream => {
        stopRingtone();
        playRingtone('connect');
        updateCallStatusLabel("Connected");
        const remoteVideo = document.getElementById("remote-video");
        remoteVideo.srcObject = remoteStream;
        remoteVideo.play().catch(()=>{});
        toggleCallVideoUI(remoteStream.getVideoTracks().length > 0);
        startCallTimer();
    });
    callObj.on('close', endCallFlow);
    callObj.on('error', endCallFlow);
}

// Runs when a PeerJS (online) call arrives. Previously this blindly
// overwrote pendingIncomingCallEvent and showed the UI, which is how the
// receiver ended up erroring: a second call overwrote the first (so the first
// caller rang forever), a call that the caller had already cancelled stayed on
// screen, and tapping Accept then answered a dead connection.
function handleIncomingCall(call) {
    if (!call || !call.peer) return;
    if (blockedPeers.has(call.peer)) { try { call.close(); } catch (e) {} return; }

    if (pendingIncomingCallEvent || activeP2PCallInstance || activeOfflineCallPeer) {
        try { call.close(); } catch (e) {}
        showToast("Already on a call — rejected " + call.peer);
        return;
    }

    pendingIncomingCallEvent = call;
    // The peer can hang up while it is still ringing here: without these
    // handlers the incoming-call screen stayed open and Accept then threw.
    if (typeof call.on === "function") {
        call.on("close", () => {
            if (pendingIncomingCallEvent === call && pendingIncomingCallInfo) {
                pendingIncomingCallInfo = null;
                clearTimeout(incomingCallTimeout);
                stopRingtone();
                hideEl("incoming-call-overlay");
                hideEl("call-screen");
                showToast("Missed call from " + call.peer);
            }
        });
        call.on("error", err => {
            console.error("Incoming call error:", err);
            rejectIncomingCall();
            showToast("Call failed: " + (err && err.message ? err.message : "connection error"));
        });
    }
    showIncomingCallUI(call.peer, (call.metadata && call.metadata.type) || 'voice');
}

// ----- Offline (QR/WiFi) calling: renegotiates the SAME RTCPeerConnection
// that already carries the offline chat data channel. No server involved —
// offer/answer/ICE candidates travel as normal chat-style messages over
// that data channel. -----
async function startOfflineCall(peerId, type) {
    const pc = offlinePeerConnections[peerId];
    if (!pc) { showToast("Peer connection not found"); return; }
    try {
        const stream = await gmGetUserMedia({ audio: true, video: type === 'video' });
        localMediaStream = stream;
        stream.getTracks().forEach(t => pc.addTrack(t, stream));
        pc.ontrack = event => {
            attachRemoteStream(event.streams[0]);
            toggleCallVideoUI(event.streams[0].getVideoTracks().length > 0);
        };
        pc.onicecandidate = e => { if (e.candidate) sendToPeer(peerId, { type: "voip-ice", candidate: e.candidate }); };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendToPeer(peerId, { type: "voip-offer", sdp: pc.localDescription, callType: type });

        openCallUI(peerId, type, type === 'video' ? "Video Calling..." : "Voice Calling...");
        activeOfflineCallPeer = peerId; activeOfflineCallType = type;
        playRingtone('ring');
    } catch(e) {
        console.error(e);
        if (!isInsecureMediaError(e)) showToast("Camera/Mic access denied");
    }
}

function attachRemoteStream(stream) {
    const remoteVideo = document.getElementById("remote-video");
    remoteVideo.srcObject = stream;
    remoteVideo.play().catch(()=>{});
}

async function acceptIncomingCall() {
    const call = pendingIncomingCallEvent;
    stopRingtone();
    clearTimeout(incomingCallTimeout);
    hideEl("incoming-call-overlay");

    if (!call) {
        // Accept tapped twice, or the caller gave up first.
        hideEl("call-screen");
        showToast("That call already ended");
        return;
    }
    if (!call.offline && call.open === false) {
        pendingIncomingCallEvent = null;
        pendingIncomingCallInfo = null;
        endCallFlow();
        showToast("That call already ended");
        return;
    }

    const isOffline = !!call.offline;
    const type = isOffline ? call.callType : ((call.metadata && call.metadata.type) || 'voice');

    let stream;
    try {
        stream = await gmGetUserMedia({ audio: true, video: type === 'video' });
    } catch (e) {
        // Out of camera/mic permission or no hardware. Answering is impossible,
        // so tell the caller instead of leaving them ringing for 45s.
        console.error("Could not get media for incoming call:", e);
        if (!isInsecureMediaError(e)) showToast("Mic/Camera unavailable — call rejected");
        if (isOffline) sendToPeer(call.peerId, { type: "voip-end" });
        else { try { call.close(); } catch (err) {} }
        pendingIncomingCallEvent = null;
        pendingIncomingCallInfo = null;
        endCallFlow();
        return;
    }

    localMediaStream = stream;
    document.getElementById("call-video-toggle-btn").classList.toggle("hidden", type !== 'video');
    document.getElementById("call-camera-switch-btn").classList.toggle("hidden", type !== 'video');
    document.getElementById("local-video").classList.toggle("hidden", type !== 'video');
    if (type === 'video') document.getElementById("local-video").srcObject = stream;

    if (isOffline) {
        const peerId = call.peerId;
        const pc = offlinePeerConnections[peerId];
        if (!pc) {
            stream.getTracks().forEach(t => t.stop());
            localMediaStream = null;
            sendToPeer(peerId, { type: "voip-end" });
            pendingIncomingCallEvent = null;
            pendingIncomingCallInfo = null;
            endCallFlow();
            showToast("Peer connection was closed — call ended");
            return;
        }
        try {
            stream.getTracks().forEach(t => pc.addTrack(t, stream));
            pc.ontrack = event => {
                attachRemoteStream(event.streams[0]);
                toggleCallVideoUI(event.streams[0].getVideoTracks().length > 0);
            };
            pc.onicecandidate = e => { if (e.candidate) sendToPeer(peerId, { type: "voip-ice", candidate: e.candidate }); };

            await pc.setRemoteDescription(new RTCSessionDescription(call.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendToPeer(peerId, { type: "voip-answer", sdp: pc.localDescription });

            activeOfflineCallPeer = peerId; activeOfflineCallType = type;
            pendingIncomingCallEvent = null;
            pendingIncomingCallInfo = null;
            updateCallStatusLabel("Connected");
            playRingtone('connect');
            startCallTimer();
        } catch (e) {
            console.error("Offline call answer failed:", e);
            sendToPeer(peerId, { type: "voip-end" });
            pendingIncomingCallEvent = null;
            pendingIncomingCallInfo = null;
            endCallFlow();
            showToast("Could not answer — connection error");
        }
        return;
    }

    try {
        call.answer(stream);
        listenCallStream(call, type);
        pendingIncomingCallInfo = null;
    } catch (e) {
        console.error("Answering the call failed:", e);
        stream.getTracks().forEach(t => t.stop());
        localMediaStream = null;
        pendingIncomingCallEvent = null;
        pendingIncomingCallInfo = null;
        endCallFlow();
        showToast("Could not answer that call");
    }
}
function rejectIncomingCall() {
    stopRingtone();
    clearTimeout(incomingCallTimeout);
    const call = pendingIncomingCallEvent;
    try {
        if (call && call.offline) sendToPeer(call.peerId, { type: "voip-end" });
        else if (call && typeof call.close === "function") call.close();
    } catch (e) {
        console.error("Rejecting the call failed:", e);
    }
    pendingIncomingCallEvent = null;
    pendingIncomingCallInfo = null;
    hideEl("call-screen");
    hideEl("incoming-call-overlay");
}

function toggleCallVideo() {
    if (!localMediaStream) return;
    const videoTracks = localMediaStream.getVideoTracks();
    if (videoTracks.length === 0) return;
    const nowEnabled = !videoTracks[0].enabled;
    videoTracks.forEach(t => t.enabled = nowEnabled);
    document.getElementById("call-video-toggle-btn").classList.toggle("video-off", !nowEnabled);
    document.getElementById("local-video").classList.toggle("hidden", !nowEnabled);
    showToast(nowEnabled ? "Camera On" : "Camera Off");
}

// Flips between front and back camera mid-call. Works for BOTH online
// (PeerJS) and offline (raw RTCPeerConnection) calls by grabbing a fresh
// video track and swapping it into the same connection with
// RTCRtpSender.replaceTrack() — the other side keeps seeing you without
// any renegotiation or dropped call.
async function switchCallCamera() {
    if (!localMediaStream) return;
    const oldVideoTrack = localMediaStream.getVideoTracks()[0];
    if (!oldVideoTrack) { showToast("No camera in this call"); return; }

    const wantFront = !isUsingFrontCamera;
    const facingMode = wantFront ? "user" : "environment";
    try {
        const newStream = await gmGetUserMedia({
            video: { facingMode: { exact: facingMode } },
            audio: false
        });
        const newVideoTrack = newStream.getVideoTracks()[0];

        // Find whichever peer connection is actually carrying this call —
        // online calls expose it via PeerJS's MediaConnection, offline
        // calls use the raw RTCPeerConnection we already keep a handle to.
        let pc = null;
        if (activeP2PCallInstance?.peerConnection) {
            pc = activeP2PCallInstance.peerConnection;
        } else if (activeOfflineCallPeer && offlinePeerConnections[activeOfflineCallPeer]) {
            pc = offlinePeerConnections[activeOfflineCallPeer];
        }
        if (pc) {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
            if (sender) await sender.replaceTrack(newVideoTrack);
        }

        localMediaStream.removeTrack(oldVideoTrack);
        localMediaStream.addTrack(newVideoTrack);
        oldVideoTrack.stop();
        document.getElementById("local-video").srcObject = localMediaStream;

        isUsingFrontCamera = wantFront;
        showToast(wantFront ? "Front camera" : "Back camera");
    } catch (e) {
        console.error("Camera switch failed:", e);
        showToast("Could not switch camera — this device may only have one camera");
    }
}

function endCurrentCall() {
    activeP2PCallInstance?.close();
    if (pendingIncomingCallEvent && !pendingIncomingCallEvent.offline) pendingIncomingCallEvent?.close();
    if (activeOfflineCallPeer) sendToPeer(activeOfflineCallPeer, { type: "voip-end" });
    endCallFlow();
}

function endCallFlow() {
    stopRingtone();
    playRingtone('end');
    stopCallTimer();
    isUsingFrontCamera = true;

    if (activeOfflineCallPeer) {
        const pc = offlinePeerConnections[activeOfflineCallPeer];
        if (pc) {
            pc.getSenders().forEach(s => { try { pc.removeTrack(s); } catch(e){} });
            pc.ontrack = null;
            pc.onicecandidate = null;
        }
    }

    localMediaStream?.getTracks().forEach(t => t.stop());
    localMediaStream = null; activeP2PCallInstance = null; pendingIncomingCallEvent = null;
    pendingIncomingCallInfo = null; clearTimeout(incomingCallTimeout);
    activeOfflineCallPeer = null; activeOfflineCallType = null;

    document.getElementById("remote-video").srcObject = null;
    document.getElementById("remote-video").classList.add("hidden");
    document.getElementById("local-video").srcObject = null;
    document.getElementById("local-video").classList.add("hidden");
    document.getElementById("call-dp-fallback").classList.remove("hidden");
    document.getElementById("call-video-toggle-btn").classList.remove("hidden", "video-off");
    document.getElementById("call-camera-switch-btn").classList.remove("hidden");

    hideEl("call-screen");
    hideEl("incoming-call-overlay");
    document.getElementById("call-timer").classList.add("hidden");
}

function startCallTimer() {
    callSeconds = 0;
    const timerEl = document.getElementById("call-timer");
    timerEl.classList.remove("hidden");
    callTimerInterval = setInterval(() => {
        callSeconds++;
        const m = String(Math.floor(callSeconds/60)).padStart(2,'0');
        const s = String(callSeconds%60).padStart(2,'0');
        timerEl.innerText = m + ":" + s;
    }, 1000);
}

function stopCallTimer() { clearInterval(callTimerInterval); callSeconds = 0; }

function toggleMute() {
    isMuted = !isMuted;
    if (localMediaStream) localMediaStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    document.getElementById("mute-btn").classList.toggle("muted", isMuted);
    showToast(isMuted ? "Muted" : "Unmuted");
}

function toggleSpeaker() {
    isSpeaker = !isSpeaker;
    document.getElementById("speaker-btn").style.color = isSpeaker ? "var(--accent)" : "";
    showToast(isSpeaker ? "Speaker On" : "Speaker Off");
}

// ===== RADAR MAP =====
// Leaflet's default marker icons are fetched from images/marker-icon.png,
// which this project doesn't ship — every L.marker() rendered a broken image
// and logged a 404. A divIcon draws the pin with CSS instead, so no extra
// image files are needed.
function gmMapPin(lat, lng, popupHtml, mapInst, openNow) {
    if (typeof L === "undefined" || !mapInst) return null;
    const marker = L.marker([lat, lng], {
        icon: L.divIcon({
            className: "gm-map-pin",
            html: "<span></span>",
            iconSize: [22, 22],
            iconAnchor: [11, 11],
            popupAnchor: [0, -12]
        })
    }).addTo(mapInst).bindPopup(popupHtml);
    if (openNow) marker.openPopup();
    return marker;
}

function initRadarMap() {
    if (typeof L === "undefined") return; // leaflet.js unavailable — everything else still works
    try {
        radarMapInstance = L.map('live-radar-map').setView([20.5937, 78.9629], 5);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(radarMapInstance);
        navigator.geolocation?.getCurrentPosition(pos => {
            userLat = pos.coords.latitude; userLng = pos.coords.longitude;
            hasRealLocation = true;
            radarMapInstance.setView([userLat, userLng], 13);
            gmMapPin(userLat, userLng, `<b>You (${userGhostID})</b>`, radarMapInstance, true);
            spawnNearbyNodes(userLat, userLng, radarMapInstance);
        }, () => spawnNearbyNodes(20.5937, 78.9629, radarMapInstance));
    } catch(e) { console.error(e); }
}

function toggleRadarMap() {
    closeAllMenus();
    const map = document.getElementById("map-container");
    const hidden = map.classList.contains("hidden");
    map.classList.toggle("hidden", !hidden);
    if (!hidden) return;
    if (radarMapInstance) setTimeout(() => radarMapInstance.invalidateSize(), 300);
}

// FIX 2 & 3: spawnNearbyNodes removed — no fake users, no fake map nodes.
// Only real connected peers appear on map and online users list.
function spawnNearbyNodes(lat, lng, mapInst) {
    // Real peers only — markers added when peers connect via setupConn
    activeConnections.forEach(conn => {
        const name = chatData[conn.peer]?.displayName || conn.peer;
        gmMapPin(lat + (Math.random()-0.5)*0.01, lng + (Math.random()-0.5)*0.01,
            `<b>${name}</b><br>P2P Connected<br><button class="map-connect-btn" onclick="openChat('${conn.peer}')">Open Chat</button>`,
            mapInst);
    });
    if (activeConnections.length === 0) {
        L.popup().setLatLng([lat, lng]).setContent("No peers nearby yet").openOn(mapInst);
    }
}

// ===== PUSH NOTIFICATION =====
function sendPushNotif(sender, text) {
    if (!notificationsEnabled) return;
    if (document.hasFocus()) return;
    // Runs on every incoming message, so it must never throw in environments
    // without the Notification API (plain Android WebView wrappers, some
    // in-app browsers).
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
        new Notification("Ghost Mesh — " + sender, { body: text, icon: "icon-192.png" });
    } catch (e) { /* notification blocked — the in-app banner already showed it */ }
}

// ===== MENUS =====
function toggleMainMenu() { const m = document.getElementById("main-menu"); m?.classList.toggle("hidden"); }
function toggleChatMenu() { const m = document.getElementById("chat-menu"); m?.classList.toggle("hidden"); }
function closeAllMenus() {
    document.getElementById("main-menu")?.classList.add("hidden");
    document.getElementById("chat-menu")?.classList.add("hidden");
    document.getElementById("radar-dot-menu")?.classList.add("hidden");
}

document.addEventListener("click", e => {
    if (!e.target.closest(".three-dot-wrap")) closeAllMenus();
    if (!e.target.closest("#emoji-picker") && !e.target.closest(".composer-side-btn")) {
        document.getElementById("emoji-picker")?.classList.add("hidden");
        document.getElementById("attach-menu")?.classList.add("hidden");
    }
});

// ===== KEYBOARD FIX (ALL ANDROID) =====
function fixKeyboard() {
    const inputArea = document.getElementById("chat-input-area");
    const msgContainer = document.getElementById("messages-container");
    if (!inputArea || !msgContainer) return;

    // WhatsApp-style keyboard fix using visualViewport API
    // Works on ALL Android phones (Chrome 61+) and iOS Safari 13+
    function adjustLayout() {
        const vv = window.visualViewport;
        if (!vv) return;

        // Height of the visible area
        const vvh = Math.round(vv.height);
        // Offset from top (important on iOS when page scrolls)
        const vvOffsetTop = Math.round(vv.offsetTop);

        // Position input bar right above keyboard
        // bottom = total window height - visible height - offsetTop
        const bottomOffset = window.innerHeight - vvh - vvOffsetTop;

        inputArea.style.position = "fixed";
        inputArea.style.bottom = Math.max(0, bottomOffset) + "px";
        inputArea.style.left = "0";
        inputArea.style.right = "0";
        inputArea.style.transform = "none"; // never use transform

        // Adjust messages padding so last message isn't hidden behind input
        const inputH = inputArea.offsetHeight || 60;
        msgContainer.style.paddingBottom = (Math.max(0, bottomOffset) + inputH + 10) + "px";

        // Auto scroll to bottom so latest message is visible
        requestAnimationFrame(() => {
            msgContainer.scrollTop = msgContainer.scrollHeight;
        });
    }

    function resetLayout() {
        inputArea.style.bottom = "0";
        inputArea.style.transform = "none";
        const inputH = inputArea.offsetHeight || 60;
        msgContainer.style.paddingBottom = (inputH + 10) + "px";
        window.scrollTo(0, 0);
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", adjustLayout, { passive: true });
        window.visualViewport.addEventListener("scroll", adjustLayout, { passive: true });
    }

    // Focus/blur events as additional safety net
    const msgInput = document.getElementById("msg-input");
    if (msgInput) {
        msgInput.addEventListener("focus", () => {
            setTimeout(adjustLayout, 100);
            setTimeout(adjustLayout, 300);
            setTimeout(() => { msgContainer.scrollTop = msgContainer.scrollHeight; }, 400);
        }, { passive: true });

        msgInput.addEventListener("blur", () => {
            setTimeout(resetLayout, 150);
        }, { passive: true });
    }

    // Initial layout
    resetLayout();
}

document.addEventListener("DOMContentLoaded", () => {
    setupTypingListener();
    fixKeyboard();

    // Fix send/mic button on all Android phones - touchend is faster than click
    const actionBtn = document.getElementById("voice-record-btn");
    if (actionBtn) {
        actionBtn.addEventListener("touchend", e => {
            e.preventDefault();
            e.stopPropagation();
            handleComposerAction();
        }, { passive: false });
    }

    // Enter sends, Shift+Enter adds a new line — textarea auto-resizes as you type
    const msgInp = document.getElementById("msg-input");
    if (msgInp) {
        msgInp.addEventListener("keydown", e => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
        updateComposerButtons();
    }
});

// Prevent pull-to-refresh — but never block real scrolling. Anything inside a
// scrollable container (messages, chat list, theme grid, Leaflet map, modals,
// online list …) or any drag that isn't a pull down from the very top of the
// page is left alone, so touch scrolling keeps working.
let lastTouchStartY = 0;
document.addEventListener("touchstart", e => {
    lastTouchStartY = (e.touches && e.touches[0]) ? e.touches[0].clientY : 0;
}, { passive: true });
document.addEventListener("touchmove", e => {
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    if (touch.clientY <= lastTouchStartY) return;              // not a downward pull
    if (window.scrollY > 0 || document.documentElement.scrollTop > 0) return;
    if (e.target.closest("#messages-container, #chat-list-container, .profile-content, .modal-box, #nearby-ghosts-list, #wifi-reach-list, #wifi-reach-panel, .leaflet-container, #theme-grid, .modal-overlay")) return;
    if (isInsideScrollable(e.target)) return;
    e.preventDefault();
}, { passive: false });

// True when the target or any ancestor is a scroll container of its own.
function isInsideScrollable(target) {
    let el = (target && target.nodeType === 1) ? target : null;
    while (el && el !== document.body && el !== document.documentElement) {
        if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
            const style = getComputedStyle(el);
            if (/(auto|scroll|overlay)/.test(style.overflowY + style.overflowX)) return true;
        }
        el = el.parentElement;
    }
    return false;
}

// ===== HELPERS =====
function nowTime() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

let toastTimer;
function showToast(msg) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.innerText = msg;
    toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 3000);
}
// ===== CREDITS & PREMIUM SYSTEM =====
// Credits are per-Ghost-ID, stored locally (no server). Eligibility: user
// must already have a Ghost ID / profile created — an anonymous/no-profile
// state never earns credits.
function getCredits() {
    if (!userGhostID) return 0;
    return parseInt(safeStorage.get("gm_credits_" + userGhostID) || "0", 10);
}
function setCredits(n) {
    if (!userGhostID) return;
    safeStorage.set("gm_credits_" + userGhostID, String(Math.max(0, n)));
    renderCreditsUI();
}
function addCredits(n) {
    setCredits(getCredits() + n);
}
function isPremiumUnlocked() {
    if (!userGhostID) return false;
    return safeStorage.get("gm_premium_" + userGhostID) === "1";
}
function setPremiumUnlocked() {
    if (!userGhostID) return;
    safeStorage.set("gm_premium_" + userGhostID, "1");
}

function renderCreditsUI() {
    const amountEl = document.getElementById("credits-amount");
    const pillAmountEl = document.getElementById("credits-pill-amount");
    const modalAmountEl = document.getElementById("premium-modal-credits");
    const eligMsg = document.getElementById("credits-eligibility-msg");
    const eligMsgModal = document.getElementById("credits-eligibility-msg-modal");
    const earnBtns = document.querySelectorAll(".credits-earn-btn");
    const premiumBtn = document.querySelector(".premium-badge-btn");
    const pillBtn = document.getElementById("credits-pill-btn");

    const hasProfile = !!userGhostID;
    const amount = hasProfile ? getCredits() : "—";
    if (amountEl) amountEl.innerText = amount;
    if (pillAmountEl) pillAmountEl.innerText = amount;
    if (modalAmountEl) modalAmountEl.innerText = amount;
    if (pillBtn) pillBtn.classList.toggle("credits-pill-premium", isPremiumUnlocked());

    const msgText = "Create your Ghost ID first to start earning credits";
    [eligMsg, eligMsgModal].forEach(el => {
        if (!el) return;
        if (!hasProfile) { el.innerText = msgText; el.classList.remove("hidden"); }
        else el.classList.add("hidden");
    });
    earnBtns.forEach(b => b.disabled = !hasProfile);

    if (premiumBtn) {
        // innerHTML (not innerText) so the inline star icon survives — emoji
        // icons are gone from the whole premium/credits surface.
        const star = '<svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
        premiumBtn.innerHTML = star + (isPremiumUnlocked() ? " Premium Active" : " Premium");
    }

    // Highlight the currently active plan (if any) in the plans grid
    document.querySelectorAll(".premium-plan-btn").forEach(btn => btn.classList.remove("plan-active"));
    const activePlan = safeStorage.get("gm_premium_plan_" + userGhostID);
    if (activePlan) {
        const btn = document.querySelector(`.premium-plan-btn[data-plan="${activePlan}"]`);
        btn?.classList.add("plan-active");
    }
}

// ----- Earning -----
function watchAdForCredits() {
    if (!userGhostID) { showToast("Create your Ghost ID first to start earning credits"); return; }
    const overlay = document.getElementById("watch-ad-overlay");
    const textEl = document.getElementById("watch-ad-text");
    if (!overlay) return;
    overlay.classList.remove("hidden");
    textEl.innerText = "Loading Ad...";
    // TESTING MODE: no real ad SDK yet — simulate a short "loading" delay,
    // then award credits. Swap this timeout for a real AdMob rewarded-ad
    // call when closer to public launch.
    setTimeout(() => {
        textEl.innerText = "Ad playing...";
        setTimeout(() => {
            overlay.classList.add("hidden");
            addCredits(5);
            showToast("🎉 +5 Credits earned!");
        }, 1200);
    }, 1200);
}

function shareAppForCredits() {
    if (!userGhostID) { showToast("Create your Ghost ID first to start earning credits"); return; }
    const shareData = {
        title: "Ghost Mesh",
        text: "Chat with me on Ghost Mesh — a private, serverless P2P messenger.",
        url: location.href
    };
    if (navigator.share) {
        navigator.share(shareData)
            .then(() => { addCredits(5); showToast("🎉 +5 Credits earned!"); })
            .catch(() => { /* user cancelled share — no credits awarded */ });
    } else {
        // No native share sheet available (desktop browser) — fall back to
        // clipboard copy so the flow still does something useful.
        navigator.clipboard?.writeText(shareData.url).then(() => {
            showToast("Link copied! Share it to earn credits — tap Share again once sent");
        });
    }
}

// ----- Spending -----
// ===== SEND CREDIT TO A PEER (chat 3-dot menu) =====
let sendCreditAmount = 5;
function openSendCreditModal() {
    closeAllMenus();
    if (!currentChatPeer) { showToast("Open a chat first"); return; }
    if (isGroupChat(currentChatPeer)) { showToast("Can't send credits to a group"); return; }
    if (!userGhostID) { showToast("Create your Ghost ID first"); return; }
    document.getElementById("send-credit-peer-name").innerText = chatData[currentChatPeer]?.displayName || currentChatPeer;
    pickCreditAmount(5);
    showEl("send-credit-modal");
}
function closeSendCreditModal() { hideEl("send-credit-modal"); }

// ===== NOT ENOUGH CREDITS PROMPT =====
// #not-enough-credits-modal exists in index.html but had no code behind it,
// so its buttons did nothing and the closeNotEnoughCreditsModal() handler
// referenced in the HTML was an undefined function.
function showNotEnoughCredits(message) {
    const msgEl = document.getElementById("not-enough-credits-msg");
    if (msgEl && message) msgEl.innerText = message;
    showEl("not-enough-credits-modal");
}
function closeNotEnoughCreditsModal() { hideEl("not-enough-credits-modal"); }
function pickCreditAmount(amt) {
    sendCreditAmount = amt;
    document.querySelectorAll(".send-credit-amount-btn").forEach(b => b.classList.toggle("active", parseInt(b.dataset.amt) === amt));
    document.getElementById("send-credit-confirm-btn").innerHTML =
        '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2a7 7 0 0 0-7 7v11l2.2-1.6L9.4 20l2.6-1.9L14.6 20l2.2-1.6L19 20V9a7 7 0 0 0-7-7zM9.5 11.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>' +
        `<span>Send ${amt} Credit${amt>1?'s':''}</span>`;
}
function confirmSendCredit() {
    if (!currentChatPeer) return;
    const amt = sendCreditAmount;
    if (getCredits() < amt) {
        showToast(`Not enough credits — you have ${getCredits()}`);
        showNotEnoughCredits(`Sending ${amt} credits needs ${amt} — you have ${getCredits()}.`);
        return;
    }
    setCredits(getCredits() - amt);
    sendToChat(currentChatPeer, { type: "credit-gift", sender: userGhostID, senderName: userDisplayName, amount: amt });
    addSystemMsg(currentChatPeer, `You sent ${amt} credits to ${chatData[currentChatPeer]?.displayName || currentChatPeer}`);
    showToast(`👻 Sent ${amt} credits!`);
    closeSendCreditModal();
}

function openPremiumModal() { closeAllMenus(); renderCreditsUI(); showEl("premium-modal"); }
function closePremiumModal() { hideEl("premium-modal"); }

function unlockPremiumTrial() {
    if (!userGhostID) { showToast("Create your Ghost ID first"); return; }
    if (isPremiumUnlocked()) { showToast("Premium already unlocked!"); closePremiumModal(); return; }
    const COST = 20;
    if (getCredits() < COST) {
        showToast(`Need ${COST} credits — you have ${getCredits()}. Watch ads or share to earn more!`);
        showNotEnoughCredits(`Premium unlock costs ${COST} credits — you have ${getCredits()}.`);
        return;
    }
    setCredits(getCredits() - COST);
    setPremiumUnlocked();
    showToast("⭐ Premium unlocked! Enjoy unlimited pins, themes & more");
    closePremiumModal();
}

// Real Play Billing / Stripe-style payment only makes sense once this is a
// native APK (see NATIVE APK CONVERSION notes) — for now this simulates the
// purchase locally so premium features can be tested end-to-end.
const PREMIUM_PLANS = {
    monthly: { label: "1 Month", price: "$5", days: 30 },
    "6month": { label: "6 Months", price: "$30", days: 182 },
    yearly:  { label: "1 Year", price: "$50", days: 365 }
};
function buyPremiumPlan(planId) {
    if (!userGhostID) { showToast("Create your Ghost ID first"); return; }
    const plan = PREMIUM_PLANS[planId];
    if (!plan) return;
    const confirmMsg = `Simulate purchasing ${plan.label} (${plan.price})? Real payments are wired up once this becomes a native app with Play Billing.`;
    if (!confirm(confirmMsg)) return;

    const expiry = Date.now() + plan.days * 24 * 60 * 60 * 1000;
    safeStorage.set("gm_premium_" + userGhostID, "1");
    safeStorage.set("gm_premium_plan_" + userGhostID, planId);
    safeStorage.set("gm_premium_expiry_" + userGhostID, String(expiry));
    showToast(`⭐ ${plan.label} Premium activated (simulated) — enjoy the perks!`);
    renderCreditsUI();
}

// Testing shortcut — instantly adds 1 credit with no eligibility bypass,
// so QA can test the whole earn→spend loop quickly without watching fake
// ads or sharing repeatedly. Remove this button before public launch.
function quickAddCredit() {
    if (!userGhostID) { showToast("Create your Ghost ID first"); return; }
    addCredits(1);
    showToast("+1 Credit (test)");
}

// ===== GHOST RADAR (Wi-Fi-settings-style) UI =====
let ghostRadarOn = true;

function toggleGhostRadar(isOn) {
    ghostRadarOn = isOn;
    document.getElementById("radar-toggle-label").innerText = isOn ? "On" : "Off";
    document.getElementById("radar-toggle-label").classList.toggle("radar-on-color", isOn);
    document.getElementById("radar-qr-icon-btn").classList.toggle("hidden", !isOn);
    document.getElementById("radar-off-msg").classList.toggle("hidden", isOn);
    document.getElementById("radar-body").classList.toggle("hidden", !isOn);
    if (!isOn) stopOfflineCamera();
}

function toggleRadarMenu() {
    const menu = document.getElementById("radar-dot-menu");
    const wasHidden = menu.classList.contains("hidden");
    closeAllMenus();
    if (wasHidden) menu.classList.remove("hidden");
    // Ghost Direct is greyed out when Radar is off — matches native
    // Android's Wi-Fi-Direct behaviour (disabled until Wi-Fi itself is on).
    document.getElementById("menu-ghost-direct").classList.toggle("menu-item-disabled", !ghostRadarOn);
}
function onGhostDirectClick() {
    if (!ghostRadarOn) { showToast("Turn on Radar first"); return; }
    closeAllMenus();
    switchOfflineTab("create");
}
function toggleTorch() {
    if (!offlineCameraStream) return;
    const track = offlineCameraStream.getVideoTracks()[0];
    const caps = track.getCapabilities?.();
    if (!caps || !caps.torch) { showToast("Flashlight not supported on this camera"); return; }
    const settings = track.getSettings();
    track.applyConstraints({ advanced: [{ torch: !settings.torch }] }).catch(() => showToast("Could not toggle flashlight"));
}

// ===== SHARED LOCATION: open in Google Maps or app's own Radar Map =====
function openLocationInMaps(lat, lng) {
    window.open(`https://www.google.com/maps?q=${lat},${lng}`, "_blank");
}
function openLocationOnRadar(lat, lng) {
    toggleRadarMap();
    if (!radarMapInstance) { showToast("Radar map not ready yet"); return; }
    setTimeout(() => {
        radarMapInstance.invalidateSize();
        radarMapInstance.setView([lat, lng], 15);
        gmMapPin(lat, lng, "📍 Shared location", radarMapInstance, true);
    }, 250);
}

// ===== ANDROID HARDWARE BACK =====
// The Android shell is a single WebView, so MainActivity asks the page before
// leaving the app (see handleBackPressed() there). Returns true when the press
// was handled inside the app, false when Android should take over and exit.
const androidBackLayers = [
    ["ghost-assistant-modal", () => gmCloseIdentityModals()],
    ["phrase-backup-modal", () => gmCloseIdentityModals()],
    // The signup phrase modal is intentionally NOT dismissable: it must be
    // confirmed first (gmIdentityBackBlocked keeps back from closing it).
    ["media-viewer", () => closeMediaViewer()],
    ["qr-scan-overlay", () => cancelCameraScan()],
    ["incoming-call-overlay", () => rejectIncomingCall()],
    ["call-screen", () => endCurrentCall()],
    ["watch-ad-overlay", () => hideEl("watch-ad-overlay")],
    ["premium-modal", () => closePremiumModal()],
    ["send-credit-modal", () => closeSendCreditModal()],
    ["not-enough-credits-modal", () => closeNotEnoughCreditsModal()],
    ["reaction-modal", () => closeReactionModal()],
    ["request-modal", () => hideEl("request-modal")],
    ["connect-modal", () => closeNewConnect()],
    ["new-group-modal", () => closeNewGroupModal()],
    ["feedback-modal", () => closeFeedbackModal()],
    ["destruct-overlay", () => hideEl("destruct-overlay")],
    ["theme-screen", () => showScreen("chatlist-screen")],
    ["profile-screen", () => closeProfile()],
    ["chat-screen", () => goBackToList()]
];

// True while the mandatory signup phrase step is open — Android back must
// not be able to skip it.
function gmIdentityBackBlocked() {
    const setup = document.getElementById("phrase-setup-modal");
    if (!setup || setup.classList.contains("hidden")) return false;
    return (typeof GMIdentity !== "undefined") && GMIdentity.phraseFlowBlocked();
}

function handleAndroidBack() {
    if (gmIdentityBackBlocked()) {
        showToast("Write down your recovery phrase and confirm it to continue");
        return true;
    }
    // Open menus and pickers are the topmost thing on screen — close those first
    const openMenu = ["main-menu", "chat-menu", "radar-dot-menu", "emoji-picker", "attach-menu"]
        .some(id => {
            const el = document.getElementById(id);
            return el && !el.classList.contains("hidden");
        });
    if (openMenu) {
        closeAllMenus();
        hideEl("emoji-picker");
        hideEl("attach-menu");
        return true;
    }

    for (const [id, close] of androidBackLayers) {
        const el = document.getElementById(id);
        if (el && !el.classList.contains("hidden")) {
            try { close(); } catch (e) { console.error("Android back handler failed for " + id, e); }
            return true;
        }
    }
    return false; // nothing left to close — let Android leave the app
}
