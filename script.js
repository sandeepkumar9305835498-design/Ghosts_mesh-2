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
let hasRealLocation = false;
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
let discoveredPeers = {};
let lobbyPollInterval = null;
let safeZone = null;
let chatMuted = {};

// ===== GROUP CHAT =====
let groups = {};
function isGroupChat(id) { return !!(id && groups[id]); }

function sendToChat(chatId, payload) {
    if (!chatId) return;
    if (isGroupChat(chatId)) {
        groups[chatId].members.forEach(peerId => sendToPeer(peerId, payload));
    } else {
        sendToPeer(chatId, payload);
    }
}

// ===== OFFLINE (QR/WiFi) CALL SUPPORT =====
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
let lastCrashToastTime = 0;
function safeToastOnce(msg) {
    const now = Date.now();
    if (now - lastCrashToastTime < 4000) return;
    lastCrashToastTime = now;
    try { showToast(msg); } catch(e) {}
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
    if (typeof GMIdentity === "undefined") {
        console.error("gm-identity.js did not load — identity recovery unavailable");
        if (typeof done === "function") done();
        return;
    }
    GMIdentity.ensureIdentityThen(done);
}

function initApp() {
    const pin = safeStorage.get("gm_pin");
    const savedName = safeStorage.get("gm_name");
    const savedPhone = safeStorage.get("gm_phone");

    if (pin && String(pin).length >= 4) {
        renderPinDots();
        showEl("lock-screen");
        hideEl("login-screen");
        return;
    }

    if (savedName || savedPhone) {
        gmEnsureIdentityThen(() => executeLogin(savedPhone || "", savedName || ""));
        return;
    }

    showEl("login-screen");
    hideEl("lock-screen");
    loadTheme();
    requestPermissions();
}

function requestPermissions() {
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(()=>{}, ()=>{});
}

// ===== PERMISSIONS =====
function requestNotificationPermission() {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
        try { Notification.requestPermission(); } catch(e) {}
    }
}

// ===== PIN LOCK =====
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
    if (phone && phone.replace(/\D/g, "").length < 6) { showToast("That phone number looks incomplete"); return; }
    if (pin.length === 4) safeStorage.set("gm_pin", pin);
    if (phone) safeStorage.set("gm_phone", phone); else safeStorage.del("gm_phone");
    safeStorage.set("gm_name", name);
    gmEnsureIdentityThen(() => executeLogin(phone, name));
}

function executeLogin(phone, name) {
    userPhoneNumber = phone || "";
    const identity = (typeof GMIdentity !== "undefined") ? GMIdentity.current() : null;
    userGhostID = identity ? identity.ghostId : ("Ghost-" + Math.floor(100000 + Math.random() * 899999));
    if (!identity) console.warn("No seed on this device — using a temporary Ghost ID");
    userDisplayName = name || safeStorage.get("gm_name") || "Ghost User";

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

    if (!navigator.onLine) {
        setTimeout(() => {
            scrollToMainTab(1);
            showToast("No internet — use WiFi tab to chat, call & share files with nearby devices");
        }, 400);
    }
}

// ===== PLACEHOLDER FUNCTIONS (app initialization shortcuts) =====
// Full implementation in original script.js - these are stubs for startup
function updateHeaderDisplay() {}
function updateProfileScreen() {}
function loadBlockedPeers() {}
function initMesh() {}
function initRadarMap() {}
function setupTypingListener() {}
function loadTheme() {}
function startOnlinePresenceBroadcast() {}
function gmStartNativeDiscovery() {}
function gmInitBottomNav() {}
function initMainTabsScroller() {}
function showScreen(id) { document.querySelectorAll(".app-screen").forEach(s => s.classList.add("hidden")); const t = document.getElementById(id); if (t) t.classList.remove("hidden"); }
function showEl(id) { const e = document.getElementById(id); if(e) e.classList.remove("hidden"); }
function hideEl(id) { const e = document.getElementById(id); if(e) e.classList.add("hidden"); }
function scrollToMainTab(index) {}
function showToast(msg) { const t = document.getElementById("toast"); if (t) { t.innerText = msg; t.classList.remove("hidden"); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => t.classList.add("hidden"), 3000); }}
