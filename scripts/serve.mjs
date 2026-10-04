#!/usr/bin/env node
// ===== GHOST MESH — LOCAL PREVIEW SERVER =====
// The app is plain static files (no bundler, no build step), so previewing it is
// just serving this folder. Dependency-free on purpose: `npm run dev` has to work
// on a fresh checkout with nothing installed.
//
// It binds 0.0.0.0 and honours PORT (the Freebuff preview injects it), so the
// same command works in the hosted preview and on a laptop. Serve over https://
// or localhost and the camera/mic APIs are available, which means the QR scanner
// can be tested in the preview on a real phone.
//
//   npm run dev                 # http://0.0.0.0:3000
//   PORT=8080 npm run dev
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 3000);

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".woff2": "font/woff2"
};

// Never served over the preview: repository history, installed packages, secrets.
const BLOCKED = /(^|\/)(\.git|node_modules|\.env)/;

const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
        return;
    }

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch (e) {
        res.writeHead(400).end("Bad request");
        return;
    }

    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    if (BLOCKED.test(rel)) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
    }

    const file = path.resolve(ROOT, rel);
    // Refuse to walk out of the project directory via ../ in the URL.
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
        res.writeHead(403).end("Forbidden");
        return;
    }

    fs.stat(file, (err, stat) => {
        if (err || !stat.isFile()) {
            // One-page app: an unknown path that is not a file falls back to the
            // shell, the same way the service worker does when offline.
            if (!path.extname(rel)) {
                res.writeHead(200, {
                    "Content-Type": MIME[".html"],
                    "Cache-Control": "no-store"
                }).end(fs.readFileSync(path.join(ROOT, "index.html")));
                return;
            }
            res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
            return;
        }
        const headers = {
            "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
            "Content-Length": stat.size,
            // no-store so a code change shows up on the next reload instead of
            // hiding behind the browser cache — this is a live preview.
            "Cache-Control": "no-store"
        };
        if (req.method === "HEAD") { res.writeHead(200, headers).end(); return; }
        const stream = fs.createReadStream(file);
        stream.on("error", () => res.destroy());
        res.writeHead(200, headers);
        stream.pipe(res);
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Ghost Mesh preview: http://0.0.0.0:${PORT}`);
});
