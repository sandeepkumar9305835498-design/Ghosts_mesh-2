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
    "gmSubmitPasteCode", "scanQrFromImage", "gmHandleQrImage", "startCameraScan"]) {
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
ok("daily bonus adds 5 credits", afterBonus === creditsAfterLogin + 5, "credits=" + afterBonus);
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
ok("settings lists all nine options", settingsRows.length === 9, String(settingsRows.length));
const settingsText = $("settings-sheet").textContent;
for (const label of ["My Profile", "Ghost Assistant (Recover ID)", "Chat Themes", "App Lock", "Clear All Chats",
    "Send Feedback", "Claim Daily Bonus", "Refer a Ghost", "Logout"]) {
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
ok("the pill nav is Chats / WiFi / Online / Settings, in that order",
    navKeys.join(",") === "chats,wifi,online,settings", navKeys.join(","));
ok("Connect is not a pill nav destination any more", !navKeys.includes("connect"));
ok("Profile is no longer a pill nav destination", !navKeys.includes("profile"));
ok("every pill nav item is wired to gmNavGo with its own key",
    navItems.every(b => b.getAttribute("onclick") === "gmNavGo('" + b.getAttribute("data-nav") + "')"));
// The top tab bar did the same job as the pill nav, so it was removed. The two
// panels and the swipe gesture stay; the scroller carries the active state.
ok("the redundant top tab bar is gone",
    doc.querySelectorAll(".main-tab-btn").length === 0 && doc.querySelector(".main-tabs-bar") === null,
    String(doc.querySelectorAll(".main-tab-btn").length));
ok("both panels still exist behind the pill nav",
    !!$("main-tabs-scroller") && !!$("main-tab-panel-0") && !!$("main-tab-panel-1"));

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

// The Online screen is its own destination (the nav slot Profile used to hold),
// reached from the pill nav and from the header menu's "Nearby Ghosts".
window.openProfile();
window.openOnlineUsers();
ok("Nearby Ghosts opens the Online screen",
    hidden("online-screen") === false && hidden("profile-screen") === true);
ok("the Online screen highlights its nav item",
    doc.querySelector('.gm-nav-item[data-nav="online"]').classList.contains("active"));
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

// The radar map used to be built at login, which fetched OpenStreetMap tiles
// for a map nobody had opened (bandwidth, battery, and an IP/area leak).
ok("the radar map is not built until it is opened",
    doc.querySelectorAll('script[src="leaflet.js"]').length === 0 && hidden("map-container") === true);

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

// ---------------------------------------------------------------- report
let failed = 0;
for (const r of results) {
    if (!r.pass) failed++;
    console.log((r.pass ? "PASS  " : "FAIL  ") + r.name + (r.pass || !r.extra ? "" : "   -> " + r.extra));
}
console.log(`\n${results.length - failed}/${results.length} runtime checks passed`);
process.exit(failed ? 1 : 0);
