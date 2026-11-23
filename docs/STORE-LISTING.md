# Ghost Mesh — Play Store listing kit

Everything Play Console asks for, in the order the console asks for it. The app
is free with no ads, no in-app purchases and no accounts, so several sections are
deliberately short ("none").

Character limits are Play's, checked against the copy below.

---

## 1. App name (max 30 characters)

**Primary**

```
Ghost Mesh: Offline P2P Chat
```

28 characters (limit 30). Picks up the two search terms people actually type
("offline", "P2P chat") without stuffing.

**Alternates** (pick one, keep the same across store + APK label)

| Name | Length | Best for |
| --- | --- | --- |
| Ghost Mesh: Private P2P Chat | 28 | privacy-first positioning |
| Ghost Mesh — No Account Chat | 28 | "no account" hook |
| Ghost Mesh | 10 | brand only (weakest for discovery) |

The launcher label comes from `android/app/src/main/res/values/strings.xml`
(`app_name` = *Ghost Mesh*), so a longer store title does not change the icon
caption — that is normal and allowed.

---

## 2. Short description (max 80 characters)

**Chosen (76)**

```
Private offline chat, calls and file sharing — no account, no cloud, no ads.
```

Alternates:

```
Chat and call phone-to-phone with no account, no server and no tracking.
```

```
Encrypted peer-to-peer messenger that works without internet or sign-up.
```

---

## 3. Full description (max 4000 characters)

```
Ghost Mesh is a messenger with no account, no server and no ads. You open it, pick a name, and you are already in — no email, no OTP, no phone verification, no profile to fill in.

Connect two phones directly. When you are on the same Wi-Fi or hotspot, Ghost Mesh finds the other phone on the local network and opens a direct link. When you are apart, the app uses a relay only to introduce the two devices — messages, files and calls then travel straight between the phones, not through a Ghost Mesh server. There is no Ghost Mesh server holding your conversations.

WHAT YOU CAN DO

• One-to-one and group chats
• Voice notes, photos, documents and camera capture
• Voice and video calls over the direct link
• View-once photos and self-destructing messages
• Pin, reply, edit, react and delete messages
• Block and report anyone, from the chat menu
• Radar map that shows nearby Ghosts you have met
• Chat themes, dark UI, and an optional 4-digit app lock
• Works fully offline on the same Wi-Fi or hotspot

NO ACCOUNT, NO CLOUD

Your Ghost ID is generated on your phone from a random local seed. It is not registered anywhere. A 12-word recovery phrase is the only backup, and it never leaves your device unless you copy it out yourself. Chats, settings and your profile stay in the app's private storage — uninstalling the app removes them.

100% FREE

Every feature is unlocked for everyone. There is no subscription, no credits, no coins, no premium tier, no advertising SDK and no in-app purchase. Nothing in the app is gated, and nothing will ever ask for a card.

PRIVACY BY DEFAULT

• No analytics, no trackers, no advertising ID
• No cloud backup: Android backup is switched off for this app
• Location is off until you choose to share it in a chat or open the map
• Camera and microphone are used only while you are scanning a QR code, recording a voice note or in a call
• Connection data is exchanged through a public relay for the handshake only; content is not stored by it

GOOD TO KNOW

• Both people need Ghost Mesh installed to chat
• Nearby mode needs you on the same Wi-Fi network or hotspot; internet mode needs a connection for the initial handshake
• Encryption is provided by the WebRTC link the two devices negotiate (DTLS); the app adds no server-side copy of your messages

Ghost Mesh is an independent project, built as a free public good for people who want to talk without handing their conversations to a platform.
```

Length: 2,448 characters — comfortably inside 4,000, and long enough to rank for
"offline chat", "P2P messenger", "no account chat", "private messenger".

---

## 4. Category, tags, contact

| Field | Value |
| --- | --- |
| App category | Communication |
| Tags | Messaging, Private, Offline |
| Email | privacy@ghostmesh.app *(use a mailbox you actually read — Play review mails here)* |
| Website | the URL that serves `privacy.html` |
| Privacy policy URL | `https://<your-domain>/privacy.html` |

`privacy.html` is already written for exactly this build (no ads, no payments, no
analytics). Host it at a public HTTPS URL before submitting — Play rejects a
policy behind a login or a `file://` path.

---

## 5. Graphics checklist

| Asset | Spec | Status |
| --- | --- | --- |
| App icon | 512 × 512 PNG, 32-bit, no transparency | `icon-512.png` exists (verify it is exactly 512 px) |
| Feature graphic | 1024 × 500 PNG/JPEG, no text in the safe area | to design |
| Phone screenshots | 2–8, 16:9 or 9:16, min 320 px, max 3840 px | to capture |
| 7" tablet screenshots | optional | skip unless you want tablet reach |
| Promo video | optional, YouTube | skip |

Screenshot order that sells this app: (1) chat list with a real conversation,
(2) a chat with a voice note and a self-destruct message, (3) the Nearby/Wi-Fi
discovery list, (4) the radar map, (5) the profile showing a Ghost ID, (6) the
"everything is free" screen. No fake numbers, no reviews, no "as seen on" badges.

---

## 6. Data safety form (answers)

Play asks "does your app collect or share user data". Ghost Mesh has no backend,
so the honest answers are:

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | **Yes** (peer-to-peer sharing counts as sharing) |
| Data types | **Messages** (shared with other users, user-initiated), **Photos and videos** (user-selected, shared with other users), **Files and docs** (user-selected), **Audio** (voice notes/calls), **Location** (approximate + precise, only when the user taps share), **Contacts** — none (the app never reads the address book) |
| Is the data encrypted in transit? | **Yes** — WebRTC DTLS |
| Can users request data deletion? | **Yes** — clear a chat, Clear All Chats, or uninstall |
| Is data collected for advertising or analytics? | **No** |
| Is data shared with third parties? | **No** (the relay sees connection metadata only) |
| Is data used for tracking? | **No** |

Do **not** tick "No data collected": the app legally shares messages and location
with other users, and an inaccurate form is a common review rejection.

---

## 7. Content rating questionnaire

| Question | Answer |
| --- | --- |
| Category | Communication / Social |
| Does the app allow users to interact or share content? | **Yes** |
| Can users exchange UGC? | **Yes** (text, photos, voice, video) |
| Does the app provide a way to report and block users? | **Yes** — report + block in the chat menu, and a Blocked Ghosts list |
| Violence / sexuality / drugs / gambling | No |
| Does the app share the user's location with other users? | **Yes**, only when the user taps Share location |
| Expected rating | **Teen / 12+** because of user-generated content |

The report + block path matters: Play's UGC policy requires both, and the app has
them (`blockCurrentPeer`, `reportCurrentPeer`, Blocked Ghosts).

---

## 8. Permissions declaration

Play asks for a written justification for sensitive permissions:

| Permission | Why it is needed (paste this) |
| --- | --- |
| `CAMERA` | Scanning the QR code that pairs two phones, and taking a photo to send in a chat. Nothing is captured in the background. |
| `RECORD_AUDIO` | Voice notes and voice/video calls. The microphone opens only while recording or in a call. |
| `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` | The radar map and the "share my location once" button, both started by the user. Discovery itself does not use location (`neverForLocation` on the Bluetooth/Wi-Fi permissions). |
| `BLUETOOTH_SCAN` / `ADVERTISE` / `CONNECT`, `NEARBY_WIFI_DEVICES` | Finding a nearby phone to chat with when there is no internet. Optional: denied permissions leave online, NSD and QR pairing working. |
| `POST_NOTIFICATIONS` | Telling the user a message or call arrived while the app is in the background. |
| `FOREGROUND_SERVICE_CONNECTED_DEVICE` | Keeping nearby discovery alive for a short time while the user is in another app. |
| `INTERNET` / `ACCESS_NETWORK_STATE` | Online mode handshake and map tiles. |

No `AD_ID` permission is declared: the app has no advertising SDK.

---

## 9. Release notes (max 500 characters, per version)

```
First release. Offline peer-to-peer chat, voice and video calls, file sharing,
QR pairing, nearby discovery over Wi-Fi, and an optional app lock. No account, no
cloud storage, no ads, no in-app purchases — every feature is free.
```

---

## 10. Pre-upload checklist

- [ ] `ghostmesh.versionCode` bumped in `android/gradle.properties` (must strictly increase)
- [ ] `ghostmesh.versionName` updated (e.g. `1.0` → `1.1`)
- [ ] `compileSdk`/`targetSdk` are **36** (Play requires API 36 for new apps and updates)
- [ ] Release keystore configured (`android/README.md` → RELEASE.md), AAB built
- [ ] `privacy.html` reachable at a public HTTPS URL and linked in the console
- [ ] Data safety form filled with the answers in section 6
- [ ] Content rating questionnaire completed (section 7)
- [ ] Icon 512×512, feature graphic 1024×500, at least 2 phone screenshots uploaded
- [ ] Tested on a real phone with two devices for nearby + online chat
- [ ] App access: no login needed, so answer "all functionality is available without special access"
