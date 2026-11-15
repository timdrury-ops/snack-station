# Family Hub

A wall-display app for a jailbroken Skylight Calendar (or any Android tablet or touchscreen). It has:

- **📅 Synced calendar**: month, week and list views. It pulls in Google, iCloud, Outlook, school and sports calendars, and you can add events from the screen itself.
- **📌 Bulletin board**: a corkboard of pinned photos from a Dropbox folder, plus sticky notes. Tap a photo to see it full size, and swipe to flip through them.
- **🌙 Screensaver**: a slideshow of your own artwork with an optional clock, date and "next event" line.
- **📷 Wyze cameras**: snapshot tiles, and you tap one for live video. This goes through docker-wyze-bridge.
- **💡 Home and Alexa**: light and plug tiles, Echo playback controls, and "tell Alexa…" commands. This goes through Home Assistant.
- **🥨 Snack Station**: the existing snack tracker in this repo, available as an optional tab.

---

## How it fits together

```
 ┌──────────────────────┐        ┌──────────────────────────────┐
 │ Skylight (Android)   │  Wi-Fi │ Home server (Pi / PC / NAS)  │
 │ Fully Kiosk Browser  ├───────►│ Family Hub  :3000            │──► Google/iCloud .ics feeds
 │ → http://SERVER:3000 │        │ wyze-bridge :8889 (optional) │──► Dropbox API
 └──────────────────────┘        │ Home Assistant (optional)    │──► Wyze / Alexa clouds
                                 └──────────────────────────────┘
```

The Skylight only runs a full-screen browser. All the logic and API keys stay on a small always-on computer at home, which keeps the display light and makes updates painless. A Raspberry Pi 4 or 5 is plenty.

> **Calendar and board only?** You can run the server on the Skylight itself in Termux (`pkg install nodejs`, then `npm start`) and point the browser at `http://localhost:3000`. The cameras and Alexa features need Home Assistant and wyze-bridge, which belong on a real server.

---

## 1. Run the server

**With Docker (recommended):**

```bash
cd family-hub
cp .env.example .env        # fill in what you use
docker compose up -d
```

**Without Docker** (Node 20+):

```bash
cd family-hub
npm install
cp .env.example .env
set -a; . ./.env; set +a; npm start
```

Open `http://<server-ip>:3000` on any phone or computer on your Wi-Fi to check it works. Every setting can be changed from there as well as from the wall screen.

Data (settings, events you add, notes, uploaded pictures) lives in `family-hub/data/`. Back that folder up.

## 2. Set up the Skylight

On the jailbroken device:

1. Install **Fully Kiosk Browser** (APK from fully-kiosk.com). Also update **Android System WebView** or Chrome if you can, because the app wants Chromium 90 or newer.
2. In Fully: set **Start URL** to `http://<server-ip>:3000` and turn on **Keep Screen On**. Under *Device Management*, enable **Launch on Boot** and set Fully as the **Home/Launcher app**.
3. Turn **off** Fully's own screensaver and its "reload on idle" option. Family Hub has its own screensaver.
4. Give the server a **fixed IP**, using a DHCP reservation in your router, so the URL never changes.

### Vertical or horizontal

Family Hub works hung either way and switches layouts on its own, even mid-use:

- **Horizontal:** the menu runs down the left side, and the calendar has today's events beside it.
- **Vertical:** the menu moves to a bottom bar, like a phone. Today's events sit under the calendar, and the week view shows one row per day.
- **Screensaver:** art shaped like the screen fills it. Art in the other orientation is shown whole on a blurred copy of itself, so there are no black bars.

A wall-mounted frame may not rotate on its own, so tell Android which way it's mounted. In Fully Kiosk, go to *Device Management → Screen Orientation* and choose **Portrait** or **Landscape** rather than *Auto*.

## 3. Calendars

Go to **Settings → Calendars → Add calendar** and paste each calendar's *secret iCal address*:

| Service | Where to find the address |
|---|---|
| Google | calendar.google.com → ⚙ → pick the calendar → **Secret address in iCal format** |
| iCloud | Calendar app → share icon next to the calendar → **Public Calendar** → copy link (`webcal://` works) |
| Outlook | Settings → Calendar → Shared calendars → **Publish a calendar** → ICS link |
| School / sports | Look for "Subscribe", "iCal" or "Export" |

Feeds refresh every 10 minutes. If a feed goes offline, the display keeps showing the last good copy and a small ⚠ badge appears.

**Events added on the wall screen** go into the built-in "Family" calendar. To see them on your phones, subscribe to `http://<server-ip>:3000/calendar.ics`. On Google, use *Other calendars → From URL*. On iPhone, use *Settings → Calendar → Accounts → Add Subscribed Calendar*. That address only works on home Wi-Fi unless you expose it with something like Tailscale.

> Synced feeds are read-only on the display, so you edit those events in Google or iCloud as usual. Full two-way editing of Google events (Google OAuth) would be the natural next step.

## 4. Dropbox (bulletin board and screensaver art)

1. Go to <https://www.dropbox.com/developers/apps> → **Create app** → *Scoped access* → **App folder** → name it, for example, "FamilyHub".
2. On the **Permissions** tab, tick `files.metadata.read`, `files.content.read` and `files.content.write`, then **Submit**.
3. On the **Settings** tab, copy the **App key** and **App secret** into `.env`, then restart the server.
4. On the display, open **Settings → Dropbox → Get code**. Sign in, paste the code back, and tap **Connect**.

Dropbox creates `Apps/FamilyHub/Bulletin Board` and `Apps/FamilyHub/Screensaver`. Anything you drop into those folders from your phone's Dropbox app shows up within a minute. Dropbox shrinks big phone photos (and converts HEIC iPhone photos) before they reach the display, so it stays snappy.

You can also skip Dropbox and use the **Add photo** and **Upload artwork** buttons, which store pictures on the server. If the Screensaver folder is empty, the screensaver uses the board photos instead.

## 5. Screensaver

Under **Settings → Screensaver** you can choose:

- the idle time before it starts
- how long each picture stays up
- whether to show the clock, date and next event, and where the clock sits
- a slow-zoom effect

Landscape art fills the screen, and portrait art is shown whole without cropping. The 🌙 **Sleep** button starts it right away, and a tap anywhere wakes the screen. That waking tap doesn't press anything underneath.

## 6. Wyze cameras

Wyze has no official way for other apps to show your cameras. The community project **[docker-wyze-bridge](https://github.com/mrlt8/docker-wyze-bridge)** logs into your Wyze account and re-streams each camera on your network.

1. Get an API ID and key at <https://developer-api-console.wyze.com>.
2. Uncomment the `wyze-bridge` block in `docker-compose.yml`, fill it in, and run `docker compose up -d`.
3. Open `http://<server-ip>:5000` to see your camera names. They are lowercased with dashes, for example `front-door`.
4. In **Settings → Cameras**, add each one:
   - Live: `http://<server-ip>:8889/front-door/`
   - Snapshot: `http://<server-ip>:5000/snapshot/front-door.jpg`

The Cameras tab refreshes snapshots every 10 seconds and opens WebRTC live video when you tap a tile. Caveats: this is unofficial, so a Wyze firmware or cloud change can break it until the bridge updates. Some newer models, such as certain v4 and battery cams, may not be supported.

## 7. Alexa and smart home

Amazon offers no public API to control Echo devices or "Alexa" from another app. The working route is **Home Assistant**, which is free and runs on the same Pi:

1. Install Home Assistant, then install **HACS** and the **Alexa Media Player** integration. That integration signs into your Amazon account and adds each Echo as a `media_player`.
2. Add your lights and plugs to Home Assistant directly. Most brands that work with Alexa (Hue, Kasa, Govee, Wyze bulbs and plugs, and so on) have integrations.
3. In Home Assistant, open your profile → **Long-lived access tokens** → create one. Put it and the URL into `.env` as `HA_URL` / `HA_TOKEN`, then restart the server.
4. On the display, open **Settings → Home & Alexa** and tick the devices to show, plus which speakers count as "Alexa".

The Home tab then gives you:

- tiles that toggle lights, switches, fans, scenes and scripts, and open covers; locks ask you to confirm before unlocking
- a thermostat tile with − and + buttons
- an **Alexa** panel to pick an Echo and type or tap a command such as "turn off all lights" or "play relaxing music". The command runs on that Echo exactly as if you'd said it, so your Alexa routines and skills work too.
- an **Announce** option that broadcasts a message out loud
- play/pause, skip and volume controls for the chosen Echo

The Home Assistant token stays on the server. The display can only call the small set of actions listed in `lib/homeassistant.js`.

## Look and theme

There are two separate color choices.

**App color** sets the whole interface. Go to **Settings → General → App color** and tap a preset (blue, red, green, teal, purple, orange, pink or graphite) or the **+** to choose any color. The screen previews it live, and the color is kept once you tap **Save**. The app builds one color family from it, with white doing most of the work:

- **Near-white tints** for the backgrounds, the board and the today highlight.
- **The color itself** for buttons, the selected tab, push pins and devices that are switched on.
- **Deep shades** for text.

Pick **graphite** for a black-and-white look.

**Calendar colors** are chosen one calendar at a time, so you can tell them apart at a glance. Go to **Settings → Calendars** and tap a calendar's color dot. Choose from 12 distinct colors, or tap **+** for any color. New calendars start with a color that isn't already in use. Each calendar's color shows on its events in every view, and these colors don't change when you change the app color.

The look is clean and modern, using the Inter typeface and thin line icons.

Under **Settings → General → Theme** you can choose:

- **Light**
- **Dark**, which uses the same color on deep, tinted backgrounds.
- **Automatic**, which switches to dark from 9 PM to 7 AM.

Photos and screensaver art always keep their own colors.

## Settings PIN

Set a PIN in **Settings → General** to stop little hands from changing settings or deleting photos and events. Adding events and notes still works without the PIN.

## Project layout

```
family-hub/
  server.js              Express server + API routes
  lib/calendar.js        .ics sync, recurring events, local events, /calendar.ics feed
  lib/dropbox.js         Dropbox OAuth (refresh token), list/thumbnail/upload/delete
  lib/media.js           board & screensaver picture lists (Dropbox + local), image cache
  lib/homeassistant.js   Home Assistant + Alexa Media Player bridge (allow-listed)
  lib/store.js           JSON settings/data files
  public/                the display: index.html, app.css, app.js (no build step)
```
