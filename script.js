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

function resetGhostAppState(reason = "App reset — please sign in again.") {
    try {
        safeStorage.del("gm_pin");
        safeStorage.del("gm_phone");
        safeStorage.del("gm_name");
        safeStorage.del("gm_blocked");
        safeStorage.del("gm_theme");
    } catch (e) {
        console.warn("Could not clear stored app state", e);
    }
    pinBuffer = "";
    hideEl("lock-screen");
    hideEl("app-shell");
    showEl("login-screen");
    const input = document.getElementById("user-display-name");
    if (input) input.focus();
    if (typeof showToast === "function") showToast(reason);
}

// ===== GROUP CHAT =====
// groupId -> { id, name, members: [peerId,...] (does NOT include self), createdBy }
let groups = {};
function isGroupChat(id) { return !!(id && groups[id]); }

// THE CORE FIX: every per-chat action ...
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

// ... rest of file unchanged ...
