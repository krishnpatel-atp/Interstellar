export const C = {
  bg: "#f4f7fb",
  surface: "#ffffff",
  surface2: "#f1f5f9",
  border: "rgba(15,23,42,0.08)",
  text: "#0f172a",
  muted: "#5b6b82",
  faint: "#94a3b8",
  brand: "#0d9488",
  brand2: "#0284c7",
  brandSoft: "rgba(13,148,136,0.12)",
  low: "#16a34a",
  lowSoft: "rgba(22,163,74,0.12)",
  obs: "#b45309",
  obsSoft: "rgba(234,179,8,0.18)",
  high: "#dc2626",
  highSoft: "rgba(220,38,38,0.12)",
  zoneLow: "#22c55e",
  zoneObs: "#eab308",
  zoneHigh: "#ef4444",
};

export const TONE = {
  low: { fg: C.low, bg: C.lowSoft, bar: C.zoneLow },
  observation: { fg: C.obs, bg: C.obsSoft, bar: C.zoneObs },
  high: { fg: C.high, bg: C.highSoft, bar: C.zoneHigh },
};
