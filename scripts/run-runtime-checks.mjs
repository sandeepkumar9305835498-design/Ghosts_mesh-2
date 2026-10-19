#!/usr/bin/env node
// ===== GHOST MESH — RUNTIME CHECKS =====
// The static checks in verify-static.mjs prove the files line up; this boots the
// REAL index.html plus every script in jsdom and exercises the code paths that
// only fail at runtime: the in-app dialogs, the daily bonus cooldown, the
// QR/paste scanner fallback, the settings sheet and the bottom pill nav.
//
// It runs with no camera and no network (the same situation as someone opening
// the page over file://), which is exactly when most of these paths used to
// dead-end. Dependency: jsdom (devDependency).
//
//   node scripts/run-runtime-checks.mjs     # exit 0 = all checks passed
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");

const results = [];
const ok = (name, pass, extra) => results.push({ name, pass: !!pass, extra: extra || "" });

function fakeCanvasCtx() {
    return {
        drawImage() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
        closePath() {}, fill() {}, stroke() {}, arc() {}, save() {}, restore() {}, translate() {},
        rotate() {}, scale() {}, setTransform() {}, putImageData() {}, createImageData() {
            return { data: new Uint8ClampedArray(4) };
        },
        getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }; }
    };
}

const dom = await JSDOM.fromFile(path.join(ROOT, "index.html"), {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
        window.HTMLCanvasElement.prototype.getContext = () => fakeCanvasCtx();
        // No camera in jsdom (mirrors the file:// / blocked-camera case).
        Object.defineProperty(window.navigator, "mediaDevices", { value: undefined, configurable: true });
        window.console.error = (...a) => { window.__consoleErrors = (window.__consoleErrors || []).concat([a.join(" ")]); };
    }
});

const { window } = dom;
const errors = [];
window.addEventListener("error", e => errors.push(String(e.message)));

await new Promise(res => {
    if (window.document.readyState === "complete") return res();
    window.addEventListener("load", res);
    setTimeout(res, 3000);
});

const doc = window.document;
const $ = id => doc.getElementById(id);
const toastText = () => ($("toast") ? $("toast").innerText : "");
const hidden = id => ($(id) ? $(id).classList.contains("hidden") : null);

// ---------------------------------------------------------------- boot
ok("page boots without a thrown error", errors.length === 0, errors.join(" | "));
ok("no console.error during boot", !(window.__consoleErrors || []).length, (window.__consoleErrors || []).join(" | "));

// ------------------------------------------------------- new functions exist
for (const fn of ["gmConfirm", "gmConfirmResolve", "openSettingsSheet", "closeSettingsSheet",
    "claimDailyBonus", "msUntilBonus", "formatBonusWait", "pasteCodeManually", "gmClosePasteModal",
    "gmSubmitPasteCode", "scanQrFromImage", "gmHandleQrImage", "startCameraScan",
    "gmSetBluetoothScan", "gmRefreshBluetoothPeers", "openLiveMap", "closeLiveMap",
    "saveProfilePhone", "gmOpenSponsoredBreak", "gmClaimSponsoredCredits", "gmDpCropOpen",
    "gmDpCropApply", "gmDpCropCancel"]) {
    ok(`window.${fn} is a function`, typeof window[fn] === "function", typeof window[fn]);
}

// ------------------------------------------------------- dead-end removal
ok("the old +1 credit shortcut is gone", typeof window.quickAddCredit === "undefined");
ok("the old fake-ad entry point is gone", typeof window.watchAdForCredits === "undefined");
ok("the fake ad overlay is gone from the DOM", $("watch-ad-overlay") === null);

// ------------------------------------------------------- sign in
window.executeLogin("", "Test Ghost");
const creditsAfterLogin = window.getCredits();
ok("sign-in grants the starter credits", creditsAfterLogin === 10, "credits=" + creditsAfterLogin);
ok("bonus is ready right after sign-in", window.msUntilBonus() === 0, "wait=" + window.msUntilBonus());

// ------------------------------------------------------- in-app confirm
ok("confirm sheet starts hidden", hidden("gm-confirm") === true);
let confirmed = false;
window.gmConfirm("Clear all messages in this chat? This cannot be undone.", () => { confirmed = true; },
    { title: "Clear chat", confirmLabel: "Clear" });
ok("confirm sheet opens", hidden("gm-confirm") === false);
ok("confirm sheet carries the message", $("gm-confirm-msg").innerText.includes("cannot be undone"), $("gm-confirm-msg").innerText);
ok("confirm sheet carries the title", $("gm-confirm-title").innerText === "Clear chat", $("gm-confirm-title").innerText);
ok("confirm sheet carries the button label", $("gm-confirm-yes").innerText === "Clear", $("gm-confirm-yes").innerText);
ok("callback does not run before the answer", confirmed === false);
window.gmConfirmResolve(true);
ok("callback runs on confirm", confirmed === true);
ok("sheet closes after confirming", hidden("gm-confirm") === true);

// cancel path must NOT run the callback
let cancelRan = false;
window.gmConfirm("Block Ghost-ABCDEF? They can no longer reach you.", () => { cancelRan = true; });
window.gmConfirmResolve(false);
ok("callback does not run on cancel", cancelRan === false);
ok("sheet closes after cancelling", hidden("gm-confirm") === true);
// a second answer must not fire the previous callback again
window.gmConfirmResolve(true);
ok("a stale answer cannot fire an old callback", cancelRan === false);

// ------------------------------------------------------- daily bonus
window.claimDailyBonus();
const afterBonus = window.getCredits();
ok("daily bonus adds 2 credits", afterBonus === creditsAfterLogin + 2, "credits=" + afterBonus);
ok("daily bonus starts the 24h cooldown", window.msUntilBonus() > 23 * 60 * 60 * 1000, "wait=" + window.msUntilBonus());
ok("bonus toast has no emoji", !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(toastText()), JSON.stringify(toastText()));

window.claimDailyBonus();          // second press inside the cooldown
ok("a second claim inside the cooldown pays nothing", window.getCredits() === afterBonus, "credits=" + window.getCredits());
ok("the cooldown is explained in the toast", /already claimed/.test(toastText()), JSON.stringify(toastText()));

// the button doubles as the countdown
window.renderCreditsUI();
ok("bonus button shows the countdown", /^Bonus ready in /.test($("bonus-earn-label").innerText), $("bonus-earn-label").innerText);
ok("bonus button is disabled during the cooldown", $("bonus-earn-btn").disabled === true);

// countdown formatting
ok("formatBonusWait formats minutes", window.formatBonusWait(5 * 60 * 1000) === "5 min", window.formatBonusWait(5 * 60 * 1000));
ok("formatBonusWait formats hours+minutes", window.formatBonusWait(90 * 60 * 1000) === "1h 30m", window.formatBonusWait(90 * 60 * 1000));

// ------------------------------------------------------- settings sheet
window.openSettingsSheet();
ok("settings sheet opens", hidden("settings-sheet") === false);
const settingsRows = doc.querySelectorAll("#settings-sheet .settings-row");
ok("settings lists all twelve options", settingsRows.length === 12, String(settingsRows.length));
const settingsText = $("settings-sheet").textContent;
for (const label of ["My Profile", "Ghost Assistant (Recover ID)", "Chat Themes", "App Lock", "Clear All Chats",
    "Blocked Ghosts", "Account Privacy", "Privacy Policy", "Send Feedback", "Claim Daily Bonus", "Refer a Ghost", "Logout"]) {
    ok(`settings has "${label}"`, settingsText.includes(label));
}
ok("no settings row says coming soon", !/coming soon/i.test(settingsText), settingsText);
// The header shows who you are: avatar + display name + Ghost ID.
ok("settings header shows the Ghost ID",
    $("settings-head-id").innerText === $("my-ghost-id-label").innerText,
    $("settings-head-id").innerText);
ok("settings header shows the display name",
    $("settings-head-name").innerText === $("my-name-display").innerText,
    $("settings-head-name").innerText);
// Profile is entered from Settings and its back button returns here.
window.gmOpenProfileFromSettings();
ok("the My Profile row opens the profile screen",
    hidden("profile-screen") === false && hidden("settings-sheet") === true);
ok("the profile screen shows the Ghost ID and its stats",
    $("profile-ghost-id").innerText === $("my-ghost-id-label").innerText &&
    !!$("profile-stat-chats") && !!$("profile-stat-credits") && !!$("profile-stat-connections"));
window.closeProfile();
ok("leaving the profile returns to Settings",
    hidden("settings-sheet") === false && hidden("profile-screen") === true);
// Chat Themes is entered from Settings too, with the same way back.
window.gmOpenThemeFromSettings();
ok("the Chat Themes row opens the theme screen",
    hidden("theme-screen") === false && hidden("settings-sheet") === true);
window.closeThemePicker();
ok("leaving the themes returns to Settings",
    hidden("settings-sheet") === false && hidden("theme-screen") === true);
window.closeSettingsSheet();
ok("settings sheet closes", hidden("settings-sheet") === true);

// The six moved features must no longer sit in the header 3-dot menu.
const menuText = $("main-menu").textContent;
for (const label of ["My Profile", "Ghost Assistant", "Chat Themes", "Clear All Chats", "Send Feedback", "Logout"]) {
    ok(`the 3-dot menu no longer offers "${label}"`, !menuText.includes(label));
}
ok("the 3-dot menu keeps the quick actions",
    ["New Chat", "New Group", "Nearby Ghosts", "Radar Map", "Ghost Mode", "Notifications"]
        .every(l => menuText.includes(l)), menuText);

// ------------------------------------------------------- paste-code sheet
window.pasteCodeManually();
ok("paste sheet opens", hidden("gm-paste-modal") === false);
window.gmClosePasteModal();
ok("paste sheet closes", hidden("gm-paste-modal") === true);

// ------------------------------------------------------- scanner without a camera
window.startOfflineJoinScan();
await new Promise(r => setTimeout(r, 30));
ok("scanner overlay opens even with no camera", hidden("qr-scan-overlay") === false);
ok("scanner explains the camera is unavailable",
    /Camera unavailable/.test($("qr-scan-title").innerText), $("qr-scan-title").innerText);
const pasteLink = doc.querySelector(".qr-scan-paste-link");
ok("paste-code fallback is offered", !!pasteLink && /Paste code/.test(pasteLink.textContent), pasteLink ? pasteLink.textContent : "(missing)");

// the paste sheet still drives the pending handshake
window.pasteCodeManually();
$("gm-paste-input").value = "not-a-real-qr-payload";
window.gmSubmitPasteCode();
await new Promise(r => setTimeout(r, 30));
ok("a bad pasted code is rejected in-app", /Invalid code/.test(toastText()), JSON.stringify(toastText()));
ok("paste sheet closed itself after submitting", hidden("gm-paste-modal") === true);

// ------------------------------------------------------- image scan wiring
window.scanQrFromImage();   // must not throw without a real File dialog
ok("scanQrFromImage is safe to call", true);
window.gmHandleQrImage({ target: { files: [] } });
ok("an empty image pick is ignored", true);

// ------------------------------------------------- bottom pill nav wiring
const navItems = [...doc.querySelectorAll("#gm-bottom-nav .gm-nav-item")];
const navKeys = navItems.map(b => b.getAttribute("data-nav"));
ok("the pill nav has exactly 4 destinations", navItems.length === 4, String(navItems.length));
ok("the pill nav is Chats / WiFi / Bluetooth / Map, in that order",
    navKeys.join(",") === "chats,wifi,bluetooth,map", navKeys.join(","));
ok("Connect is not a pill nav destination any more", !navKeys.includes("connect"));
ok("Profile is no longer a pill nav destination", !navKeys.includes("profile"));
ok("Settings left the pill nav for the 3-dot menu", !navKeys.includes("settings"));
ok("the 3-dot menu opens Settings", /openSettingsSheet\(/.test($("main-menu").innerHTML));
ok("every pill nav item is wired to gmNavGo with its own key",
    navItems.every(b => b.getAttribute("onclick") === "gmNavGo('" + b.getAttribute("data-nav") + "')"));
// The top tab bar did the same job as the pill nav, so it was removed. The two
// panels and the swipe gesture stay; the scroller carries the active state.
ok("the redundant top tab bar is gone",
    doc.querySelectorAll(".main-tab-btn").length === 0 && doc.querySelector(".main-tabs-bar") === null,
    String(doc.querySelectorAll(".main-tab-btn").length));
ok("all three panels still exist behind the pill nav",
    !!$("main-tabs-scroller") && !!$("main-tab-panel-0") && !!$("main-tab-panel-1") && !!$("main-tab-panel-2"));

// Settings is a sheet, so the highlight must stay on the tab the user came from.
window.gmNavGo("wifi");
window.gmNavGo("settings");
ok("the Settings destination opens the settings sheet", hidden("settings-sheet") === false);
ok("opening settings leaves the nav highlight on the previous tab",
    doc.querySelector('.gm-nav-item[data-nav="wifi"]').classList.contains("active"));
window.closeSettingsSheet();

window.gmNavGo("wifi");
ok("the WiFi destination selects the WiFi panel",
    $("main-tabs-scroller").dataset.activeTab === "1",
    String($("main-tabs-scroller").dataset.activeTab));
ok("the WiFi destination highlights the WiFi nav item",
    doc.querySelector('.gm-nav-item[data-nav="wifi"]').classList.contains("active"));
ok("the WiFi destination shows the pill nav", hidden("gm-bottom-nav") === false);

// The Online screen is reached from the header menu's "Nearby Ghosts" (the
// every-transport list); the nav no longer parks a highlight there.
window.openProfile();
window.openOnlineUsers();
ok("Nearby Ghosts opens the Online screen",
    hidden("online-screen") === false && hidden("profile-screen") === true);
ok("the Online screen explains what it lists",
    /Bluetooth or Wi-Fi Direct/.test($("online-screen").textContent));
window.closeOnlineScreen();
ok("the Online screen has a back button to the chats",
    hidden("online-screen") === true && hidden("chatlist-screen") === false);

// ------------------------------------------------------ one reach list only
ok("the Chats panel no longer repeats the reachable list",
    $("nearby-ghosts-list") === null && $("nearby-count") === null);
ok("the WiFi panel no longer hosts the reach list",
    $("wifi-reach-list") === null && $("wifi-reach-count") === null);
ok("the Online screen hosts the single reachable-ghosts list",
    !!$("online-reach-list") && !!$("online-reach-count"));
// No "Online Nearby" heading, id or handler may survive in the markup — a leftover
// would only be re-populated by a renderer that no longer exists.
ok("the duplicated Online Nearby block is gone from index.html",
    !/Online Nearby/.test(read("index.html")));
window.renderPeerLists();
ok("the reach list renders its empty state",
    /Nobody reachable yet/.test($("online-reach-list").textContent), $("online-reach-list").textContent);
ok("the empty reach list offers both QR pairing actions",
    /Show My QR/.test($("online-reach-list").textContent) &&
    /Scan Friend's QR/.test($("online-reach-list").textContent),
    $("online-reach-list").textContent);
ok("the reach counter reads 0 with no peers", Number($("online-reach-count").innerText) === 0, String($("online-reach-count").innerText));

// ------------------------------------------------------- accessibility
// A button whose only content is an <svg> has no accessible name, so TalkBack
// announces it as just "button". Every one of them must carry aria-label/title
// (the hidden PIN-grid spacer is aria-hidden and is skipped).
const unnamedButtons = [];
doc.querySelectorAll("button").forEach(b => {
    if (b.getAttribute("aria-hidden") === "true") return;
    // textContent (not just direct text nodes) so a button whose caption is
    // wrapped in a <span> still counts; <svg> contributes no text.
    if (b.textContent.trim()) return;
    if (b.getAttribute("aria-label") || b.getAttribute("title")) return;
    unnamedButtons.push(b.outerHTML.slice(0, 90));
});
ok("every icon-only button has an accessible name (" + doc.querySelectorAll("button").length + " buttons)",
    unnamedButtons.length === 0, unnamedButtons.join(" | "));
ok("the toast is a live region",
    $("toast").getAttribute("role") === "status" && $("toast").getAttribute("aria-live") === "polite");
ok("the chat search input has a label", $("chat-search").getAttribute("aria-label") === "Search chats");
ok("modal overlays are dialogs",
    $("settings-sheet").getAttribute("role") === "dialog" &&
    $("premium-modal").getAttribute("role") === "dialog" &&
    $("gm-confirm").getAttribute("role") === "dialog");
ok("the empty-state image is decorative",
    doc.querySelector("#empty-state img").getAttribute("alt") === "");

// role="button" divs are reachable, and Enter/Space behaves like a tap.
const kbTarget = doc.createElement("div");
kbTarget.setAttribute("role", "button");
kbTarget.setAttribute("tabindex", "0");
let kbClicks = 0;
kbTarget.addEventListener("click", () => { kbClicks++; });
doc.body.appendChild(kbTarget);
kbTarget.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
ok("Enter activates a role=button element", kbClicks === 1, "clicks=" + kbClicks);
kbTarget.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
ok("Space activates a role=button element", kbClicks === 2, "clicks=" + kbClicks);
kbTarget.remove();
const menuRow = doc.querySelector("#main-menu .menu-item");
ok("menu rows are exposed as buttons", !!menuRow && menuRow.getAttribute("role") === "button" && menuRow.getAttribute("tabindex") === "0");

// ------------------------------------------------------- chat search states
const fakeChat = doc.createElement("div");
fakeChat.className = "chat-item";
fakeChat.id = "chatitem-Ghost-TEST11";
fakeChat.innerHTML = '<span class="chat-item-name">Test Ghost</span>';
$("chat-list-container").appendChild(fakeChat);
window.filterChats("zzz-no-match");
ok("a search with no matches shows the empty note", hidden("chat-search-empty") === false);
ok("the empty note quotes the query", /zzz-no-match/.test($("chat-search-empty-text").textContent),
    $("chat-search-empty-text").textContent);
window.filterChats("test ghost");
ok("the search matches the display name, not just the id", fakeChat.style.display !== "none", fakeChat.style.display);
ok("the empty note hides as soon as something matches", hidden("chat-search-empty") === true);
window.filterChats("");
ok("clearing the search shows every chat again", fakeChat.style.display !== "none");
fakeChat.remove();
window.filterChats("");
ok("with no chats at all the note stays hidden", hidden("chat-search-empty") === true);

// ------------------------------------------------------- lazy vendor loading
// ~1 MB of vendor JS used to be parsed before first paint. It now loads on
// first use, which only stays true if nothing eagerly re-adds the tags.
ok("gmEnsureLib is a function", typeof window.gmEnsureLib === "function");
const libA = window.gmEnsureLib("qrcode");
const libB = window.gmEnsureLib("qrcode");
ok("gmEnsureLib caches a library load (same promise)", libA === libB);
const libLoaded = await libA;
ok("a lazy library load resolves to a boolean", typeof libLoaded === "boolean");
// End-to-end proof that the injected path is real: the file must load and
// define its global, exactly as it must on a phone.
ok("the lazy qrcode library really loads and defines QRCode",
    libLoaded === true && typeof window.QRCode !== "undefined",
    "loaded=" + libLoaded + " QRCode=" + typeof window.QRCode);
ok("a library is only injected once",
    doc.querySelectorAll('script[src="qrcode.min.js"]').length === 1,
    String(doc.querySelectorAll('script[src="qrcode.min.js"]').length));
ok("an unknown library resolves false instead of throwing",
    (await window.gmEnsureLib("nope")) === false);
const headScriptSrcs = [...read("index.html").match(/<head>([\s\S]*?)<\/head>/)[1]
    .matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
ok("heavy libraries are not referenced by a <script> tag any more",
    !headScriptSrcs.some(s => /three\.min\.js|jsQR\.js|leaflet\.js|qrcode\.min\.js/.test(s)),
    headScriptSrcs.join(", "));

// The reply-QR step can be the first thing a session does, so it has to load
// its own library — previously it fell into the "QR too large" catch, which was
// a misleading message for a library that simply had not loaded yet.
await window.renderOfflineQR("offline-qr-host", { probe: "lazy-lib" });
ok("the reply QR path fills the box (or explains itself)",
    $("offline-qr-host").innerHTML.trim() !== "" || /QR library could not load/.test(toastText()),
    JSON.stringify($("offline-qr-host").innerHTML.slice(0, 60)));
ok("the reply QR never reports a bogus 'too large' error",
    !/too large/i.test(toastText()), JSON.stringify(toastText()));

// The map used to be a 240px strip inside the Chats panel; it is a full-screen
// destination now, built only when it is opened.
ok("the old inline map strip is gone", $("map-container") === null);
ok("the map screen is hidden until it is opened", hidden("map-screen") === true);
ok("the map is not built at boot",
    doc.querySelectorAll('script[src="leaflet.js"]').length === 0);

// Android's status bar follows the theme-colour meta tag.
window.applyTheme("ocean");
ok("the status bar follows the theme",
    doc.querySelector('meta[name="theme-color"]').getAttribute("content") === "#2196f3",
    doc.querySelector('meta[name="theme-color"]').getAttribute("content"));
window.applyTheme("default");
ok("the status bar returns to the default accent",
    doc.querySelector('meta[name="theme-color"]').getAttribute("content") === "#9b59f7");

// The live 3D theme must degrade cleanly where WebGL is missing/unusable
// (jsdom has no WebGL, exactly like a low-end WebView): the canvas stays
// hidden and the app falls back to the default theme instead of throwing.
window.applyTheme("fish");
await new Promise(r => setTimeout(r, 600));
ok("the live theme falls back cleanly without WebGL",
    hidden("fish-canvas-wrap") === true && !doc.body.classList.contains("theme-fish"),
    "hidden=" + hidden("fish-canvas-wrap") + " class=" + doc.body.className);
ok("the fallback leaves the app usable",
    doc.querySelector('meta[name="theme-color"]').getAttribute("content") === "#9b59f7",
    doc.querySelector('meta[name="theme-color"]').getAttribute("content"));

// ------------------------------------------------------- old wording is gone
const html = read("index.html");
const js = read("script.js");
const banned = ["testing shortcut", "simulated for testing", "coming soon", "Simulate purchasing",
    "+1 Credit (test)", "Copy code (for testing", "Loading Ad", "Ad playing", "Watch Ad"];
for (const phrase of banned) {
    ok(`index.html/script.js no longer contain "${phrase}"`,
        !html.includes(phrase) && !js.includes(phrase));
}

// ------------------------------------------------------- app lock (Settings)
// The PIN is no longer asked for at signup. Until one is set the lock screen
// never appears; Settings is the only place to set, change or remove it.
window.gmAppLockRefreshStatus();
ok("the App Lock row reads Off with no PIN",
    $("app-lock-status").innerText === "Off" && !$("app-lock-status").classList.contains("on"),
    $("app-lock-status").innerText);
window.openAppLockSheet();
ok("with no PIN the sheet opens ready to set one",
    hidden("app-lock-modal") === false && $("app-lock-title").innerText === "Set a 4-digit PIN",
    $("app-lock-title").innerText);
const pinPress = digits => { for (const d of digits) window.gmAppLockPress(d); };
pinPress("1234");
await new Promise(r => setTimeout(r, 200));
ok("4 digits move on to the confirmation step",
    $("app-lock-title").innerText === "Confirm your new PIN" &&
    doc.querySelectorAll("#app-lock-dots span.filled").length === 0,
    $("app-lock-title").innerText);
pinPress("1235");
await new Promise(r => setTimeout(r, 200));
ok("a mismatched confirmation is rejected",
    toastText() === "PINs do not match" && window.gmAppLockHasPin() === false, toastText());
ok("the mismatch sends the person back to enter the PIN again",
    $("app-lock-title").innerText === "Set a 4-digit PIN", $("app-lock-title").innerText);
pinPress("1234");
await new Promise(r => setTimeout(r, 200));
pinPress("1234");
await new Promise(r => setTimeout(r, 200));
ok("a matching confirmation saves the PIN", window.gmAppLockHasPin() === true);
ok("saving says PIN set", toastText() === "PIN set", toastText());
ok("the sheet closes and the row flips to On",
    hidden("app-lock-modal") === true && $("app-lock-status").innerText === "On",
    $("app-lock-status").innerText);
// Reload: the saved gm_pin must still drive the lock screen.
window.initApp();
ok("reloading with a PIN set shows the lock screen", hidden("lock-screen") === false);
window.openAppLockSheet();
ok("with a PIN set the sheet offers change and remove",
    $("app-lock-title").innerText === "App Lock is on" &&
    $("app-lock-actions").classList.contains("hidden") === false,
    $("app-lock-title").innerText);
// Change PIN: the current PIN first, then the new one twice.
window.gmAppLockStartChange();
ok("changing asks for the current PIN first",
    $("app-lock-title").innerText === "Enter your current PIN", $("app-lock-title").innerText);
pinPress("1234");
await new Promise(r => setTimeout(r, 200));
ok("the current PIN moves on to choosing a new one",
    $("app-lock-title").innerText === "Set a new 4-digit PIN", $("app-lock-title").innerText);
pinPress("5678");
await new Promise(r => setTimeout(r, 200));
pinPress("5678");
await new Promise(r => setTimeout(r, 200));
ok("changing the PIN saves the new one and keeps the lock on",
    toastText() === "PIN set" && window.gmAppLockHasPin() === true, toastText());
// Remove PIN: the same current-PIN gate, which the replaced PIN no longer passes.
window.openAppLockSheet();
window.gmAppLockStartRemove();
ok("removing asks for the current PIN first",
    $("app-lock-title").innerText === "Enter your current PIN" &&
    doc.querySelectorAll("#app-lock-dots span").length === 4);
pinPress("1234");
await new Promise(r => setTimeout(r, 200));
ok("the old PIN is rejected once the PIN has been changed",
    toastText() === "Wrong current PIN" && window.gmAppLockHasPin() === true, toastText());
pinPress("0000");
await new Promise(r => setTimeout(r, 200));
ok("a wrong current PIN is rejected",
    toastText() === "Wrong current PIN" && window.gmAppLockHasPin() === true, toastText());
pinPress("5678");
await new Promise(r => setTimeout(r, 200));
ok("the right current PIN removes the lock",
    toastText() === "PIN removed" && window.gmAppLockHasPin() === false, toastText());
ok("the row flips back to Off", $("app-lock-status").innerText === "Off", $("app-lock-status").innerText);
// A real reload starts from a fresh DOM; the lock screen must stay hidden.
$("lock-screen").classList.add("hidden");
window.initApp();
ok("reloading with no PIN goes to login, not the lock screen",
    hidden("lock-screen") === true && hidden("login-screen") === false,
    "lock=" + hidden("lock-screen") + " login=" + hidden("login-screen"));

// ------------------------------------------------------- profile name save
window.openProfile();
$("profile-name-input").value = "Sumit";
window.gmProfileNameDirty();
ok("editing the name reveals the Save button", hidden("profile-save-btn") === false);
window.saveDisplayName();
ok("saving the name says Name saved!", toastText() === "Name saved!", toastText());
ok("the Save button hides again after saving", hidden("profile-save-btn") === true);
ok("the header picked up the new name", $("my-name-display").innerText === "Sumit", $("my-name-display").innerText);
ok("the profile hero shows the name", $("profile-name-display").innerText === "Sumit", $("profile-name-display").innerText);
ok("the Ghost ID has a device-only note", /only on this device/i.test($("profile-screen").textContent));
ok("the profile has a premium call to action", !!doc.querySelector("#profile-screen .profile-premium-btn"));
window.closeProfile();

// ------------------------------------------------------- chats: online strip
window.updateOnlineUsers("Ghost-ON1", "Online One", true);
ok("the Chats tab lists an online user",
    doc.querySelectorAll("#online-strip-list .online-strip-item").length === 1,
    String(doc.querySelectorAll("#online-strip-list .online-strip-item").length));
ok("the no-one-online note hides", hidden("online-strip-empty") === true);
window.updateOnlineUsers("Ghost-ON1", "Online One", false);
ok("going offline empties the strip",
    doc.querySelectorAll("#online-strip-list .online-strip-item").length === 0 &&
    hidden("online-strip-empty") === false);

// ------------------------------------------------------- one empty card only
const chatList = $("chat-list-container");
const emptyClone = $("empty-state").cloneNode(true);
emptyClone.removeAttribute("id");
chatList.appendChild(emptyClone);
ok("two empty cards can exist before the guard", chatList.querySelectorAll(".empty-state").length === 2);
window.renderChatList();
ok("renderChatList keeps exactly one empty card", chatList.querySelectorAll(".empty-state").length === 1);

// ------------------------------------------------------- privacy policy
window.openPrivacyPolicy();
ok("the privacy policy opens", hidden("privacy-modal") === false);
ok("the policy says no account server and no cloud database",
    /no account server/i.test($("privacy-modal").textContent) && /Nothing\./.test($("privacy-modal").textContent));
window.closePrivacyPolicy();
ok("the privacy policy closes", hidden("privacy-modal") === true);

// ------------------------------------------------------- recovery phrase veil
ok("the recovery phrase starts hidden", $("phrase-backup-veil").classList.contains("revealed") === false);
window.gmTogglePhraseReveal();
ok("the eye reveals the phrase",
    $("phrase-backup-veil").classList.contains("revealed") === true &&
    $("phrase-backup-reveal-label").innerText === "Hide",
    $("phrase-backup-reveal-label").innerText);
window.gmTogglePhraseReveal();
ok("the eye hides it again",
    $("phrase-backup-veil").classList.contains("revealed") === false &&
    $("phrase-backup-reveal-label").innerText === "Reveal");
ok("the phrase screen carries the red warning",
    /steal your ID/i.test($("phrase-backup-modal").textContent));

// ------------------------------------------------------- skip recovery phrase
{
    window.GMIdentity.forget();
    let continued = false;
    window.gmEnsureIdentityThen(() => { continued = true; });
    ok("a brand-new identity shows the recovery phrase", hidden("phrase-setup-modal") === false);
    ok("the phrase step offers Skip for now",
        /Skip for now/.test($("phrase-setup-modal").textContent),
        $("phrase-setup-modal").textContent.slice(0, 80));
    window.gmSkipPhraseSetup();
    ok("skipping asks for confirmation first", hidden("gm-confirm") === false);
    window.gmConfirmResolve(true);
    ok("skipping closes the phrase flow and continues sign-in",
        continued === true && hidden("phrase-setup-modal") === true,
        "continued=" + continued + " modal=" + hidden("phrase-setup-modal"));
    ok("the Ghost ID still exists after skipping", window.GMIdentity.exists() === true);
}

// ------------------------------------------------------- safety filter
ok("threats are blocked", window.gmSafetyCheck("I will kill you").blocked === true);
ok("leetspeak is folded before matching", window.gmSafetyCheck("k1ll y0u").blocked === true);
ok("sexual solicitation is blocked", window.gmSafetyCheck("send nudes").blocked === true);
ok("ordinary chat passes the filter", window.gmSafetyCheck("see you at 5 near the station").blocked === false);

// ------------------------------------------------------- report & block
window.initChatData("Ghost-SAFE01");
window.openChat("Ghost-SAFE01");
window.reportCurrentPeer();
ok("reporting asks first", hidden("gm-confirm") === false && /Report abuse/.test($("gm-confirm-title").innerText));
window.gmConfirmResolve(true);
ok("reporting returns to the chat list", hidden("chat-screen") === true && hidden("chatlist-screen") === false);
ok("reporting blocks the sender", /blocked/.test(toastText()), toastText());
window.openBlockedList();
ok("the blocked list shows the reported Ghost", /Ghost-SAFE01/.test($("blocked-list").textContent), $("blocked-list").textContent);
window.unblockPeer("Ghost-SAFE01");
ok("unblocking removes the Ghost from the list", !/Ghost-SAFE01/.test($("blocked-list").textContent));
window.closeBlockedList();

// ------------------------------------------------------- live location opt-in
window.initChatData("Ghost-LOC01");
window.openChat("Ghost-LOC01");
window.shareLiveLocation();
ok("live location asks before anything is shared",
    hidden("gm-confirm") === false && /off by default/i.test($("gm-confirm-msg").innerText),
    $("gm-confirm-msg").innerText);
window.gmConfirmResolve(false);
ok("declining shares nothing", /Live location on/.test(toastText()) === false, toastText());
window.goBackToList();

// ------------------------------------------------------- battery saver
window.toggleLowBatteryMode();
ok("battery saver turns on", $("call-battery-btn").classList.contains("battery-on"));
window.toggleLowBatteryMode();
ok("battery saver turns off", $("call-battery-btn").classList.contains("battery-on") === false);

// ---------------------------------------------- call screen: dialer controls
// Six identical circles in one row was the "bahut sare button" complaint, so the
// row is the same short set a phone dialer shows and the extras moved behind ⋮.
{
    const ctrlRow = doc.querySelector(".call-bottom-controls");
    // Static markup reads through textContent in jsdom (no layout → no innerText).
    const labels = [...ctrlRow.querySelectorAll(".call-ctrl-label")].map(el => el.textContent.trim());
    ok("the call row is the short dialer set: Mute / Camera / End / Speaker / More",
        labels.join(",") === "Mute,Camera,End,Speaker,More", labels.join(","));
    ok("switch camera and the battery saver moved out of the row into More",
        !!$("call-camera-switch-btn") && !!$("call-battery-btn") &&
        !!$("call-camera-switch-btn").closest("#call-more-sheet") &&
        !!$("call-battery-btn").closest("#call-more-sheet") &&
        ctrlRow.querySelector("#call-camera-switch-btn") === null);
    window.gmToggleCallMore();
    ok("More opens the extra call options",
        hidden("call-more-sheet") === false && $("call-more-btn").getAttribute("aria-expanded") === "true");
    window.gmToggleCallMore(false);
    ok("More closes again",
        hidden("call-more-sheet") === true && $("call-more-btn").getAttribute("aria-expanded") === "false");
}

// ------------------------------------------- incoming call is a real ring screen
{
    window.initChatData("Ghost-RING1");
    // A callee whose camera is refused: exactly the case that used to answer
    // "Mic/Camera unavailable — call rejected" and drop the call.
    const mediaRequests = [];
    Object.defineProperty(window.navigator, "mediaDevices", {
        configurable: true,
        value: {
            getUserMedia: async constraints => {
                mediaRequests.push(JSON.stringify(constraints));
                if (constraints && constraints.video) {
                    const err = new Error("camera refused");
                    err.name = "NotAllowedError";
                    throw err;
                }
                return { getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] };
            }
        }
    });

    let answeredWith = null;
    const call = {
        peer: "Ghost-RING1", open: true, metadata: { type: "video" },
        on() {}, close() {}, answer(stream) { answeredWith = stream; }
    };
    window.handleIncomingCall(call);
    ok("an incoming call takes over the whole screen",
        hidden("call-screen") === false && hidden("incoming-call-overlay") === false);
    ok("the ring screen names the caller", $("incoming-peer-name").innerText === "Ghost-RING1", $("incoming-peer-name").innerText);
    ok("the ring screen says what kind of call it is",
        /Incoming video call/.test($("incoming-call-kind").innerText), $("incoming-call-kind").innerText);
    ok("the ring screen offers exactly Accept and Decline, with labels",
        doc.querySelectorAll(".incoming-actions .incoming-btn").length === 2 &&
        !!doc.querySelector(".incoming-accept") && !!doc.querySelector(".incoming-reject") &&
        doc.querySelectorAll(".incoming-action-label").length === 2);

    window.acceptIncomingCall();
    await new Promise(r => setTimeout(r, 40));
    ok("answering a video call still connects when the camera is refused",
        answeredWith !== null && hidden("call-screen") === false, JSON.stringify(mediaRequests));
    ok("the answer tried video first and then fell back to audio only",
        mediaRequests.length === 2 && /"video":true/.test(mediaRequests[0]) && !/"video"/.test(mediaRequests[1]),
        JSON.stringify(mediaRequests));
    ok("a voice-only answer hides the camera controls and says why",
        hidden("call-video-toggle-btn") === true && /voice only/i.test(toastText()), toastText());
    window.endCurrentCall();
    await new Promise(r => setTimeout(r, 20));
    ok("ending the call closes the call screen", hidden("call-screen") === true);
}

// --------------------------------------------- screen stays awake during calls
{
    ok("the call screen can hold a screen wake lock", typeof window.gmSetCallWakeLock === "function");
    let requested = 0, released = 0;
    Object.defineProperty(window.navigator, "wakeLock", {
        configurable: true,
        value: { request: async () => { requested++; return { release: async () => { released++; } }; } }
    });
    await window.gmSetCallWakeLock(true);
    ok("a call asks the platform for a screen wake lock", requested === 1, String(requested));
    await window.gmSetCallWakeLock(true);
    ok("asking again does not stack a second lock", requested === 1, String(requested));
    window.endCallFlow();
    await new Promise(r => setTimeout(r, 10));
    ok("ending the call releases the wake lock", released === 1, String(released));
    Object.defineProperty(window.navigator, "wakeLock", { configurable: true, value: undefined });
    await window.gmSetCallWakeLock(true);
    ok("a platform without the API is skipped quietly", true);
}

// ------------------------------------------ a call nobody answers times out
{
    window.initChatData("Ghost-RING3");
    window.GM_CALL_TIMEOUT_MS = 120;
    window.openCallUI("Ghost-RING3", "video", "Video Calling...");
    ok("the outgoing call screen is up before it is answered", hidden("call-screen") === false);
    await new Promise(r => setTimeout(r, 260));
    ok("an unanswered call ends itself instead of ringing forever",
        hidden("call-screen") === true && /No answer/.test(toastText()), toastText());
    delete window.GM_CALL_TIMEOUT_MS;
}

// --------------------------- placing a video call when the camera is refused
{
    window.initChatData("Ghost-RING2");
    window.gmPlaceOnlineCall("Ghost-RING2", "video");
    await new Promise(r => setTimeout(r, 40));
    ok("placing a video call without a camera asks before dropping to voice",
        hidden("gm-confirm") === false && $("gm-confirm-title").innerText === "Camera unavailable" &&
        /voice only/i.test($("gm-confirm-msg").innerText), $("gm-confirm-msg").innerText);
    let retried = null;
    const realInitiate = window.initiateP2PCall;
    window.initiateP2PCall = type => { retried = type; };
    window.gmConfirmResolve(true);
    ok("confirming the fallback re-runs the call as a voice call", retried === "voice", String(retried));
    window.initiateP2PCall = realInitiate;
    // Back to the no-camera-at-all state the rest of the suite boots with.
    Object.defineProperty(window.navigator, "mediaDevices", { value: undefined, configurable: true });
}

// ---------------------------------- answering with no camera/mic at all
// file:// and older WebViews have no getUserMedia. The ring screen used to stay
// up forever on that path, so the caller rang on with no answer and the callee
// was stuck looking at a call they could not join.
{
    window.initChatData("Ghost-RING4");
    let closed = false;
    const call = { peer: "Ghost-RING4", open: true, metadata: { type: "video" }, on() {}, close() { closed = true; }, answer() {} };
    window.handleIncomingCall(call);
    ok("the ring screen is up before answering", hidden("incoming-call-overlay") === false);
    window.acceptIncomingCall();
    await new Promise(r => setTimeout(r, 40));
    ok("answering with no camera/mic ends the call instead of hanging on the ring screen",
        hidden("call-screen") === true && closed === true, "closed=" + closed);
    ok("the ring screen is gone after a refused answer", hidden("incoming-call-overlay") === true);
}

// ------------------------------------------------------- self-destruct wipes
{
    window.initChatData("Ghost-DES01");
    window.openChat("Ghost-DES01");
    $("msg-input").value = "this should vanish";
    window.sendMessage();
    const bubbles = [...doc.querySelectorAll("#messages-container .card")];
    const lastBubble = bubbles[bubbles.length - 1];
    const msgId = lastBubble ? lastBubble.id : "";
    ok("the sent message has a bubble", !!msgId, msgId);
    window.scheduleDestruct(msgId, 0.05, "Ghost-DES01");
    await new Promise(r => setTimeout(r, 200));
    window.renderAllMessages("Ghost-DES01");
    ok("a self-destructed message is gone from the store, not just the DOM",
        doc.getElementById(msgId) === null, msgId);
    window.goBackToList();
}

// ------------------------------------------------------- PIN hardening
window.openAppLockSheet();
pinPress("1357");
await new Promise(r => setTimeout(r, 200));
pinPress("1357");
await new Promise(r => setTimeout(r, 200));
ok("a fresh PIN is saved hashed", window.gmAppLockHasPin() === true && window.gmPinIsHashed() === true);
ok("the stored value is not the four digits", window.gmPinMatches("1357") === true && window.gmPinMatches("0000") === false);
for (let i = 0; i < 5; i++) window.gmPinRegisterFail();
ok("five wrong tries lock the PIN pad", window.gmPinLockRemaining() > 0, String(window.gmPinLockRemaining()));
window.gmLockSession();
ok("the idle lock covers the app with the lock screen",
    hidden("lock-screen") === false && hidden("app-shell") === true);
window.gmPinResetFails();
// pinPress() drives the lock screen; the App Lock sheet has its own keypad
// (gmAppLockPress) and must not be used while the sheet is closed.
for (const d of "1357") window.pinPress(d);
await new Promise(r => setTimeout(r, 300));
// This session never stored a phone number, so a correct unlock lands on the
// name/phone form (a real signed-in device goes straight to the app shell).
ok("the right PIN unlocks the idle-locked app",
    hidden("lock-screen") === true && hidden("login-screen") === false,
    "lock=" + hidden("lock-screen") + " login=" + hidden("login-screen"));

// ------------------------------------- Bluetooth / Wi-Fi / Chats split
{
    // One phone found over BLE, one over Wi-Fi Direct — the native layer pushes
    // both into the same table with a `transport` tag.
    window.gmApplyNativePeers([
        { ghostId: "Ghost-BT1", name: "BT Phone", transport: "ble", address: "AA:BB:CC" },
        { ghostId: "Ghost-WF1", name: "WiFi Phone", transport: "wifi-direct", address: "wf-1" }
    ]);
    const btText = $("bt-peer-list").textContent;
    const wifiText = $("wifi-peer-list").textContent;
    ok("the Bluetooth panel lists only BLE phones",
        /Ghost-BT1/.test(btText) && !/Ghost-WF1/.test(btText), btText);
    ok("the WiFi panel lists only Wi-Fi Direct phones",
        /Ghost-WF1/.test(wifiText) && !/Ghost-BT1/.test(wifiText), wifiText);
    ok("each transport panel counts its own phones",
        Number($("bt-peer-count").innerText) === 1 && Number($("wifi-peer-count").innerText) === 1,
        $("bt-peer-count").innerText + "/" + $("wifi-peer-count").innerText);
    ok("the Chats strip shows peers from every transport",
        /BT Phone/.test($("online-strip-list").textContent) &&
        /WiFi Phone/.test($("online-strip-list").textContent),
        $("online-strip-list").textContent);

    // Tapping Connect on a Bluetooth phone must not fire a Wi-Fi Direct join at
    // a BLE address; it explains the link and opens the route that works.
    const nativeCalls = [];
    window.GhostNative = { connect: address => nativeCalls.push(address), startDiscovery() {}, stopDiscovery() {} };
    window.gmConnectNativePeer("Ghost-BT1");
    ok("connecting to a Bluetooth phone explains how the chat link opens",
        hidden("gm-confirm") === false && /Chat over Bluetooth/.test($("gm-confirm-title").innerText),
        $("gm-confirm-title").innerText);
    // The QR handshake itself needs a real WebRTC stack (jsdom has none), so the
    // wiring is checked instead: the confirm must land on the WiFi tab and ask
    // for the host QR, and must never touch the native Wi-Fi Direct join.
    let hostQrAsked = 0;
    const realStartOfflineHost = window.startOfflineHost;
    window.startOfflineHost = () => { hostQrAsked++; };
    window.gmConfirmResolve(true);
    ok("accepting it never hands a BLE address to the Wi-Fi Direct join",
        nativeCalls.length === 0, JSON.stringify(nativeCalls));
    ok("accepting it opens the QR handshake on the WiFi tab",
        hostQrAsked === 1 && $("main-tabs-scroller").dataset.activeTab === "1",
        "qrAsked=" + hostQrAsked + " tab=" + $("main-tabs-scroller").dataset.activeTab);
    window.startOfflineHost = realStartOfflineHost;
    window.closeOfflineConnect();
    window.gmConnectNativePeer("Ghost-WF1");
    ok("connecting to a Wi-Fi Direct phone goes straight to the native join",
        hidden("gm-confirm") === true && nativeCalls.length === 1 && nativeCalls[0] === "wf-1",
        JSON.stringify(nativeCalls));
    delete window.GhostNative;

    window.gmNavGo("bluetooth");
    ok("the Bluetooth destination selects the third panel",
        $("main-tabs-scroller").dataset.activeTab === "2",
        String($("main-tabs-scroller").dataset.activeTab));
    ok("the Bluetooth destination highlights its nav item",
        doc.querySelector('.gm-nav-item[data-nav="bluetooth"]').classList.contains("active"));
    ok("the Bluetooth panel explains what it does",
        /Bluetooth finds the other phone/.test($("main-tab-panel-2").textContent));
    ok("Bluetooth discovery says it needs the Android app on the web",
        /Android app/.test($("bt-status-line").innerText), $("bt-status-line").innerText);
    window.gmSetBluetoothScan(false);
    ok("turning Bluetooth discovery off is safe without the native layer",
        hidden("main-tab-panel-2") === false);
    window.gmApplyNativePeers([]);          // clear the fake table again
    ok("the transport lists empty out with no phones",
        !/Ghost-BT1|Ghost-WF1/.test($("bt-peer-list").textContent + $("wifi-peer-list").textContent) &&
        Number($("bt-peer-count").innerText) === 0);
}

// ------------------------------------------------------- full-screen map
{
    await window.openLiveMap();
    ok("the Map destination opens the map screen", hidden("map-screen") === false);
    ok("the Map destination highlights its nav item",
        doc.querySelector('.gm-nav-item[data-nav="map"]').classList.contains("active"));
    ok("the map screen carries its own controls",
        !!$("live-radar-map") && !!$("map-status-line") && !!$("map-my-coords") && !!$("map-peer-count"));
    // jsdom has no layout, so static markup reads through textContent while a
    // value the app wrote itself reads through innerText.
    ok("the map reads no location until asked",
        $("map-my-coords").textContent === "—" && $("map-status-line").innerText.trim() !== "",
        $("map-my-coords").textContent);
    // The chrome used to be absolutely positioned over the map with a lingering
    // transform on the screen; it could be panned/painted away. It is a flow
    // layout now, and the long note is opt-in behind ⓘ so the map stays whole.
    ok("the map bar and the map itself are separate blocks (no overlay on the map)",
        $("live-radar-map").closest(".live-map-wrap") !== null &&
        !$("live-radar-map").closest(".live-map-wrap").contains(doc.querySelector(".live-map-top")) &&
        !$("live-radar-map").closest(".live-map-wrap").contains(doc.querySelector(".live-map-panel")));
    ok("the long privacy note is hidden until asked for", hidden("map-info-note") === true);
    window.gmToggleMapInfo();
    ok("the ⓘ button reveals the note",
        hidden("map-info-note") === false && $("map-info-btn").getAttribute("aria-expanded") === "true");
    window.gmToggleMapInfo(false);
    ok("the note hides again", hidden("map-info-note") === true);
    ok("the map stats and actions stay visible (nothing auto-hides)",
        !doc.querySelector(".live-map-panel").classList.contains("hidden") &&
        doc.querySelectorAll(".live-map-stats .live-map-row").length === 2 &&
        doc.querySelectorAll(".live-map-actions .credits-earn-btn").length === 2);
    window.closeLiveMap();
    ok("closing the map returns to the chats",
        hidden("chatlist-screen") === false && hidden("map-screen") === true);
}

// ------------------------------------------------ editable phone number
{
    window.openProfile();
    $("profile-phone-input").value = "9876543210";
    window.gmProfilePhoneDirty();
    ok("editing the phone reveals its own Save button", hidden("profile-phone-save-btn") === false);
    window.saveProfilePhone();
    ok("saving the phone number says so", toastText() === "Phone number saved!", toastText());
    ok("the phone Save button hides again", hidden("profile-phone-save-btn") === true);
    window.updateProfileScreen();
    ok("the saved phone shows up in the profile field",
        $("profile-phone-input").value === "9876543210", $("profile-phone-input").value);
    $("profile-phone-input").value = "123";
    window.saveProfilePhone();
    ok("an incomplete phone number is rejected",
        toastText() === "That phone number looks incomplete", toastText());
    $("profile-phone-input").value = "9876543210";
    window.saveProfilePhone();
    window.closeProfile();
}

// ------------------------------------------- sponsor break (+2 credits)
{
    // A duration long enough that "claiming early" is still early when the test
    // reaches it, but short enough that the suite does not sit through 15s.
    window.GM_AD_DURATION_MS = 400;
    const before = window.getCredits();
    window.gmOpenSponsoredBreak("earn");
    ok("the Earn Credits menu entry opens the sponsor break", hidden("gm-ad-screen") === false);
    ok("the advertiser slot is filled", $("gm-ad-slot").innerHTML.trim() !== "");
    ok("the rewarded break names the 2-credit reward",
        /\+2 credits/.test($("gm-ad-title").innerText), $("gm-ad-title").innerText);
    ok("the claim waits for the view to finish", hidden("gm-ad-claim") === true);
    window.gmClaimSponsoredCredits();
    ok("claiming early pays nothing",
        window.getCredits() === before && /full sponsor break/.test(toastText()), toastText());
    await new Promise(r => setTimeout(r, 900));
    ok("the claim appears once the view finishes", hidden("gm-ad-claim") === false);
    window.gmClaimSponsoredCredits();
    ok("watching a sponsor adds 2 credits", window.getCredits() === before + 2, "credits=" + window.getCredits());
    ok("the break closes after claiming", hidden("gm-ad-screen") === true);
    ok("one sponsor view is counted for today", window.gmAdViewsLeft() === 9, String(window.gmAdViewsLeft()));

    // The daily cap keeps the credit economy finite. jsdom refuses
    // window.localStorage on a file:// origin, so the count comes in through the
    // app's own reader instead of a raw storage key.
    const realViewsToday = window.gmAdViewsToday;
    window.gmAdViewsToday = () => 10;
    window.gmOpenSponsoredBreak("earn");
    ok("the daily sponsor limit is enforced",
        hidden("gm-ad-screen") === true && /Daily sponsor limit/.test(toastText()), toastText());
    window.gmAdViewsToday = realViewsToday;
    ok("the limit leaves the credit balance untouched", window.getCredits() === before + 2);
}

// ----------------------------------- theme change is the only automatic ad
{
    window.GM_AD_DURATION_MS = 300;
    window.applyTheme("forest", true);
    ok("changing the theme shows the sponsor break", hidden("gm-ad-screen") === false);
    ok("the theme break offers no credits", hidden("gm-ad-claim") === true);
    await new Promise(r => setTimeout(r, 800));
    ok("the theme break finishes with Continue", hidden("gm-ad-continue") === false);
    window.gmCloseSponsoredBreak();
    ok("the theme break closes", hidden("gm-ad-screen") === true);
    window.applyTheme("forest");
    ok("restoring the theme (boot / fallback) shows no break", hidden("gm-ad-screen") === true);
    delete window.GM_AD_DURATION_MS;
    window.applyTheme("default");
}

// ------------------------------------------- profile photo adjuster
{
    const photo = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'></svg>";
    window.gmDpCropOpen(photo);
    ok("picking a photo opens the adjuster instead of saving it straight away",
        hidden("dp-crop-modal") === false);
    ok("the adjuster has a zoom control and a round preview",
        !!$("dp-crop-zoom") && !!$("dp-crop-viewport") && !!$("dp-crop-image"));
    ok("the adjusting step runs before the photo is stored",
        toastText() !== "Profile photo updated!", toastText());
    window.gmDpCropZoom(2.5);
    ok("zooming the photo does not throw", true);
    window.gmDpCropApply();
    await new Promise(r => setTimeout(r, 60));
    ok("using the photo saves it and says so",
        toastText() === "Profile photo updated!" && hidden("dp-crop-modal") === true, toastText());
    ok("the saved photo is the profile picture",
        /data:image/.test($("profile-avatar-big").innerHTML));
    window.gmDpCropOpen(photo);
    window.gmDpCropCancel();
    ok("cancelling the adjuster keeps the old photo and closes",
        hidden("dp-crop-modal") === true && /data:image/.test($("profile-avatar-big").innerHTML));
}

// ------------------------------------------------- account privacy (requests)
// Private is the default: a stranger with your Ghost ID sends a request you
// accept. Public opens the chat straight away. Either way a blocked Ghost is
// rejected before this gate. This block runs last on purpose: accepting a
// connection adds a peer to the reach lists, so the list checks above must have
// already run.
{
    ok("the privacy row says Private out of the box", $("privacy-mode-state").innerText === "Private", $("privacy-mode-state").innerText);
    window.openPrivacyModeSheet();
    ok("the privacy chooser opens with both modes",
        hidden("privacy-mode-sheet") === false && !!$("privacy-opt-private") && !!$("privacy-opt-public"));
    ok("the current mode is highlighted", $("privacy-opt-private").classList.contains("selected"));

    // Private: the request dialog appears and nothing is auto-approved.
    const sent = [];
    const fakeConn = peer => ({ peer, open: true, send(m) { sent.push({ peer, m }); }, close() {} });
    window.handleIncomingRequest(fakeConn("Ghost-REQ1"));
    ok("a private account asks before connecting",
        hidden("request-modal") === false && /Ghost-REQ1 wants to connect/.test($("request-modal-text").innerText),
        $("request-modal-text").innerText);
    ok("a private account sends no approval until Accept", sent.length === 0, JSON.stringify(sent));
    window.rejectConnectionRequest();
    ok("declining closes the request dialog", hidden("request-modal") === true);

    // Public: same request, no dialog, approved immediately.
    window.gmPickPrivacyMode("public");
    ok("switching to public updates the settings row", $("privacy-mode-state").innerText === "Public", $("privacy-mode-state").innerText);
    window.handleIncomingRequest(fakeConn("Ghost-REQ2"));
    ok("a public account opens the chat without asking", hidden("request-modal") === true);
    ok("a public account approves the connection right away",
        sent.some(s => s.peer === "Ghost-REQ2" && s.m.type === "handshake-status" && s.m.approved === true),
        JSON.stringify(sent));
    window.gmPickPrivacyMode("private");
    ok("switching back to private is possible at any time", $("privacy-mode-state").innerText === "Private");
    window.closePrivacyModeSheet();
    ok("the privacy chooser closes", hidden("privacy-mode-sheet") === true);
    // Accept must still work when the button calls it with no argument at all.
    window.handleIncomingRequest(fakeConn("Ghost-REQ3"));
    window.acceptConnectionRequest();
    ok("the Accept button still approves the connection",
        sent.some(s => s.peer === "Ghost-REQ3" && s.m.approved === true), JSON.stringify(sent));
    ok("accepting closes the request dialog", hidden("request-modal") === true);
}

// ---------------------------------------------- nothing logged an error
// The boot check above only covers first paint; this one covers every flow the
// suite walked — the map, the radios, the sponsor break and the photo adjuster
// included. A flow that copies the old failure mode (a swallowed exception
// inside a try/catch, say) shows up here instead of only on a phone.
//
// One scanner test deliberately feeds a malformed pasted code; the offline
// handshake catches it, logs it and toasts "Invalid code". That is the only
// expected noise, and the count is pinned exactly, so any *new* error — in any
// flow — still fails this check.
const EXPECTED_DELIBERATE_QR_LOGS = 1;
ok("no console.error during the whole run apart from the deliberate bad QR payloads",
    (window.__consoleErrors || []).length === EXPECTED_DELIBERATE_QR_LOGS,
    "got " + (window.__consoleErrors || []).length + ": " + (window.__consoleErrors || []).join(" | "));

// ---------------------------------------------------------------- report
let failed = 0;
for (const r of results) {
    if (!r.pass) failed++;
    console.log((r.pass ? "PASS  " : "FAIL  ") + r.name + (r.pass || !r.extra ? "" : "   -> " + r.extra));
}
console.log(`\n${results.length - failed}/${results.length} runtime checks passed`);
process.exit(failed ? 1 : 0);
