// Photo → pixels. Expo Go has no canvas, so we resize with expo-image-manipulator,
// get a JPEG as base64 and decode it in pure JS (jpeg-js).
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { decode as decodeJpeg } from "jpeg-js";
import { base64ToBytes } from "./base64.js";

/**
 * Loads a photo as ImageData-like pixels, downscaled to `width` px wide.
 * Returns { image: {width, height, data}, uri } where uri is the resized JPEG.
 */
export async function loadPixels(uri, width = 640) {
  const ref = await ImageManipulator.manipulate(uri).resize({ width }).renderAsync();
  const saved = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.92, base64: true });
  const decoded = decodeJpeg(base64ToBytes(saved.base64), {
    useTArray: true,
    formatAsRGBA: true,
    maxMemoryUsageInMB: 256,
  });
  return {
    uri: saved.uri,
    image: { width: decoded.width, height: decoded.height, data: decoded.data },
  };
}
