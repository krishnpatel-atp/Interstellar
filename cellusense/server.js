// Zero-dependency static server for CelluSense.
//   npm start                 → http://localhost:5173
//   PORT=8080 npm start       → custom port
//   HTTPS_KEY=key.pem HTTPS_CERT=cert.pem npm start  → HTTPS (needed for the
//   live camera on another device over Wi-Fi; localhost works without it)
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT) || 5173;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
const PRIVATE = [
  "node_modules",
  "tests",
  "scripts",
  ".vscode",
  "package.json",
  "package-lock.json",
  "server.js",
];

function handler(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (pathname.endsWith("/")) pathname += "index.html";
  const file = normalize(join(ROOT, pathname));
  const rel = file.slice(ROOT.length + 1);
  if (!file.startsWith(ROOT + sep) || PRIVATE.some(p => rel === p || rel.startsWith(p + sep))) {
    res.writeHead(404).end("Not found");
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

const tls =
  process.env.HTTPS_KEY && process.env.HTTPS_CERT
    ? { key: readFileSync(process.env.HTTPS_KEY), cert: readFileSync(process.env.HTTPS_CERT) }
    : null;
const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
const scheme = tls ? "https" : "http";

server.on("error", err => {
  console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is busy — try PORT=5174 npm start` : err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log("\n  CelluSense is running:\n");
  console.log(`  ➜ Local:   ${scheme}://localhost:${PORT}/`);
  for (const nets of Object.values(networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === "IPv4" && !n.internal) console.log(`  ➜ Network: ${scheme}://${n.address}:${PORT}/`);
    }
  }
  if (!tls) {
    console.log("\n  Tip: phones on Wi-Fi need HTTPS for the live camera. Without it, use the");
    console.log("  “Use phone camera app” button — it works over plain HTTP.\n");
  }
});
