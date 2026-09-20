// ===== GHOST MESH IDENTITY =====
// A Ghost ID that can be recovered on a brand-new device without any server.
//
// How it works (BIP-39 wallet pattern, applied to the Ghost ID):
//   1. On signup a TRULY RANDOM 128-bit seed is generated on the device with
//      crypto.getRandomValues(). It is never derived from the phone number,
//      the name, the device or anything else guessable.
//   2. The seed deterministically produces two things:
//        a) the Ghost ID          -> Ghost-XXXXXX   (public, shareable)
//        b) a 12-word phrase      -> the only human-readable backup
//   3. Recovery runs the exact same math locally. Typing the 12 words
//      reproduces the seed, and therefore the same Ghost ID.
//
// NO network call is made anywhere in this file. The phrase is never sent,
// hashed-for-lookup, or verified against a server — there is no server. Doing
// the math on-device is what keeps the "No Server · No Trace" promise intact;
// a server-side check would leak the phrase to whoever runs it.
//
// Consequence, stated plainly in the UI: if the phrase is lost and the device
// is gone, the Ghost ID is unrecoverable. Same trade-off as a wallet seed.

(function () {
    "use strict";

    // ---------------------------------------------------------------- wordlist
    const WORDS = (typeof GM_BIP39_WORDS !== "undefined" && GM_BIP39_WORDS) ? GM_BIP39_WORDS : [];
    const WORD_INDEX = Object.create(null);
    WORDS.forEach((w, i) => { WORD_INDEX[w] = i; });

    const STORAGE_SEED = "gm_seed";              // 32 hex chars = 16 bytes
    const STORAGE_ID = "gm_ghost_id";            // "Ghost-ABC123"
    const STORAGE_CREATED = "gm_seed_created_at";
    const SEED_BYTES = 16;                       // 128 bits of entropy
    const PHRASE_WORD_COUNT = 12;                // 128 bits + 4 checksum bits = 12 x 11 bits
    // Base32 without 0/1/I/O so an ID can be read out loud or typed by hand.
    const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    const ID_CHARS = 6;

    // ---------------------------------------------------------------- storage
    // Deliberately self-contained (this file must not depend on the load order
    // of script.js) and tolerant of localStorage being unavailable.
    const memStore = {};
    function idGet(key) {
        try {
            const v = localStorage.getItem(key);
            if (v !== null && v !== undefined) return v;
        } catch (e) { /* private mode / storage disabled */ }
        return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null;
    }
    function idSet(key, value) {
        try { localStorage.setItem(key, value); } catch (e) {}
        memStore[key] = value;
    }
    function idDel(key) {
        try { localStorage.removeItem(key); } catch (e) {}
        delete memStore[key];
    }

    // ---------------------------------------------------------------- SHA-256
    // Pure JS on purpose: Web Crypto's digest() is async and crypto.subtle does
    // not exist outside a secure context (file://, some WebViews), but recovery
    // must work offline on every origin. Verified against the NIST vectors
    // sha256("") and sha256("abc") by the test harness.
    const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

    function sha256Bytes(bytes) {
        const len = bytes.length;
        const withPad = new Uint8Array(((len + 8) >> 6) * 64 + 64);
        withPad.set(bytes);
        withPad[len] = 0x80;
        const dv = new DataView(withPad.buffer);
        dv.setUint32(withPad.length - 8, Math.floor(len / 536870912));
        dv.setUint32(withPad.length - 4, (len * 8) >>> 0);

        const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        const w = new Uint32Array(64);

        for (let off = 0; off < withPad.length; off += 64) {
            for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
            for (let i = 16; i < 64; i++) {
                const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
                const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
                w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
            }
            let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
            for (let i = 0; i < 64; i++) {
                const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
                const ch = (e & f) ^ (~e & g);
                const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
                const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
                const maj = (a & b) ^ (a & c) ^ (b & c);
                const t2 = (S0 + maj) >>> 0;
                hh = g; g = f; f = e; e = (d + t1) >>> 0;
                d = c; c = b; b = a; a = (t1 + t2) >>> 0;
            }
            h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
            h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
        }
        const out = new Uint8Array(32);
        const odv = new DataView(out.buffer);
        for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]);
        return out;
    }

    function utf8Bytes(str) {
        const out = [];
        for (let i = 0; i < str.length; i++) {
            let c = str.charCodeAt(i);
            if (c < 0x80) out.push(c);
            else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
            else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
                const c2 = str.charCodeAt(++i);
                c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
                out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
            } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
        return new Uint8Array(out);
    }

    function bytesToHex(bytes) {
        let s = "";
        for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
        return s;
    }
    function hexToBytes(hex) {
        const clean = String(hex || "").trim().toLowerCase();
        if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) return null;
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
        return out;
    }

    function sha256Hex(str) { return bytesToHex(sha256Bytes(utf8Bytes(str))); }

    // ---------------------------------------------------------------- randomness
    let usedSecureRandom = true;
    function randomBytes(n) {
        const out = new Uint8Array(n);
        const c = (typeof crypto !== "undefined" && crypto) ? crypto : null;
        if (c && typeof c.getRandomValues === "function") {
            try { c.getRandomValues(out); return out; } catch (e) { /* fall through */ }
        }
        usedSecureRandom = false; // only reachable on ancient/broken runtimes
        for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
        return out;
    }

    // ---------------------------------------------------------------- BIP-39
    function bytesToBitString(bytes) {
        let s = "";
        for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(2).padStart(8, "0");
        return s;
    }

    function phraseFromSeedHex(seedHex) {
        const entropy = hexToBytes(seedHex);
        if (!entropy || entropy.length !== SEED_BYTES) return null;
        if (!WORDS.length) return null;
        const checksumBits = SEED_BYTES * 8 / 32;                       // 4 bits
        const checksum = bytesToBitString(sha256Bytes(entropy)).slice(0, checksumBits);
        const bits = bytesToBitString(entropy) + checksum;              // 132 bits
        const words = [];
        for (let i = 0; i < PHRASE_WORD_COUNT; i++) {
            words.push(WORDS[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
        }
        return words.join(" ");
    }

    // Returns "ok", or a short reason so the UI can say what is actually wrong
    // instead of a useless "invalid phrase".
    function validatePhrase(text) {
        const words = normalisePhrase(text).split(" ").filter(Boolean);
        if (!WORDS.length) return { ok: false, reason: "wordlist-missing", words };
        if (words.length !== PHRASE_WORD_COUNT) {
            return { ok: false, reason: "word-count", words, detail: words.length };
        }
        const unknown = words.find(w => WORD_INDEX[w] === undefined);
        if (unknown) return { ok: false, reason: "unknown-word", words, detail: unknown };

        let bits = "";
        words.forEach(w => { bits += WORD_INDEX[w].toString(2).padStart(11, "0"); });
        const entropyBits = bits.slice(0, SEED_BYTES * 8);
        const checksumBits = bits.slice(SEED_BYTES * 8);
        const entropy = new Uint8Array(SEED_BYTES);
        for (let i = 0; i < SEED_BYTES; i++) entropy[i] = parseInt(entropyBits.slice(i * 8, i * 8 + 8), 2);
        const expected = bytesToBitString(sha256Bytes(entropy)).slice(0, checksumBits.length);
        if (expected !== checksumBits) return { ok: false, reason: "checksum", words };
        return { ok: true, words, seedHex: bytesToHex(entropy) };
    }

    function seedHexFromPhrase(text) {
        const result = validatePhrase(text);
        return result.ok ? result.seedHex : null;
    }

    function normalisePhrase(text) {
        return String(text || "")
            .toLowerCase()
            .replace(/[^a-z]+/g, " ")   // strips numbers, commas, numbering like "1."
            .trim();
    }

    // ---------------------------------------------------------------- Ghost ID
    // sha256(seed | domain separator) -> base32. The separator keeps this ID
    // derivation independent from any other use of the same seed later on.
    function ghostIdFromSeedHex(seedHex) {
        const digest = sha256Bytes(utf8Bytes("ghost-mesh|ghost-id|v1|" + String(seedHex || "").toLowerCase()));
        let id = "";
        for (let i = 0; i < ID_CHARS; i++) id += ID_ALPHABET[digest[i] % ID_ALPHABET.length];
        return "Ghost-" + id;
    }

    // ---------------------------------------------------------------- identity
    function currentIdentity() {
        const seedHex = idGet(STORAGE_SEED);
        if (!seedHex || !/^[0-9a-f]{32}$/.test(seedHex)) return null;
        return { seedHex, ghostId: ghostIdFromSeedHex(seedHex) };
    }

    function identityExists() { return !!currentIdentity(); }

    function saveIdentity(seedHex) {
        const clean = String(seedHex || "").toLowerCase();
        if (!/^[0-9a-f]{32}$/.test(clean)) return null;
        idSet(STORAGE_SEED, clean);
        const ghostId = ghostIdFromSeedHex(clean);
        idSet(STORAGE_ID, ghostId);
        if (!idGet(STORAGE_CREATED)) idSet(STORAGE_CREATED, String(Date.now()));
        return { seedHex: clean, ghostId, phrase: phraseFromSeedHex(clean) };
    }

    function createIdentity() { return saveIdentity(bytesToHex(randomBytes(SEED_BYTES))); }

    // Creates the identity on first run; returns whether it had to create one.
    function ensureIdentity() {
        const existing = currentIdentity();
        if (existing) return { identity: existing, created: false, secureRandom: usedSecureRandom };
        const created = createIdentity();
        return { identity: created, created: true, secureRandom: usedSecureRandom };
    }

    function forgetIdentity() { idDel(STORAGE_SEED); idDel(STORAGE_ID); idDel(STORAGE_CREATED); }

    // ---------------------------------------------------------------- UI plumbing
    function gmShow(id) { const el = document.getElementById(id); if (el) el.classList.remove("hidden"); }
    function gmHide(id) { const el = document.getElementById(id); if (el) el.classList.add("hidden"); }
    function gmToast(msg) {
        if (typeof showToast === "function") showToast(msg);
    }

    let pendingPhraseCallback = null;   // set while the mandatory signup flow runs
    let activePhrase = null;
    let verifyTargets = [];

    // A phrase flow that has not been confirmed yet must not be dismissible —
    // that is the whole point of the confirmation step.
    function phraseFlowBlocked() { return pendingPhraseCallback !== null; }

    function renderWordsInto(containerId, phrase) {
        const box = document.getElementById(containerId);
        if (!box) return;
        box.innerHTML = "";
        phrase.split(" ").forEach((word, i) => {
            const chip = document.createElement("div");
            chip.className = "phrase-chip";
            chip.innerHTML = '<span class="phrase-chip-num">' + (i + 1) + '</span><span class="phrase-chip-word">' + word + "</span>";
            box.appendChild(chip);
        });
    }

    // Called by script.js once the user's name/phone/PIN are validated. Creates
    // the seed if this is a brand-new install, and runs `done` only after the
    // phrase has been shown AND confirmed.
    function ensureIdentityThen(done) {
        if (identityExists()) { if (typeof done === "function") done(); return; }
        const created = createIdentity();
        if (!created) { gmToast("Could not create a Ghost ID on this device"); return; }
        activePhrase = created.phrase;
        pendingPhraseCallback = (typeof done === "function") ? done : null;

        if (!activePhrase) {
            // The bundled wordlist failed to load. Do not silently hand out an
            // identity that can never be recovered — say so and let the person
            // log in anyway (their Ghost ID still works on this device).
            pendingPhraseCallback = null;
            gmToast("Recovery phrase unavailable (wordlist not loaded) — reinstall to fix");
            if (typeof done === "function") done();
            return;
        }

        renderWordsInto("phrase-words", activePhrase);
        const check = document.getElementById("phrase-saved-check");
        if (check) check.checked = false;
        const btn = document.getElementById("phrase-continue-btn");
        if (btn) btn.disabled = true;
        gmHide("phrase-verify-step");
        gmShow("phrase-show-step");

        if (!usedSecureRandom) {
            const warn = document.getElementById("phrase-random-warning");
            if (warn) warn.classList.remove("hidden");
        }
        gmShow("phrase-setup-modal");
    }

    function phraseSavedChanged() {
        const check = document.getElementById("phrase-saved-check");
        const btn = document.getElementById("phrase-continue-btn");
        if (btn) btn.disabled = !(check && check.checked);
    }

    function copyPhrase() {
        if (!activePhrase && currentIdentity()) activePhrase = phraseFromSeedHex(currentIdentity().seedHex);
        if (!activePhrase) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(activePhrase).then(
                () => gmToast("Phrase copied — paste it somewhere private, then delete it"),
                () => gmToast("Could not copy — please write the words down instead")
            );
        } else {
            gmToast("Copy not available — please write the words down");
        }
    }

    // Step 2: ask for 3 random positions out of the 12 words.
    function phraseContinue() {
        const check = document.getElementById("phrase-saved-check");
        if (!check || !check.checked) { gmToast("Please confirm you wrote the words down"); return; }
        if (!activePhrase) return;
        const positions = [];
        const pool = [];
        for (let i = 1; i <= PHRASE_WORD_COUNT; i++) pool.push(i);
        while (positions.length < 3) positions.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
        positions.sort((a, b) => a - b);
        verifyTargets = positions;

        const fields = document.getElementById("phrase-verify-fields");
        if (fields) {
            fields.innerHTML = positions.map((pos, i) =>
                '<label class="phrase-verify-field"><span>Word #' + pos + '</span>' +
                '<input type="text" id="phrase-verify-input-' + i + '" autocomplete="off" autocapitalize="off" ' +
                'spellcheck="false" placeholder="word ' + pos + '"></label>'
            ).join("");
        }
        const err = document.getElementById("phrase-verify-error");
        if (err) err.classList.add("hidden");
        gmHide("phrase-show-step");
        gmShow("phrase-verify-step");
    }

    function phraseBackToShow() {
        gmHide("phrase-verify-step");
        gmShow("phrase-show-step");
    }

    function phraseVerify() {
        if (!activePhrase) return;
        const words = activePhrase.split(" ");
        for (let i = 0; i < verifyTargets.length; i++) {
            const input = document.getElementById("phrase-verify-input-" + i);
            const typed = normalisePhrase(input ? input.value : "").trim();
            if (typed !== words[verifyTargets[i] - 1]) {
                const err = document.getElementById("phrase-verify-error");
                if (err) {
                    err.innerText = "Word #" + verifyTargets[i] + " doesn't match. Check your written copy and try again.";
                    err.classList.remove("hidden");
                }
                return;
            }
        }
        finishPhraseFlow();
    }

    function finishPhraseFlow() {
        gmHide("phrase-setup-modal");
        const done = pendingPhraseCallback;
        pendingPhraseCallback = null;
        gmToast("Ghost ID created — keep that phrase safe");
        if (typeof done === "function") done();
    }

    // ----- Profile: "Show my recovery phrase" (re-derived from the local seed)
    function openPhraseBackup() {
        const identity = currentIdentity();
        if (!identity) { gmToast("No Ghost ID on this device yet"); return; }
        const phrase = phraseFromSeedHex(identity.seedHex);
        if (!phrase) { gmToast("Recovery phrase unavailable — wordlist failed to load"); return; }
        activePhrase = phrase;
        renderWordsInto("phrase-backup-words", phrase);
        const idEl = document.getElementById("phrase-backup-id");
        if (idEl) idEl.innerText = identity.ghostId;
        gmShow("phrase-backup-modal");
    }

    // ----- Ghost Assistant: type the 12 words, rebuild the Ghost ID locally
    function openGhostAssistant() {
        const input = document.getElementById("assistant-phrase-input");
        if (input) input.value = "";
        gmHide("assistant-error");
        gmHide("assistant-preview");
        gmHide("assistant-restore-btn");
        const hint = document.getElementById("assistant-hint");
        if (hint) hint.innerText = "Type your 12 words in order, separated by spaces.";
        gmShow("ghost-assistant-modal");
    }

    let assistantSeedHex = null;

    function assistantCheck() {
        const input = document.getElementById("assistant-phrase-input");
        const err = document.getElementById("assistant-error");
        const result = validatePhrase(input ? input.value : "");
        if (!result.ok) {
            assistantSeedHex = null;
            gmHide("assistant-preview");
            gmHide("assistant-restore-btn");
            if (err) {
                err.innerText = {
                    "word-count": "A recovery phrase is exactly 12 words — you entered " + (result.detail || 0) + ".",
                    "unknown-word": "\"" + (result.detail || "?") + "\" is not a Ghost Mesh phrase word. Check the spelling.",
                    "checksum": "Those 12 words don't go together (the last word acts as a checksum). Re-check the order.",
                    "wordlist-missing": "The wordlist could not be loaded — restart the app and try again."
                }[result.reason] || "That phrase is not valid.";
                err.classList.remove("hidden");
            }
            return;
        }
        assistantSeedHex = result.seedHex;
        const ghostId = ghostIdFromSeedHex(result.seedHex);
        const idEl = document.getElementById("assistant-preview-id");
        if (idEl) idEl.innerText = ghostId;
        const hint = document.getElementById("assistant-hint");
        const existing = currentIdentity();
        if (hint) {
            hint.innerText = (existing && existing.ghostId === ghostId)
                ? "This is the Ghost ID already on this device."
                : "Ghost Assistant rebuilt " + ghostId + " on this device — nothing was sent anywhere.";
        }
        if (err) err.classList.add("hidden");
        gmShow("assistant-preview");
        gmShow("assistant-restore-btn");
    }

    function assistantRestore() {
        if (!assistantSeedHex) { assistantCheck(); return; }
        const ghostId = ghostIdFromSeedHex(assistantSeedHex);
        // Ask BEFORE touching storage, so cancelling leaves everything as it was.
        // Name / phone / PIN belong to the device, not to the identity — they stay.
        if (typeof confirm === "function" && !confirm("Restore " + ghostId + " on this device?\n\nYour chats stay on the phone, but the app will now use this Ghost ID.")) {
            return;
        }
        const identity = saveIdentity(assistantSeedHex);
        if (!identity) { gmToast("Could not restore that phrase"); return; }
        gmToast("Restored " + identity.ghostId + " — reloading");
        setTimeout(() => { try { location.reload(); } catch (e) {} }, 700);
    }

    function closeIdentityModals() {
        if (phraseFlowBlocked()) {
            gmToast("Write down your recovery phrase and confirm it to continue");
            return;
        }
        ["phrase-setup-modal", "phrase-backup-modal", "ghost-assistant-modal"].forEach(gmHide);
    }

    window.GMIdentity = {
        // crypto / encoding (also used by the test harness)
        sha256Hex,
        randomSeedHex: () => bytesToHex(randomBytes(SEED_BYTES)),
        usedSecureRandom: () => usedSecureRandom,
        phraseFromSeedHex,
        seedHexFromPhrase,
        validatePhrase,
        normalisePhrase,
        ghostIdFromSeedHex,
        wordCount: WORDS.length,
        // identity lifecycle
        current: currentIdentity,
        exists: identityExists,
        save: saveIdentity,
        create: createIdentity,
        ensure: ensureIdentity,
        forget: forgetIdentity,
        // UI entry points
        ensureIdentityThen,
        phraseSavedChanged,
        phraseContinue,
        phraseBackToShow,
        phraseVerify,
        copyPhrase,
        openPhraseBackup,
        openGhostAssistant,
        assistantCheck,
        assistantRestore,
        closeModals: closeIdentityModals,
        phraseFlowBlocked
    };

    // Inline HTML handlers (onclick="...") look these up on window.
    window.gmEnsureIdentityThen = ensureIdentityThen;
    window.gmPhraseSavedChanged = phraseSavedChanged;
    window.gmPhraseContinue = phraseContinue;
    window.gmPhraseBackToShow = phraseBackToShow;
    window.gmPhraseVerify = phraseVerify;
    window.gmCopyPhrase = copyPhrase;
    window.gmOpenPhraseBackup = openPhraseBackup;
    window.gmOpenGhostAssistant = openGhostAssistant;
    window.gmAssistantCheck = assistantCheck;
    window.gmAssistantRestore = assistantRestore;
    window.gmCloseIdentityModals = closeIdentityModals;
})();
