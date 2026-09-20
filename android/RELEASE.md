# Releasing Ghost Mesh to the Play Store

Everything here runs from the `android/` folder. `./gradlew` is the Gradle 8.9
wrapper that ships with the project (use `gradlew.bat` on Windows).

> **Keys first, uploads later.** Play Console rejects any artifact that is not
> signed, and `bundleRelease` / `assembleRelease` now **stop with an error** if no
> upload key is configured. `assembleDebug` never needs one, and a build that only
> *contains* the release variant (e.g. `./gradlew build`) just prints a warning.

---

## 0. How the two keys work (read this once)

| Key | Who holds it | What it signs |
| --- | --- | --- |
| **Upload key** (yours, created below) | you + whoever builds releases | the `.aab` you upload |
| **App signing key** (only if you opt into Play App Signing) | Google | the APK users actually download |

With Play App Signing (the default for new apps) Google re-signs your upload, so
the upload key can be rotated if it leaks. Either way: **if you lose the upload
key and every copy of its passwords, you cannot ship updates** until you ask Play
Support for an upload-key reset. Back it up.

---

## 1. Create the upload keystore

Keep the file **outside this repository** (e.g. `~/keystores/`), never inside the
project folder.

### Option A — keytool (Android Studio's embedded JDK works too)

```bash
mkdir -p ~/keystores

keytool -genkeypair -v \
  -storetype PKCS12 \
  -keystore ~/keystores/ghostmesh-upload.jks \
  -alias ghostmesh-upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

- `-validity 10000` ≈ 27 years. **Play requires the key to still be valid in 2033+**,
  so do not use a short validity.
- Use a strong store password and, by default, let keytool ask for it.
- `keytool` not found on Windows? Use Android Studio's JDK:
  `"C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe"` (adjust the path).

### Option B — Android Studio wizard

**Build → Generate Signed App Bundle / APK… → Android App Bundle → Next →
Create new…** and fill in Key store path / Password / Alias / Key password.
This creates the keystore *and* gives you a ready-made signed `.aab`.

### Package name is already decided: `com.ghostmesh.app`

The `applicationId` in `android/app/build.gradle` is final. The older
`io.github.sandeepkumar9305835498design.ghostsmesh2.twa` package belongs to a local
TWA build that was **never uploaded to Play**, so there is no listing, no upload key
and no fingerprint worth carrying over. Create a **fresh** upload keystore for this
package rather than reusing the old TWA signing key.

`applicationId` and `namespace` are both `com.ghostmesh.app`, so the manifest and
`MainActivity` need no changes.

---

## 2. Point the build at the keystore

```bash
cp keystore.properties.example keystore.properties
```

Then edit that new `android/keystore.properties`:

```properties
storeFile=/Users/you/keystores/ghostmesh-upload.jks   # absolute, or relative to android/
storePassword=…
keyAlias=ghostmesh-upload
keyPassword=…
```

- `keystore.properties` is **gitignored** (as are `*.jks` / `*.keystore`) — it must
  never be committed.
- Escape backslashes on Windows: `storeFile=C:\\Users\\you\\keystores\\ghostmesh-upload.jks`
- Prefer environment variables in CI instead of a file:
  `GHOSTMESH_STORE_FILE`, `GHOSTMESH_STORE_PASSWORD`, `GHOSTMESH_KEY_ALIAS`,
  `GHOSTMESH_KEY_PASSWORD`. The build reads the file first, then falls back to these.
- Confirm the build picked it up: `./gradlew signingReport` prints the keystore each
  variant uses. `Variant: release` must show your alias, not `androiddebugkey`.

---

## 3. Bump the version

Edit `android/gradle.properties` before **every** upload:

```properties
ghostmesh.versionCode=2      # must strictly increase every upload Play receives
ghostmesh.versionName=1.1    # what users see; free-form
```

Play refuses a bundle whose `versionCode` was already used. One-off override:

```bash
./gradlew bundleRelease -Pghostmesh.versionCode=7 -Pghostmesh.versionName=1.2
```

---

## 4. Build

```bash
cd android

# Debug APK — no signing needed, keeps WebView DevTools enabled
./gradlew assembleDebug
#   app/build/outputs/apk/debug/app-debug.apk

# Signed release APK — for sideloading / direct sharing (universal, all ABIs)
./gradlew assembleRelease
#   app/build/outputs/apk/release/app-release.apk

# Signed App Bundle — this is the file you upload to Play
./gradlew bundleRelease
#   app/build/outputs/bundle/release/app-release.aab
```

In Android Studio the same thing is **Build → Generate Signed App Bundle / APK…**
(choose *Android App Bundle* for Play, *APK* for sideloading).

Both release tasks run `copyWebAssets` first, so the bundle always contains the
current web files from the repository root.

### Verify the signature

```bash
# which keystore each variant uses (no build required)
./gradlew signingReport

# fingerprints of the built APK (uses Android SDK build-tools)
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

Check the AAB before uploading, optionally with Google's
[bundletool](https://github.com/google/bundletool):

```bash
java -jar bundletool.jar build-apks \
  --bundle=app/build/outputs/bundle/release/app-release.aab \
  --output=ghostmesh.apks --ks=~/keystores/ghostmesh-upload.jks \
  --ks-key-alias=ghostmesh-upload
```

### Install the release APK on a device

```bash
adb install -r app/build/outputs/apk/release/app-release.apk
```

A release build installed over a debug build fails with
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` (different signing keys) — uninstall the
debug one first.

---

## 5. Upload to Play Console

1. <https://play.google.com/console> → **Create app** (name, language, "App",
   "Free"). The **package name is permanent** — decide `applicationId` now
   (currently `com.ghostmesh.app` in `android/app/build.gradle`).
2. **Release → Testing → Internal testing** first: create a release, upload
   `app-release.aab`, add your own Google account as a tester, and install it from
   the opt-in link. This validates signing, permissions and WebRTC on a real device
   without a public rollout.
3. Before production you must also complete, in **Policy and program**:
   - the **Data safety** form (this app uses camera, microphone, location,
     Bluetooth/nearby devices and notifications, and stores chats locally /
     transfers them peer-to-peer — say exactly that),
   - a **privacy policy URL** (required because of the sensitive permissions),
   - the **foreground service declaration**: Play asks which
     `foregroundServiceType` the app uses and why. This project uses
     `connectedDevice` for `GhostMeshService`, justified as *“keeps Bluetooth LE
     and Wi-Fi Direct discovery running so nearby-device messages can arrive
     while the app is in the background”*. Without that declaration the release
     is rejected,
   - **Content rating** questionnaire,
   - **Target audience**, and **Ads** declarations.
4. Meet Play's API requirement: this project targets **SDK 35**; check Play's
   current minimum each August, since it is raised yearly.
5. Promote internal → closed/open testing → production (staged rollout).

### `.well-known/assetlinks.json` (Android App Links)

The copy in this repository still lists the abandoned TWA package
(`io.github.sandeepkumar9305835498design.ghostsmesh2.twa`), so it will never match
the app you ship. Once the app is live, either replace `package_name` with
`com.ghostmesh.app` and set `sha256_cert_fingerprints` to your **app signing key**
(Play Console → *Test and release → App integrity → App signing key certificate*,
or locally `keytool -list -v -keystore … -alias ghostmesh-upload`), or delete the
file if you do not use App Links / deep links at all. Re-upload it as
`https://<your-domain>/.well-known/assetlinks.json`. Without a matching entry,
Android App Links will not verify.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Release signing is not configured…` | No `keystore.properties` and no `GHOSTMESH_*` env vars. Do step 2, or use `assembleDebug`. |
| `Release keystore not found: …` | `storeFile` path is wrong — relative paths resolve from `android/`. |
| Gradle produces `app-release-unsigned.apk` | A release variant was built with signing incomplete (e.g. via `./gradlew build`). An `-unsigned` artifact cannot be uploaded — configure `keystore.properties` and rebuild. |
| `./gradlew build` warns *"a release variant is being built without a signing config"* | Expected until you add an upload key; use `assembleDebug` for plain compile checks. |
| `Keystore was tampered with, or password was incorrect` | `storePassword` and `keyPassword` are swapped or wrong. Note that PKCS12 keystores normally use the **same** password for both. |
| `keytool error: java.io.IOException: keystore password was incorrect` | Wrong password, or a JKS file opened with the PKCS12 assumption (or vice versa). `keytool -list -keystore file.jks -storetype JKS` to inspect. |
| Play: *"You uploaded an APK or Android App Bundle that was signed with a key that is not expected"* | You switched upload keys after the first upload, or re-used a `versionCode`. |
| Play: *"Version code N has already been used"* | Bump `ghostmesh.versionCode` in `android/gradle.properties`. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` on device | Uninstall the previously installed build (debug/release keys differ). |
| Camera works in an `assembleDebug` build but not in a WebView test page | Load through `WebViewAssetLoader` (`https://appassets.androidplatform.net`) — `file://` is not a secure origin. |

---

## 7. Pre-upload checklist

- [ ] Upload keystore created, plus a backup of the `.jks` **and** its passwords in a password manager.
- [ ] `android/keystore.properties` filled in locally and **not** staged in git (`git status` shows nothing under it).
- [ ] `ghostmesh.versionCode` bumped; `ghostmesh.versionName` sensible.
- [ ] `applicationId` is `com.ghostmesh.app` (decided) and `./gradlew signingReport` reports it for the release variant.
- [ ] `.well-known/assetlinks.json` updated to `com.ghostmesh.app` + the app signing key, or deleted if unused.
- [ ] Data safety lists camera, microphone, location, **Bluetooth/nearby devices** and notifications.
- [ ] Foreground-service (`connectedDevice`) declaration + justification submitted.
- [ ] `./gradlew signingReport` shows your release alias for the `release` variant.
- [ ] `bundleRelease` output installed and smoke-tested on a real device (login, chat, camera QR pairing, voice call, back button).
- [ ] Data safety, privacy policy, content rating and screenshots done in Play Console.
- [ ] Premium purchases are still simulated — wire up Play Billing before charging users (see README).
