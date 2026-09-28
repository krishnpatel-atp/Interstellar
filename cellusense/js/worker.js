// Runs image analysis off the main thread so the UI never stutters.
import { analyzeImage, detectRing } from "./analysis.js";
import { renderBandage } from "./demo.js";

self.onmessage = ({ data }) => {
  const { id, type, payload } = data;
  try {
    let result;
    let transfer = [];
    if (type === "analyze") {
      result = analyzeImage(toImage(payload.image), payload.options);
    } else if (type === "detect") {
      result = detectRing(toImage(payload.image), payload.options);
    } else if (type === "demo") {
      const img = renderBandage(payload);
      result = { width: img.width, height: img.height, data: img.data };
      transfer = [img.data.buffer];
    } else {
      throw new Error(`Unknown task ${type}`);
    }
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};

function toImage({ width, height, buffer }) {
  return { width, height, data: new Uint8ClampedArray(buffer) };
}
