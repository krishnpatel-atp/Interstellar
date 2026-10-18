import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Rect } from "react-native-svg";
import {
  DEFAULT_CURVE,
  DEFAULT_REFERENCE,
  GEOMETRY,
  analyzeImage,
  classifyRisk,
  indicatorColor,
  linearToSrgb,
  recommendations,
  round,
  srgbToLinear,
  trendAlerts,
  validateCurve,
} from "./src/analysis.js";
import { TrendChart } from "./src/TrendChart.js";
import { toFhirBundle } from "./src/fhir.js";
import { LIGHTING, renderBandage } from "./src/demo.js";
import { loadPixels } from "./src/image.js";
import { DEFAULT_SETTINGS, loadState, saveState, uid } from "./src/store.js";
import { C, TONE } from "./src/theme.js";

const GUIDE = 0.36; // guide-circle radius as a fraction of the camera view width
const nextFrame = () => new Promise(r => setTimeout(r, 30));

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState(null);
  const [tab, setTab] = useState("scan");
  const [currentId, setCurrentId] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadState().then(setState);
  }, []);

  const update = useCallback(fn => {
    setState(prev => {
      const next = fn(prev);
      saveState(next);
      return next;
    });
  }, []);

  if (!state) {
    return (
      <View style={[styles.fill, styles.center]}>
        <ActivityIndicator color={C.brand} />
      </View>
    );
  }

  const { settings, scans } = state;
  const patientScans = scans.filter(s => s.patient === settings.patient).sort((a, b) => a.ts - b.ts);
  const current = scans.find(s => s.id === currentId) || patientScans[patientScans.length - 1] || null;

  /** Runs the full pipeline on pixels and stores the scan. */
  const process = async (image, extra) => {
    setBusy(true);
    await nextFrame(); // let the spinner render before the CPU-heavy work
    try {
      const opts = { curve: settings.curve, reference: settings.reference };
      let analysis = analyzeImage(image, { ...opts, hint: extra.hint });
      if (!analysis.ring.found && extra.hint) analysis = analyzeImage(image, opts);
      const { hint, ...rest } = extra;
      const scan = {
        id: uid(),
        ts: Date.now(),
        patient: settings.patient,
        ph: analysis.ph,
        ratio: analysis.ratio,
        risk: analysis.risk.id,
        quality: analysis.quality,
        analysis,
        note: "",
        ...rest,
      };
      update(s => ({ ...s, scans: [...s.scans, scan] }));
      setCurrentId(scan.id);
      setTab("result");
    } catch (err) {
      console.warn(err);
      Alert.alert("Analysis failed", "Try another photo with the whole ring in view.");
    } finally {
      setBusy(false);
    }
  };

  const fromPhoto = async (uri, source, hint) => {
    setBusy(true);
    try {
      const { image, uri: small } = await loadPixels(uri);
      const h = hint ? { cx: image.width / 2, cy: image.height / 2, r: image.width * GUIDE } : undefined;
      await process(image, { source, photo: small, hint: h });
    } catch (err) {
      console.warn(err);
      setBusy(false);
      Alert.alert("Couldn't read that photo", "Please try again.");
    }
  };

  const fromDemo = async (ph, lighting) => {
    setBusy(true);
    await nextFrame();
    const w = 360;
    const image = renderBandage({ ph, lighting, width: w, height: 480, r: w * 0.3, seed: Math.floor(Math.random() * 1e6) });
    await process(image, { source: "demo", demo: { ph, lighting } });
  };

  const loadDemoHistory = async () => {
    setBusy(true);
    await nextFrame();
    const patient = "Demo · Post-op incision";
    const course = [5.8, 5.9, 5.7, 6.0, 6.1, 5.9, 6.3, 6.6, 6.8, 7.1, 7.4, 7.9];
    const lights = Object.keys(LIGHTING);
    const now = Date.now();
    const span = 5 * 86400e3;
    const made = course.map((ph, i) => {
      const lighting = lights[i % lights.length];
      const analysis = analyzeImage(renderBandage({ ph, lighting, width: 240, height: 320, r: 72, seed: 100 + i }));
      return {
        id: uid() + i,
        ts: now - span + (span / (course.length - 1)) * i,
        patient,
        ph: analysis.ph,
        ratio: analysis.ratio,
        risk: analysis.risk.id,
        quality: analysis.quality,
        analysis,
        source: "demo",
        demo: { ph, lighting },
        note: i === 9 ? "Mild redness at incision" : i === 11 ? "Warmth + discharge — surgeon notified" : "",
      };
    });
    update(s => ({
      settings: { ...s.settings, patient },
      scans: [...s.scans.filter(x => x.patient !== patient), ...made],
    }));
    setBusy(false);
  };

  const openScan = id => {
    setCurrentId(id);
    setTab("result");
  };

  return (
    <View style={[styles.fill, { backgroundColor: C.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Logo />
        <View style={{ flex: 1 }}>
          <Text style={styles.brand}>CelluSense</Text>
          <Text style={styles.brandSub}>Smart Bandage Scanner</Text>
        </View>
        <Pressable style={styles.chip} onPress={() => setTab("settings")}>
          <Text style={styles.chipText} numberOfLines={1}>
            {settings.patient}
          </Text>
        </Pressable>
      </View>

      <View style={styles.fill}>
        {tab === "scan" && <ScanScreen busy={busy} onPhoto={fromPhoto} onDemo={fromDemo} />}
        {tab === "result" && (
          <ResultScreen
            scan={current}
            history={current ? scans.filter(s => s.patient === current.patient).sort((a, b) => a.ts - b.ts) : []}
            onOpen={openScan}
            onNote={(id, note) => update(s => ({ ...s, scans: s.scans.map(x => (x.id === id ? { ...x, note } : x)) }))}
            onDiscard={id => {
              update(s => ({ ...s, scans: s.scans.filter(x => x.id !== id) }));
              setCurrentId(null);
            }}
            onScan={() => setTab("scan")}
          />
        )}
        {tab === "trends" && (
          <TrendsScreen
            patient={settings.patient}
            scans={patientScans}
            onOpen={openScan}
            onDemo={loadDemoHistory}
            onDelete={id => update(s => ({ ...s, scans: s.scans.filter(x => x.id !== id) }))}
          />
        )}
        {tab === "settings" && <SettingsScreen state={state} update={update} />}
        {busy && (
          <View style={styles.busy}>
            <ActivityIndicator size="large" color="#fff" />
            <Text style={styles.busyText}>Analyzing bandage…</Text>
          </View>
        )}
      </View>

      <View style={[styles.tabbar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {[
          ["scan", "Scan", "◎"],
          ["result", "Results", "♥"],
          ["trends", "Trends", "↗"],
          ["settings", "Settings", "⚙"],
        ].map(([key, label, glyph]) => (
          <Pressable
            key={key}
            style={styles.tab}
            onPress={() => setTab(key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === key }}
          >
            <View style={[styles.tabIcon, tab === key && { backgroundColor: C.brandSoft }]}>
              <Text style={[styles.tabGlyph, tab === key && { color: C.brand }]}>{glyph}</Text>
            </View>
            <Text style={[styles.tabLabel, tab === key && { color: C.brand }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/* ======================================================================= */

function ScanScreen({ busy, onPhoto, onDemo }) {
  const { width } = useWindowDimensions();
  const camW = width - 32;
  const camH = (camW * 4) / 3; // matches the 3:4 photo so the guide maps 1:1
  const [permission, requestPermission] = useCameraPermissions();
  const camRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState("back");
  const [torch, setTorch] = useState(false);
  const [demoPh, setDemoPh] = useState(7.8);
  const [light, setLight] = useState("warm");

  const capture = async () => {
    if (!camRef.current || !ready || busy) return;
    try {
      const pic = await camRef.current.takePictureAsync({ quality: 0.9, shutterSound: false });
      await onPhoto(pic.uri, "camera", true);
    } catch (err) {
      console.warn(err);
      Alert.alert("Couldn't take the photo", "Please try again.");
    }
  };

  const pick = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
    if (!res.canceled && res.assets?.[0]) await onPhoto(res.assets[0].uri, "upload", false);
  };

  const zone = classifyRisk(demoPh);
  const r = camW * GUIDE;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.h1}>Scan bandage</Text>
      <Text style={styles.sub}>Center the printed ring inside the circle, then capture.</Text>

      <View style={[styles.camera, { width: camW, height: camH }]}>
        {permission?.granted ? (
          <CameraView
            ref={camRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            enableTorch={torch}
            onCameraReady={() => setReady(true)}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.center, { padding: 24 }]}>
            <Text style={styles.camMsg}>
              {permission && !permission.canAskAgain
                ? "Camera access is off. Enable it in Settings, or pick a photo instead."
                : "CelluSense needs the camera to scan bandages."}
            </Text>
            {(!permission || permission.canAskAgain) && (
              <Btn title="Allow camera" onPress={requestPermission} primary />
            )}
          </View>
        )}
        <Svg width={camW} height={camH} style={StyleSheet.absoluteFill} pointerEvents="none">
          <Circle cx={camW / 2} cy={camH / 2} r={r} stroke="#fff" strokeWidth={3} strokeDasharray="10 8" fill="none" />
          <Circle
            cx={camW / 2}
            cy={camH / 2}
            r={r * GEOMETRY.pad}
            stroke="rgba(255,255,255,.45)"
            strokeWidth={1.5}
            strokeDasharray="3 6"
            fill="none"
          />
        </Svg>
        <View style={styles.camBar}>
          <RoundBtn label="🖼" onPress={pick} accessibilityLabel="Pick a photo" />
          <Pressable
            onPress={capture}
            disabled={!ready || busy}
            style={({ pressed }) => [styles.shutter, (!ready || busy) && { opacity: 0.5 }, pressed && { transform: [{ scale: 0.94 }] }]}
            accessibilityLabel="Capture and analyze"
          >
            <View style={styles.shutterInner} />
          </Pressable>
          <RoundBtn
            label={facing === "back" ? "⟲" : "⟳"}
            onPress={() => setFacing(f => (f === "back" ? "front" : "back"))}
            accessibilityLabel="Switch camera"
          />
        </View>
        {facing === "back" && (
          <Pressable style={styles.torch} onPress={() => setTorch(t => !t)} accessibilityLabel="Toggle light">
            <Text style={{ color: torch ? "#fde047" : "#fff", fontSize: 18 }}>⚡</Text>
          </Pressable>
        )}
      </View>

      <Card>
        <Text style={styles.h2}>Demo bandage</Text>
        <Text style={styles.muted}>No bandage handy? Scan a simulated one at any pH and lighting.</Text>
        <View style={styles.demoRow}>
          <BandageArt ph={demoPh} lighting={light} size={84} />
          <View style={{ flex: 1, gap: 6 }}>
            <View style={styles.stepper}>
              <Btn title="−" onPress={() => setDemoPh(p => Math.max(5, round(p - 0.1, 1)))} small />
              <Text style={styles.stepValue}>pH {demoPh.toFixed(1)}</Text>
              <Btn title="+" onPress={() => setDemoPh(p => Math.min(9, round(p + 0.1, 1)))} small />
            </View>
            <Text style={[styles.zoneText, { color: TONE[zone.id].fg }]}>
              {zone.zone} · {zone.label} risk
            </Text>
          </View>
        </View>
        <View style={styles.chips}>
          {Object.entries(LIGHTING).map(([key, l]) => (
            <Pressable key={key} onPress={() => setLight(key)} style={[styles.pill, light === key && styles.pillOn]}>
              <Text style={[styles.pillText, light === key && { color: "#fff" }]}>{l.label}</Text>
            </Pressable>
          ))}
        </View>
        <Btn title="Scan simulated bandage" onPress={() => onDemo(demoPh, light)} primary disabled={busy} />
      </Card>

      <Card>
        <Text style={styles.h2}>How it works</Text>
        {[
          ["Capture", "Snap the bandage with your phone."],
          ["Normalize", "The printed white & black rings correct lighting and shadows."],
          ["Analyze", "Index = R_center / G_center of the indicator pad."],
          ["Score", "pH maps to a risk zone and is logged to the trend."],
        ].map(([t, d], i) => (
          <View key={t} style={styles.step}>
            <Text style={styles.stepNum}>{i + 1}</Text>
            <Text style={styles.stepText}>
              <Text style={{ fontWeight: "700", color: C.text }}>{t}. </Text>
              {d}
            </Text>
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}

/* ======================================================================= */

function ResultScreen({ scan, history, onOpen, onNote, onDiscard, onScan }) {
  const { width } = useWindowDimensions();
  const [note, setNote] = useState(scan?.note || "");
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setNote(scan?.note || "");
    setImgFailed(false);
  }, [scan?.id]);

  if (!scan) {
    return (
      <View style={[styles.fill, styles.center, { padding: 24, gap: 12 }]}>
        <Text style={styles.h1}>No results yet</Text>
        <Text style={[styles.muted, { textAlign: "center" }]}>Scan a bandage or try the demo bandage.</Text>
        <Btn title="Start a scan" onPress={onScan} primary />
      </View>
    );
  }

  const a = scan.analysis;
  const zone = classifyRisk(scan.ph);
  const tone = TONE[zone.id];
  const rec = recommendations(scan.ph);
  const alerts = trendAlerts(history.filter(s => s.ts <= scan.ts));
  const pct = Math.min(1, Math.max(0, (scan.ph - 4.5) / 4.5));
  const gaugeW = width - 32 - 40;
  const d = new Date(scan.ts);

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.h1}>Diagnostic results</Text>
      <Text style={styles.sub}>
        {scan.patient} · {d.toLocaleDateString()} {d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        {scan.source === "demo" ? " · simulated" : ""}
      </Text>

      <Card style={{ borderTopWidth: 5, borderTopColor: tone.bar }}>
        <Text style={styles.eyebrow}>ESTIMATED PH</Text>
        <Text style={styles.phValue}>pH {scan.ph.toFixed(1)}</Text>
        <View style={[styles.badge, { backgroundColor: tone.bg }]}>
          <View style={[styles.dot, { backgroundColor: tone.fg }]} />
          <Text style={[styles.badgeText, { color: tone.fg }]}>Infection Risk: {zone.label}</Text>
        </View>
        <View style={{ marginTop: 22 }}>
          <View style={styles.gauge}>
            <View style={{ flex: 1.75, backgroundColor: C.zoneLow }} />
            <View style={{ flex: 1, backgroundColor: C.zoneObs }} />
            <View style={{ flex: 1.75, backgroundColor: C.zoneHigh }} />
          </View>
          <View style={[styles.marker, { left: pct * gaugeW - 12 }]} />
          <View style={styles.gaugeLabels}>
            {["4.5", "5.5", "6.3", "7.3", "9.0"].map(l => (
              <Text key={l} style={styles.gaugeLabel}>
                {l}
              </Text>
            ))}
          </View>
        </View>
        <Text style={styles.zoneLine}>
          <Text style={{ fontWeight: "800", color: tone.fg }}>{zone.zone}</Text> · {zone.title}
        </Text>
      </Card>

      <Card>
        <Text style={styles.eyebrow}>RECOMMENDED ACTION</Text>
        <Text style={styles.headline}>{rec.headline}</Text>
        {rec.actions.map(t => (
          <Text key={t} style={styles.action}>
            ✓ {t}
          </Text>
        ))}
        {alerts.map(al => (
          <View key={al.text} style={styles.alert}>
            <Text style={styles.alertText}>⚠ {al.text}</Text>
          </View>
        ))}
        <Text style={styles.disclaimer}>Research prototype — not a medical device.</Text>
      </Card>

      <Card>
        <Text style={styles.h2}>pH trend</Text>
        <TrendChart scans={history} width={width - 32 - 40} height={180} highlight={scan.id} onSelect={onOpen} />
      </Card>

      <Card>
        <Text style={styles.h2}>Scanned bandage</Text>
        <View style={styles.photoWrap}>
          {scan.photo && !imgFailed ? (
            <PhotoWithRing uri={scan.photo} ring={a.ring} width={width - 72} onError={() => setImgFailed(true)} />
          ) : scan.demo ? (
            <BandageArt ph={scan.demo.ph} lighting={scan.demo.lighting} size={Math.min(260, width - 72)} />
          ) : (
            <Text style={styles.muted}>Photo no longer available</Text>
          )}
        </View>
      </Card>

      <Card>
        <Text style={styles.h2}>Lighting normalization</Text>
        <View style={styles.swatches}>
          <Swatch rgb={a.center.raw} label="As captured" />
          <Text style={{ color: C.faint, fontSize: 20 }}>→</Text>
          <Swatch rgb={a.center.corrected} label="Corrected" />
        </View>
        <View style={styles.stats}>
          {[
            ["R/G index", a.ratio.toFixed(3)],
            ["Lighting", `${a.lighting.cast}, ${a.lighting.level}`],
            ["Gains R·G·B", a.reference.gains.map(g => g.toFixed(2)).join(" · ")],
            ["Ring", a.ring.found ? `${Math.round(a.ring.confidence * 100)}% confidence` : "Not found"],
            ["Quality", a.quality],
            ["Processing", `${a.ms} ms`],
          ].map(([k, v]) => (
            <View key={k} style={styles.stat}>
              <Text style={styles.statK}>{k}</Text>
              <Text style={styles.statV}>{v}</Text>
            </View>
          ))}
        </View>
        {a.issues.map(i => (
          <Text key={i.text} style={styles.issue}>
            • {i.text}
          </Text>
        ))}
      </Card>

      <Card>
        <Text style={styles.h2}>Clinical note</Text>
        <TextInput
          style={styles.input}
          value={note}
          onChangeText={setNote}
          onEndEditing={() => onNote(scan.id, note)}
          placeholder="e.g. Dressing changed, mild redness"
          placeholderTextColor={C.faint}
          multiline
        />
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          <Btn title="New scan" onPress={onScan} primary />
          <Btn
            title="Discard"
            onPress={() =>
              Alert.alert("Discard this scan?", undefined, [
                { text: "Cancel", style: "cancel" },
                { text: "Discard", style: "destructive", onPress: () => onDiscard(scan.id) },
              ])
            }
          />
        </View>
      </Card>
    </ScrollView>
  );
}

function PhotoWithRing({ uri, ring, width, onError }) {
  const [size, setSize] = useState(null);
  useEffect(() => {
    Image.getSize(uri, (w, h) => setSize({ w, h }), onError);
  }, [uri]);
  if (!size) return <ActivityIndicator color={C.brand} />;
  const s = width / size.w;
  const h = size.h * s;
  return (
    <View style={{ width, height: h }}>
      <Image source={{ uri }} style={{ width, height: h, borderRadius: 12 }} onError={onError} />
      <Svg width={width} height={h} style={StyleSheet.absoluteFill}>
        <Circle cx={ring.cx * s} cy={ring.cy * s} r={ring.r * s} stroke={ring.found ? "#34d399" : "#f59e0b"} strokeWidth={3} fill="none" />
        <Circle
          cx={ring.cx * s}
          cy={ring.cy * s}
          r={ring.r * s * GEOMETRY.samplePad}
          stroke="#fbbf24"
          strokeWidth={2}
          strokeDasharray="6 4"
          fill="none"
        />
      </Svg>
    </View>
  );
}

/* ======================================================================= */

function TrendsScreen({ patient, scans, onOpen, onDemo, onDelete }) {
  const { width } = useWindowDimensions();
  const [days, setDays] = useState(0);
  const shown = useMemo(() => {
    if (!days) return scans;
    const from = Date.now() - days * 86400e3;
    return scans.filter(s => s.ts >= from);
  }, [scans, days]);
  const latest = shown[shown.length - 1];
  const delta = shown.length > 1 ? latest.ph - shown[0].ph : null;
  const peak = shown.reduce((m, s) => Math.max(m, s.ph), Number.NEGATIVE_INFINITY);
  const zone = latest ? classifyRisk(latest.ph) : null;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.h1}>Historical trend</Text>
      <Text style={styles.sub}>
        {patient} · {shown.length} scan{shown.length === 1 ? "" : "s"}
      </Text>
      <View style={styles.segment}>
        {[
          [1, "24 h"],
          [7, "7 d"],
          [30, "30 d"],
          [0, "All"],
        ].map(([v, l]) => (
          <Pressable key={l} onPress={() => setDays(v)} style={[styles.segBtn, days === v && styles.segOn]}>
            <Text style={[styles.segText, days === v && { color: C.text }]}>{l}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.kpis}>
        <Kpi label="Latest pH" value={latest ? latest.ph.toFixed(1) : "—"} />
        <Kpi
          label="Change"
          value={delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`}
          color={delta > 0.05 ? C.high : delta < -0.05 ? C.low : C.text}
        />
        <Kpi label="Peak pH" value={latest ? peak.toFixed(1) : "—"} />
        <Kpi label="Zone" value={zone ? zone.label : "—"} color={zone ? TONE[zone.id].fg : C.text} />
      </View>
      <Card>
        <TrendChart scans={shown} width={width - 32 - 40} height={240} onSelect={onOpen} />
        <View style={styles.legend}>
          <Legend color={C.zoneLow} text="Green · 5.5–6.2 normal" />
          <Legend color={C.zoneObs} text="Yellow · 6.3–7.2 observe" />
          <Legend color={C.zoneHigh} text="Red · ≥7.3 notify team" />
        </View>
      </Card>
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={styles.h2}>Scan log</Text>
          <Btn title="Load demo data" onPress={onDemo} small />
        </View>
        {!!shown.length && (
          <View style={{ marginTop: 10 }}>
            <Btn
              title="Send to health record (FHIR)"
              small
              onPress={() =>
                Share.share({
                  title: `CelluSense — ${patient}`,
                  message: JSON.stringify(toFhirBundle(shown, { patient }), null, 2),
                }).catch(() => {})
              }
            />
          </View>
        )}
        {!shown.length && <Text style={[styles.muted, { marginTop: 8 }]}>No scans yet.</Text>}
        {[...shown].reverse().map(s => {
          const z = classifyRisk(s.ph);
          const d = new Date(s.ts);
          return (
            <Pressable key={s.id} style={styles.logRow} onPress={() => onOpen(s.id)} onLongPress={() =>
              Alert.alert("Delete scan?", undefined, [
                { text: "Cancel", style: "cancel" },
                { text: "Delete", style: "destructive", onPress: () => onDelete(s.id) },
              ])
            }>
              <View style={{ flex: 1 }}>
                <Text style={styles.logWhen}>
                  {d.toLocaleDateString([], { month: "short", day: "numeric" })} ·{" "}
                  {d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {s.note || (s.source === "demo" ? "Simulated bandage" : s.source === "upload" ? "Photo" : "Camera scan")}
                </Text>
              </View>
              <Text style={styles.logPh}>{s.ph.toFixed(1)}</Text>
              <View style={[styles.logPill, { backgroundColor: TONE[z.id].bar }]}>
                <Text style={styles.logPillText}>{z.label}</Text>
              </View>
            </Pressable>
          );
        })}
        {!!shown.length && <Text style={[styles.disclaimer, { marginTop: 10 }]}>Long-press a scan to delete it.</Text>}
      </Card>
    </ScrollView>
  );
}

/* ======================================================================= */

function SettingsScreen({ state, update }) {
  const { settings, scans } = state;
  const [name, setName] = useState(settings.patient);
  const [knownPh, setKnownPh] = useState("");
  const patients = [...new Set([settings.patient, ...scans.map(s => s.patient)])];
  const lastScan = [...scans].sort((a, b) => a.ts - b.ts).pop();
  const curve = [...settings.curve].sort((a, b) => a.ph - b.ph);
  const isDefault = JSON.stringify(curve) === JSON.stringify(DEFAULT_CURVE.map(p => ({ ...p })));

  const savePatient = () => {
    const n = name.trim().slice(0, 40);
    if (n) update(s => ({ ...s, settings: { ...s.settings, patient: n } }));
    else setName(settings.patient);
  };

  const addCalibration = () => {
    const ph = Number.parseFloat(knownPh);
    if (!lastScan) return Alert.alert("Scan a buffer-soaked square first.");
    if (!Number.isFinite(ph) || ph < 3 || ph > 11) return Alert.alert("Enter a pH between 3 and 11.");
    const next = curve.filter(p => Math.abs(p.ph - ph) > 1e-6).concat({ ph: round(ph, 2), ratio: lastScan.ratio });
    next.sort((a, b) => a.ph - b.ph);
    const err = validateCurve(next);
    if (err) return Alert.alert("Can't add that point", err);
    update(s => ({ ...s, settings: { ...s.settings, curve: next } }));
    setKnownPh("");
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.h1}>Settings</Text>
      <Card>
        <Text style={styles.h2}>Patient / wound ID</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} onEndEditing={savePatient} returnKeyType="done" />
        {patients.length > 1 && (
          <View style={[styles.chips, { marginTop: 10 }]}>
            {patients.map(p => (
              <Pressable
                key={p}
                onPress={() => {
                  setName(p);
                  update(s => ({ ...s, settings: { ...s.settings, patient: p } }));
                }}
                style={[styles.pill, p === settings.patient && styles.pillOn]}
              >
                <Text style={[styles.pillText, p === settings.patient && { color: "#fff" }]}>{p}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </Card>

      <Card>
        <Text style={styles.h2}>Calibration curve</Text>
        <Text style={styles.muted}>
          Soak hydrogel squares in buffers of known pH (vinegar ≈ 5.5, baking soda ≈ 8.5), scan each, then enter its pH
          here to add the latest scan's R/G index to the curve.
        </Text>
        <View style={styles.table}>
          {curve.map(p => (
            <View key={p.ph} style={styles.tableRow}>
              <Text style={styles.tableCell}>pH {p.ph.toFixed(1)}</Text>
              <Text style={styles.tableCell}>R/G {p.ratio.toFixed(3)}</Text>
            </View>
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={knownPh}
            onChangeText={setKnownPh}
            placeholder={lastScan ? `Known pH for R/G ${lastScan.ratio.toFixed(3)}` : "Known pH"}
            placeholderTextColor={C.faint}
            keyboardType="decimal-pad"
          />
          <Btn title="Add" onPress={addCalibration} primary small />
        </View>
        {!isDefault && (
          <View style={{ marginTop: 10 }}>
            <Btn
              title="Reset to default curve"
              onPress={() => update(s => ({ ...s, settings: { ...s.settings, curve: DEFAULT_CURVE.map(p => ({ ...p })) } }))}
              small
            />
          </View>
        )}
      </Card>

      <Card>
        <Text style={styles.h2}>Reference ring</Text>
        <Text style={styles.muted}>
          White {settings.reference.white.join(", ")} · Black {settings.reference.black.join(", ")} (RGB as photographed
          in daylight).
        </Text>
        <View style={{ marginTop: 10 }}>
          <Btn
            title="Reset reference"
            small
            onPress={() =>
              update(s => ({
                ...s,
                settings: { ...s.settings, reference: { white: [...DEFAULT_REFERENCE.white], black: [...DEFAULT_REFERENCE.black] } },
              }))
            }
          />
        </View>
      </Card>

      <Card>
        <Text style={styles.h2}>Data</Text>
        <Text style={styles.muted}>{scans.length} scans stored on this device. Nothing is uploaded.</Text>
        <View style={{ marginTop: 10 }}>
          <Btn
            title="Delete all data"
            onPress={() =>
              Alert.alert("Delete all data?", "This removes every scan and calibration.", [
                { text: "Cancel", style: "cancel" },
                { text: "Delete", style: "destructive", onPress: () => update(() => ({ settings: DEFAULT_SETTINGS, scans: [] })) },
              ])
            }
          />
        </View>
      </Card>

      <Card>
        <Text style={styles.h2}>Risk zones</Text>
        <Legend color={C.zoneLow} text="Green · pH 5.5–6.2 · normal healing" />
        <Legend color={C.zoneObs} text="Yellow · pH 6.3–7.2 · flag for observation" />
        <Legend color={C.zoneHigh} text="Red · pH ≥ 7.3 · notify care team" />
        <Text style={styles.disclaimer}>CelluSense is a student research prototype, not a certified medical device.</Text>
      </Card>
    </ScrollView>
  );
}

/* ======================================================================= */

function litColor(rgb, lighting) {
  const l = LIGHTING[lighting] || LIGHTING.daylight;
  const c = rgb.map((v, i) => Math.round(linearToSrgb(srgbToLinear(Math.round(v)) * l.gain[i] * l.exposure)));
  return `rgb(${c.join(",")})`;
}

/** Vector drawing of a CelluSense bandage under a given light. */
function BandageArt({ ph, lighting, size }) {
  const R = size * 0.42;
  const c = size / 2;
  return (
    <Svg width={size} height={size}>
      <Rect x={0} y={0} width={size} height={size} rx={size * 0.14} fill={litColor([228, 216, 200], lighting)} />
      <Circle cx={c} cy={c} r={R} fill={litColor(DEFAULT_REFERENCE.black, lighting)} />
      <Circle cx={c} cy={c} r={R * GEOMETRY.whiteOuter} fill={litColor(DEFAULT_REFERENCE.white, lighting)} />
      <Circle cx={c} cy={c} r={R * GEOMETRY.whiteInner} fill={litColor([206, 200, 188], lighting)} />
      <Circle cx={c} cy={c} r={R * GEOMETRY.pad} fill={litColor(indicatorColor(ph), lighting)} />
    </Svg>
  );
}

function Logo() {
  return (
    <View style={styles.logo}>
      <View style={styles.logoRing}>
        <View style={styles.logoDot} />
      </View>
    </View>
  );
}

function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function Btn({ title, onPress, primary, small, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        primary && styles.btnPrimary,
        small && styles.btnSmall,
        (pressed || disabled) && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.btnText, primary && { color: "#fff" }]}>{title}</Text>
    </Pressable>
  );
}

function RoundBtn({ label, onPress, accessibilityLabel }) {
  return (
    <Pressable onPress={onPress} style={styles.round} accessibilityLabel={accessibilityLabel}>
      <Text style={{ color: "#fff", fontSize: 20 }}>{label}</Text>
    </Pressable>
  );
}

function Swatch({ rgb, label }) {
  return (
    <View style={{ alignItems: "center", gap: 4 }}>
      <View style={[styles.swatch, { backgroundColor: `rgb(${rgb.join(",")})` }]} />
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.mono}>{rgb.join(", ")}</Text>
    </View>
  );
}

function Kpi({ label, value, color = C.text }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, { color }]}>{value}</Text>
    </View>
  );
}

function Legend({ color, text }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
      <View style={{ width: 12, height: 12, borderRadius: 4, backgroundColor: color }} />
      <Text style={styles.muted}>{text}</Text>
    </View>
  );
}

/* ======================================================================= */

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: C.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  logo: { width: 36, height: 36, borderRadius: 11, backgroundColor: C.brand, alignItems: "center", justifyContent: "center" },
  logoRing: { width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: "#fff", alignItems: "center", justifyContent: "center" },
  logoDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff" },
  brand: { fontSize: 17, fontWeight: "800", color: C.text },
  brandSub: { fontSize: 11.5, color: C.muted },
  chip: { maxWidth: 150, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface2 },
  chipText: { fontSize: 13, fontWeight: "700", color: C.text },
  page: { padding: 16, paddingBottom: 40, gap: 14 },
  h1: { fontSize: 26, fontWeight: "800", color: C.text },
  h2: { fontSize: 16, fontWeight: "700", color: C.text, marginBottom: 6 },
  sub: { color: C.muted, marginTop: -8 },
  muted: { color: C.muted, fontSize: 13.5, lineHeight: 19 },
  mono: { color: C.muted, fontSize: 12, fontVariant: ["tabular-nums"] },
  card: {
    backgroundColor: C.surface,
    borderRadius: 20,
    padding: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    shadowColor: "#0f172a",
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  camera: { borderRadius: 22, overflow: "hidden", backgroundColor: "#03070f" },
  camMsg: { color: "#cbd5e1", textAlign: "center", marginBottom: 14, fontSize: 15 },
  camBar: { position: "absolute", left: 0, right: 0, bottom: 16, flexDirection: "row", justifyContent: "space-around", alignItems: "center" },
  shutter: { width: 74, height: 74, borderRadius: 37, borderWidth: 4, borderColor: "#fff", alignItems: "center", justifyContent: "center" },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: C.brand },
  round: { width: 48, height: 48, borderRadius: 24, backgroundColor: "rgba(0,0,0,.45)", alignItems: "center", justifyContent: "center" },
  torch: { position: "absolute", top: 12, right: 12, width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(0,0,0,.45)", alignItems: "center", justifyContent: "center" },
  demoRow: { flexDirection: "row", alignItems: "center", gap: 14, marginVertical: 14 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepValue: { fontSize: 20, fontWeight: "800", color: C.text, minWidth: 80, textAlign: "center", fontVariant: ["tabular-nums"] },
  zoneText: { fontWeight: "700", fontSize: 13.5 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  pill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99, backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border },
  pillOn: { backgroundColor: C.brand, borderColor: C.brand },
  pillText: { fontSize: 13, fontWeight: "600", color: C.muted },
  step: { flexDirection: "row", gap: 10, marginTop: 8, alignItems: "flex-start" },
  stepNum: { width: 24, height: 24, borderRadius: 8, backgroundColor: C.brandSoft, color: C.brand, textAlign: "center", lineHeight: 24, fontWeight: "800", overflow: "hidden" },
  stepText: { flex: 1, color: C.muted, lineHeight: 20 },
  eyebrow: { fontSize: 12, fontWeight: "800", letterSpacing: 1, color: C.muted },
  phValue: { fontSize: 60, fontWeight: "900", color: C.text, letterSpacing: -1.5, marginVertical: 4, fontVariant: ["tabular-nums"] },
  badge: { flexDirection: "row", alignSelf: "flex-start", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 14 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  badgeText: { fontWeight: "800", fontSize: 15 },
  gauge: { flexDirection: "row", height: 12, borderRadius: 6, overflow: "hidden" },
  marker: { position: "absolute", top: -6, width: 24, height: 24, borderRadius: 12, borderWidth: 4, borderColor: C.text, backgroundColor: "#fff" },
  gaugeLabels: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  gaugeLabel: { fontSize: 11, color: C.faint },
  zoneLine: { marginTop: 12, color: C.muted, fontSize: 14 },
  headline: { fontSize: 21, fontWeight: "800", color: C.text, marginTop: 4, marginBottom: 8 },
  action: { fontSize: 15, color: C.text, marginTop: 6, lineHeight: 21 },
  alert: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: C.obsSoft },
  alertText: { color: C.text, fontSize: 14 },
  disclaimer: { marginTop: 14, fontSize: 12, color: C.faint },
  photoWrap: { alignItems: "center", marginTop: 4 },
  swatches: { flexDirection: "row", justifyContent: "space-around", alignItems: "center", marginVertical: 8 },
  swatch: { width: 56, height: 56, borderRadius: 28, borderWidth: 3, borderColor: "#f0f0f0" },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  stat: { width: "48%", backgroundColor: C.surface2, borderRadius: 12, padding: 10 },
  statK: { fontSize: 11, fontWeight: "700", color: C.muted, textTransform: "uppercase" },
  statV: { fontSize: 15, fontWeight: "700", color: C.text, marginTop: 2 },
  issue: { color: C.muted, fontSize: 13, marginTop: 6 },
  input: { minHeight: 44, borderWidth: 1, borderColor: "rgba(15,23,42,0.16)", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: C.text, backgroundColor: C.surface },
  btn: { paddingHorizontal: 16, height: 44, borderRadius: 12, backgroundColor: C.surface2, alignItems: "center", justifyContent: "center" },
  btnPrimary: { backgroundColor: C.brand },
  btnSmall: { height: 36, paddingHorizontal: 12 },
  btnText: { fontWeight: "700", fontSize: 14.5, color: C.text },
  segment: { flexDirection: "row", backgroundColor: C.surface2, borderRadius: 12, padding: 4, alignSelf: "flex-start" },
  segBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 9 },
  segOn: { backgroundColor: C.surface },
  segText: { fontWeight: "700", color: C.muted, fontSize: 13 },
  kpis: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  kpi: { width: "48%", flexGrow: 1, backgroundColor: C.surface, borderRadius: 16, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border },
  kpiLabel: { fontSize: 11.5, fontWeight: "700", color: C.muted, textTransform: "uppercase" },
  kpiValue: { fontSize: 26, fontWeight: "900", marginTop: 4, fontVariant: ["tabular-nums"] },
  legend: { marginTop: 8 },
  logRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  logWhen: { fontWeight: "700", color: C.text, fontSize: 14 },
  logPh: { fontSize: 18, fontWeight: "900", color: C.text, fontVariant: ["tabular-nums"] },
  logPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99 },
  logPillText: { color: "#fff", fontWeight: "800", fontSize: 12 },
  table: { marginVertical: 12, borderRadius: 12, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: C.border },
  tableRow: { flexDirection: "row", paddingVertical: 8, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  tableCell: { flex: 1, color: C.text, fontVariant: ["tabular-nums"] },
  tabbar: { flexDirection: "row", backgroundColor: C.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, paddingTop: 6 },
  tab: { flex: 1, alignItems: "center", gap: 2 },
  tabIcon: { width: 52, height: 30, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  tabGlyph: { fontSize: 18, color: C.muted },
  tabLabel: { fontSize: 11.5, fontWeight: "700", color: C.muted },
  busy: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(3,7,18,.55)", alignItems: "center", justifyContent: "center", gap: 12 },
  busyText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
