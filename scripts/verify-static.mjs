#!/usr/bin/env node
// ===== GHOST MESH — STATIC CHECKS =====
// This project has no build step: index.html, style.css and a handful of plain
// scripts are the whole app (plus the Android WebView shell that copies the
// same files into assets/www). That means a typo in a handler name or an id
// reaches the user's phone with nothing in between, so the checks that matter
// are the cross-file ones:
//
//   1. every local asset referenced by index.html actually exists
//   2. every .js file parses
//   3. every inline handler in index.html resolves to a real function
//   4. every getElementById() has a matching element
//   5. every class the JS toggles exists in style.css
//   6. the CSS itself is balanced
//   7. the bottom pill nav's cross-file wiring lines up
//   8. the muted text colour clears WCAG AA on every surface it can sit on
//
// Dependency-free on purpose: `node scripts/verify-static.mjs` is the whole
// contract, so it runs identically on a laptop and in CI.
//
// Exit code 0 = everything passed, 1 = at least one check failed.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = p => fs.existsSync(path.join(ROOT, p));

const results = [];
/** Records one check. `problems` is an array of human-readable failures. */
function check(name, problems) {
    results.push({ name, problems: problems || [] });
}

// ---------------------------------------------------------------- 1. assets
const REQUIRED = [
    "index.html",
    "style.css",
    "script.js",
    "service-worker.js",
    "manifest.json",
    "gm-identity.js",
    "bip39-wordlist.js",
    "icon-192.png",
    "icon-512.png"
];
check("required app files are present", REQUIRED.filter(f => !exists(f)).map(f => "missing " + f));

const html = read("index.html");
const localRefs = new Set();
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1];
    if (/^(https?:|data:|mailto:|#|\/\/)/.test(ref)) continue;   // external / inline
    localRefs.add(ref.replace(/^\.\//, "").split("?")[0]);
}
// The heavy vendor libraries are lazy-loaded (see gmEnsureLib in script.js), so
// they are no longer <script> tags in index.html — but they still ship, so they
// have to stay in the syntax check and on disk.
const scriptSource = read("script.js");
const lazyBlock = (scriptSource.match(/const gmLibSrc = \{([\s\S]*?)\};/) || [null, ""])[1];
const lazyPairs = [...lazyBlock.matchAll(/(\w+):\s*"([^"]+\.js)"/g)].map(m => ({ key: m[1], file: m[2] }));
const lazyLibs = lazyPairs.map(p => p.file);

const jsFiles = [...new Set([
    ...[...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1].replace(/^\.\//, "")),
    ...lazyLibs,
    "script.js", "gm-identity.js", "bip39-wordlist.js", "service-worker.js"
])].filter(f => f.endsWith(".js"));
check("every local asset referenced by index.html exists",
    [...localRefs].filter(r => r.endsWith(".js") ? false : !exists(r)));
check("every script tag points at a file that exists",
    jsFiles.filter(f => !exists(f)));

// ---------------------------------------------------------------- 2. syntax
const syntaxFailures = [];
for (const f of jsFiles) {
    try {
        execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" });
    } catch (e) {
        syntaxFailures.push(f + ": " + String(e.stderr || e.message).split("\n").slice(0, 2).join(" ").trim());
    }
}
check("every JavaScript file parses (" + jsFiles.length + " files)", syntaxFailures);

// ---------------------------------------------------------------- 3. handlers
const js = jsFiles.map(f => read(f)).join("\n");
const css = read("style.css");

const builtins = new Set(["event", "this", "window", "console", "alert", "confirm", "prompt", "return",
    "if", "for", "while", "switch", "typeof", "new", "Math", "JSON", "String", "Number", "Array", "Object",
    "Boolean", "Date", "RegExp", "Promise", "parseInt", "parseFloat", "isNaN", "setTimeout", "setInterval",
    "clearTimeout", "clearInterval", "encodeURIComponent", "decodeURIComponent", "void", "delete"]);
const defined = new Set([...js.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
for (const m of js.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) defined.add(m[1]);
for (const m of js.matchAll(/(?:window\.|globalThis\.)([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);

const unknownHandlers = new Set();
const handlerAttrs = [...html.matchAll(/\son[a-z]+\s*=\s*"([^"]*)"/g)].map(m => m[1]);
for (const body of handlerAttrs) {
    // Blank out string literals so `onclick="showToast('hi')"` still counts.
    const code = body.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
        const fn = m[1];
        // Skip method calls (event.stopPropagation()) and anything defined.
        if (m.index > 0 && /[.\w$]/.test(code[m.index - 1])) continue;
        if (builtins.has(fn) || defined.has(fn)) continue;
        unknownHandlers.add(fn);
    }
}
check("every inline handler in index.html resolves to a function (" + handlerAttrs.length + " handlers)",
    [...unknownHandlers]);

// ---------------------------------------------------------------- 4. ids
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const jsIds = new Set([...js.matchAll(/id="([^"]+)"/g)].map(m => m[1]));       // built via innerHTML
const queried = new Set([...js.matchAll(/getElementById\("([^"]+)"\)/g)].map(m => m[1]));
check("every getElementById() has a matching element (" + queried.size + " ids)",
    [...queried].filter(id => !htmlIds.has(id) && !jsIds.has(id)));

// A duplicated id silently breaks getElementById (the browser always returns
// the first match), so a modal block pasted twice would half-work at runtime.
const allHtmlIds = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
const duplicateIds = [...new Set(allHtmlIds.filter((id, i) => allHtmlIds.indexOf(id) !== i))];
check("no duplicate element ids in index.html (" + allHtmlIds.length + " ids)", duplicateIds);

// ---------------------------------------------------------------- 5. classes
const cssClasses = new Set([...css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map(m => m[1]));
const toggled = new Set([...js.matchAll(/classList\.(?:add|remove|toggle|contains)\(\s*"([^"]+)"/g)].map(m => m[1]));
// `hidden`/`active`/`open`/`show` are shared state classes, and a name ending in
// "-" is built at runtime ("theme-" + name), so neither can be looked up here.
const stateClasses = new Set(["hidden", "active", "open", "show"]);
check("every class the JS toggles exists in style.css (" + toggled.size + " classes)",
    [...toggled].filter(c => !cssClasses.has(c) && !stateClasses.has(c) && !c.endsWith("-")));

// ---------------------------------------------------------------- 6. css shape
let depth = 0, line = 1, firstNegative = null;
for (const ch of css) {
    if (ch === "\n") line++;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth < 0 && firstNegative === null) firstNegative = line; }
}
const cssProblems = [];
if (depth !== 0) cssProblems.push("unbalanced braces (depth " + depth + " at EOF)");
if (firstNegative !== null) cssProblems.push("stray } on line " + firstNegative);
const commentsOpen = (css.match(/\/\*/g) || []).length;
const commentsClose = (css.match(/\*\//g) || []).length;
if (commentsOpen !== commentsClose) cssProblems.push("unbalanced comments (" + commentsOpen + " open, " + commentsClose + " close)");
check("style.css is balanced", cssProblems);

// ------------------------------------------------------- 7. polish wiring
// The top tab bar and the bottom pill nav share their state through
// setActiveMainTab()/showScreen(), so the pieces have to keep matching up.
const polishProblems = [];
const navBlock = (html.match(/<nav id="gm-bottom-nav"[\s\S]*?<\/nav>/) || [""])[0];
const navKeys = [...navBlock.matchAll(/data-nav="([a-z]+)"/g)].map(m => m[1]);
if (navKeys.length !== 4) polishProblems.push("expected 4 pill nav items, found " + navKeys.length);
if (!/id="gm-bottom-nav" class="gm-nav hidden"/.test(html)) polishProblems.push("pill nav is not hidden by default");
for (const k of navKeys) {
    if (!navBlock.includes("gmNavGo('" + k + "')")) polishProblems.push("nav item '" + k + "' is not wired to gmNavGo");
    if (!defined.has("gmNavGo")) polishProblems.push("gmNavGo is not defined");
}
if (navKeys.join(",") !== "chats,wifi,online,settings") polishProblems.push("pill nav is not Chats/WiFi/Online/Settings (" + navKeys.join(",") + ")");
if (navKeys.includes("profile")) polishProblems.push("Profile is back as a pill nav destination");
// The reachable-ghosts list has one home: the Online screen.
if (/id="wifi-reach-list"|id="wifi-reach-count"/.test(html)) polishProblems.push("the reach list is still inside the WiFi panel");
for (const id of ["online-screen", "online-reach-list", "online-reach-count"]) {
    if (!htmlIds.has(id)) polishProblems.push("missing " + id);
}
if (!htmlIds.has("gm-nav-pill")) polishProblems.push("highlight capsule element is missing");
for (const fn of ["gmNavGo", "gmSyncBottomNav", "gmSetBottomNavActive", "gmMoveNavPill"]) {
    if (!defined.has(fn)) polishProblems.push(fn + "() is missing");
}
// gmSyncBottomNav must gate the nav to the screens that should show it.
if (!/GM_NAV_SCREENS\s*=\s*\{[^}]*"chatlist-screen"\s*:\s*true[^}]*"online-screen"\s*:\s*true/.test(js)) {
    polishProblems.push("GM_NAV_SCREENS does not cover chatlist-screen + online-screen");
}
// Scroll snapping must stay off: a browser snap point is what made a fast flick
// skip every panel and land on the last one.
if (/scroll-snap-type\s*:/.test(css)) polishProblems.push("scroll-snap-type is set again on the tab scroller");
if (!/--gm-nav-h/.test(css)) polishProblems.push("--gm-nav-h is not defined");
for (const screen of ["#chatlist-screen", "#profile-screen"]) {
    const rule = new RegExp("\\" + screen + "[^{]*\\{[^}]*--gm-nav-h");
    if (!rule.test(css.replace(/\n/g, " ")) && !css.includes(screen)) polishProblems.push(screen + " has no reserved nav space");
}
if (!css.includes("prefers-reduced-motion: reduce")) polishProblems.push("no reduced-motion block");
if (!css.includes(".gm-screen-push") || !css.includes(".gm-screen-fade")) polishProblems.push("screen transition classes are missing");
// The pill nav is the single switcher now: the top tab bar that duplicated it
// must not come back, the two panels have to survive, and the scroller has to
// keep the active-panel state the nav/swipe/tests all read.
if (/class="main-tab-btn/.test(html)) polishProblems.push("the redundant top tab bar is back in index.html");
if (/main-tab-btn|main-tab-indicator|main-tabs-bar/.test(css)) polishProblems.push("dead top-tab-bar CSS is still in style.css");
for (const id of ["main-tabs-scroller", "main-tab-panel-0", "main-tab-panel-1"]) {
    if (!htmlIds.has(id)) polishProblems.push("missing " + id);
}
if (!/dataset\.activeTab\s*=/.test(js)) polishProblems.push("setActiveMainTab does not record the active panel");
check("bottom pill nav + transitions are wired across files", polishProblems);

// ----------------------------------- 8. settings sheet owns the moved features
// Profile, Ghost Assistant, Chat Themes, Clear All Chats, Send Feedback and
// Logout left the header 3-dot menu and moved into the Settings sheet, whose
// header shows the avatar + name + Ghost ID of the signed-in user.
const settingsProblems = [];
const menuStart = html.indexOf('id="main-menu"');
const menuEnd = html.indexOf("</header>", menuStart);
const menuHtml = menuStart >= 0 && menuEnd > menuStart ? html.slice(menuStart, menuEnd) : "";
const sheetStart = html.indexOf('id="settings-sheet"');
const sheetEnd = html.indexOf('id="gm-confirm"', sheetStart);
const sheetHtml = sheetStart >= 0 && sheetEnd > sheetStart ? html.slice(sheetStart, sheetEnd) : "";
if (!menuHtml) settingsProblems.push("could not locate the header 3-dot menu");
if (!sheetHtml) settingsProblems.push("could not locate the settings sheet");
const movedFeatures = [
    { label: "Profile", menu: "openProfile(", settings: "gmOpenProfileFromSettings(" },
    { label: "Ghost Assistant", menu: "gmOpenGhostAssistant(", settings: "gmOpenGhostAssistant(" },
    { label: "Chat Themes", menu: "openThemePicker(", settings: "gmOpenThemeFromSettings(" },
    { label: "Clear All Chats", menu: "clearAllChats(", settings: "clearAllChats(" },
    { label: "Send Feedback", menu: "openFeedbackModal(", settings: "openFeedbackModal(" },
    { label: "Logout", menu: "logoutApp(", settings: "logoutApp(" }
];
for (const f of movedFeatures) {
    if (menuHtml.includes(f.menu)) settingsProblems.push(f.label + " is back in the header 3-dot menu");
    if (!sheetHtml.includes(f.settings)) settingsProblems.push(f.label + " is missing from the Settings sheet");
}
for (const id of ["settings-avatar", "settings-head-name", "settings-head-id"]) {
    if (!htmlIds.has(id)) settingsProblems.push("settings header is missing #" + id);
}
const settingsRowCount = (sheetHtml.match(/class="settings-row/g) || []).length;
if (settingsRowCount < 9) settingsProblems.push("expected at least 9 settings rows, found " + settingsRowCount);
for (const id of ["profile-name-display", "profile-stat-chats", "profile-stat-credits", "profile-stat-connections"]) {
    if (!htmlIds.has(id)) settingsProblems.push("profile screen is missing #" + id);
}
check("settings sheet owns the six moved features + identity header", settingsProblems);

// ---------------------------------------------------------------- 9. contrast
// --text3 carries the 9-11px labels (timestamps, hints, phrase notes), so it has
// to clear WCAG AA (4.5:1) on every surface a label can land on, not just the
// darkest one. It was #6b5e8a = 3.35:1 on --bg before this was checked.
function hexToRgb(hex) {
    const m = String(hex || "").trim().match(/^#([0-9a-f]{6})$/i);
    if (!m) return null;
    return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
}
function relLuminance(rgb) {
    const [r, g, b] = rgb.map(v => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(a, b) {
    const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}
const rootBlock = (css.match(/:root\s*\{([\s\S]*?)\}/) || [null, ""])[1];
const rootVars = {};
for (const m of rootBlock.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) rootVars[m[1]] = m[2].split("/*")[0].trim();
const contrastProblems = [];
const text3 = hexToRgb(rootVars["text3"]);
if (!text3) contrastProblems.push("--text3 is not a plain hex colour (" + rootVars["text3"] + ")");
else {
    for (const surface of ["bg", "bg2", "surface", "surface2"]) {
        const rgb = hexToRgb(rootVars[surface]);
        if (!rgb) continue;
        const ratio = contrastRatio(text3, rgb);
        if (ratio < 4.5) contrastProblems.push("--text3 on --" + surface + " is " + ratio.toFixed(2) + ":1 (needs 4.5:1)");
    }
}
check("--text3 clears WCAG AA on every surface", contrastProblems);

// ------------------------------------------------ 10. lazy libs + status bar
// ~1 MB of vendor JavaScript used to be parsed before first paint on every
// launch. It is loaded on demand now, so the tags must stay out of index.html,
// every lazy file must still exist, and each theme's status-bar colour must
// match the --accent that theme actually paints with.
const lazyProblems = [];
if (lazyLibs.length !== 4) lazyProblems.push("expected 4 lazy libraries in gmLibSrc, found " + lazyLibs.length);
for (const { key, file } of lazyPairs) {
    if (!exists(file)) lazyProblems.push("lazy library is missing from disk: " + file);
    if (html.includes('src="' + file + '"')) lazyProblems.push(file + " is still loaded eagerly in index.html");
    if (!new RegExp("gmEnsureLib\\(\\s*\"" + key + "\"").test(scriptSource)) {
        lazyProblems.push(file + " has no gmEnsureLib(\"" + key + "\") call site");
    }
}
// The one library that is warmed in the background is the scanner — the only
// lazy lib a core flow depends on.
if (!/gmEnsureLib\("jsqr"\)/.test(scriptSource)) lazyProblems.push("jsQR is not pre-warmed after boot");
// The radar map must not be built at startup (it used to fetch OSM tiles for a
// hidden map on every login).
if (/\n\s*initMesh\(\);\s*\n\s*initRadarMap\(\);/.test(scriptSource)) {
    lazyProblems.push("initRadarMap() still runs at startup");
}
check("heavy vendor libraries are lazy-loaded (" + lazyLibs.join(", ") + ")", lazyProblems);

// Status-bar / theme-color coordination: each theme swatch in `themes` (used
// for the meta tag) must equal that theme's CSS --accent.
function cssVar(block, name) {
    const m = block.match(new RegExp("--" + name + "\\s*:\\s*([^;]+);"));
    return m ? m[1].split("/*")[0].trim() : null;
}
const rootAccent = cssVar((css.match(/:root\s*\{([\s\S]*?)\}/) || [null, ""])[1], "accent");
const themeAccents = {};
for (const m of css.matchAll(/body\.(theme-[\w-]+)\s*\{([\s\S]*?)\}/g)) {
    themeAccents[m[1]] = cssVar(m[2], "accent") || rootAccent;
}
const themeProblems = [];
const themeRows = [...scriptSource.matchAll(/\{\s*id:\s*"([\w-]+)",\s*name:\s*"[^"]*",\s*bg:\s*"([^"]+)"\s*\}/g)];
if (themeRows.length < 6) themeProblems.push("expected at least 6 themes, found " + themeRows.length);
for (const [, id, bg] of themeRows) {
    if (!/^#[0-9a-fA-F]{6}$/.test(bg)) continue;             // swatch is a gradient (fish) — skipped
    const cssAccent = id === "default" ? rootAccent : themeAccents["theme-" + id];
    if (!cssAccent) themeProblems.push("no CSS --accent for theme '" + id + "'");
    else if (cssAccent.toLowerCase() !== bg.toLowerCase()) {
        themeProblems.push("theme '" + id + "': status-bar colour " + bg + " does not match --accent " + cssAccent);
    }
}
check("theme colours match the CSS accents (" + themeRows.length + " themes)", themeProblems);

// --------------------------------------- 11. app lock lives in Settings
// The optional "App Lock PIN" field used to sit on the signup screen and
// verifyAndLogin() wrote the PIN. It now lives entirely in Settings: signup
// asks only for a name (+ optional phone), and the App Lock sheet sets,
// changes or removes the 4-digit PIN using the lock screen's own storage keys
// (gm_pin + gm_pin_length), so an existing PIN keeps working.
const appLockProblems = [];
if (/id="set-pin-input"/.test(html)) appLockProblems.push("the signup form still asks for a PIN");
if (!/id="app-lock-modal"/.test(html)) appLockProblems.push("the App Lock sheet is missing from index.html");
if (!/id="app-lock-modal"[^>]*role="dialog"/.test(html)) appLockProblems.push("the App Lock sheet is not a dialog");
for (const id of ["app-lock-status", "app-lock-dots", "app-lock-numpad", "app-lock-actions"]) {
    if (!htmlIds.has(id)) appLockProblems.push("the App Lock sheet is missing #" + id);
}
for (const fn of ["openAppLockSheet", "closeAppLockSheet", "gmAppLockStartChange", "gmAppLockStartRemove",
    "gmAppLockPress", "gmAppLockBackspace", "gmAppLockComplete", "gmAppLockRefreshStatus"]) {
    if (!defined.has(fn)) appLockProblems.push(fn + "() is missing");
}
for (const key of ["gm_pin", "gm_pin_length"]) {
    if (!scriptSource.includes(key)) appLockProblems.push(key + " is no longer used");
}
check("app lock is set up from Settings, not signup", appLockProblems);

// ---------------------------------------------------------------- report
const failed = results.filter(r => r.problems.length);
for (const r of results) {
    console.log((r.problems.length ? "FAIL  " : "PASS  ") + r.name);
    for (const p of r.problems) console.log("        - " + p);
}
console.log("\n" + (results.length - failed.length) + "/" + results.length + " checks passed");
process.exit(failed.length ? 1 : 0);
