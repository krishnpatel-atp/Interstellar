# CelluSense — Smart Bandage Scanner

A working camera-to-data prototype for the CelluSense pH-sensing hydrogel bandage.
Snap a photo of the bandage → the app finds the printed calibration ring, corrects for
room lighting, measures the indicator pad's **R/G ratio**, converts it to **wound pH**,
scores **infection risk**, recommends an action, and logs it to a **trend chart**.

Runs in any modern browser on phones, tablets and laptops. No build step, no internet
needed once loaded (installable, offline-capable PWA). All data stays on the device.

## Run it in VS Code

1. **File → Open Folder…** and pick this `cellusense` folder.
2. Accept the recommended extensions when prompted (Biome for formatting).
3. Press **F5** (“Run CelluSense in Chrome”) — this starts the server and opens the app.
   Or in the terminal: `npm start`, then open http://localhost:5173.
4. Run the tests: **Terminal → Run Task… → Run tests** (or `npm test`).

Requires [Node.js](https://nodejs.org) 18+. `npm start` and `npm test` need no `npm install`
(only `npm run lint`/`format` use the Biome dev dependency).

## The three core screens

| Screen | What it does |
| --- | --- |
| **Scan** | Live camera with a circular target overlay. The ring outline turns green when the calibration ring is detected (“Ring locked”). Capture, upload a photo, use the phone's camera app, or generate a **Demo bandage** at any pH and lighting. |
| **Results** | Calculated pH (e.g. **pH 7.8**), risk badge (**Infection Risk: High**), zone gauge, recommended clinical actions (**Alert care team / Clean wound site**), trend alerts, the photo with the detected ring, and the lighting-normalization details (raw vs corrected colour, channel gains, scan quality). The ring can be adjusted by hand and re-analyzed. |
| **Trends** | pH over time with green/yellow/red zone bands, tap-to-inspect points, 24 h / 7 d / 30 d / all ranges, KPIs, a scan log and CSV export. **Demo data** loads a realistic 5-day infection course. |

## The algorithm (`js/analysis.js`)

1. **Ring detection** – a coarse-to-fine circle search scores candidate circles by how much
   they look like a bright white ring enclosed by a black ring (contrast, uniformity, low colour).
2. **Lighting normalization** – the median colour of the white ring and the black ring are
   compared with their known printed values. In *linear light*, each channel gets
   `corrected = refBlack + (c − seenBlack) × (refWhite − refBlack) / (seenWhite − seenBlack)`,
   which removes colour casts (warm bulbs, fluorescent), brightness changes and — because the
   ring is sampled all the way round — even-gradient shadows.
3. **Pad sampling** – a trimmed mean of the central indicator disc, skipping glare pixels.
4. **Index = R<sub>center</sub> / G<sub>center</sub>** of the corrected colour.
5. **pH** – piecewise-linear interpolation of the calibration curve (editable in Settings).
6. **Risk zones**
   - 🟢 **Green** pH 5.5–6.2 · Normal healing process
   - 🟡 **Yellow** pH 6.3–7.2 · Elevated alkaline shift — flag for observation
   - 🔴 **Red** pH ≥ 7.3 · High risk of surgical site infection — notify care team

Accuracy on simulated photos: within ±0.1 pH under daylight, warm bulb, fluorescent, dim/shadow
and LED lighting (verified by `tests/analysis.test.js`). Without normalization, warm light
shifts readings by 0.3–0.5 pH — enough to miss a yellow-zone wound.

## Making the physical prototype scannable

Print [`ring-template.svg`](ring-template.svg) at 100% scale and put the hydrogel film in the
centre of a ring. Then in **Settings**:

- **Reference ring** – photograph a clean ring in daylight and enter the white/black RGB the
  camera sees (defaults: white 240, black 30).
- **Calibration curve** – soak squares in known buffers (vinegar ≈ pH 5.5, baking soda ≈ pH 8.5,
  plus any others you have), scan each, then use **“Add latest scan as known pH…”** and **Save curve**.
  Natural cabbage/turmeric colours vary batch to batch, so this step makes real readings accurate.

## Live pitch checklist (offline & reliable)

- Open the app once while online — it is then cached for offline use (Settings shows
  “Ready to work offline”). On a phone, use **Install app / Add to Home Screen**.
- The **live camera** needs HTTPS or `localhost`. For a phone/tablet, either
  - host the folder on any static HTTPS host (GitHub Pages, Netlify, Vercel), or
  - run `npm start` on your laptop and use **“Use phone camera app”** on the phone (works over plain HTTP), or
  - start with a certificate: `HTTPS_KEY=key.pem HTTPS_CERT=cert.pem npm start`.
- Backup plan: the **Demo bandage** and **Demo data** buttons always work, with no camera.
- Good light, fill the circle with the ring, avoid flash glare on the white ring.

## Project layout

```
index.html            App shell (3 core screens + settings)
css/styles.css        Design system, light/dark themes, responsive layout
js/analysis.js        Ring detection, lighting normalization, R/G → pH, risk scoring (pure, tested)
js/demo.js            Simulated bandage photos under different lighting
js/app.js             UI controller: camera, results, trends, settings
js/camera.js          getUserMedia wrapper (flip, torch, frame grab)
js/chart.js           Dependency-free SVG trend + calibration charts
js/store.js           On-device storage (localStorage)
js/worker.js          Runs analysis off the main thread
sw.js                 Offline cache (service worker)
server.js             Zero-dependency dev server
tests/                Node test suite (npm test)
ring-template.svg     Printable calibration rings
```

> CelluSense is a student research prototype and is not a certified medical device.
