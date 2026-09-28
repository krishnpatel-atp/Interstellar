/**
 * Dependency-free SVG charts (works offline, crisp at any size).
 */
import { classifyRisk } from "./analysis.js";

const NS = "http://www.w3.org/2000/svg";
const LOW_MAX = 6.25; // boundary between green and yellow (displayed 6.2 | 6.3)
const OBS_MAX = 7.25; // boundary between yellow and red  (displayed 7.2 | 7.3)

const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fmtDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fmtFull = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function el(tag, attrs, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function niceTimeTicks(t0, t1, count) {
  const span = t1 - t0;
  const H = 3600e3;
  const steps = [H, 2 * H, 3 * H, 6 * H, 12 * H, 24 * H, 2 * 24 * H, 7 * 24 * H, 14 * 24 * H, 30 * 24 * H];
  const step = steps.find(s => span / s <= count) || steps[steps.length - 1];
  const ticks = [];
  // Align ticks to local-time boundaries (midnight, 6 am, …).
  const offset = new Date(t0).getTimezoneOffset() * 60e3;
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t <= t1; t += step) {
    ticks.push(t);
  }
  return { ticks, step };
}

/**
 * pH-over-time chart with risk-zone bands.
 * @param {HTMLElement} container
 * @param {{id:string, ts:number, ph:number}[]} points  oldest → newest
 * @param {{height?:number, compact?:boolean, from?:number, to?:number, onSelect?:(id:string)=>void, highlight?:string}} opts
 */
export function trendChart(container, points, opts = {}) {
  const { compact = false, onSelect, highlight } = opts;
  container.replaceChildren();
  container.style.position = "relative";

  if (!points.length) {
    const empty = document.createElement("div");
    empty.className = "chart-empty";
    empty.textContent = compact
      ? "Scans will appear here over time."
      : "No scans in this period yet. Scan a bandage or load demo data.";
    container.append(empty);
    return;
  }

  const width = Math.max(280, container.clientWidth || 600);
  const height = opts.height || (compact ? 170 : Math.min(340, Math.max(220, width * 0.42)));
  const pad = { l: 34, r: 12, t: 10, b: 26 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;

  let yMin = 4.5;
  let yMax = 9;
  for (const p of points) {
    yMin = Math.min(yMin, Math.floor(p.ph * 2) / 2);
    yMax = Math.max(yMax, Math.ceil(p.ph * 2) / 2);
  }
  let t0 = opts.from ?? points[0].ts;
  let t1 = opts.to ?? points[points.length - 1].ts;
  if (opts.from == null) t0 = Math.min(t0, points[0].ts);
  if (t1 - t0 < 3600e3) {
    const mid = (t0 + t1) / 2;
    t0 = mid - 6 * 3600e3;
    t1 = mid + 6 * 3600e3;
  } else {
    const padT = (t1 - t0) * 0.04;
    t0 -= padT;
    t1 += padT;
  }

  const x = t => pad.l + ((t - t0) / (t1 - t0)) * iw;
  const y = v => pad.t + (1 - (v - yMin) / (yMax - yMin)) * ih;

  const svg = el("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
    "aria-label": `pH trend with ${points.length} scans`,
  });
  const defs = el("defs", {}, svg);
  const grad = el("linearGradient", { id: "area-grad", x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el("stop", { offset: "0", "stop-color": "var(--brand)", "stop-opacity": "0.22" }, grad);
  el("stop", { offset: "1", "stop-color": "var(--brand)", "stop-opacity": "0" }, grad);
  const clip = el("clipPath", { id: `clip-${compact ? "m" : "f"}` }, defs);
  el("rect", { x: pad.l, y: pad.t, width: iw, height: ih }, clip);

  // Zone bands
  const bands = el("g", { "clip-path": `url(#clip-${compact ? "m" : "f"})` }, svg);
  el("rect", { class: "band-low", x: pad.l, width: iw, y: y(LOW_MAX), height: y(yMin) - y(LOW_MAX) }, bands);
  el(
    "rect",
    { class: "band-obs", x: pad.l, width: iw, y: y(OBS_MAX), height: y(LOW_MAX) - y(OBS_MAX) },
    bands,
  );
  el("rect", { class: "band-high", x: pad.l, width: iw, y: y(yMax), height: y(OBS_MAX) - y(yMax) }, bands);

  // Grid + y axis
  const grid = el("g", { class: "grid" }, svg);
  const axis = el("g", { class: "axis" }, svg);
  const yStep = compact ? 1 : 0.5;
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 1e-9; v += yStep) {
    el("line", { x1: pad.l, x2: pad.l + iw, y1: y(v), y2: y(v) }, grid);
    const t = el("text", { x: pad.l - 8, y: y(v) + 4, "text-anchor": "end" }, axis);
    t.textContent = v.toFixed(1);
  }
  el(
    "line",
    {
      class: "threshold",
      x1: pad.l,
      x2: pad.l + iw,
      y1: y(LOW_MAX),
      y2: y(LOW_MAX),
      stroke: "var(--zone-obs)",
    },
    svg,
  );
  el(
    "line",
    {
      class: "threshold",
      x1: pad.l,
      x2: pad.l + iw,
      y1: y(OBS_MAX),
      y2: y(OBS_MAX),
      stroke: "var(--zone-high)",
    },
    svg,
  );

  // X axis ticks
  const { ticks, step } = niceTimeTicks(t0, t1, compact ? 4 : Math.max(3, Math.floor(iw / 90)));
  for (const t of ticks) {
    const label = el("text", { x: x(t), y: height - 6, "text-anchor": "middle" }, axis);
    // Multi-day spans label midnights with the date so days are distinguishable.
    const d = new Date(t);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    const showTime = step < 24 * 3600e3 && !(midnight && t1 - t0 > 24 * 3600e3);
    label.textContent = showTime ? fmtTime.format(t) : fmtDay.format(t);
  }

  // Line + area
  const pts = points.map(p => [x(p.ts), y(p.ph)]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  if (pts.length > 1) {
    el(
      "path",
      {
        class: "area",
        d: `${line}L${pts[pts.length - 1][0].toFixed(1)},${pad.t + ih}L${pts[0][0].toFixed(1)},${pad.t + ih}Z`,
      },
      svg,
    );
    el("path", { class: "line", d: line }, svg);
  }

  const cursor = el("line", { class: "cursor", y1: pad.t, y2: pad.t + ih, visibility: "hidden" }, svg);
  const dots = el("g", {}, svg);
  points.forEach((p, i) => {
    const r = p.id === highlight ? 7 : compact ? 4 : 5;
    el("circle", { class: `pt pt-${classifyRisk(p.ph).id}`, cx: pts[i][0], cy: pts[i][1], r }, dots);
  });

  container.append(svg);

  // Tooltip
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.hidden = true;
  container.append(tip);

  let nearest = -1;
  const locate = evt => {
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * width;
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    pts.forEach((p, i) => {
      const d = Math.abs(p[0] - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return bestD < 40 ? best : -1;
  };
  svg.addEventListener("pointermove", evt => {
    nearest = locate(evt);
    if (nearest < 0) {
      tip.hidden = true;
      cursor.setAttribute("visibility", "hidden");
      return;
    }
    const p = points[nearest];
    const zone = classifyRisk(p.ph);
    tip.innerHTML = `<strong>pH ${p.ph.toFixed(1)}</strong> · ${zone.label} risk<br>${fmtFull.format(p.ts)}`;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / width;
    tip.style.left = `${pts[nearest][0] * scale}px`;
    tip.style.top = `${pts[nearest][1] * scale}px`;
    tip.hidden = false;
    cursor.setAttribute("x1", pts[nearest][0]);
    cursor.setAttribute("x2", pts[nearest][0]);
    cursor.setAttribute("visibility", "visible");
  });
  svg.addEventListener("pointerleave", () => {
    tip.hidden = true;
    cursor.setAttribute("visibility", "hidden");
  });
  if (onSelect) {
    svg.style.cursor = "pointer";
    svg.addEventListener("click", evt => {
      const i = locate(evt);
      if (i >= 0) onSelect(points[i].id);
    });
  }
}

/** Calibration curve plot: pH (x) vs R/G index (y). */
export function curveChart(container, curve, marker = null) {
  container.replaceChildren();
  const pts = [...curve]
    .filter(p => Number.isFinite(p.ph) && Number.isFinite(p.ratio))
    .sort((a, b) => a.ph - b.ph);
  if (pts.length < 2) return;
  const width = Math.max(260, container.clientWidth || 360);
  const height = 200;
  const pad = { l: 36, r: 10, t: 10, b: 26 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const phMin = Math.min(4.5, pts[0].ph);
  const phMax = Math.max(9.5, pts[pts.length - 1].ph);
  const rMax = Math.ceil(Math.max(...pts.map(p => p.ratio)) * 2) / 2 + 0.25;
  const x = v => pad.l + ((v - phMin) / (phMax - phMin)) * iw;
  const y = v => pad.t + (1 - v / rMax) * ih;

  const svg = el("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
    "aria-label": "Calibration curve",
  });
  const grid = el("g", { class: "grid" }, svg);
  const axis = el("g", { class: "axis" }, svg);
  el("rect", { class: "band-low", x: pad.l, y: pad.t, width: x(LOW_MAX) - pad.l, height: ih }, svg);
  el("rect", { class: "band-obs", x: x(LOW_MAX), y: pad.t, width: x(OBS_MAX) - x(LOW_MAX), height: ih }, svg);
  el(
    "rect",
    { class: "band-high", x: x(OBS_MAX), y: pad.t, width: pad.l + iw - x(OBS_MAX), height: ih },
    svg,
  );
  for (let v = 0; v <= rMax + 1e-9; v += 0.5) {
    el("line", { x1: pad.l, x2: pad.l + iw, y1: y(v), y2: y(v) }, grid);
    el("text", { x: pad.l - 6, y: y(v) + 4, "text-anchor": "end" }, axis).textContent = v.toFixed(1);
  }
  for (let v = Math.ceil(phMin); v <= phMax; v += 1) {
    el("text", { x: x(v), y: height - 6, "text-anchor": "middle" }, axis).textContent = `pH ${v}`;
  }
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ph).toFixed(1)},${y(p.ratio).toFixed(1)}`).join("");
  el("path", { class: "curve", d }, svg);
  for (const p of pts) {
    el("circle", { class: `pt pt-${classifyRisk(p.ph).id}`, cx: x(p.ph), cy: y(p.ratio), r: 4.5 }, svg);
  }
  if (marker && Number.isFinite(marker.ph) && Number.isFinite(marker.ratio)) {
    el(
      "circle",
      { cx: x(marker.ph), cy: y(marker.ratio), r: 7, fill: "none", stroke: "var(--text)", "stroke-width": 2 },
      svg,
    );
  }
  container.append(svg);
}
