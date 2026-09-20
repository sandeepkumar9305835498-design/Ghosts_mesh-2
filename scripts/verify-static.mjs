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
const jsFiles = [...new Set([
    ...[...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1].replace(/^\.\//, "")),
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
if (!htmlIds.has("gm-nav-pill")) polishProblems.push("highlight capsule element is missing");
for (const fn of ["gmNavGo", "gmSyncBottomNav", "gmSetBottomNavActive", "gmMoveNavPill"]) {
    if (!defined.has(fn)) polishProblems.push(fn + "() is missing");
}
// gmSyncBottomNav must gate the nav to the screens that should show it.
if (!/GM_NAV_SCREENS\s*=\s*\{[^}]*"chatlist-screen"\s*:\s*true[^}]*"profile-screen"\s*:\s*true/.test(js)) {
    polishProblems.push("GM_NAV_SCREENS does not cover chatlist-screen + profile-screen");
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
check("bottom pill nav + transitions are wired across files", polishProblems);

// ---------------------------------------------------------------- report
const failed = results.filter(r => r.problems.length);
for (const r of results) {
    console.log((r.problems.length ? "FAIL  " : "PASS  ") + r.name);
    for (const p of r.problems) console.log("        - " + p);
}
console.log("\n" + (results.length - failed.length) + "/" + results.length + " checks passed");
process.exit(failed.length ? 1 : 0);
