# CelluSense Mobile (Expo Go)

The native phone version of the CelluSense smart-bandage scanner. It uses the same
lighting-normalized R/G → pH engine as the web app (`../cellusense`).

## Run it on your phone with Expo Go

1. Install **Expo Go** on your phone (App Store / Google Play). It must support **SDK 58**.
2. In VS Code, open this `cellusense-mobile` folder and click **Trust** if VS Code shows
   “Restricted Mode” (otherwise the terminal can't run the project).
3. Open the terminal (**Terminal → New Terminal**) and run:

   ```bash
   npm install
   npx expo start
   ```

4. A **QR code** appears in the terminal.
   - **iPhone:** scan it with the Camera app.
   - **Android:** scan it from inside Expo Go.

Your phone and computer must be on the **same Wi-Fi**. On school or other locked-down
networks, use `npx expo start --tunnel` instead.

## VS Code ↔ Expo Go (one-click)

Open this folder in VS Code (**File → Open Folder…**, then **Trust**). Install the
recommended extensions when prompted (**Expo Tools**, React Native Tools, Biome).

| What | How |
| --- | --- |
| Start + QR code | **Terminal → Run Build Task…** (⇧⌘B) → *Expo Go: start (same Wi-Fi)* |
| Testers on another network / school Wi-Fi | **Terminal → Run Task…** → *Expo Go: start with tunnel* |
| App shows old code or a red error | **Run Task…** → *Expo Go: start and clear cache* |
| Debug (breakpoints in VS Code) | **Run and Debug** (⇧⌘D) → *Debug app in Expo Go* → ▶ |

While it runs, every time you **save a file in VS Code the app on the phone reloads
instantly** (Fast Refresh). Shake the phone to open the Expo menu.

### Beta testing with friends / teammates

- **Live session (easiest):** run the *tunnel* task (it asks you to `npx expo login` once — SDK 58 tunnels need your Expo account) and send testers a screenshot of the
  QR code. They install Expo Go (SDK 58) and scan it. It works from anywhere, as long as
  your laptop keeps the task running.
- **Without your laptop running:** publish with EAS Update:
  ```bash
  npx eas-cli@latest login        # your Expo account (krishnpatel1234)
  npx eas-cli@latest update:configure
  npm run beta:publish
  ```
  The update appears on expo.dev under the *cellusense* project. Opening it in Expo Go
  works for accounts you invite to the project; for testers outside it, make a
  development build (`npx eas-cli@latest build --profile development`) or a TestFlight / internal
  Android build.

## Screens

- **Scan:** live camera with a circular target; capture, pick a photo, or scan a simulated
  demo bandage at any pH and lighting.
- **Results:** pH (e.g. *pH 7.8*), *Infection Risk: High*, a zone gauge, recommended actions,
  trend alerts, the photo with the detected ring, and raw-vs-corrected colour details.
- **Trends:** pH over time with green / yellow / red zones, KPIs and a scan log
  (tap to open, long-press to delete). **Load demo data** shows a 5-day infection course.
- **Settings:** patient ID, calibration curve (add buffer-solution readings), reference ring, data.

## How it works on the phone

Expo Go has no canvas, so `src/image.js` resizes the photo with `expo-image-manipulator`,
gets a JPEG as base64, and decodes it to pixels with `jpeg-js`. The pixels go through
`src/analysis.js`: ring detection → white/black reference correction in linear light →
`Index = R_center / G_center` → pH → risk zone.

`npm test` checks that pipeline on JPEG photos of simulated bandages under five
lighting conditions (it needs Python 3 with Pillow to make the test JPEGs).

> Student research prototype — not a certified medical device.
