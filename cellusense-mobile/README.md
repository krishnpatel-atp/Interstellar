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
