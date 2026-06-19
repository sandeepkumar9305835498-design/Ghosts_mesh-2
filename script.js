// ===== GHOST MESH V2 - COMPLETE SCRIPT =====

// State
let userPhoneNumber = "", userGhostID = "", userCurrentDP = "";
let myPeerInstance = null;
let activeConnections = [];
let chatData = {}; // { peerId: { messages:[], unread:0, lastMsg:'', lastTime:'', dp:'' } }
let currentChatPeer = null;
let typingTimeout = null;
let pendingIncomingConnection = null;
let isViewOnceEnabled = false;
let mediaRecorderInstance = null, recordedAudioChunks = [], isRecordingAudio = false;
let selectedMsgIdForContext = null;
let localMediaStream = null, activeP2PCallInstance = null, pendingIncomingCallEvent = null;
let radarMapInstance = null, sosMapInstance = null;
let sosActive = false, sosInterval = null;
let userLat = 20.5937, userLng = 78.9629;
let pinBuffer = "";
let liveLocationInterval = null;

const bannedWords = ["blackmail", "paisa do", "rupay do", "video leak", "threat", "leak"];

// ===== APP LOCK =====
function checkAppLock() {
    const pin = localStorage.getItem("gm_pin");
    if (pin) { showEl("lock-screen"); } 
    else {
        const phone = localStorage.getItem("gm_phone");
        if (phone) executeLogin(phone);
        else showEl("login-screen");
    }
}

function pinPress(digit) {
    if (pinBuffer.length >= 4) return;
    pinBuffer += digit;
    updatePinDots();
    if (pinBuffer.length === 4) setTimeout(checkPin, 150);
}

function pinBackspace() {
    pinBuffer = pinBuffer.slice(0, -1);
    updatePinDots();
}

function updatePinDots() {
    const dots = document.querySelectorAll("#pin-dots span");
    dots.forEach((d, i) => d.classList.toggle("filled", i < pinBuffer.length));
}

function checkPin() {
    const saved = localStorage.getItem("gm_pin");
    if (pinBuffer === saved) {
        hideEl("lock-screen");
        const phone = localStorage.getItem("gm_phone");
        if (phone) executeLogin(phone); else showEl("login-screen");
    } else {
        pinBuffer = "";
        updatePinDots();
        showToast("❌ Wrong PIN");
    }
}

// ===== LOGIN =====
function verifyAndLogin() {
    const phone = document.getElementById("phone-number").value.trim();
    const pin = document.getElementById("set-pin-input").value.trim();
    if (!phone || phone.length < 6) { showToast("Enter a valid phone number"); return; }
    if (pin.length === 4) localStorage.setItem("gm_pin", pin);
    localStorage.setItem("gm_phone", phone);
    executeLogin(phone);
}

function executeLogin(phone) {
    userPhoneNumber = phone;
    userGhostID = "Ghost-" + phone.slice(-4);
    userCurrentDP = "https://api.dicebear.com/7.x/bottts/svg?seed=" + userGhostID;

    hideEl("login-screen"); hideEl("lock-screen");
    showEl("app-shell");
    showScreen("chatlist-screen");

    document.getElementById("my-ghost-id-label").innerText = userGhostID;
    document.getElementById("my-dp-chatlist").src = userCurrentDP;
    document.getElementById("profile-dp-big").src = userCurrentDP;
    document.getElementById("profile-ghost-id").innerText = userGhostID;
    document.getElementById("profile-phone").innerText = phone;

    initMesh();
    initRadarMap();
    fetchSOSInfo();
}

function logoutApp() {
    if (!confirm("Logout from Ghost Mesh?")) return;
    localStorage.removeItem("gm_phone");
    localStorage.removeItem("gm_pin");
    location.reload();
}

// ===== SCREEN NAV =====
function showScreen(id) {
    document.querySelectorAll(".app-screen").forEach(s => s.classList.add("hidden"));
    document.getElementById(id).classList.remove("hidden");
}

function showEl(id) { document.getElementById(id).classList.remove("hidden"); }
function hideEl(id) { document.getElementById(id).classList.add("hidden"); }

function openProfile() {
    closeAllMenus();
    showScreen("profile-screen");
}
function closeProfile() { showScreen("chatlist-screen"); }

function openSOS() {
    closeAllMenus();
    showScreen("sos-screen");
    initSOSMap();
    fetchSOSInfo();
}
function closeSOS() { showScreen("chatlist-screen"); }

function goBackToList() {
    currentChatPeer = null;
    showScreen("chatlist-screen");
    renderChatList();
}

// ===== MESH NETWORK =====
function initMesh() {
    try {
        myPeerInstance = new Peer(userGhostID);
        myPeerInstance.on('open', id => {
            document.getElementById("my-ghost-id-label").innerText = id;
            showToast("✅ Ghost Mesh Live: " + id);
        });
        myPeerInstance.on('connection', conn => {
            handleIncomingRequest(conn);
            setupConn(conn);
        });
        myPeerInstance.on('call', call => handleIncomingCall(call));
        myPeerInstance.on('error', err => {
            if (err.type === 'unavailable-id') {
                userGhostID = "Ghost-" + Math.floor(1000 + Math.random() * 9000);
                document.getElementById("my-ghost-id-label").innerText = userGhostID;
                initMesh();
            } else { showToast("⚠️ Network issue, retrying..."); }
        });
    } catch(e) { console.error(e); }
}

function setupConn(conn) {
    conn.on('open', () => {
        conn.send({ type: "dp-update", sender: userGhostID, dpData: userCurrentDP });
        if (!chatData[conn.peer]) initChatData(conn.peer);
    });

    conn.on('data', data => {
        if (!data || !data.type) return;
        switch(data.type) {
            case "handshake-status":
                if (data.approved) {
                    if (!activeConnections.some(c => c.peer === conn.peer)) activeConnections.push(conn);
                    if (!chatData[conn.peer]) initChatData(conn.peer);
                    addSystemMsg(conn.peer, `🎉 Connected with ${conn.peer}`);
                    renderChatList();
                    showToast("🎉 Connected with " + conn.peer);
                } else {
                    showToast("❌ " + conn.peer + " rejected request");
                    conn.close();
                }
                break;
            case "chat":
                if (!chatData[data.sender]) initChatData(data.sender);
                const msg = { id: data.msgId, sender: data.sender, text: data.text, direction: "incoming",
                    dp: data.senderDP, contentType: data.contentType, mediaPayload: data.mediaPayload,
                    viewOnce: data.viewOnce, time: new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) };
                chatData[data.sender].messages.push(msg);
                chatData[data.sender].lastMsg = data.text || "📎 Media";
                chatData[data.sender].lastTime = msg.time;
                if (currentChatPeer !== data.sender) {
                    chatData[data.sender].unread = (chatData[data.sender].unread || 0) + 1;
                } else {
                    renderMessage(msg);
                }
                renderChatList();
                if (conn.open) conn.send({ type: "ack", msgId: data.msgId });
                if (navigator.vibrate) navigator.vibrate(50);
                break;
            case "typing":
                if (currentChatPeer === data.sender) {
                    const ind = document.getElementById("typing-indicator");
                    if (data.isTyping) { ind.innerText = data.sender + " is typing..."; ind.classList.remove("hidden"); }
                    else ind.classList.add("hidden");
                }
                break;
            case "ack":
                const tick = document.getElementById("tick-" + data.msgId);
                if (tick) { tick.innerText = "✓✓"; tick.className = "msg-tick read"; }
                break;
            case "dp-update":
                if (chatData[data.sender]) chatData[data.sender].dp = data.dpData;
                window["dp_" + data.sender] = data.dpData;
                document.querySelectorAll(".avatar-" + data.sender).forEach(img => img.src = data.dpData);
                renderChatList();
                break;
            case "reaction": renderReactionLocal(data.msgId, data.emoji); break;
            case "delete": renderDeleteLocal(data.msgId); break;
            case "location":
                showToast(`📍 ${data.sender} shared location`);
                if (currentChatPeer === data.sender) {
                    const locMsg = { id: "loc-" + Date.now(), sender: data.sender, text: `📍 Live Location\nLat: ${data.lat.toFixed(5)}, Lng: ${data.lng.toFixed(5)}`, direction: "incoming",
                        dp: data.senderDP, contentType: "text", time: new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) };
                    chatData[data.sender].messages.push(locMsg);
                    renderMessage(locMsg);
                }
                break;
            case "sos":
                showToast("🆘 SOS from " + data.sender + "!");
                showNearbyAlert(data);
                break;
        }
    });

    conn.on('close', () => {
        activeConnections = activeConnections.filter(c => c.peer !== conn.peer);
        if (chatData[conn.peer]) addSystemMsg(conn.peer, "🔌 " + conn.peer + " disconnected");
        renderChatList();
    });
}

function initChatData(peerId) {
    if (!chatData[peerId]) {
        chatData[peerId] = {
            messages: [],
            unread: 0,
            lastMsg: "",
            lastTime: "",
            dp: window["dp_" + peerId] || "https://api.dicebear.com/7.x/bottts/svg?seed=" + peerId,
            muted: false
        };
    }
}

function addSystemMsg(peerId, text) {
    if (!chatData[peerId]) initChatData(peerId);
    chatData[peerId].messages.push({ id: "sys-" + Date.now(), type: "system", text });
    if (currentChatPeer === peerId) {
        const container = document.getElementById("messages-container");
        const div = document.createElement("div");
        div.className = "date-chip";
        div.innerHTML = `<span>${text}</span>`;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }
}

// ===== CONNECT =====
function openNewConnect() { closeAllMenus(); showEl("connect-modal"); }
function closeNewConnect() { hideEl("connect-modal"); document.getElementById("peer-id-input").value = ""; }

function connectFromUI() {
    const id = document.getElementById("peer-id-input").value.trim();
    if (!id || id === userGhostID) { showToast("Enter a valid Ghost ID"); return; }
    connectToPeer(id);
    closeNewConnect();
}

function connectToPeer(targetID) {
    if (!myPeerInstance) { showToast("Not connected yet"); return; }
    showToast("Connecting to " + targetID + "...");
    const conn = myPeerInstance.connect(targetID);
    setupConn(conn);
}

// ===== ACCEPT / REJECT =====
function handleIncomingRequest(conn) {
    pendingIncomingConnection = conn;
    document.getElementById("request-modal-text").innerText = conn.peer + " wants to connect with you.";
    showEl("request-modal");
}

function acceptConnectionRequest() {
    hideEl("request-modal");
    if (!pendingIncomingConnection) return;
    if (!activeConnections.some(c => c.peer === pendingIncomingConnection.peer)) activeConnections.push(pendingIncomingConnection);
    initChatData(pendingIncomingConnection.peer);
    pendingIncomingConnection.send({ type: "handshake-status", approved: true, sender: userGhostID });
    addSystemMsg(pendingIncomingConnection.peer, "🎉 Connected with " + pendingIncomingConnection.peer);
    renderChatList();
    showToast("✅ Accepted " + pendingIncomingConnection.peer);
    pendingIncomingConnection = null;
}

function rejectConnectionRequest() {
    hideEl("request-modal");
    if (!pendingIncomingConnection) return;
    pendingIncomingConnection.send({ type: "handshake-status", approved: false, sender: userGhostID });
    setTimeout(() => { if (pendingIncomingConnection) pendingIncomingConnection.close(); pendingIncomingConnection = null; }, 500);
}

// ===== CHAT LIST =====
function renderChatList() {
    const container = document.getElementById("chat-list-container");
    const empty = document.getElementById("empty-state");
    const peers = Object.keys(chatData);

    if (peers.length === 0) {
        empty.style.display = "flex";
        return;
    }
    empty.style.display = "none";

    // Sort by last time
    peers.sort((a, b) => {
        const ta = chatData[a].lastTime || "";
        const tb = chatData[b].lastTime || "";
        return tb.localeCompare(ta);
    });

    // Remove old items (keep empty state)
    container.querySelectorAll(".chat-item").forEach(el => el.remove());

    peers.forEach(peerId => {
        const data = chatData[peerId];
        const isOnline = activeConnections.some(c => c.peer === peerId);
        const item = document.createElement("div");
        item.className = "chat-item";
        item.id = "chatitem-" + peerId;
        item.onclick = () => openChat(peerId);
        item.innerHTML = `
            <div class="chat-item-avatar">
                <img src="${data.dp || 'https://api.dicebear.com/7.x/bottts/svg?seed=' + peerId}" class="chat-item-dp avatar-${peerId}">
                ${isOnline ? '<span class="online-dot"></span>' : ''}
            </div>
            <div class="chat-item-body">
                <div class="chat-item-top">
                    <span class="chat-item-name">${peerId}</span>
                    <span class="chat-item-time">${data.lastTime || ''}</span>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span class="chat-item-preview">${data.lastMsg || 'Tap to chat'}</span>
                    ${data.unread > 0 ? `<span class="unread-badge">${data.unread}</span>` : ''}
                </div>
            </div>`;
        container.appendChild(item);
    });
}

function filterChats(query) {
    const q = query.toLowerCase();
    document.querySelectorAll(".chat-item").forEach(item => {
        item.style.display = item.id.toLowerCase().includes(q) ? "" : "none";
    });
}

function openChat(peerId) {
    currentChatPeer = peerId;
    if (!chatData[peerId]) initChatData(peerId);
    chatData[peerId].unread = 0;

    document.getElementById("chat-peer-name").innerText = peerId;
    const dp = chatData[peerId].dp || "https://api.dicebear.com/7.x/bottts/svg?seed=" + peerId;
    document.getElementById("chat-peer-dp").src = dp;
    document.getElementById("call-peer-dp").src = dp;
    const isOnline = activeConnections.some(c => c.peer === peerId);
    document.getElementById("chat-peer-status").innerText = isOnline ? "🟢 P2P Connected" : "⚫ Offline";

    showScreen("chat-screen");
    renderAllMessages(peerId);
    document.getElementById("msg-input").focus();
}

function renderAllMessages(peerId) {
    const container = document.getElementById("messages-container");
    container.innerHTML = '<div class="date-chip"><span>Today</span></div>';
    (chatData[peerId]?.messages || []).forEach(msg => {
        if (msg.type === "system") {
            const div = document.createElement("div");
            div.className = "date-chip";
            div.innerHTML = `<span>${msg.text}</span>`;
            container.appendChild(div);
        } else {
            renderMessage(msg);
        }
    });
    container.scrollTop = container.scrollHeight;
}

// ===== MESSAGING =====
function sendMessage() {
    const input = document.getElementById("msg-input");
    const txt = input.value.trim();
    if (!txt) return;

    for (const w of bannedWords) {
        if (txt.toLowerCase().includes(w)) { showToast("⚠️ Message blocked by safety filter"); input.value = ""; return; }
    }

    sendBundle("text", txt);
    input.value = "";
}

function sendBundle(contentType, payload) {
    const msgId = "msg-" + Date.now();
    const time = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const text = contentType === "text" ? payload : "";

    const msg = { id: msgId, sender: userGhostID, text, direction: "outgoing",
        dp: userCurrentDP, contentType, mediaPayload: payload, viewOnce: isViewOnceEnabled, time };

    if (currentChatPeer) {
        if (!chatData[currentChatPeer]) initChatData(currentChatPeer);
        chatData[currentChatPeer].messages.push(msg);
        chatData[currentChatPeer].lastMsg = text || "📎 Media";
        chatData[currentChatPeer].lastTime = time;
        renderMessage(msg);
    }

    broadcastToMesh({ type: "chat", msgId, sender: userGhostID, text,
        senderDP: userCurrentDP, contentType, mediaPayload: payload, viewOnce: isViewOnceEnabled });

    if (isViewOnceEnabled) toggleViewOnceMode();
    renderChatList();
}

function renderMessage(msg) {
    const container = document.getElementById("messages-container");
    const card = document.createElement("div");
    card.id = msg.id;
    card.setAttribute("data-sender", msg.sender);
    card.className = "card " + (msg.direction === "outgoing" ? "outgoing" : "incoming");
    card.onclick = () => openReactionModal(msg.id);

    if (msg.direction === "incoming") {
        const img = document.createElement("img");
        img.src = msg.dp || window["dp_" + msg.sender] || "https://api.dicebear.com/7.x/bottts/svg?seed=" + msg.sender;
        img.className = "msg-avatar avatar-" + msg.sender;
        card.appendChild(img);
    }

    const body = document.createElement("div");
    body.style.flex = "1";

    if (msg.direction === "incoming") {
        const sender = document.createElement("div");
        sender.className = "sender";
        sender.innerText = msg.sender;
        body.appendChild(sender);
    }

    const txtNode = document.createElement("div");
    txtNode.className = "msg-text-content";

    if (msg.viewOnce && msg.direction === "incoming") {
        txtNode.innerText = "👁️ Tap to view (disappears after)";
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

    const timeRow = document.createElement("div");
    timeRow.className = "msg-time-row";
    const timeEl = document.createElement("span");
    timeEl.className = "msg-time";
    timeEl.innerText = msg.time || "";
    timeRow.appendChild(timeEl);

    if (msg.direction === "outgoing") {
        const tick = document.createElement("span");
        tick.id = "tick-" + msg.id;
        tick.className = "msg-tick";
        tick.innerText = "✓";
        timeRow.appendChild(tick);
    }

    body.appendChild(timeRow);
    card.appendChild(body);
    container.appendChild(card);
    container.scrollTop = container.scrollHeight;
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
            wrap.innerHTML = `<a href="${payload.fileData}" download="${payload.fileName}" style="color:var(--accent);font-weight:bold;">📁 ${payload.fileName}</a>`;
        }
        node.appendChild(wrap);
    } else if (type === "audio" && payload) {
        const wrap = document.createElement("div");
        wrap.style.marginTop = "6px";
        wrap.innerHTML = `<audio src="${payload}" controls></audio>`;
        node.appendChild(wrap);
    }
}

function broadcastToMesh(obj) {
    activeConnections.forEach(c => { if (c?.open) c.send(obj); });
}

// ===== TYPING =====
function setupTypingListener() {
    const inp = document.getElementById("msg-input");
    if (!inp) return;
    inp.addEventListener("input", () => {
        broadcastToMesh({ type: "typing", sender: userGhostID, isTyping: true });
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => broadcastToMesh({ type: "typing", sender: userGhostID, isTyping: false }), 2000);
    });
}

document.addEventListener("DOMContentLoaded", setupTypingListener);

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
    const card = document.getElementById(msgId);
    if (!card) return;
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
    const card = document.getElementById(msgId);
    if (!card) return;
    const txt = card.querySelector(".msg-text-content");
    if (txt) { txt.innerText = "🚫 Message deleted"; txt.style.cssText = "font-style:italic;opacity:0.5;"; }
    card.querySelector(".media-container")?.remove();
}

// ===== THEME =====
function toggleAppTheme() {
    closeAllMenus();
    document.body.classList.toggle("light-theme");
}

// ===== DP =====
function triggerDPUpload() { document.getElementById("dp-file-input").click(); }
function handleDPChange(event) {
    const file = event.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        userCurrentDP = e.target.result;
        document.getElementById("my-dp-chatlist").src = userCurrentDP;
        document.getElementById("profile-dp-big").src = userCurrentDP;
        broadcastToMesh({ type: "dp-update", sender: userGhostID, dpData: userCurrentDP });
        showToast("✅ Profile photo updated");
    };
    reader.readAsDataURL(file);
}

function copyGhostID() {
    navigator.clipboard?.writeText(userGhostID).then(() => showToast("📋 Ghost ID copied!")).catch(() => showToast(userGhostID));
}

// ===== FILE ATTACH =====
function triggerFileAttachment() { document.getElementById("attachment-file-input").click(); }
function handleFileAttachment(event) {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 10 * 1024 * 1024) { showToast("File too large! Max 10MB"); return; }
    const reader = new FileReader();
    reader.onload = e => sendBundle("media", { fileData: e.target.result, fileName: file.name, fileType: file.type });
    reader.readAsDataURL(file);
}

// ===== VIEW ONCE =====
function toggleViewOnceMode() {
    isViewOnceEnabled = !isViewOnceEnabled;
    document.getElementById("view-once-btn").style.color = isViewOnceEnabled ? "var(--accent)" : "";
    document.getElementById("view-once-badge").classList.toggle("hidden", !isViewOnceEnabled);
}

// ===== VOICE RECORD =====
function toggleVoiceRecord() {
    const btn = document.getElementById("voice-record-btn");
    if (!isRecordingAudio) {
        navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
            recordedAudioChunks = [];
            mediaRecorderInstance = new MediaRecorder(stream);
            mediaRecorderInstance.ondataavailable = e => recordedAudioChunks.push(e.data);
            mediaRecorderInstance.onstop = () => {
                const blob = new Blob(recordedAudioChunks, { type: 'audio/ogg' });
                const reader = new FileReader();
                reader.onload = e => sendBundle("audio", e.target.result);
                reader.readAsDataURL(blob);
                stream.getTracks().forEach(t => t.stop());
            };
            mediaRecorderInstance.start();
            isRecordingAudio = true;
            btn.innerText = "🛑";
            btn.style.color = "var(--danger)";
        }).catch(() => showToast("Mic permission denied"));
    } else {
        mediaRecorderInstance.stop();
        isRecordingAudio = false;
        btn.innerText = "🎙️";
        btn.style.color = "";
    }
}

// ===== CALLS =====
function initiateP2PCall(type) {
    if (activeConnections.length === 0) { showToast("Connect to a peer first!"); return; }
    const target = currentChatPeer || activeConnections[0].peer;
    navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' }).then(stream => {
        localMediaStream = stream;
        showEl("call-screen");
        document.getElementById("call-status-label").innerText = type === 'video' ? "📹 Video Calling..." : "📞 Voice Calling...";
        document.getElementById("call-peer-label").innerText = target;
        if (type === 'video') {
            document.getElementById("video-grid").classList.remove("hidden");
            document.getElementById("local-video").srcObject = stream;
        }
        activeP2PCallInstance = myPeerInstance.call(target, stream, { metadata: { type } });
        listenCallStream(activeP2PCallInstance, type);
    }).catch(() => showToast("Camera/Mic access denied"));
}

function listenCallStream(callObj, type) {
    callObj.on('stream', remoteStream => {
        document.getElementById("call-status-label").innerText = "🟢 Connected";
        document.getElementById("remote-video").srcObject = remoteStream;
        if (type === 'video') document.getElementById("video-grid").classList.remove("hidden");
    });
    callObj.on('close', endCallFlow);
    callObj.on('error', endCallFlow);
}

function handleIncomingCall(call) {
    pendingIncomingCallEvent = call;
    const type = call.metadata?.type || 'voice';
    showEl("call-screen");
    document.getElementById("call-status-label").innerText = type === 'video' ? "📹 Incoming Video Call" : "📞 Incoming Voice Call";
    document.getElementById("call-peer-label").innerText = call.peer;
    document.getElementById("accept-call-btn").classList.remove("hidden");
}

function acceptIncomingCall() {
    document.getElementById("accept-call-btn").classList.add("hidden");
    const type = pendingIncomingCallEvent?.metadata?.type || 'voice';
    navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' }).then(stream => {
        localMediaStream = stream;
        if (type === 'video') { document.getElementById("video-grid").classList.remove("hidden"); document.getElementById("local-video").srcObject = stream; }
        pendingIncomingCallEvent.answer(stream);
        listenCallStream(pendingIncomingCallEvent, type);
    }).catch(() => showToast("Camera/Mic access denied"));
}

function endCurrentCall() {
    activeP2PCallInstance?.close();
    pendingIncomingCallEvent?.close();
    endCallFlow();
}

function endCallFlow() {
    localMediaStream?.getTracks().forEach(t => t.stop());
    localMediaStream = null; activeP2PCallInstance = null; pendingIncomingCallEvent = null;
    document.getElementById("remote-video").srcObject = null;
    document.getElementById("local-video").srcObject = null;
    hideEl("call-screen");
    document.getElementById("accept-call-btn").classList.add("hidden");
    document.getElementById("video-grid").classList.add("hidden");
}

// ===== RADAR MAP =====
function initRadarMap() {
    try {
        radarMapInstance = L.map('live-radar-map').setView([20.5937, 78.9629], 5);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(radarMapInstance);
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(pos => {
                userLat = pos.coords.latitude; userLng = pos.coords.longitude;
                radarMapInstance.setView([userLat, userLng], 13);
                L.marker([userLat, userLng]).addTo(radarMapInstance).bindPopup(`<b>👻 You (${userGhostID})</b>`).openPopup();
                spawnNearbyNodes(userLat, userLng, radarMapInstance);
            }, () => spawnNearbyNodes(20.5937, 78.9629, radarMapInstance));
        }
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

function spawnNearbyNodes(lat, lng, mapInst) {
    const nodes = [
        { id: "Ghost-4683", lo: 0.005, ln: 0.003 },
        { id: "Ghost-7446", lo: -0.004, ln: -0.006 },
        { id: "Ghost-9122", lo: 0.002, ln: -0.003 }
    ];
    nodes.forEach(n => {
        L.marker([lat + n.lo, lng + n.ln]).addTo(mapInst).bindPopup(
            `<b>👾 ${n.id}</b><br>Status: Online<br><button class="map-connect-btn" onclick="connectToPeer('${n.id}')">⚡ Connect</button>`
        );
    });
}

// ===== SOS =====
function initSOSMap() {
    if (sosMapInstance) { setTimeout(() => sosMapInstance.invalidateSize(), 200); return; }
    try {
        sosMapInstance = L.map('sos-map').setView([userLat, userLng], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(sosMapInstance);
        L.marker([userLat, userLng]).addTo(sosMapInstance).bindPopup("📍 Your Location").openPopup();
        spawnNearbyNodes(userLat, userLng, sosMapInstance);
    } catch(e) { console.error(e); }
}

function fetchSOSInfo() {
    document.getElementById("sos-peers").innerText = activeConnections.length + " peers";
    // Battery
    if (navigator.getBattery) {
        navigator.getBattery().then(b => {
            document.getElementById("sos-battery").innerText = Math.round(b.level * 100) + "%";
        });
    }
    // Location
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            userLat = pos.coords.latitude; userLng = pos.coords.longitude;
            document.getElementById("sos-my-location").innerText = userLat.toFixed(4) + ", " + userLng.toFixed(4);
        }, () => {
            document.getElementById("sos-my-location").innerText = "Location blocked";
        });
    }
}

function toggleSOS() {
    const btn = document.getElementById("sos-main-btn");
    if (!sosActive) {
        sosActive = true;
        btn.innerHTML = "🛑 STOP SOS";
        btn.classList.add("active-sos");
        document.getElementById("sos-title").innerText = "🆘 SOS ACTIVE!";
        document.getElementById("sos-desc").innerText = "Broadcasting your location to all nearby Ghost Mesh peers...";
        broadcastSOS();
        sosInterval = setInterval(broadcastSOS, 15000);
        showToast("🆘 SOS Alert sent to all peers!");
    } else {
        sosActive = false;
        clearInterval(sosInterval);
        btn.innerHTML = "🆘 SEND SOS ALERT";
        btn.classList.remove("active-sos");
        document.getElementById("sos-title").innerText = "Emergency Help";
        document.getElementById("sos-desc").innerText = "Press SOS to alert all nearby Ghost Mesh users with your live GPS location";
        showToast("SOS stopped");
    }
}

function broadcastSOS() {
    broadcastToMesh({ type: "sos", sender: userGhostID, lat: userLat, lng: userLng,
        senderDP: userCurrentDP, time: new Date().toLocaleTimeString() });
}

function showNearbyAlert(data) {
    const box = document.getElementById("nearby-alerts");
    const list = document.getElementById("nearby-alerts-list");
    box.classList.remove("hidden");
    const item = document.createElement("div");
    item.style.cssText = "padding:10px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:10px;margin-bottom:8px;font-size:13px;";
    item.innerHTML = `<b>🆘 ${data.sender}</b><br>📍 Lat: ${data.lat?.toFixed(4)}, Lng: ${data.lng?.toFixed(4)}<br>🕐 ${data.time}
        <br><button onclick="connectToPeer('${data.sender}')" style="background:var(--danger);color:white;border:none;padding:5px 12px;border-radius:8px;margin-top:6px;cursor:pointer;font-weight:700;">📞 Respond</button>`;
    list.prepend(item);
}

function shareLiveLocation() {
    closeAllMenus();
    if (!navigator.geolocation) { showToast("Location not available"); return; }
    navigator.geolocation.getCurrentPosition(pos => {
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        broadcastToMesh({ type: "location", sender: userGhostID, lat, lng, senderDP: userCurrentDP });
        showToast("📍 Live location shared for 15 min");
        if (liveLocationInterval) clearInterval(liveLocationInterval);
        liveLocationInterval = setInterval(() => {
            navigator.geolocation.getCurrentPosition(p => {
                broadcastToMesh({ type: "location", sender: userGhostID, lat: p.coords.latitude, lng: p.coords.longitude, senderDP: userCurrentDP });
            });
        }, 30000);
        setTimeout(() => { clearInterval(liveLocationInterval); showToast("📍 Live location stopped"); }, 15 * 60 * 1000);
    }, () => showToast("Location permission denied"));
}

// ===== CHAT MENU ACTIONS =====
function muteCurrentChat() { closeAllMenus(); if (currentChatPeer && chatData[currentChatPeer]) { chatData[currentChatPeer].muted = true; showToast("🔇 Chat muted"); } }
function clearCurrentChat() { closeAllMenus(); if (!currentChatPeer) return; if (confirm("Clear all messages?")) { chatData[currentChatPeer].messages = []; renderAllMessages(currentChatPeer); showToast("🗑️ Chat cleared"); } }
function clearAllChats() { closeAllMenus(); if (confirm("Clear all chats?")) { Object.keys(chatData).forEach(k => chatData[k].messages = []); showToast("🗑️ All chats cleared"); renderChatList(); } }
function blockCurrentPeer() { closeAllMenus(); if (!currentChatPeer) return; if (confirm("Block " + currentChatPeer + "?")) { activeConnections = activeConnections.filter(c => c.peer !== currentChatPeer); delete chatData[currentChatPeer]; goBackToList(); showToast("🚫 " + currentChatPeer + " blocked"); } }
function disconnectCurrentPeer() { closeAllMenus(); const conn = activeConnections.find(c => c.peer === currentChatPeer); if (conn) conn.close(); goBackToList(); showToast("🔌 Disconnected"); }
function searchInChat() { closeAllMenus(); showToast("Search coming soon!"); }
function viewSharedMedia() { closeAllMenus(); showToast("Media gallery coming soon!"); }

// ===== MENU TOGGLES =====
function toggleMainMenu() {
    const m = document.getElementById("main-menu");
    m.classList.toggle("hidden");
}

function toggleChatMenu() {
    const m = document.getElementById("chat-menu");
    m.classList.toggle("hidden");
}

function closeAllMenus() {
    document.getElementById("main-menu")?.classList.add("hidden");
    document.getElementById("chat-menu")?.classList.add("hidden");
}

document.addEventListener("click", e => {
    if (!e.target.closest(".three-dot-wrap")) closeAllMenus();
});

// ===== TOAST =====
let toastTimer;
function showToast(msg) {
    const toast = document.getElementById("toast");
    toast.innerText = msg;
    toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 3000);
}
