import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_CURVE, DEFAULT_REFERENCE, validateCurve } from "./analysis.js";

const KEY = "cellusense:mobile:v1";

export const DEFAULT_SETTINGS = {
  patient: "Patient A",
  curve: DEFAULT_CURVE.map(p => ({ ...p })),
  reference: { white: [...DEFAULT_REFERENCE.white], black: [...DEFAULT_REFERENCE.black] },
};

export async function loadState() {
  try {
    const raw = JSON.parse((await AsyncStorage.getItem(KEY)) || "null");
    if (raw && typeof raw === "object") {
      const settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
      if (validateCurve(settings.curve)) settings.curve = DEFAULT_SETTINGS.curve;
      const scans = Array.isArray(raw.scans)
        ? raw.scans.filter(s => s && typeof s.id === "string" && Number.isFinite(s.ph))
        : [];
      return { settings, scans };
    }
  } catch {}
  return { settings: DEFAULT_SETTINGS, scans: [] };
}

export async function saveState(state) {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.warn("Could not save", err);
  }
}

export function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
