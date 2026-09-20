# Ghost Mesh — Android shell

A single-screen WebView app that runs the Ghost Mesh web app from this repository.
The web code stays the single source of truth: `copyWebAssets` packages
`index.html`, `script.js`, `style.css` and the vendor libraries into the APK at
build time, so you never maintain a second copy.

```
android/
├── RELEASE.md                           ← keystore setup + signed AAB/APK + Play upload
├── keystore.properties.example          ← copy to keystore.properties (gitignored) to sign releases
├── app/
│   ├── build.gradle                     ← SDK levels, deps, copyWebAssets task, signing config
│   └── src/main/
│       ├── AndroidManifest.xml          ← permissions + the one activity
│       ├── java/com/ghostmesh/app/MainActivity.java
│       ├── res/layout/activity_main.xml ← WebView fills the padded root
│       └── res/values/                  ← strings, colors (match style.css), dark theme
└── gradle/wrapper/                      ← Gradle 8.9 wrapper
```

## Open it

1. Android Studio → **Open** → select this `android/` folder (not the repo root).
2. Let it sync. The first sync downloads Gradle 8.9, the Android Gradle Plugin
   8.7.3 and Android **SDK 35** (accept the install prompt if it appears).
3. Run ▶ on a device/emulator. `MainActivity` loads
   `https://appassets.androidplatform.net/assets/www/index.html`.

Requirements: Android Studio Koala/Ladybug (2024.1) or newer, JDK 17.
`local.properties` (your SDK path) is created by Android Studio and is gitignored.

## Editing the web app

Edit `index.html` / `script.js` / `style.css` at the **repository root**. The
next build copies the current files into `app/src/main/assets/www/` (that folder
is generated and gitignored — never edit it directly).

The file list is in `app/build.gradle` (`webAppFiles`); add any new asset there
too, otherwise it will not reach the APK.

## Why it is wired this way

| Concern | What the project does |
| --- | --- |
| Camera / mic / QR scan / geolocation | Served from `https://appassets.androidplatform.net` by `WebViewAssetLoader`. A real secure origin — `file://` is not one, and all of those APIs silently fail there. |
| JS `alert` / `confirm` / `prompt` | `onJsAlert` / `onJsConfirm` / `onJsPrompt` show a real dialog. A bare WebView auto-answers `confirm()` with `false` and `prompt()` with `null`, which made logout / clear chat / paste-code look broken. |
| `<input type="file">` (photo, video, document, profile picture) | `onShowFileChooser` opens the system picker and returns the result. |
| `window.open()` (Google Maps links) | `onCreateWindow` routes the URL to the system browser instead of a second WebView; in-page links that leave the app do the same via `shouldOverrideUrlLoading`. |
| `getUserMedia()` permission prompts | `onPermissionRequest` asks Android for `CAMERA` / `RECORD_AUDIO` and then grants the page's request. |
| Hardware back button | Asks the page first through `handleAndroidBack()` (in `script.js`): closes menus → modals → call screens → returns from a chat. Only then does Android leave the app. |
| Edge-to-edge (Android 15+) | `applySystemBarInsets()` pads the root view with the system bar insets, so the app is never drawn under the status/navigation bars. |
| Service worker | Skipped inside the APK (`navigator.userAgent` contains `GhostMeshAndroid`). The page is already local, and a cached copy would mask web updates after an app update. |
| Keyboard | `adjustResize` + the app's own `visualViewport` logic; `mediaPlaybackRequiresUserGesture(false)` so voice notes and call audio can start without an extra tap. |

## Debugging

- **Logcat**, tag `GhostMeshWeb` — every `console.log`/error from the page.
- **chrome://inspect** on your computer (debug builds only) for full DevTools.

## Permissions

`INTERNET`, `ACCESS_NETWORK_STATE`, `CAMERA`, `RECORD_AUDIO`,
`MODIFY_AUDIO_SETTINGS`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`,
`VIBRATE`, `POST_NOTIFICATIONS`, plus the native-mesh group described below.
Runtime prompts appear the first time the matching feature is used.

## Native mesh: Bluetooth LE + Wi-Fi Direct

Beyond PeerJS (which needs internet) and QR pairing (which needs two people to
point cameras at each other), the Android shell can find nearby Ghosts by
itself:

| Piece | What it does |
| --- | --- |
| `BleMeshDiscovery.java` | Advertises a fixed Ghost Mesh service UUID (`d9a5e5c0-1b1e-4a3f-9f4e-7c1a9b6d0e01`) plus this device's short Ghost ID, and scans for the same UUID. No pairing, no bonding, no server. |
| `WifiDirectMesh.java` | `WifiP2pManager` discovery + connection, so two phones can form a direct link with no router and no hotspot. Uses WPS PBC, so there is no PIN to type. |
| `GhostMeshService.java` | Foreground service (`connectedDevice`) that keeps both radios scanning while the app is backgrounded, with a silent ongoing notification. |
| `GhostNativeBridge.java` | The `window.GhostNative` object the page calls: `isSupported`, `setGhostId`, `setDisplayName`, `startDiscovery`, `stopDiscovery`, `getPeers`, `connect`. |

Discovered peers are pushed into the page (`window.gmApplyNativePeers([...])`)
and rendered by the *same* function as PeerJS peers, so they appear in both
Chats → **Online Nearby** and WiFi → **Ghosts You Can Reach**, labelled
`Bluetooth` / `Wi-Fi Direct`, each with a **Connect** button. Nothing about the
existing chat/call path changes: BLE only finds devices and carries the Ghost
ID, Wi-Fi Direct supplies the direct link, and the WebRTC/QR handshake still
does the talking.

Permissions: `BLUETOOTH_SCAN` (with `neverForLocation`), `BLUETOOTH_ADVERTISE`,
`BLUETOOTH_CONNECT` on Android 12+, legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` below
that, `NEARBY_WIFI_DEVICES` on Android 13+, and `FOREGROUND_SERVICE` +
`FOREGROUND_SERVICE_CONNECTED_DEVICE` for the service. On Android 11 and older,
BLE scanning and Wi-Fi Direct discovery are location-gated, which is why
`ACCESS_FINE_LOCATION` is still declared and requested.

### Testing it on two phones

1. Install the APK on both devices, sign in on both.
2. Accept the Bluetooth / nearby-devices prompt on each (the first
   `GhostNative.startDiscovery()` asks for it).
3. A small silent notification appears — that is the discovery service.
4. Put the phones within a few metres: each should appear in the other's
   **Online Nearby** (Chats tab) and **Ghosts You Can Reach** (WiFi tab) within
   ~10 seconds, labelled `Bluetooth`.
5. Tap **Connect** on a Wi-Fi Direct entry to form the direct link; the toast
   reports the result. For the actual conversation, the QR/offline handshake
   (or a normal online connection) is still what pairs the two Ghost IDs.

Known limits, stated plainly: BLE advertisements are capped at 31 bytes, so
only a short Ghost ID (plus an optional short name) fits — the full identity is
exchanged afterwards. Wi-Fi Direct discovery exposes only device names, so
those entries are labelled by device until they are paired. Background scanning
is best-effort: Android battery optimisation can still suspend it, which is why
the foreground service exists.

## Signing and building a release

Release signing is configured in `android/app/build.gradle`: credentials come from
`android/keystore.properties` (gitignored) or the `GHOSTMESH_*` environment
variables, and `ghostmesh.versionCode` / `ghostmesh.versionName` in
`android/gradle.properties` set the app version.

```bash
cd android
./gradlew assembleDebug      # unsigned-free debug APK (no keystore needed)
./gradlew signingReport      # show which keystore each variant uses
./gradlew assembleRelease    # signed APK  -> app/build/outputs/apk/release/
./gradlew bundleRelease      # signed AAB  -> app/build/outputs/bundle/release/
```

Running `assembleRelease` / `bundleRelease` without an upload key fails fast with
setup instructions, instead of silently emitting an unsigned artifact that Play
rejects. (`./gradlew build`, which merely contains the release variant, only warns.)

**Full walkthrough — creating the upload keystore, keystore.properties,
versionCode bumps, signature verification, Play Console upload and
troubleshooting: [RELEASE.md](RELEASE.md).**

## Package name (decided)

`applicationId` is **`com.ghostmesh.app`** (`app/build.gradle`) and is final for
Play. The earlier `io.github.sandeepkumar9305835498design.ghostsmesh2.twa` package
came from a local TWA build that was **never uploaded to Play**, so there is no
existing listing to keep alive and no old signing key to reuse. `namespace` and the
Java package use the same value, so nothing else in the project depends on it.

The package name locks in with the first accepted upload. `.well-known/assetlinks.json`
still references the abandoned TWA package — refresh or delete it when you go live
(see [RELEASE.md](RELEASE.md)).

## Identity and recovery (12-word phrase)

Ghost IDs are no longer derived from the phone number. On first signup the web
app generates a random 128-bit seed on the device and derives both the Ghost ID
(`Ghost-XXXXXX`, shown in the header) and a 12-word BIP-39 recovery phrase:

- `bip39-wordlist.js` — the official 2048-word list (data only, hash-verified).
- `gm-identity.js` — SHA-256, BIP-39 encode/decode with checksum, Ghost ID
  derivation, the mandatory signup phrase screen, the profile backup view and
  the **Ghost Assistant** restore flow.

Everything runs locally: no fetch, no WebSocket, no lookup hash sent anywhere —
which is the whole point, because a server-side phrase check would leak the very
secret that protects the account. Losing both the device and the phrase loses
the Ghost ID permanently, exactly like a wallet seed. Logging out deliberately
keeps the seed (only name/phone/PIN are cleared) so the identity survives.

## Still open for a Play Store release

- The web app's Premium purchases are still simulated — wire Play Billing before charging money.
- `new Notification()` is not implemented by Android WebView; the app already
  guards it, and in-app banners plus vibration still work.
- Native mesh behaviour (BLE discovery range, Wi-Fi Direct group formation on
  different OEMs, background scanning longevity) still needs testing on real
  device pairs — it cannot be verified from a desktop build.
