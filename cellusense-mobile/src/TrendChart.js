import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from "react-native-svg";
import { classifyRisk } from "./analysis.js";
import { C } from "./theme.js";

const LOW_MAX = 6.25;
const OBS_MAX = 7.25;
const ZONE_FILL = { low: C.zoneLow, observation: C.zoneObs, high: C.zoneHigh };

/** pH-over-time chart with green/yellow/red risk bands. */
export function TrendChart({ scans, width, height = 220, highlight, onSelect }) {
  if (!scans.length) {
    return (
      <View style={[styles.empty, { height }]}>
        <Text style={styles.emptyText}>Scans will appear here over time.</Text>
      </View>
    );
  }
  const pad = { l: 32, r: 10, t: 10, b: 24 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  let yMin = 4.5;
  let yMax = 9;
  for (const s of scans) {
    yMin = Math.min(yMin, Math.floor(s.ph * 2) / 2);
    yMax = Math.max(yMax, Math.ceil(s.ph * 2) / 2);
  }
  let t0 = scans[0].ts;
  let t1 = scans[scans.length - 1].ts;
  if (t1 - t0 < 3600e3) {
    t0 -= 6 * 3600e3;
    t1 += 6 * 3600e3;
  } else {
    const p = (t1 - t0) * 0.05;
    t0 -= p;
    t1 += p;
  }
  const x = t => pad.l + ((t - t0) / (t1 - t0)) * iw;
  const y = v => pad.t + (1 - (v - yMin) / (yMax - yMin)) * ih;
  const pts = scans.map(s => [x(s.ts), y(s.ph)]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const area = `${line}L${pts[pts.length - 1][0]},${pad.t + ih}L${pts[0][0]},${pad.t + ih}Z`;
  const ticks = [];
  for (let v = Math.ceil(yMin); v <= yMax; v += 1) ticks.push(v);
  const days = (t1 - t0) / 86400e3;
  const fmt = t => {
    const d = new Date(t);
    return days > 1.5
      ? `${d.getMonth() + 1}/${d.getDate()}`
      : `${d.getHours() % 12 || 12}${d.getHours() < 12 ? "am" : "pm"}`;
  };
  const xTicks = [0, 0.33, 0.66, 1].map(f => t0 + (t1 - t0) * f);

  return (
    <View>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="area" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={C.brand} stopOpacity="0.25" />
            <Stop offset="1" stopColor={C.brand} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect x={pad.l} width={iw} y={y(LOW_MAX)} height={y(yMin) - y(LOW_MAX)} fill={C.zoneLow} opacity={0.12} />
        <Rect x={pad.l} width={iw} y={y(OBS_MAX)} height={y(LOW_MAX) - y(OBS_MAX)} fill={C.zoneObs} opacity={0.15} />
        <Rect x={pad.l} width={iw} y={y(yMax)} height={y(OBS_MAX) - y(yMax)} fill={C.zoneHigh} opacity={0.12} />
        {ticks.map(v => (
          <SvgText key={v} x={pad.l - 6} y={y(v) + 4} fontSize="10" fill={C.faint} textAnchor="end">
            {v.toFixed(1)}
          </SvgText>
        ))}
        {xTicks.map((t, i) => (
          <SvgText
            key={t}
            x={Math.min(width - 14, Math.max(pad.l + 10, x(t)))}
            y={height - 6}
            fontSize="10"
            fill={C.faint}
            textAnchor={i === 0 ? "start" : i === 3 ? "end" : "middle"}
          >
            {fmt(t)}
          </SvgText>
        ))}
        <Line x1={pad.l} x2={pad.l + iw} y1={y(LOW_MAX)} y2={y(LOW_MAX)} stroke={C.zoneObs} strokeDasharray="4 4" />
        <Line x1={pad.l} x2={pad.l + iw} y1={y(OBS_MAX)} y2={y(OBS_MAX)} stroke={C.zoneHigh} strokeDasharray="4 4" />
        {pts.length > 1 && <Path d={area} fill="url(#area)" />}
        {pts.length > 1 && <Path d={line} stroke={C.brand} strokeWidth={2.5} fill="none" strokeLinejoin="round" />}
        {scans.map((s, i) => (
          <Circle
            key={s.id}
            cx={pts[i][0]}
            cy={pts[i][1]}
            r={s.id === highlight ? 7 : 5}
            fill={ZONE_FILL[classifyRisk(s.ph).id]}
            stroke="#fff"
            strokeWidth={2}
          />
        ))}
      </Svg>
      {onSelect &&
        scans.map((s, i) => (
          <Pressable
            key={s.id}
            onPress={() => onSelect(s.id)}
            hitSlop={8}
            accessibilityLabel={`Scan pH ${s.ph.toFixed(1)}`}
            style={{ position: "absolute", left: pts[i][0] - 12, top: pts[i][1] - 12, width: 24, height: 24 }}
          />
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: "center", justifyContent: "center" },
  emptyText: { color: C.muted, fontSize: 14 },
});
