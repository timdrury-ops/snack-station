# Family Hub for Android (Skylight frame)

A self-contained Android app that turns a jailbroken Skylight Calendar (or any Android tablet) into a family wall display. It shows your calendars, a bulletin board, a screensaver and Home/Alexa controls.

**Nothing personal is hosted anywhere.**

- **The interface ships inside the APK.** The web files (`family-hub/public`) are bundled into the APK and loaded locally in the WebView.
- **Calendars are downloaded by the frame itself.** Native Kotlin code fetches each calendar's private iCal (`.ics`) address, so there are no CORS problems and no server in the middle.
- **Addresses are never in the code.** You paste them into the app's Settings screen, and they are stored only in the app's private storage.
- **Everything else stays private too.** Events you add, notes, photos and the Home Assistant token are stored only in the app's private storage.
- **Backups are disabled,** so none of that leaves the device through Android backup or device transfer.
- **The page is locked down.** It can't navigate to outside websites, and fonts and libraries are bundled, so no third-party requests are made.

|                  |                                                  |
|------------------|--------------------------------------------------|
| Package          | `app.familyhub`                                  |
| Main activity    | `app.familyhub.MainActivity`                     |
| minSdk / target  | 24 (Android 7.0) / 34                            |
| CPU              | Any. No native code, so one APK runs on arm, arm64 and x86 |
| APK after build  | `android/app/build/outputs/apk/debug/app-debug.apk` |

---

## 1. Build the APK

You need **JDK 17+** and the **Android SDK** (platform 34 and build-tools 34). Android Studio installs both. Then:

```bash
cd android
./gradlew assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest      # optional: calendar-download tests
```

Each build copies `family-hub/public` (plus the Snack Station page) into the APK's assets, so edit the web files in one place only.

If the SDK isn't auto-detected, create `android/local.properties` containing `sdk.dir=/path/to/Android/sdk`. That file is git-ignored.

**Release signing (optional).** A debug-signed APK sideloads fine. For a release build, create `android/keystore.properties` with `storeFile`, `storePassword`, `keyAlias` and `keyPassword`, then run `./gradlew assembleRelease`. The properties file and keystores are git-ignored.

## 2. Install and launch (from a computer with ADB)

Install [Android Platform-Tools](https://developer.android.com/tools/releases/platform-tools) on your computer, enable ADB on the frame, then:

```bash
adb devices                                         # the frame must show as "device"
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n app.familyhub/.MainActivity
```

| Task | Command |
|---|---|
| Watch logs | `adb logcat --pid=$(adb shell pidof -s app.familyhub)` (Windows: `adb logcat \| findstr /i familyhub`) |
| Stop the app | `adb shell am force-stop app.familyhub` |
| Wipe all app data (calendars, notes, photos) | `adb shell pm clear app.familyhub` |
| Uninstall | `adb uninstall app.familyhub` |

## 3. Kiosk behavior

- **Full screen:** the status and navigation bars are hidden, and a swipe shows them briefly.
- **Screen stays on** while the app is open. The built-in screensaver handles idle time.
- **Locked orientation:** horizontal by default. Change it in **Settings → Display**, or from a computer:
  ```bash
  adb shell am start -n app.familyhub/.MainActivity --es orientation portrait
  # landscape | portrait | reverse_landscape | reverse_portrait
  ```
- **Back button** closes whatever is open (photo, dialog, screensaver) and never exits the app.
- **Start on boot.** Android 10 and newer only let an app open itself at boot if it is the home app, or if it is allowed to "display over other apps". Do one of these:
  ```bash
  # A) make Family Hub the home screen (most reliable)
  adb shell cmd package set-home-activity app.familyhub/.MainActivity
  # B) keep the stock launcher but allow the boot start
  adb shell appops set app.familyhub SYSTEM_ALERT_WINDOW allow
  ```
  To turn boot start off: `adb shell am start -n app.familyhub/.MainActivity --ez start_on_boot false`

### Restoring the Skylight launcher

Before step A, write down the current home app:

```bash
adb shell cmd package resolve-activity -a android.intent.action.MAIN -c android.intent.category.HOME
adb shell pm list packages | grep -i skylight
```

To undo, use either of these:

- `adb uninstall app.familyhub`, which makes Android fall back to the remaining launcher.
- `adb shell cmd package set-home-activity <launcher.package>/<HomeActivity>`, using the name you wrote down.

If the screen is ever stuck, run `adb shell am force-stop app.familyhub` and then `adb shell input keyevent KEYCODE_HOME`.

## 4. Add your calendars

1. Get each calendar's **private iCal address**:
   - **Google:** Calendar settings → pick the calendar → *Integrate calendar* → **Secret address in iCal format**.
   - **iCloud:** in the Calendar app, share the calendar → **Public Calendar** → copy the link (`webcal://…` is fine).
   - **Outlook:** Settings → Calendar → Shared calendars → **Publish a calendar** → ICS link.
2. On the frame, open **Settings → Calendars → Add calendar**, paste the address, give it a name and a color, and tap **Save**.

Typing long addresses on the frame is painful, so you can send one from a computer instead:

```bash
adb shell am start -n app.familyhub/.MainActivity \
  --es add_calendar_name "Family" --es add_calendar_url "https://calendar.google.com/calendar/ical/…/basic.ics"
```

That puts the address in your computer's shell history, so clear it afterwards (`history -d`, or close the terminal without saving history).

**How syncing works:**

- **Schedule:** the frame checks every **15, 20 or 30 minutes** (Settings → Calendars). It also checks at start-up, when you tap **Sync now**, and as soon as Wi-Fi returns after a failure.
- **Offline copy:** the **last good copy** of each calendar is kept on the device. If the internet or a feed is down, the calendar still shows, with a small "calendar offline" badge.
- **Status in Settings:** each calendar shows when it last updated, or a plain-English error. For example, "The calendar address was rejected (HTTP 404) — it may have been reset; paste the new one".
- **Bandwidth:** the frame only re-downloads when a calendar has changed. It uses the server's ETag/Last-Modified headers.
- **Changing or removing an address** deletes the old calendar's cached copy immediately.
- **Events you add on the frame** are stored only on the device. They don't appear on your phones, because there's no server to publish them.

## 5. Photos, screensaver and Home/Alexa

- **Board photos and screensaver art:** tap **Photo** (Board) or **Upload artwork** (Settings → Screensaver). Pictures are shrunk to a display-friendly size and saved privately on the device.
  - If the frame has no photo-picker app, install a gallery or file-manager APK.
  - To get pictures onto the frame, run `adb push photo.jpg /sdcard/Download/` and then pick them in the app.
- **Home Assistant / Alexa:** in **Settings → Home & Alexa**, enter the Home Assistant address and a long-lived access token.
  - The token is stored natively and is never shown to the page again.
  - The app only allows the small set of actions it needs: toggling lights and switches, scenes, the thermostat, media controls and Alexa commands.

## 6. Privacy checklist

- **Set a Settings PIN** (Settings → General). Without it, anyone at the frame can open Settings and read the calendar addresses.
- **Treat secret iCal addresses like passwords.** Anyone with one can read that calendar. If one leaks, reset it in Google Calendar ("Reset" next to the secret address) and paste the new one.
- **Nothing personal is committed to git.** The repo's `.gitignore` excludes `.env` files, `*.ics`, calendar caches, data folders, signing keys, `local.properties` and all build output, and the source contains no calendar addresses.

## 7. Check on your frame before relying on it

- **Android version:** `adb shell getprop ro.build.version.release` must be 7.0 or newer.
- **Screen size:** `adb shell wm size` (the layout adapts to any size and to vertical mounting).
- **WebView version:** `adb shell dumpsys package com.google.android.webview | grep versionName`. Chromium 90 or newer is best; on some builds the package is `com.android.webview`.
- **Date and time:** the frame's clock must be correct, or secure calendar downloads will fail.
- **Boot start:** if the app doesn't open on boot, use one of the start-on-boot options in section 3.
