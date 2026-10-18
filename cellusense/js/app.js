import {
  DEFAULT_CURVE,
  DEFAULT_REFERENCE,
  GEOMETRY,
  ZONES,
  classifyRisk,
  indicatorColor,
  recommendations,
  round,
  trendAlerts,
  validateCurve,
} from "./analysis.js";
import { Camera } from "./camera.js";
import { curveChart, trendChart } from "./chart.js";
import { LIGHTING } from "./demo.js";
import { toFhirBundle } from "./fhir.js";
import { store, uid, validReference } from "./store.js";

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const fmtDateTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const fmtShort = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/* =========================================================================
 * Analysis engine: a module worker, with a main-thread fallback.
 * ========================================================================= */
const engine = (() => {
  let worker = null;
  let seq = 0;
  const pending = new Map();

  const local = async (type, payload) => {
    const [{ analyzeImage, detectRing }, { renderBandage }] = await Promise.all([
      import("./analysis.js"),
      import("./demo.js"),
    ]);
    const img = payload.image
      ? {
          width: payload.image.width,
          height: payload.image.height,
          data: new Uint8ClampedArray(payload.image.buffer),
        }
      : null;
    if (type === "analyze") return analyzeImage(img, payload.options);
    if (type === "detect") return detectRing(img, payload.options);
    if (type === "demo") return renderBandage(payload);
    throw new Error(`Unknown task ${type}`);
  };

  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.result);
    };
    worker.onerror = e => {
      e.preventDefault?.();
      console.warn("Worker unavailable, analysing on the main thread.", e.message);
      worker?.terminate();
      worker = null;
      for (const [id, job] of pending) {
        pending.delete(id);
        local(job.type, job.payload).then(job.resolve, job.reject);
      }
    };
  } catch {
    worker = null;
  }

  return {
    run(type, payload, transfer = []) {
      if (!worker) return local(type, payload);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        // Keep a copy for fallback in case the worker dies mid-job.
        const copy =
          payload.image && transfer.length
            ? { ...payload, image: { ...payload.image, buffer: payload.image.buffer.slice(0) } }
            : payload;
        pending.set(id, { resolve, reject, type, payload: copy });
        worker.postMessage({ id, type, payload }, transfer);
      });
    },
  };
})();

function packImage(image) {
  const buffer = image.data.buffer.slice(
    image.data.byteOffset,
    image.data.byteOffset + image.data.byteLength,
  );
  return { image: { width: image.width, height: image.height, buffer }, transfer: [buffer] };
}

function analyze(image, options = {}) {
  const { image: packed, transfer } = packImage(image);
  const { curve, reference } = store.settings;
  return engine.run("analyze", { image: packed, options: { curve, reference, ...options } }, transfer);
}

function detect(image, options = {}) {
  const { image: packed, transfer } = packImage(image);
  return engine.run("detect", { image: packed, options }, transfer);
}

/* =========================================================================
 * Small UI helpers
 * ========================================================================= */
function icon(name, cls = "i") {
  return `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
}

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function toast(message, { action, duration = 3800, kind = "info" } = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `${icon(kind === "error" ? "alert" : kind === "success" ? "check" : "info")}<span>${esc(message)}</span>`;
  const close = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  };
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.addEventListener("click", () => {
      action.run();
      close();
    });
    el.append(b);
  }
  $("#toasts").append(el);
  setTimeout(close, duration);
}

function rgbCss(rgb) {
  return `rgb(${rgb.map(v => Math.round(v)).join(",")})`;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function canvasFrom(image) {
  const c = document.createElement("canvas");
  c.width = image.width;
  c.height = image.height;
  c.getContext("2d", { willReadFrequently: true }).putImageData(
    image instanceof ImageData
      ? image
      : new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    0,
    0,
  );
  return c;
}

function imageDataOf(canvas) {
  return canvas
    .getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height);
}

async function loadFile(file, maxDim = 1600) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Unsupported image"));
      };
      img.src = url;
    });
  }
  const w0 = source.width || source.naturalWidth;
  const h0 = source.height || source.naturalHeight;
  const s = Math.min(1, maxDim / Math.max(w0, h0));
  const c = document.createElement("canvas");
  c.width = Math.round(w0 * s);
  c.height = Math.round(h0 * s);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, c.width, c.height);
  source.close?.();
  return c;
}

function loadImageUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = reject;
    img.src = url;
  });
}

/** Small JPEG copies stored with each scan (full photos would fill storage). */
function makePreview(canvas, ring) {
  const s = Math.min(1, 360 / Math.max(canvas.width, canvas.height));
  const p = document.createElement("canvas");
  p.width = Math.round(canvas.width * s);
  p.height = Math.round(canvas.height * s);
  const pctx = p.getContext("2d");
  pctx.imageSmoothingQuality = "high";
  pctx.drawImage(canvas, 0, 0, p.width, p.height);

  const t = document.createElement("canvas");
  t.width = t.height = 96;
  const half = ring.r * 1.15;
  const tctx = t.getContext("2d");
  tctx.imageSmoothingQuality = "high";
  tctx.fillStyle = "#111";
  tctx.fillRect(0, 0, 96, 96);
  tctx.drawImage(canvas, ring.cx - half, ring.cy - half, half * 2, half * 2, 0, 0, 96, 96);

  return {
    preview: p.toDataURL("image/jpeg", 0.74),
    thumb: t.toDataURL("image/jpeg", 0.72),
    ringRel: { cx: ring.cx / canvas.width, cy: ring.cy / canvas.height, r: ring.r / canvas.width },
  };
}

/* =========================================================================
 * Router
 * ========================================================================= */
const VIEWS = ["scan", "result", "trends", "settings"];
let currentView = null;

function route() {
  const name = location.hash.replace("#", "");
  const view = VIEWS.includes(name) ? name : "scan";
  if (view === currentView) return;
  const prev = currentView;
  currentView = view;
  for (const v of $$(".view")) v.hidden = v.dataset.view !== view;
  for (const a of $$(".tabs a")) {
    if (a.dataset.tab === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (prev === "scan") scanView.leave();
  if (view === "scan") scanView.enter();
  if (view === "result") resultView.enter();
  if (view === "trends") trendsView.render();
  if (view === "settings") settingsView.render();
  window.scrollTo({ top: 0 });
}

function go(view) {
  if (location.hash === `#${view}`) route();
  else location.hash = view;
}

/* =========================================================================
 * Scan view
 * ========================================================================= */
const scanView = (() => {
  const video = $("#video");
  const vf = $("#viewfinder");
  const status = $("#vf-status");
  const empty = $("#vf-empty");
  const busyEl = $("#vf-busy");
  const captureBtn = $("#capture");
  const camera = new Camera(video);
  let busy = false;
  let lockTimer = 0;
  let lockStreak = 0;
  let detecting = false;
  let leaveTimer = 0;
  const guide = { cx: 0, cy: 0, r: 0 };

  function layoutGuide() {
    const w = vf.clientWidth;
    const h = vf.clientHeight;
    guide.cx = w / 2;
    guide.cy = h / 2;
    guide.r = Math.min(w, h) * 0.36;
    for (const id of ["#guide-hole", "#guide-ring"]) {
      const c = $(id);
      c.setAttribute("cx", guide.cx);
      c.setAttribute("cy", guide.cy);
      c.setAttribute("r", guide.r);
    }
    const inner = $("#guide-inner");
    inner.setAttribute("cx", guide.cx);
    inner.setAttribute("cy", guide.cy);
    inner.setAttribute("r", guide.r * GEOMETRY.pad);
  }

  /** Maps between on-screen (object-fit: cover) and video-frame coordinates. */
  function coverTransform() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cw = vf.clientWidth;
    const ch = vf.clientHeight;
    const k = Math.max(cw / vw, ch / vh);
    return { k, ox: (cw - vw * k) / 2, oy: (ch - vh * k) / 2, cw };
  }

  function hintFor(scale) {
    const { k, ox, oy, cw } = coverTransform();
    const mirror = camera.facing === "user";
    const gx = mirror ? cw - guide.cx : guide.cx;
    return { cx: ((gx - ox) / k) * scale, cy: ((guide.cy - oy) / k) * scale, r: (guide.r / k) * scale };
  }

  function setStatus(text, locked = false) {
    status.textContent = text;
    vf.classList.toggle("locked", locked);
  }

  function showEmpty(message) {
    empty.hidden = false;
    $("#vf-empty-msg").textContent = message;
    status.hidden = true;
    $("#guide").style.visibility = "hidden";
    captureBtn.disabled = true;
    $("#flip").disabled = true;
  }

  async function start() {
    layoutGuide();
    if (!Camera.supported()) {
      showEmpty(Camera.explain());
      return;
    }
    try {
      setStatus("Starting camera…");
      empty.hidden = true;
      await camera.start();
      status.hidden = false;
      $("#guide").style.visibility = "";
      captureBtn.disabled = false;
      $("#flip").disabled = false;
      $("#torch").hidden = !camera.hasTorch();
      setStatus("Center the bandage ring in the circle");
      loop();
    } catch (err) {
      console.warn(err);
      showEmpty(Camera.explain(err));
    }
  }

  function loop() {
    clearTimeout(lockTimer);
    lockTimer = setTimeout(async () => {
      if (currentView !== "scan" || !camera.active) return;
      if (store.settings.liveLock && !busy && !detecting && !document.hidden) {
        const frame = camera.grab(320);
        if (frame) {
          detecting = true;
          try {
            const ring = await detect(frame.image, { hint: hintFor(frame.scale) });
            showLock(ring, frame.scale);
          } catch {}
          detecting = false;
        }
      } else if (!store.settings.liveLock) {
        setStatus("Center the bandage ring in the circle");
      }
      loop();
    }, 280);
  }

  function showLock(ring, scale) {
    if (currentView !== "scan") return;
    if (!ring.found || ring.confidence < 0.3) {
      lockStreak = 0;
      setStatus("Center the bandage ring in the circle");
      return;
    }
    const { k, ox, oy, cw } = coverTransform();
    let x = (ring.cx / scale) * k + ox;
    if (camera.facing === "user") x = cw - x;
    const lock = $("#lock-ring");
    lock.setAttribute("cx", x);
    lock.setAttribute("cy", (ring.cy / scale) * k + oy);
    lock.setAttribute("r", (ring.r / scale) * k);
    lockStreak++;
    setStatus(store.settings.autoCapture ? "Ring locked — hold steady…" : "Ring locked — tap capture", true);
    if (store.settings.autoCapture && lockStreak >= 4) {
      lockStreak = 0;
      capture();
    }
  }

  async function capture() {
    if (busy || !camera.active) return;
    const frame = camera.grab(1600);
    if (!frame) return;
    const canvas = canvasFrom(frame.image);
    await process(canvas, "camera", { hint: hintFor(frame.scale) });
  }

  async function process(canvas, source, options = {}, extra = {}) {
    if (busy) return;
    busy = true;
    busyEl.hidden = false;
    captureBtn.disabled = true;
    try {
      const analysis = await analyze(imageDataOf(canvas), options);
      const record = createRecord(canvas, analysis, source, extra);
      resultView.show(record, canvas);
      go("result");
      if (analysis.quality === "poor") {
        toast("Low-quality scan — check the ring overlay and adjust if needed.", {
          kind: "error",
          duration: 5000,
        });
      }
    } catch (err) {
      console.error(err);
      toast("Analysis failed. Try another photo.", { kind: "error" });
    } finally {
      busy = false;
      busyEl.hidden = true;
      captureBtn.disabled = !camera.active;
    }
  }

  function createRecord(canvas, analysis, source, extra) {
    const media = makePreview(canvas, analysis.ring);
    return store.addScan({
      id: uid(),
      ts: Date.now(),
      patient: store.settings.patient,
      ph: analysis.ph,
      ratio: analysis.ratio,
      risk: analysis.risk.id,
      quality: analysis.quality,
      source,
      analysis,
      note: "",
      ...media,
      ...extra,
    });
  }

  // Demo controls
  const demoPh = $("#demo-ph");
  const demoLight = $("#demo-light");
  for (const [key, l] of Object.entries(LIGHTING)) {
    demoLight.append(new Option(l.label, key));
  }
  demoLight.value = "warm";
  function updateDemoPreview() {
    const ph = Number(demoPh.value);
    $("#demo-ph-out").textContent = ph.toFixed(1);
    $("#demo-swatch").style.background = rgbCss(indicatorColor(ph));
    const z = classifyRisk(ph);
    $("#demo-zone").textContent = `${z.zone} · ${z.title}`;
  }
  demoPh.addEventListener("input", updateDemoPreview);
  updateDemoPreview();

  $("#demo-scan").addEventListener("click", async () => {
    if (busy) return;
    const ph = Number(demoPh.value);
    const lighting = demoLight.value;
    const jitter = () => (Math.random() - 0.5) * 0.08;
    const width = 720;
    const height = 960;
    busyEl.hidden = false;
    try {
      const img = await engine.run("demo", {
        ph,
        lighting,
        width,
        height,
        cx: width * (0.5 + jitter()),
        cy: height * (0.48 + jitter()),
        r: width * (0.3 + jitter() / 2),
        seed: Math.floor(Math.random() * 1e6),
      });
      busyEl.hidden = true;
      await process(canvasFrom(img), "demo", {}, { demo: { ph, lighting } });
    } catch (err) {
      console.error(err);
      busyEl.hidden = true;
      toast("Couldn't generate the demo bandage.", { kind: "error" });
    }
  });

  // Uploads
  async function onFile(input) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const canvas = await loadFile(file);
      await process(canvas, "upload");
    } catch (err) {
      console.error(err);
      toast("Couldn't read that image. Try a JPEG or PNG.", { kind: "error" });
    }
  }
  $("#file-input").addEventListener("change", e => onFile(e.currentTarget));
  $("#native-input").addEventListener("change", e => onFile(e.currentTarget));

  captureBtn.addEventListener("click", capture);
  $("#flip").addEventListener("click", async () => {
    try {
      await camera.flip();
      $("#torch").hidden = !camera.hasTorch();
    } catch (err) {
      toast(Camera.explain(err), { kind: "error" });
    }
  });
  let torchOn = false;
  $("#torch").addEventListener("click", async () => {
    try {
      torchOn = !torchOn;
      await camera.setTorch(torchOn);
    } catch {
      toast("Light not available on this camera.", { kind: "error" });
    }
  });
  $("#retry-camera").addEventListener("click", start);

  new ResizeObserver(layoutGuide).observe(vf);
  document.addEventListener("visibilitychange", () => {
    if (currentView !== "scan") return;
    if (document.hidden) camera.stop();
    else start();
  });
  document.addEventListener("keydown", e => {
    if (currentView !== "scan" || e.target.closest("input, select, textarea, button")) return;
    if (e.code === "Space" || e.key === "Enter") {
      e.preventDefault();
      capture();
    }
  });

  return {
    enter() {
      clearTimeout(leaveTimer);
      if (!camera.active) start();
      else loop();
    },
    leave() {
      clearTimeout(lockTimer);
      // Keep the camera warm briefly in case the user comes straight back.
      leaveTimer = setTimeout(() => camera.stop(), 1500);
    },
    process,
  };
})();

/* =========================================================================
 * Result view
 * ========================================================================= */
const resultView = (() => {
  const photo = $("#photo");
  const wrap = $("#photo-wrap");
  let current = null; // { id, source: HTMLCanvasElement, ring }
  let adjusting = null;

  function record() {
    return current ? store.getScan(current.id) : null;
  }

  async function show(rec, sourceCanvas = null) {
    let source = sourceCanvas;
    if (!source && rec.preview) {
      try {
        source = await loadImageUrl(rec.preview);
      } catch {}
    }
    let ring = null;
    if (source) {
      ring = sourceCanvas
        ? { ...rec.analysis.ring }
        : rec.ringRel
          ? {
              cx: rec.ringRel.cx * source.width,
              cy: rec.ringRel.cy * source.height,
              r: rec.ringRel.r * source.width,
            }
          : null;
    }
    current = { id: rec.id, source, ring };
    adjusting = null;
    render();
  }

  function render() {
    const rec = record();
    $("#result-empty").hidden = !!rec;
    $("#result-body").hidden = !rec;
    if (!rec) {
      $("#result-time").textContent = "No scan yet";
      return;
    }
    const a = rec.analysis;
    const zone = classifyRisk(rec.ph);
    const rec2 = recommendations(rec.ph);

    $("#result-time").textContent = `${rec.patient} · ${fmtDateTime.format(rec.ts)}${
      rec.source === "demo" ? " · simulated bandage" : ""
    }`;
    const verdict = $("#verdict");
    verdict.dataset.risk = zone.id;
    $("#ph-value").textContent = `pH ${rec.ph.toFixed(1)}`;
    $("#risk-badge").textContent = `Infection Risk: ${zone.label}`;
    $("#zone-name").textContent = zone.zone;
    $("#zone-title").textContent = `· ${zone.title}`;
    const pct = Math.min(100, Math.max(0, ((rec.ph - 4.5) / 4.5) * 100));
    $("#gauge-marker").style.left = `${pct}%`;

    $("#action-card").dataset.risk = zone.id;
    $("#action-headline").textContent = rec2.headline;
    $("#action-list").innerHTML = rec2.actions
      .map(t => `<li>${icon("check")}<span>${esc(t)}</span></li>`)
      .join("");

    const history = store.scansFor(rec.patient).filter(s => s.ts <= rec.ts);
    $("#trend-alerts").innerHTML = trendAlerts(history)
      .map(
        al =>
          `<div class="alert ${al.level === "info" ? "info" : ""}">${icon(al.level === "info" ? "info" : "alert")}<span>${esc(al.text)}</span></div>`,
      )
      .join("");

    // Lighting normalisation details
    $("#sw-raw").style.background = rgbCss(a.center.raw);
    $("#sw-corr").style.background = rgbCss(a.center.corrected);
    $("#rgb-raw").textContent = a.center.raw.join(", ");
    $("#rgb-corr").textContent = a.center.corrected.join(", ");
    const g = a.reference.gains;
    $("#stats").innerHTML = [
      ["R/G index", a.ratio.toFixed(3)],
      ["Lighting", `${a.lighting.cast}, ${a.lighting.level}`],
      ["White ring seen", a.reference.whiteRaw.map(v => Math.round(v)).join(", ")],
      ["Channel gains R·G·B", g.map(v => v.toFixed(2)).join(" · ")],
      [
        "Ring detection",
        a.ring.manual
          ? "Manual"
          : a.ring.found
            ? `${Math.round(a.ring.confidence * 100)}% confidence`
            : "Not found",
      ],
      ["Processing", `${a.ms} ms`],
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`)
      .join("");
    $("#quality").innerHTML =
      `<div class="quality-head">Scan quality <span class="q-badge q-${a.quality}">${a.quality}</span></div>${
        a.issues.length
          ? `<ul class="issues">${a.issues.map(i => `<li>${esc(i.text)}</li>`).join("")}</ul>`
          : ""
      }`;

    $("#note").value = rec.note || "";
    $("#adjust").hidden = !adjusting;
    $("#photo-actions").hidden = !!adjusting;
    $("#adjust-start").disabled = !current.source;
    wrap.classList.toggle("adjusting", !!adjusting);
    drawPhoto();
    renderMini();
  }

  function drawPhoto() {
    const src = current?.source;
    const ctx = photo.getContext("2d");
    if (!src) {
      photo.width = 600;
      photo.height = 300;
      ctx.fillStyle = "#0b1220";
      ctx.fillRect(0, 0, 600, 300);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "600 18px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("Photo not stored for this scan", 300, 155);
      return;
    }
    const s = Math.min(1, 1000 / Math.max(src.width, src.height));
    photo.width = Math.round(src.width * s);
    photo.height = Math.round(src.height * s);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, photo.width, photo.height);
    const ring = adjusting || current.ring;
    if (!ring) return;
    const cx = ring.cx * s;
    const cy = ring.cy * s;
    const r = ring.r * s;
    const lw = Math.max(2, photo.width / 260);
    const found = adjusting || record()?.analysis.ring.found;
    ctx.lineWidth = lw;
    ctx.strokeStyle = found ? "#34d399" : "#f59e0b";
    ctx.shadowColor = "rgba(0,0,0,.6)";
    ctx.shadowBlur = lw * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([lw * 2, lw * 2]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(cx, cy, r * GEOMETRY.whiteInner, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#fbbf24";
    ctx.setLineDash([lw * 2.5, lw * 1.8]);
    ctx.beginPath();
    ctx.arc(cx, cy, r * GEOMETRY.samplePad, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  function renderMini() {
    const rec = record();
    if (!rec) return;
    trendChart($("#mini-chart"), store.scansFor(rec.patient), {
      compact: true,
      highlight: rec.id,
      onSelect: id => openScan(id),
    });
  }

  // Manual ring adjustment ---------------------------------------------------
  const slider = $("#adjust-r");
  $("#adjust-start").addEventListener("click", () => {
    if (!current?.source) return;
    const src = current.source;
    const base = current.ring || {
      cx: src.width / 2,
      cy: src.height / 2,
      r: Math.min(src.width, src.height) * 0.3,
    };
    adjusting = { ...base };
    const minDim = Math.min(src.width, src.height);
    slider.min = String(Math.round(minDim * 0.05));
    slider.max = String(Math.round(minDim * 0.6));
    slider.step = String(Math.max(0.5, minDim / 400));
    slider.value = String(adjusting.r);
    render();
  });
  slider.addEventListener("input", () => {
    if (!adjusting) return;
    adjusting.r = Number(slider.value);
    drawPhoto();
  });
  $("#adjust-cancel").addEventListener("click", () => {
    adjusting = null;
    render();
  });
  $("#adjust-apply").addEventListener("click", async () => {
    if (!adjusting || !current?.source) return;
    const ring = { ...adjusting };
    const btn = $("#adjust-apply");
    btn.disabled = true;
    try {
      const analysis = await analyze(imageDataOf(current.source), { ring });
      const media = makePreview(current.source, analysis.ring);
      store.updateScan(current.id, {
        ph: analysis.ph,
        ratio: analysis.ratio,
        risk: analysis.risk.id,
        quality: analysis.quality,
        analysis,
        ringRel: media.ringRel,
        thumb: media.thumb,
      });
      current.ring = ring;
      adjusting = null;
      render();
      toast(`Re-analyzed: pH ${analysis.ph.toFixed(1)}`, { kind: "success" });
    } catch (err) {
      console.error(err);
      toast("Re-analysis failed.", { kind: "error" });
    } finally {
      btn.disabled = false;
    }
  });

  let drag = null;
  photo.addEventListener("pointerdown", e => {
    if (!adjusting) return;
    photo.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, cx: adjusting.cx, cy: adjusting.cy };
  });
  photo.addEventListener("pointermove", e => {
    if (!adjusting || !drag) return;
    const rect = photo.getBoundingClientRect();
    const k = current.source.width / rect.width;
    adjusting.cx = drag.cx + (e.clientX - drag.x) * k;
    adjusting.cy = drag.cy + (e.clientY - drag.y) * k;
    drawPhoto();
  });
  const endDrag = () => {
    drag = null;
  };
  photo.addEventListener("pointerup", endDrag);
  photo.addEventListener("pointercancel", endDrag);
  photo.addEventListener(
    "wheel",
    e => {
      if (!adjusting) return;
      e.preventDefault();
      adjusting.r = Math.max(
        Number(slider.min),
        Math.min(Number(slider.max), adjusting.r * (e.deltaY < 0 ? 1.03 : 0.97)),
      );
      slider.value = String(adjusting.r);
      drawPhoto();
    },
    { passive: false },
  );

  // Notes & discard ------------------------------------------------------------
  let noteTimer;
  $("#note").addEventListener("input", e => {
    clearTimeout(noteTimer);
    const value = e.currentTarget.value;
    noteTimer = setTimeout(() => current && store.updateScan(current.id, { note: value }), 400);
  });

  $("#discard").addEventListener("click", () => {
    const rec = record();
    if (!rec) return;
    const removed = store.removeScan(rec.id);
    current = null;
    const latest = store.scansFor().at(-1);
    if (latest) show(latest);
    else render();
    toast("Scan discarded.", {
      action: {
        label: "Undo",
        run: () => {
          store.addScan(removed);
          show(removed);
        },
      },
    });
  });

  return {
    show,
    enter() {
      if (!record()) {
        const latest = store.scansFor().at(-1);
        if (latest) {
          show(latest);
          return;
        }
      }
      render();
    },
    refresh() {
      if (currentView === "result") renderMini();
    },
  };
})();

function openScan(id) {
  const rec = store.getScan(id);
  if (!rec) return;
  if (rec.patient !== store.settings.patient) store.updateSettings({ patient: rec.patient });
  resultView.show(rec);
  go("result");
}

/* =========================================================================
 * Trends view
 * ========================================================================= */
const trendsView = (() => {
  let days = 0;

  $("#range").addEventListener("click", e => {
    const b = e.target.closest("button[data-range]");
    if (!b) return;
    days = Number(b.dataset.range);
    for (const x of $$("#range button")) x.setAttribute("aria-pressed", String(x === b));
    render();
  });

  function scansInRange() {
    const all = store.scansFor();
    if (!days) return all;
    const from = Date.now() - days * 86400e3;
    return all.filter(s => s.ts >= from);
  }

  function render() {
    const scans = scansInRange();
    const patient = store.settings.patient;
    $("#trend-sub").textContent = `${patient} · ${scans.length} scan${scans.length === 1 ? "" : "s"}${
      days ? ` in the last ${days === 1 ? "24 hours" : `${days} days`}` : ""
    }`;

    // KPIs
    const latest = scans.at(-1);
    const first = scans[0];
    const peak = scans.reduce((m, s) => (s.ph > (m?.ph ?? -1) ? s : m), null);
    const delta = latest && first && scans.length > 1 ? latest.ph - first.ph : null;
    const zone = latest ? classifyRisk(latest.ph) : null;
    $("#kpis").innerHTML = [
      ["Latest pH", latest ? latest.ph.toFixed(1) : "—", ""],
      [
        "Change",
        delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`,
        delta > 0.05 ? "delta-up" : delta < -0.05 ? "delta-down" : "",
      ],
      ["Peak pH", peak ? peak.ph.toFixed(1) : "—", ""],
      ["Current zone", zone ? zone.label : "—", zone ? `zone-${zone.id}` : ""],
    ]
      .map(
        ([k, v, cls]) =>
          `<div class="kpi"><small>${k}</small><strong class="${cls}">${esc(v)}</strong></div>`,
      )
      .join("");
    const zoneKpi = $("#kpis .kpi:last-child strong");
    if (zone) zoneKpi.style.color = `var(--${zone.id === "observation" ? "obs" : zone.id})`;

    trendChart($("#trend-chart"), scans, {
      from: days ? Date.now() - days * 86400e3 : undefined,
      to: days ? Date.now() : undefined,
      onSelect: openScan,
    });

    // Log
    const log = $("#log");
    if (!scans.length) {
      log.innerHTML = `<li class="chart-empty" style="display:block;cursor:default">No scans yet for ${esc(patient)}.</li>`;
      return;
    }
    log.innerHTML = scans
      .slice()
      .reverse()
      .map(s => {
        const z = classifyRisk(s.ph);
        return `<li data-id="${s.id}" tabindex="0">
          ${s.thumb ? `<img src="${s.thumb}" alt="" loading="lazy" width="52" height="52">` : `<span class="thumb"></span>`}
          <div class="when"><strong>${fmtShort.format(s.ts)} · ${fmtTime.format(s.ts)}</strong>${esc(
            s.note ||
              (s.source?.startsWith("demo")
                ? "Simulated bandage"
                : s.source === "upload"
                  ? "Uploaded photo"
                  : "Camera scan"),
          )}</div>
          <div class="row gap"><span class="ph">${s.ph.toFixed(1)}</span><span class="pill z-${z.id === "observation" ? "obs" : z.id}">${z.label}</span></div>
          <button class="icon-btn" type="button" data-del="${s.id}" aria-label="Delete scan">${icon("trash")}</button>
        </li>`;
      })
      .join("");
  }

  $("#log").addEventListener("click", e => {
    const del = e.target.closest("[data-del]");
    if (del) {
      e.stopPropagation();
      const removed = store.removeScan(del.dataset.del);
      if (removed) {
        render();
        toast("Scan deleted.", {
          action: {
            label: "Undo",
            run: () => {
              store.addScan(removed);
              render();
            },
          },
        });
      }
      return;
    }
    const li = e.target.closest("li[data-id]");
    if (li) openScan(li.dataset.id);
  });
  $("#log").addEventListener("keydown", e => {
    const li = e.target.closest("li[data-id]");
    if (li && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openScan(li.dataset.id);
    }
  });

  $("#export-fhir").addEventListener("click", () => {
    const scans = store.scansFor();
    if (!scans.length) {
      toast("No scans to export yet.");
      return;
    }
    const bundle = toFhirBundle(scans, { patient: store.settings.patient });
    download(
      `cellusense-${store.settings.patient.replace(/[^\w-]+/g, "_")}-fhir.json`,
      JSON.stringify(bundle, null, 2),
      "application/fhir+json",
    );
    toast(`Exported ${scans.length} time-stamped readings in FHIR R4 format.`, { kind: "success" });
  });

  $("#export-csv").addEventListener("click", () => {
    const scans = store.scansFor();
    if (!scans.length) {
      toast("No scans to export yet.");
      return;
    }
    const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      [
        "timestamp",
        "patient",
        "pH",
        "rg_index",
        "risk",
        "zone",
        "quality",
        "source",
        "raw_r",
        "raw_g",
        "raw_b",
        "corrected_r",
        "corrected_g",
        "corrected_b",
        "note",
      ],
      ...scans.map(s => {
        const z = classifyRisk(s.ph);
        const a = s.analysis || {};
        return [
          new Date(s.ts).toISOString(),
          s.patient,
          s.ph.toFixed(2),
          s.ratio?.toFixed(3),
          z.label,
          z.zone,
          s.quality,
          s.source,
          ...(a.center?.raw || ["", "", ""]),
          ...(a.center?.corrected || ["", "", ""]),
          s.note,
        ];
      }),
    ];
    download(
      `cellusense-${store.settings.patient.replace(/[^\w-]+/g, "_")}.csv`,
      rows.map(r => r.map(q).join(",")).join("\n"),
      "text/csv",
    );
  });

  $("#load-demo").addEventListener("click", async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const patient = "Demo · Post-op incision";
    // A realistic course: normal healing, then an alkaline shift signalling infection.
    const course = [5.8, 5.9, 5.7, 6.0, 6.1, 5.9, 6.3, 6.6, 6.8, 7.1, 7.4, 7.9];
    const lights = Object.keys(LIGHTING);
    const now = Date.now();
    const span = 5 * 86400e3;
    store.updateSettings({ patient });
    for (const s of store.scansFor(patient)) if (s.source === "demo-history") store.removeScan(s.id);
    try {
      for (let i = 0; i < course.length; i++) {
        const w = 300;
        const h = 400;
        const img = await engine.run("demo", {
          ph: course[i],
          lighting: lights[i % lights.length],
          width: w,
          height: h,
          r: w * 0.3,
          seed: 100 + i,
        });
        const canvas = canvasFrom(img);
        const analysis = await analyze(img);
        const media = makePreview(canvas, analysis.ring);
        store.addScan({
          id: uid(),
          ts: now - span + (span / (course.length - 1)) * i,
          patient,
          ph: analysis.ph,
          ratio: analysis.ratio,
          risk: analysis.risk.id,
          quality: analysis.quality,
          source: "demo-history",
          analysis,
          note:
            i === 9 ? "Mild redness at incision" : i === 11 ? "Warmth + discharge — surgeon notified" : "",
          ...media,
        });
      }
      toast(`Loaded ${course.length} demo scans for “${patient}”.`, { kind: "success" });
    } catch (err) {
      console.error(err);
      toast("Couldn't create demo data.", { kind: "error" });
    } finally {
      btn.disabled = false;
      render();
    }
  });

  return { render };
})();

/* =========================================================================
 * Settings view
 * ========================================================================= */
const settingsView = (() => {
  let draft = [];

  function renderPatients() {
    const sel = $("#patient-select");
    sel.replaceChildren(...store.patients().map(p => new Option(p, p)));
    sel.value = store.settings.patient;
    $("#patient-input").value = store.settings.patient;
  }

  $("#patient-input").addEventListener("change", e => {
    const name = e.currentTarget.value.trim().slice(0, 40);
    if (!name) {
      e.currentTarget.value = store.settings.patient;
      return;
    }
    store.updateSettings({ patient: name });
    renderPatients();
    toast(`Now scanning for “${name}”.`, { kind: "success" });
  });
  $("#patient-select").addEventListener("change", e => {
    store.updateSettings({ patient: e.currentTarget.value });
    renderPatients();
  });

  $("#opt-live").addEventListener("change", e => store.updateSettings({ liveLock: e.currentTarget.checked }));
  $("#opt-auto").addEventListener("change", e =>
    store.updateSettings({ autoCapture: e.currentTarget.checked }),
  );
  $("#opt-theme").addEventListener("change", e => {
    const theme = e.currentTarget.value;
    store.updateSettings({ theme });
    applyTheme();
    trendsView.render();
  });

  // Calibration curve editor ---------------------------------------------------
  function renderCurve() {
    const tbody = $("#curve-table tbody");
    tbody.innerHTML = draft
      .map(
        (p, i) => `<tr>
          <td><input class="input" type="number" step="0.1" min="3" max="11" value="${p.ph}" data-i="${i}" data-k="ph" aria-label="pH"></td>
          <td><input class="input" type="number" step="0.001" min="0.01" max="10" value="${p.ratio}" data-i="${i}" data-k="ratio" aria-label="R/G index"></td>
          <td><button class="icon-btn" type="button" data-rm="${i}" aria-label="Remove point">${icon("x")}</button></td>
        </tr>`,
      )
      .join("");
    drawCurve();
  }

  function drawCurve() {
    const last = store.scansFor().at(-1);
    curveChart($("#curve-chart"), draft, last ? { ph: last.ph, ratio: last.ratio } : null);
    const err = validateCurve(draft);
    $("#curve-error").textContent = err || "";
  }

  $("#curve-table").addEventListener("input", e => {
    const input = e.target.closest("input[data-i]");
    if (!input) return;
    draft[Number(input.dataset.i)][input.dataset.k] = Number.parseFloat(input.value);
    drawCurve();
  });
  $("#curve-table").addEventListener("click", e => {
    const rm = e.target.closest("[data-rm]");
    if (!rm) return;
    draft.splice(Number(rm.dataset.rm), 1);
    renderCurve();
  });
  $("#curve-add").addEventListener("click", () => {
    const lastPt = [...draft].sort((a, b) => a.ph - b.ph).at(-1);
    draft.push({
      ph: round((lastPt?.ph ?? 8.5) + 0.5, 1),
      ratio: round(Math.max(0.05, (lastPt?.ratio ?? 0.5) * 0.85), 3),
    });
    renderCurve();
  });
  $("#curve-from-scan").addEventListener("click", () => {
    const last = store.scans.at(-1);
    if (!last) {
      toast("Scan a buffer-soaked square first.");
      return;
    }
    const answer = prompt(
      `Latest scan R/G index: ${last.ratio.toFixed(3)}\nWhat is the known pH of the buffer solution?`,
      "7.0",
    );
    if (answer == null) return;
    const ph = Number.parseFloat(answer);
    if (!Number.isFinite(ph) || ph < 3 || ph > 11) {
      toast("Enter a pH between 3 and 11.", { kind: "error" });
      return;
    }
    const existing = draft.find(p => Math.abs(p.ph - ph) < 1e-6);
    if (existing) existing.ratio = last.ratio;
    else draft.push({ ph: round(ph, 2), ratio: last.ratio });
    draft.sort((a, b) => a.ph - b.ph);
    renderCurve();
    toast("Point added — review, then Save curve.");
  });
  $("#curve-save").addEventListener("click", () => {
    const clean = draft
      .map(p => ({ ph: round(p.ph, 2), ratio: round(p.ratio, 3) }))
      .sort((a, b) => a.ph - b.ph);
    const err = validateCurve(clean);
    if (err) {
      $("#curve-error").textContent = err;
      return;
    }
    store.updateSettings({ curve: clean });
    draft = clean.map(p => ({ ...p }));
    renderCurve();
    toast("Calibration saved. New scans will use it.", { kind: "success" });
  });
  $("#curve-reset").addEventListener("click", () => {
    draft = DEFAULT_CURVE.map(p => ({ ...p }));
    store.updateSettings({ curve: draft.map(p => ({ ...p })) });
    renderCurve();
    toast("Calibration reset to default.");
  });

  // Reference ring -------------------------------------------------------------
  function renderReference() {
    const ref = store.settings.reference;
    for (let i = 0; i < 3; i++) {
      $(`#ref-w${i}`).value = ref.white[i];
      $(`#ref-k${i}`).value = ref.black[i];
    }
  }
  $("#ref-save").addEventListener("click", () => {
    const ref = {
      white: [0, 1, 2].map(i => Number($(`#ref-w${i}`).value)),
      black: [0, 1, 2].map(i => Number($(`#ref-k${i}`).value)),
    };
    if (!validReference(ref)) {
      toast("Use 0–255 values, with white at least 40 above black in every channel.", { kind: "error" });
      return;
    }
    store.updateSettings({ reference: ref });
    toast("Reference colours saved.", { kind: "success" });
  });
  $("#ref-reset").addEventListener("click", () => {
    store.updateSettings({
      reference: { white: [...DEFAULT_REFERENCE.white], black: [...DEFAULT_REFERENCE.black] },
    });
    renderReference();
    toast("Reference colours reset.");
  });

  // Data -----------------------------------------------------------------------
  $("#export-json").addEventListener("click", () =>
    download(
      `cellusense-backup-${new Date().toISOString().slice(0, 10)}.json`,
      store.exportData(),
      "application/json",
    ),
  );
  $("#import-json").addEventListener("change", async e => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!file) return;
    try {
      const n = store.importData(await file.text());
      render();
      toast(`Imported ${n} scans.`, { kind: "success" });
    } catch {
      toast("That file isn't a CelluSense backup.", { kind: "error" });
    }
  });
  $("#clear-data").addEventListener("click", () => {
    if (!confirm("Delete all scans, patients and calibration on this device? This can't be undone.")) return;
    store.clear();
    render();
    toast("All data deleted.");
  });

  function render() {
    renderPatients();
    $("#opt-live").checked = store.settings.liveLock;
    $("#opt-auto").checked = store.settings.autoCapture;
    $("#opt-theme").value = store.settings.theme;
    draft = store.settings.curve.map(p => ({ ...p }));
    renderCurve();
    renderReference();
  }

  return { render, drawCurve };
})();

/* =========================================================================
 * Global wiring
 * ========================================================================= */
function applyTheme() {
  const t = store.settings.theme;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  $('meta[name="theme-color"]').content = dark ? "#070b14" : "#0f766e";
}

function updatePatientChip() {
  $("#patient-name").textContent = store.settings.patient;
}

$("#patient-chip").addEventListener("click", () => {
  go("settings");
  setTimeout(() => $("#patient-input").focus(), 50);
});

let lastPatient = store.settings.patient;
store.subscribe(() => {
  updatePatientChip();
  if (store.settings.patient !== lastPatient) {
    lastPatient = store.settings.patient;
    if (currentView === "trends") trendsView.render();
  }
  resultView.refresh();
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentView === "trends") trendsView.render();
    if (currentView === "result") resultView.refresh();
    if (currentView === "settings") settingsView.drawCurve();
  }, 150);
});

// Offline support + install prompt ---------------------------------------------
async function setupOffline() {
  const statusEl = $("#offline-status");
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    statusEl.textContent =
      "Offline mode needs HTTPS or localhost. The app still works while this page stays open.";
    return;
  }
  try {
    await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    statusEl.innerHTML = `${icon("check")} Ready to work offline — no internet needed during your demo.`;
  } catch (err) {
    console.warn(err);
    statusEl.textContent = "Offline caching is unavailable in this browser.";
  }
}

let installEvent = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  installEvent = e;
  $("#install").hidden = false;
});
$("#install").addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  $("#install").hidden = true;
});

applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
updatePatientChip();
window.addEventListener("hashchange", route);
route();
setupOffline();

// Exposed for debugging from the browser console.
window.CelluSense = { store, ZONES };
