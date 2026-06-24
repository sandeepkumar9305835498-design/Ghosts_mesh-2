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
let radarMapInstance = null, sosMapInstance = null;
let sosActive = false, sosInterval = null;
let userLat = 20.5937, userLng = 78.9629;
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
let onlineUsers = {};
let shakeLastTime = 0, shakeThreshold = 15;
let safeZone = null;
let chatMuted = {};

const bannedWords = ["blackmail","paisa do","rupay do","video leak","threat","leak"];

// ===== SAFE STORAGE =====
const safeStorage = {
    _memory: {},
    _ok: (() => { try { localStorage.setItem('__t','1'); localStorage.removeItem('__t'); return true; } catch(e){ return false; } })(),
    get(k){ if(this._ok){ try{ return localStorage.getItem(k); }catch(e){} } return this._memory[k]||null; },
    set(k,v){ if(this._ok){ try{ localStorage.setItem(k,v); return; }catch(e){} } this._memory[k]=v; },
    del(k){ if(this._ok){ try{ localStorage.removeItem(k); return; }catch(e){} } delete this._memory[k]; }
};

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
    initShakeDetect();
    requestPermissions();
}

function requestPermissions() {
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(()=>{}, ()=>{});
}

// ===== PERMISSIONS =====
// Permissions are declared in manifest.json and requested on demand
// Camera/Mic: requested on call initiation
// Location: requested on map/SOS open
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

    updateHeaderDisplay();
    updateProfileScreen();
    loadBlockedPeers();
    initMesh();
    initRadarMap();
    setupTypingListener();
    loadTheme();
    requestNotificationPermission();
    startOnlinePresenceBroadcast();
}

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
}
function showEl(id) { const e = document.getElementById(id); if(e) e.classList.remove("hidden"); }
function hideEl(id) { const e = document.getElementById(id); if(e) e.classList.add("hidden"); }

function openProfile() { closeAllMenus(); updateProfileScreen(); showScreen("profile-screen"); }
function closeProfile() { showScreen("chatlist-screen"); }
function openSOS() { closeAllMenus(); showScreen("sos-screen"); initSOSMap(); fetchSOSInfo(); }
function closeSOS() { showScreen("chatlist-screen"); }
function openThemePicker() { closeAllMenus(); buildThemeGrid(); showScreen("theme-screen"); }
function openOnlineUsers() { closeAllMenus(); showScreen("online-screen"); renderOnlineUsers(); }

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

// ===== SHAKE TO SOS =====
function initShakeDetect() {
    if (!window.DeviceMotionEvent) return;
    window.addEventListener("devicemotion", e => {
        const a = e.accelerationIncludingGravity;
        if (!a) return;
        const total = Math.abs(a.x||0) + Math.abs(a.y||0) + Math.abs(a.z||0);
        const now = Date.now();
        if (total > shakeThreshold * 3 && now - shakeLastTime > 3000) {
            shakeLastTime = now;
            if (!sosActive) {
                showToast("Shake detected — SOS activating!");
                setTimeout(() => { openSOS(); toggleSOS(); }, 800);
            }
        }
    });
}

// ===== MESH NETWORK =====
function initMesh() {
    try {
        myPeerInstance = new Peer(userGhostID);
        myPeerInstance.on('open', id => {
            document.getElementById("my-ghost-id-label").innerText = id;
            showToast("Ghost Mesh Live: " + id);
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
            }
        });
    } catch(e) { console.error(e); }
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
    });

    conn.on('data', data => {
        if (!data || !data.type) return;
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

            case "chat":
                if (blockedPeers.has(data.sender)) break; // FIX 8: ignore blocked
                if (!chatData[data.sender]) initChatData(data.sender);
                const msg = {
                    id: data.msgId, sender: data.sender, text: data.text,
                    direction: "incoming", dp: data.senderDP, displayName: data.senderName,
                    contentType: data.contentType, mediaPayload: data.mediaPayload,
                    viewOnce: data.viewOnce, time: nowTime(),
                    replyTo: data.replyTo, replyText: data.replyText,
                    selfDestruct: data.selfDestruct
                };
                chatData[data.sender].messages.push(msg);
                chatData[data.sender].lastMsg = data.text || "Media";
                chatData[data.sender].lastTime = msg.time;
                if (currentChatPeer !== data.sender) {
                    chatData[data.sender].unread = (chatData[data.sender].unread || 0) + 1;
                } else {
                    renderMessage(msg);
                    if (data.selfDestruct > 0) scheduleDestruct(data.msgId, data.selfDestruct);
                }
                renderChatList();
                if (conn.open) conn.send({ type: "ack", msgId: data.msgId });
                if (navigator.vibrate && notificationsEnabled && !chatMuted[data.sender]) navigator.vibrate(50);
                sendPushNotif(data.senderName || data.sender, data.text || "sent a message");
                break;

            case "typing":
                if (currentChatPeer === data.sender) {
                    const ind = document.getElementById("typing-indicator");
                    if (data.isTyping) { ind.innerText = (data.displayName || data.sender) + " is typing..."; ind.classList.remove("hidden"); }
                    else ind.classList.add("hidden");
                }
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

            case "location":
                showToast((data.senderName || data.sender) + " shared location");
                if (currentChatPeer === data.sender) {
                    const lm = { id: "loc-"+Date.now(), sender: data.sender, text: "Live Location — " + data.lat.toFixed(4) + ", " + data.lng.toFixed(4), direction: "incoming", dp: data.senderDP, contentType: "text", time: nowTime() };
                    if (chatData[data.sender]) chatData[data.sender].messages.push(lm);
                    renderMessage(lm);
                }
                break;

            case "sos":
                showToast("SOS from " + (data.senderName || data.sender) + "!");
                if (navigator.vibrate) navigator.vibrate([300,100,300,100,300]);
                showNearbyAlert(data);
                break;

            case "presence":
                if (!isGhostMode) updateOnlineUsers(data.sender, data.displayName || data.sender, data.online);
                break;

            case "status-update":
                if (chatData[data.sender]) chatData[data.sender].status = data.status;
                break;
        }
    });

    conn.on('close', () => {
        activeConnections = activeConnections.filter(c => c.peer !== conn.peer);
        if (chatData[conn.peer]) addSystemMsg(conn.peer, conn.peer + " disconnected");
        updateOnlineUsers(conn.peer, conn.peer, false);
        renderChatList();
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
    const peers = Object.keys(onlineUsers);
    if (peers.length === 0) {
        list.innerHTML = '<div class="system-msg" style="margin-top:30px;">No users online nearby</div>';
        return;
    }
    list.innerHTML = "";
    peers.forEach(peerId => {
        const u = onlineUsers[peerId];
        const item = document.createElement("div");
        item.className = "online-user-item";
        const alreadyConnected = activeConnections.some(c => c.peer === peerId);
        item.innerHTML = `
            <div class="online-user-dot"></div>
            <div class="online-user-name">${u.displayName}<br><span style="font-size:11px;color:var(--text3);">${peerId}</span></div>
            ${alreadyConnected
                ? `<button class="online-user-connect" style="background:var(--success);" onclick="openChat('${peerId}')">Open Chat</button>`
                : `<button class="online-user-connect" onclick="connectToPeer('${peerId}');showToast('Connecting...')">Connect</button>`}
        `;
        list.appendChild(item);
    });
}

// ===== CONNECT =====
function openNewConnect() { closeAllMenus(); showEl("connect-modal"); }
function closeNewConnect() { hideEl("connect-modal"); document.getElementById("peer-id-input").value = ""; }

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
        const isOnline = activeConnections.some(c => c.peer === peerId);
        const item = document.createElement("div");
        item.className = "chat-item";
        item.id = "chatitem-" + peerId;
        item.onclick = () => openChat(peerId);

        const dpHtml = d.dp
            ? `<img src="${d.dp}" class="chat-item-dp msg-dp-${peerId}">`
            : `<div class="default-avatar" style="width:50px;height:50px;" id="chatdp-${peerId}"><svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg></div>`;

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

    const d = chatData[peerId];
    document.getElementById("chat-peer-name").innerText = d.displayName || peerId;
    const isOnline = activeConnections.some(c => c.peer === peerId);
    document.getElementById("chat-peer-status").innerText = isOnline ? "P2P Connected" : "Offline";

    const peerDot = document.getElementById("peer-online-dot");
    if (peerDot) peerDot.style.display = isOnline ? "" : "none";

    const peerAvatar = document.getElementById("chat-peer-avatar");
    if (peerAvatar) {
        if (d.dp) peerAvatar.innerHTML = `<img src="${d.dp}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
        else peerAvatar.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>`;
    }

    showScreen("chat-screen");
    if (currentTheme === "fish") startFishAnimation();
    renderAllMessages(peerId);
    document.getElementById("msg-input").focus();
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

// ===== MESSAGING =====
function sendMessage() {
    const inp = document.getElementById("msg-input");
    if (!inp) return;
    const txt = inp.value.trim();
    if (!txt) return;

    for (const w of bannedWords) {
        if (txt.toLowerCase().includes(w)) {
            showToast("Message blocked by safety filter");
            inp.value = "";
            return;
        }
    }

    if (!currentChatPeer) {
        showToast("Connect to a peer first!");
        return;
    }

    sendBundle("text", txt);
    inp.value = "";
    inp.focus();
}

function sendBundle(contentType, payload) {
    const msgId = "msg-" + Date.now();
    const time = nowTime();
    const text = contentType === "text" ? payload : "";
    // FIX 1: Capture reply data BEFORE any cancelReply() can clear them
    const capturedReplyToMsgId = replyToMsgId;
    const capturedReplyText = replyText;
    const msg = {
        id: msgId, sender: userGhostID, text, direction: "outgoing",
        dp: userCurrentDP, displayName: userDisplayName,
        contentType, mediaPayload: payload,
        viewOnce: isViewOnceEnabled,
        selfDestruct: selfDestructSeconds,
        time, replyTo: capturedReplyToMsgId, replyText: capturedReplyText
    };

    if (currentChatPeer) {
        if (!chatData[currentChatPeer]) initChatData(currentChatPeer);
        chatData[currentChatPeer].messages.push(msg);
        chatData[currentChatPeer].lastMsg = text || "Media";
        chatData[currentChatPeer].lastTime = time;
        renderMessage(msg);
        if (selfDestructSeconds > 0) scheduleDestruct(msgId, selfDestructSeconds);
    }

    // Reset reply state before broadcast
    cancelReply();

    broadcastToMesh({
        type: "chat", msgId, sender: userGhostID, text,
        senderDP: userCurrentDP, senderName: userDisplayName,
        contentType, mediaPayload: payload,
        viewOnce: isViewOnceEnabled, selfDestruct: selfDestructSeconds,
        replyTo: capturedReplyToMsgId, replyText: capturedReplyText
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

function renderMedia(node, type, payload) {
    if (!type || !payload) return;
    if (type === "media" && payload.fileData) {
        const wrap = document.createElement("div");
        wrap.style.marginTop = "6px";
        if (payload.fileType?.startsWith("image/")) {
            wrap.innerHTML = `<img src="${payload.fileData}" class="shared-img" onclick="window.open(this.src)">`;
        } else if (payload.fileType?.startsWith("video/")) {
            wrap.innerHTML = `<video src="${payload.fileData}" controls class="shared-video"></video>`;
        } else {
            wrap.innerHTML = `<a href="${payload.fileData}" download="${payload.fileName}" style="color:var(--accent);font-weight:bold;">${payload.fileName}</a>`;
        }
        node.appendChild(wrap);
    } else if (type === "audio" && payload) {
        const wrap = document.createElement("div");
        wrap.style.marginTop = "6px";
        wrap.innerHTML = `<audio src="${payload}" controls></audio>`;
        node.appendChild(wrap);
    }
}

function scheduleDestruct(msgId, seconds) {
    setTimeout(() => {
        renderDeleteLocal(msgId);
        broadcastToMesh({ type: "destruct", msgId });
    }, seconds * 1000);
}

function setSelfDestruct(s) {
    selfDestructSeconds = s;
    hideEl("destruct-overlay");
    showToast(s > 0 ? `Self-destruct: ${s < 60 ? s + " sec" : "1 min"}` : "Self-destruct off");
}

function broadcastToMesh(obj) {
    activeConnections.forEach(c => { if (c?.open) c.send(obj); });
}

// ===== TYPING =====
function setupTypingListener() {
    const inp = document.getElementById("msg-input");
    if (!inp) return;
    inp.addEventListener("input", () => {
        broadcastToMesh({ type: "typing", sender: userGhostID, displayName: userDisplayName, isTyping: true });
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => broadcastToMesh({ type: "typing", sender: userGhostID, isTyping: false }), 2000);
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
function openReactionModal(msgId) { selectedMsgIdForContext = msgId; showEl("reaction-modal"); }
function closeReactionModal() { hideEl("reaction-modal"); }

function sendReaction(emoji) {
    closeReactionModal();
    if (!selectedMsgIdForContext) return;
    renderReactionLocal(selectedMsgIdForContext, emoji);
    broadcastToMesh({ type: "reaction", msgId: selectedMsgIdForContext, emoji });
}

function renderReactionLocal(msgId, emoji) {
    const card = document.getElementById(msgId); if (!card) return;
    let badge = card.querySelector(".reaction-badge");
    if (!badge) { badge = document.createElement("span"); badge.className = "reaction-badge"; card.appendChild(badge); }
    badge.innerText = emoji;
}

function triggerDeleteForEveryone() {
    closeReactionModal();
    const card = document.getElementById(selectedMsgIdForContext);
    if (!card) return;
    if (card.getAttribute("data-sender") !== userGhostID) { showToast("Can only delete your own messages"); return; }
    renderDeleteLocal(selectedMsgIdForContext);
    broadcastToMesh({ type: "delete", msgId: selectedMsgIdForContext });
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
        broadcastToMesh({ type: "location", sender: userGhostID, senderName: userDisplayName, lat: pos.coords.latitude, lng: pos.coords.longitude, senderDP: userCurrentDP });
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
function triggerFileAttachment() { document.getElementById("attachment-file-input").click(); }
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
function initiateP2PCall(type) {
    if (activeConnections.length === 0) { showToast("Connect to a peer first!"); return; }
    const target = currentChatPeer || activeConnections[0].peer;
    navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' }).then(stream => {
        localMediaStream = stream;
        showEl("call-screen");
        const isVideo = type === 'video';
        document.getElementById("call-status-label").innerText = isVideo ? "Video Calling..." : "Voice Calling...";
        document.getElementById("call-peer-label").innerText = target;
        document.getElementById("video-grid").classList.toggle("hidden", !isVideo);
        if (isVideo) document.getElementById("local-video").srcObject = stream;
        activeP2PCallInstance = myPeerInstance.call(target, stream, { metadata: { type } });
        listenCallStream(activeP2PCallInstance, type);
        playRingtone('ring');
    }).catch(() => showToast("Camera/Mic access denied"));
}

function listenCallStream(callObj, type) {
    callObj.on('stream', remoteStream => {
        stopRingtone();
        playRingtone('connect');
        document.getElementById("call-status-label").innerText = "Connected";
        // FIX 5: Always attach remote stream; show video grid if video tracks present
        const remoteVideo = document.getElementById("remote-video");
        remoteVideo.srcObject = remoteStream;
        remoteVideo.play().catch(()=>{});
        const hasVideo = remoteStream.getVideoTracks().length > 0;
        document.getElementById("video-grid").classList.toggle("hidden", !hasVideo);
        startCallTimer();
    });
    callObj.on('close', endCallFlow);
    callObj.on('error', endCallFlow);
}

function handleIncomingCall(call) {
    pendingIncomingCallEvent = call;
    const type = call.metadata?.type || 'voice';
    showEl("call-screen");
    document.getElementById("call-status-label").innerText = type === 'video' ? "Incoming Video Call" : "Incoming Voice Call";
    document.getElementById("call-peer-label").innerText = call.peer;
    document.getElementById("accept-call-btn").classList.remove("hidden");
    startRingtone();
    if (navigator.vibrate) navigator.vibrate([500,200,500]);
}

function acceptIncomingCall() {
    stopRingtone();
    document.getElementById("accept-call-btn").classList.add("hidden");
    const type = pendingIncomingCallEvent?.metadata?.type || 'voice';
    navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' }).then(stream => {
        localMediaStream = stream;
        if (type === 'video') {
            document.getElementById("video-grid").classList.remove("hidden");
            document.getElementById("local-video").srcObject = stream;
        }
        pendingIncomingCallEvent.answer(stream);
        listenCallStream(pendingIncomingCallEvent, type);
    }).catch(() => showToast("Camera/Mic access denied"));
}

function endCurrentCall() { activeP2PCallInstance?.close(); pendingIncomingCallEvent?.close(); endCallFlow(); }

function endCallFlow() {
    stopRingtone();
    playRingtone('end');
    stopCallTimer();
    localMediaStream?.getTracks().forEach(t => t.stop());
    localMediaStream = null; activeP2PCallInstance = null; pendingIncomingCallEvent = null;
    document.getElementById("remote-video").srcObject = null;
    document.getElementById("local-video").srcObject = null;
    hideEl("call-screen");
    document.getElementById("accept-call-btn").classList.add("hidden");
    document.getElementById("video-grid").classList.add("hidden");
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

// ===== SOS =====
function initSOSMap() {
    if (sosMapInstance) { setTimeout(() => sosMapInstance.invalidateSize(), 200); return; }
    try {
        sosMapInstance = L.map('sos-map').setView([userLat, userLng], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(sosMapInstance);
        L.marker([userLat, userLng]).addTo(sosMapInstance).bindPopup("Your Location").openPopup();
        spawnNearbyNodes(userLat, userLng, sosMapInstance);
    } catch(e) { console.error(e); }
}

function fetchSOSInfo() {
    document.getElementById("sos-peers").innerText = activeConnections.length + " peers";
    navigator.getBattery?.().then(b => { document.getElementById("sos-battery").innerText = Math.round(b.level*100) + "%"; });
    navigator.geolocation?.getCurrentPosition(pos => {
        userLat = pos.coords.latitude; userLng = pos.coords.longitude;
        document.getElementById("sos-my-location").innerText = userLat.toFixed(4) + ", " + userLng.toFixed(4);
    }, () => { document.getElementById("sos-my-location").innerText = "Location blocked"; });
}

function toggleSOS() {
    const btn = document.getElementById("sos-main-btn");
    if (!sosActive) {
        sosActive = true;
        btn.innerHTML = "STOP SOS ALERT";
        btn.classList.add("active-sos");
        document.getElementById("sos-title").innerText = "SOS ACTIVE!";
        document.getElementById("sos-desc").innerText = "Broadcasting your location to all nearby Ghost Mesh peers...";
        broadcastSOSNow();
        sosInterval = setInterval(broadcastSOSNow, 15000);
        showToast("SOS Alert sent to all peers!");
        if (navigator.vibrate) navigator.vibrate([300,100,300,100,300]);
    } else {
        sosActive = false; clearInterval(sosInterval);
        btn.innerHTML = "SEND SOS ALERT";
        btn.classList.remove("active-sos");
        document.getElementById("sos-title").innerText = "Emergency Help";
        document.getElementById("sos-desc").innerText = "Press SOS to alert all nearby Ghost Mesh users with your live GPS location";
        showToast("SOS stopped");
    }
}

function broadcastSOSNow() {
    broadcastToMesh({ type: "sos", sender: userGhostID, senderName: userDisplayName, lat: userLat, lng: userLng, senderDP: userCurrentDP, time: nowTime() });
}

function showNearbyAlert(data) {
    const box = document.getElementById("nearby-alerts");
    const list = document.getElementById("nearby-alerts-list");
    box?.classList.remove("hidden");
    if (!list) return;
    const item = document.createElement("div");
    item.style.cssText = "padding:10px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:10px;margin-bottom:8px;font-size:13px;";
    item.innerHTML = `<b>${data.senderName || data.sender}</b><br>Lat: ${data.lat?.toFixed(4)}, Lng: ${data.lng?.toFixed(4)}<br>${data.time}<br><button onclick="connectToPeer('${data.sender}')" style="background:var(--danger);color:white;border:none;padding:5px 14px;border-radius:8px;margin-top:6px;cursor:pointer;font-weight:700;min-height:36px;">Respond</button>`;
    list.prepend(item);
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

    // Fix send button on all Android phones - touchend is faster than click
    const sendBtn = document.getElementById("send-btn");
    if (sendBtn) {
        sendBtn.addEventListener("touchend", e => {
            e.preventDefault();
            e.stopPropagation();
            sendMessage();
        }, { passive: false });
    }

    // Enter key on input
    const msgInp = document.getElementById("msg-input");
    if (msgInp) {
        msgInp.addEventListener("keydown", e => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }
});

// Prevent pull-to-refresh
document.addEventListener("touchmove", e => {
    if (e.target.closest("#messages-container, #chat-list-container, .sos-content, .profile-content, .modal-box, #online-users-list")) return;
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
