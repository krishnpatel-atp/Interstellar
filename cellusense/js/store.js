/**
 * Local persistence. Everything lives in localStorage on the device — no
 * network, so the app works fully offline during a pitch.
 */
import { DEFAULT_CURVE, DEFAULT_REFERENCE, validateCurve } from "./analysis.js";

const KEY = "cellusense:v1";
const MAX_SCANS = 1000;

const DEFAULT_SETTINGS = {
  patient: "Patient A",
  liveLock: true,
  autoCapture: false,
  theme: "system",
  curve: DEFAULT_CURVE.map(p => ({ ...p })),
  reference: { white: [...DEFAULT_REFERENCE.white], black: [...DEFAULT_REFERENCE.black] },
};

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && typeof raw === "object") {
      const settings = { ...structuredClone(DEFAULT_SETTINGS), ...(raw.settings || {}) };
      if (validateCurve(settings.curve)) settings.curve = structuredClone(DEFAULT_SETTINGS.curve);
      if (!validReference(settings.reference)) {
        settings.reference = structuredClone(DEFAULT_SETTINGS.reference);
      }
      const scans = Array.isArray(raw.scans) ? raw.scans.filter(validScan) : [];
      return { settings, scans };
    }
  } catch {}
  return { settings: structuredClone(DEFAULT_SETTINGS), scans: [] };
}

function validScan(s) {
  return s && typeof s.id === "string" && Number.isFinite(s.ts) && Number.isFinite(s.ph);
}

export function validReference(ref) {
  const ok = arr =>
    Array.isArray(arr) && arr.length === 3 && arr.every(v => Number.isFinite(v) && v >= 0 && v <= 255);
  return !!ref && ok(ref.white) && ok(ref.black) && ref.white.every((w, i) => w - ref.black[i] >= 40);
}

const state = load();
const listeners = new Set();

function persist() {
  const write = () => localStorage.setItem(KEY, JSON.stringify(state));
  try {
    write();
  } catch {
    // Storage full: drop photo previews from the oldest scans, then retry.
    for (const s of state.scans) {
      if (s.preview) {
        s.preview = undefined;
        try {
          write();
          return;
        } catch {}
      }
    }
    try {
      write();
    } catch (err) {
      console.error("Could not save CelluSense data", err);
    }
  }
}

function emit() {
  for (const fn of listeners) fn(state);
}

export const store = {
  get settings() {
    return state.settings;
  },
  get scans() {
    return state.scans;
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  updateSettings(patch) {
    Object.assign(state.settings, patch);
    persist();
    emit();
  },
  addScan(scan) {
    state.scans.push(scan);
    state.scans.sort((a, b) => a.ts - b.ts);
    if (state.scans.length > MAX_SCANS) state.scans.splice(0, state.scans.length - MAX_SCANS);
    persist();
    emit();
    return scan;
  },
  updateScan(id, patch) {
    const s = state.scans.find(x => x.id === id);
    if (!s) return null;
    Object.assign(s, patch);
    persist();
    emit();
    return s;
  },
  removeScan(id) {
    const i = state.scans.findIndex(x => x.id === id);
    if (i === -1) return null;
    const [removed] = state.scans.splice(i, 1);
    persist();
    emit();
    return removed;
  },
  getScan(id) {
    return state.scans.find(x => x.id === id) || null;
  },
  scansFor(patient = state.settings.patient) {
    return state.scans.filter(s => s.patient === patient);
  },
  patients() {
    return [...new Set([state.settings.patient, ...state.scans.map(s => s.patient)])].filter(Boolean);
  },
  exportData() {
    return JSON.stringify(
      { app: "CelluSense", version: 1, exported: new Date().toISOString(), ...state },
      null,
      2,
    );
  },
  importData(json) {
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.scans)) throw new Error("Not a CelluSense backup");
    const scans = data.scans.filter(validScan);
    const known = new Set(state.scans.map(s => s.id));
    for (const s of scans) if (!known.has(s.id)) state.scans.push(s);
    state.scans.sort((a, b) => a.ts - b.ts);
    if (data.settings && typeof data.settings === "object") {
      const { curve, reference, patient } = data.settings;
      if (curve && !validateCurve(curve)) state.settings.curve = curve;
      if (reference && validReference(reference)) state.settings.reference = reference;
      if (typeof patient === "string" && patient) state.settings.patient = patient;
    }
    persist();
    emit();
    return scans.length;
  },
  clear() {
    state.scans = [];
    Object.assign(state.settings, structuredClone(DEFAULT_SETTINGS), {
      theme: state.settings.theme,
    });
    persist();
    emit();
  },
  DEFAULT_SETTINGS,
};

export function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
