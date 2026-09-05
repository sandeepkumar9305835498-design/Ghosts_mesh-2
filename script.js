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

// ===== INIT =====
function initApp() {
    const pin = safeStorage.get("gm_pin");
    if (pin) { showEl("lock-screen"); }
    else {
        const phone = safeStorage.get("gm_phone");
        if (phone) executeLogin(phone, safeStorage.get("gm_name")||"");
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
    if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
    }
}

// ===== PIN LOCK =====
function pinPress(d) {
    if (pinBuffer.length >= 4) return;
    pinBuffer += d;
    updatePinDots();
    if (pinBuffer.length === 4) setTimeout(checkPin, 150);
}
function pinBackspace() { pinBuffer = pinBuffer.slice(0,-1); updatePinDots(); }
function updatePinDots() {
    document.querySelectorAll("#pin-dots span").forEach((s,i) => s.classList.toggle("filled", i < pinBuffer.length));
}
function checkPin() {
    if (pinBuffer === safeStorage.get("gm_pin")) {
        document.getElementById("app-pin-input") && (document.getElementById("app-pin-input").value = "");
        pinBuffer = "";
        updatePinDots();
        hideEl("lock-screen");
        const phone = safeStorage.get("gm_phone");
        if (phone) executeLogin(phone, safeStorage.get("gm_name")||"");
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
    const phone = document.getElementById("phone-number").value.trim();
    const pin = document.getElementById("set-pin-input").value.trim();
    if (!phone || phone.length < 6) { showToast("Enter a valid phone number"); return; }
    if (pin.length === 4) safeStorage.set("gm_pin", pin);
    safeStorage.set("gm_phone", phone);
    safeStorage.set("gm_name", name || "Ghost User");
    executeLogin(phone, name || "Ghost User");
}

function executeLogin(phone, name) {
    userPhoneNumber = phone;
    userGhostID = "Ghost-" + phone.slice(-4);
    userDisplayName = name || safeStorage.get("gm_name") || "Ghost User";

    const savedDP = safeStorage.get("gm_dp");
    userCurrentDP = savedDP || null;

    hideEl("login-screen"); hideEl("lock-screen");
    showEl("app-shell");
    showScreen("chatlist-screen");
    initMainTabsScroller();

    updateHeaderDisplay();
    updateProfileScreen();
    loadBlockedPeers();
    initMesh();
    initRadarMap();
    setupTypingListener();
    loadTheme();
    requestNotificationPermission();
    startOnlinePresenceBroadcast();

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
    document.getElementById("my-ghost-id-label").innerText = userGhostID;
    document.getElementById("my-name-display").innerText = userDisplayName;
    setAvatarDisplay("my-avatar-display", userCurrentDP);
}

function updateProfileScreen() {
    const nameInput = document.getElementById("profile-name-input");
    if (nameInput) nameInput.value = userDisplayName;
    const gid = document.getElementById("profile-ghost-id");
    if (gid) gid.innerText = userGhostID;
    const ph = document.getElementById("profile-phone");
    if (ph) ph.innerText = userPhoneNumber;
    setAvatarDisplay("profile-avatar-big", userCurrentDP);
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
    if (!confirm("Logout from Ghost Mesh?")) return;
    safeStorage.del("gm_phone"); safeStorage.del("gm_pin"); safeStorage.del("gm_name");
    location.reload();
}

// ===== SCREENS =====
function showScreen(id) {
    document.querySelectorAll(".app-screen").forEach(s => s.classList.add("hidden"));
    const t = document.getElementById(id);
    if (t) t.classList.remove("hidden");
    if (id === "chatlist-screen") scrollToMainTab(0);
}
function showEl(id) { const e = document.getElementById(id); if(e) e.classList.remove("hidden"); }
function hideEl(id) { const e = document.getElementById(id); if(e) e.classList.add("hidden"); }

// ===== WHATSAPP-STYLE MAIN TABS (Chats / WiFi / Online) =====
function scrollToMainTab(index) {
    const scroller = document.getElementById("main-tabs-scroller");
    if (!scroller) return;
    scroller.scrollTo({ left: index * scroller.clientWidth, behavior: "smooth" });
    setActiveMainTab(index);
}
function setActiveMainTab(index) {
    for (let i = 0; i < 3; i++) {
        document.getElementById("main-tab-btn-" + i)?.classList.toggle("active", i === index);
    }
    const indicator = document.getElementById("main-tab-indicator");
    if (indicator) indicator.style.transform = `translateX(${index * 100}%)`;
    if (index === 2) { refreshOnlineUsers(); } // Online tab needs a fresh peer list
}
function initMainTabsScroller() {
    const scroller = document.getElementById("main-tabs-scroller");
    if (!scroller) return;
    let scrollTimeout;
    scroller.addEventListener("scroll", () => {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            const index = Math.round(scroller.scrollLeft / scroller.clientWidth);
            setActiveMainTab(index);
        }, 80);
    });
}

function openProfile() { closeAllMenus(); updateProfileScreen(); showScreen("profile-screen"); }
function closeProfile() { showScreen("chatlist-screen"); }
function openThemePicker() { closeAllMenus(); buildThemeGrid(); showScreen("theme-screen"); }
function openOnlineUsers() {
    closeAllMenus();
    showScreen("chatlist-screen");
    scrollToMainTab(2);
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

// ===== MESH NETWORK =====
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
        });
        myPeerInstance.on('connection', conn => {
            // FIX 8: Reject blocked peers immediately
            if (blockedPeers.has(conn.peer)) { conn.close(); return; }
            handleIncomingRequest(conn); setupConn(conn);
        });
        myPeerInstance.on('call', call => handleIncomingCall(call));
        myPeerInstance.on('error', err => {
            if (err.type === 'unavailable-id') {
                userGhostID = "Ghost-" + Math.floor(1000 + Math.random() * 9000);
                document.getElementById("my-ghost-id-label").innerText = userGhostID;
                initMesh();
            } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || !navigator.onLine) {
                // Online (PeerJS cloud) signaling couldn't be reached — normal
                // when offline. Offline WiFi/QR mode is unaffected by this.
                document.getElementById("my-ghost-id-label").innerText = "Offline (use WiFi tab)";
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

            case "location": {
                const chatId = data.groupId || data.sender;
                showToast((data.senderName || data.sender) + " shared location");
                if (currentChatPeer === chatId) {
                    const lm = { id: "loc-"+Date.now(), sender: data.sender, text: "Live Location — " + data.lat.toFixed(4) + ", " + data.lng.toFixed(4), direction: "incoming", dp: data.senderDP, contentType: "text", time: nowTime() };
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
            case "voip-offer":
                pendingIncomingCallEvent = { offline: true, peerId: conn.peer, sdp: data.sdp, callType: data.callType };
                showIncomingCallUI(conn.peer, data.callType);
                break;

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

function renderOnlineUsers() {
    const list = document.getElementById("online-users-list");
    if (!list) return;
    const peers = Object.keys(onlineUsers).filter(id => id !== userGhostID);
    if (peers.length === 0) {
        list.innerHTML = '<div class="system-msg" style="margin-top:30px;">No users online nearby.<br>Use "New Chat" or "Connect via WiFi" to find someone.</div>';
        return;
    }
    list.innerHTML = "";
    peers.forEach(peerId => {
        const u = onlineUsers[peerId];
        const item = document.createElement("div");
        item.className = "online-user-item";
        const alreadyConnected = activeConnections.some(c => c.peer === peerId && c.open);
        item.innerHTML = `
            <div class="online-user-dot" style="${alreadyConnected ? '' : 'background:var(--text3);'}"></div>
            <div class="online-user-name">${u.displayName}<br><span style="font-size:11px;color:var(--text3);">${peerId}${alreadyConnected ? '' : ' · offline'}</span></div>
            ${alreadyConnected
                ? `<button class="online-user-connect" style="background:var(--success);" onclick="openChat('${peerId}')">Open Chat</button>`
                : `<button class="online-user-connect" onclick="connectToPeer('${peerId}');showToast('Connecting...')">Reconnect</button>`}
        `;
        list.appendChild(item);
    });
}

// ===== CONNECT =====
function openNewConnect() { closeAllMenus(); showEl("connect-modal"); }

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
    document.getElementById("offline-create-step1").classList.remove("hidden");
    document.getElementById("offline-create-step2").classList.add("hidden");
    document.getElementById("offline-create-step3").classList.add("hidden");
    document.getElementById("offline-create-step4").classList.add("hidden");
    document.getElementById("offline-join-step1").classList.remove("hidden");
    document.getElementById("offline-join-step2").classList.add("hidden");
    document.getElementById("offline-video-join").classList.add("hidden");
    document.getElementById("offline-qr-host").innerHTML = "";
    document.getElementById("offline-qr-join").innerHTML = "";
    const msgEl = document.getElementById("offline-status-msg");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        msgEl.innerText = "⚠️ You're opening this file directly, so the camera (QR scan) is blocked by the browser. Serve it over https:// or http://localhost for scanning to work.";
    } else {
        msgEl.innerText = "";
    }
}

function switchOfflineTab(tab) {
    document.getElementById("offline-tab-create").classList.toggle("active", tab === "create");
    document.getElementById("offline-tab-join").classList.toggle("active", tab === "join");
    document.getElementById("offline-create-panel").classList.toggle("hidden", tab !== "create");
    document.getElementById("offline-join-panel").classList.toggle("hidden", tab !== "join");
}

function offlineIceConfig() {
    // No STUN/TURN — we only want local network (host) candidates since
    // this feature is specifically for "no internet" same-WiFi use.
    return { iceServers: [] };
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
    new QRCode(container, {
        text: JSON.stringify(payloadObj),
        width: 220,
        height: 220,
        correctLevel: QRCode.CorrectLevel.L
    });
}

// ----- HOST (creator) side -----
async function startOfflineHost() {
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

        const payload = { gid: userGhostID, name: userDisplayName, sdp: offlinePC.localDescription };
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
    startCameraScan("offline-video-host", "offline-canvas-host", async decoded => {
        try {
            const answer = JSON.parse(decoded);
            if (!answer.sdp || !answer.gid) { showToast("Invalid QR — try again"); return false; }
            stopOfflineCamera();
            document.getElementById("offline-create-step3").classList.add("hidden");
            document.getElementById("offline-create-step4").classList.remove("hidden");

            if (offlineDC) offlineDC.__peerId = answer.gid;
            await offlinePC.setRemoteDescription(new RTCSessionDescription(answer.sdp));
            offlinePendingPeerInfo = { gid: answer.gid, name: answer.name };
            return true;
        } catch(e) {
            console.error(e);
            showToast("Could not read QR — try again");
            return false;
        }
    });
}

let offlinePendingPeerInfo = null;

function setupOfflineDataChannel(dc, knownPeerId, pcRef) {
    const wrapped = wrapOfflineChannel(dc, knownPeerId || "offline-pending");
    dc.addEventListener("open", () => {
        // Patch in the real peer id once we know it (host side learns it
        // from the scanned answer; join side knows it from the start).
        if (offlinePendingPeerInfo) {
            wrapped.peer = offlinePendingPeerInfo.gid;
        }
        // Remember this peer's RTCPeerConnection so voice/video calls can
        // renegotiate it later — this is what makes offline calls possible.
        if (pcRef) offlinePeerConnections[wrapped.peer] = pcRef;
        showToast("Offline connection established!");
        closeOfflineConnect();
        setupConn(wrapped);
    });
}

// ----- JOIN (scanner) side -----
function startOfflineJoinScan() {
    document.getElementById("offline-join-step1").querySelector(".primary-btn")?.classList.add("hidden");
    const video = document.getElementById("offline-video-join");
    video.classList.remove("hidden");
    startCameraScan("offline-video-join", "offline-canvas-join", async decoded => {
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

            const payload = { gid: userGhostID, name: userDisplayName, sdp: offlinePC.localDescription };
            document.getElementById("offline-join-step1").classList.add("hidden");
            document.getElementById("offline-join-step2").classList.remove("hidden");
            renderOfflineQR("offline-qr-join", payload);
            return true;
        } catch(e) {
            console.error(e);
            showToast("Could not read QR — try again");
            return false;
        }
    });
}

// ----- Shared camera scanning helper -----
function startCameraScan(videoElId, canvasElId, onDecoded) {
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
    const video = document.getElementById(videoElId);
    const canvas = document.getElementById(canvasElId);
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

        function tick() {
            if (!offlineCameraStream) return;
            if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const code = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "dontInvert" });
                if (code && code.data) {
                    Promise.resolve(onDecoded(code.data)).then(ok => {
                        if (!ok) offlineScanLoopId = requestAnimationFrame(tick);
                    });
                    return;
                }
            }
            offlineScanLoopId = requestAnimationFrame(tick);
        }
        tick();
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } })
        .then(beginScanLoop)
        .catch(err => {
            console.error("Rear camera request failed:", err);
            if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
                showToast("Camera permission denied — allow camera access in your browser/app settings");
                return;
            }
            if (err.name === "NotReadableError" || err.name === "TrackStartError") {
                showToast("Camera is busy — close any other app using the camera and try again");
                return;
            }
            // Rear-camera constraint not satisfiable — fall back to any available camera.
            navigator.mediaDevices.getUserMedia({ video: true })
                .then(beginScanLoop)
                .catch(err2 => {
                    console.error("Fallback camera request failed:", err2);
                    if (err2.name === "NotFoundError" || err2.name === "DevicesNotFoundError") {
                        showToast("No camera found on this device");
                    } else {
                        showToast("Could not access camera: " + (err2.name || "unknown error"));
                    }
                });
        });
}

function stopOfflineCamera() {
    if (offlineScanLoopId) { cancelAnimationFrame(offlineScanLoopId); offlineScanLoopId = null; }
    if (offlineCameraStream) {
        offlineCameraStream.getTracks().forEach(t => t.stop());
        offlineCameraStream = null;
    }
    ["offline-video-host", "offline-video-join"].forEach(id => {
        const v = document.getElementById(id);
        if (v) { v.srcObject = null; v.classList.add("hidden"); }
    });
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
function setupTypingListener() {
    const inp = document.getElementById("msg-input");
    if (!inp) return;
    inp.addEventListener("input", () => {
        updateComposerButtons();
        sendToChat(currentChatPeer, { type: "typing", sender: userGhostID, displayName: userDisplayName, isTyping: true, groupId: isGroupChat(currentChatPeer) ? currentChatPeer : undefined });
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
        sendToChat(currentChatPeer, { type: "location", sender: userGhostID, senderName: userDisplayName, lat: pos.coords.latitude, lng: pos.coords.longitude, senderDP: userCurrentDP, groupId: isGroupChat(currentChatPeer) ? currentChatPeer : undefined });
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
        navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
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
        }).catch(() => showToast("Mic permission denied"));
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
    document.getElementById("call-video-toggle-btn").classList.remove("video-off");
    document.getElementById("local-video").classList.toggle("hidden", !isVideo);
    document.getElementById("remote-video").classList.add("hidden");
    document.getElementById("call-dp-fallback").classList.remove("hidden");
    setAvatarDisplay("call-peer-avatar-big", chatData[peerId]?.dp || null);
    if (isVideo && localMediaStream) document.getElementById("local-video").srcObject = localMediaStream;
}

function showIncomingCallUI(peerId, type) {
    showEl("call-screen");
    document.getElementById("call-peer-label").innerText = chatData[peerId]?.displayName || peerId;
    document.getElementById("call-status-label").innerText = type === 'video' ? "Incoming Video Call" : "Incoming Voice Call";
    document.getElementById("call-timer").classList.add("hidden");
    document.getElementById("remote-video").classList.add("hidden");
    document.getElementById("call-dp-fallback").classList.remove("hidden");
    document.getElementById("local-video").classList.add("hidden");
    document.getElementById("call-video-toggle-btn").classList.add("hidden");
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

    navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' }).then(stream => {
        localMediaStream = stream;
        openCallUI(target, type, type === 'video' ? "Video Calling..." : "Voice Calling...");
        if (type === 'video') document.getElementById("local-video").srcObject = stream;
        activeP2PCallInstance = myPeerInstance.call(target, stream, { metadata: { type } });
        listenCallStream(activeP2PCallInstance, type);
        playRingtone('ring');
    }).catch(() => showToast("Camera/Mic access denied"));
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

function handleIncomingCall(call) {
    pendingIncomingCallEvent = call;
    showIncomingCallUI(call.peer, call.metadata?.type || 'voice');
}

// ----- Offline (QR/WiFi) calling: renegotiates the SAME RTCPeerConnection
// that already carries the offline chat data channel. No server involved —
// offer/answer/ICE candidates travel as normal chat-style messages over
// that data channel. -----
async function startOfflineCall(peerId, type) {
    const pc = offlinePeerConnections[peerId];
    if (!pc) { showToast("Peer connection not found"); return; }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' });
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
        showToast("Camera/Mic access denied");
    }
}

function attachRemoteStream(stream) {
    const remoteVideo = document.getElementById("remote-video");
    remoteVideo.srcObject = stream;
    remoteVideo.play().catch(()=>{});
}

async function acceptIncomingCall() {
    stopRingtone();
    hideEl("incoming-call-overlay");
    const isOffline = !!pendingIncomingCallEvent?.offline;
    const type = isOffline ? pendingIncomingCallEvent.callType : (pendingIncomingCallEvent?.metadata?.type || 'voice');

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' });
        localMediaStream = stream;
        document.getElementById("call-video-toggle-btn").classList.toggle("hidden", type !== 'video');
        document.getElementById("local-video").classList.toggle("hidden", type !== 'video');
        if (type === 'video') document.getElementById("local-video").srcObject = stream;

        if (isOffline) {
            const peerId = pendingIncomingCallEvent.peerId;
            const pc = offlinePeerConnections[peerId];
            if (!pc) { showToast("Peer connection not found"); return; }
            stream.getTracks().forEach(t => pc.addTrack(t, stream));
            pc.ontrack = event => {
            attachRemoteStream(event.streams[0]);
            toggleCallVideoUI(event.streams[0].getVideoTracks().length > 0);
        };
            pc.onicecandidate = e => { if (e.candidate) sendToPeer(peerId, { type: "voip-ice", candidate: e.candidate }); };

            await pc.setRemoteDescription(new RTCSessionDescription(pendingIncomingCallEvent.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendToPeer(peerId, { type: "voip-answer", sdp: pc.localDescription });

            activeOfflineCallPeer = peerId; activeOfflineCallType = type;
            updateCallStatusLabel("Connected");
            playRingtone('connect');
            startCallTimer();
        } else {
            pendingIncomingCallEvent.answer(stream);
            listenCallStream(pendingIncomingCallEvent, type);
        }
    } catch(e) {
        console.error(e);
        showToast("Camera/Mic access denied");
    }
}

function rejectIncomingCall() {
    stopRingtone();
    if (pendingIncomingCallEvent?.offline) {
        sendToPeer(pendingIncomingCallEvent.peerId, { type: "voip-end" });
    } else {
        pendingIncomingCallEvent?.close();
    }
    pendingIncomingCallEvent = null;
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
    activeOfflineCallPeer = null; activeOfflineCallType = null;

    document.getElementById("remote-video").srcObject = null;
    document.getElementById("remote-video").classList.add("hidden");
    document.getElementById("local-video").srcObject = null;
    document.getElementById("local-video").classList.add("hidden");
    document.getElementById("call-dp-fallback").classList.remove("hidden");
    document.getElementById("call-video-toggle-btn").classList.remove("hidden", "video-off");

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
function initRadarMap() {
    try {
        radarMapInstance = L.map('live-radar-map').setView([20.5937, 78.9629], 5);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(radarMapInstance);
        navigator.geolocation?.getCurrentPosition(pos => {
            userLat = pos.coords.latitude; userLng = pos.coords.longitude;
            hasRealLocation = true;
            radarMapInstance.setView([userLat, userLng], 13);
            L.marker([userLat, userLng]).addTo(radarMapInstance).bindPopup(`<b>You (${userGhostID})</b>`).openPopup();
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
        L.marker([lat + (Math.random()-0.5)*0.01, lng + (Math.random()-0.5)*0.01])
            .addTo(mapInst)
            .bindPopup(`<b>${name}</b><br>P2P Connected<br><button class="map-connect-btn" onclick="openChat('${conn.peer}')">Open Chat</button>`);
    });
    if (activeConnections.length === 0) {
        L.popup().setLatLng([lat, lng]).setContent("No peers nearby yet").openOn(mapInst);
    }
}

// ===== PUSH NOTIFICATION =====
function sendPushNotif(sender, text) {
    if (!notificationsEnabled) return;
    if (document.hasFocus()) return;
    if (Notification.permission === "granted") {
        new Notification("Ghost Mesh — " + sender, { body: text, icon: "icon-192.png" });
    }
}

// ===== MENUS =====
function toggleMainMenu() { const m = document.getElementById("main-menu"); m?.classList.toggle("hidden"); }
function toggleChatMenu() { const m = document.getElementById("chat-menu"); m?.classList.toggle("hidden"); }
function closeAllMenus() {
    document.getElementById("main-menu")?.classList.add("hidden");
    document.getElementById("chat-menu")?.classList.add("hidden");
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

// Prevent pull-to-refresh
document.addEventListener("touchmove", e => {
    if (e.target.closest("#messages-container, #chat-list-container, .profile-content, .modal-box, #online-users-list")) return;
    e.preventDefault();
}, { passive: false });

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