/** Thin wrapper around getUserMedia with friendly errors, flip and torch. */
export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facing = "environment";
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  static supported() {
    return !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
  }

  static explain(err) {
    if (!window.isSecureContext) {
      return "Live camera needs HTTPS or localhost. Use “Use phone camera app” or upload a photo instead.";
    }
    if (!navigator.mediaDevices?.getUserMedia)
      return "This browser can't open the camera. Upload a photo instead.";
    switch (err?.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Camera permission was denied. Allow camera access in your browser settings, or upload a photo.";
      case "NotFoundError":
      case "OverconstrainedError":
        return "No camera was found on this device. Upload a photo instead.";
      case "NotReadableError":
        return "The camera is being used by another app.";
      default:
        return "Couldn't start the camera. Upload a photo instead.";
    }
  }

  get active() {
    return !!this.stream && this.stream.getVideoTracks().some(t => t.readyState === "live");
  }

  get track() {
    return this.stream?.getVideoTracks()[0] || null;
  }

  async start(facing = this.facing) {
    this.stop();
    this.facing = facing;
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    this.video.classList.toggle("mirror", facing === "user");
    await this.video.play().catch(() => {});
    if (!this.video.videoWidth) {
      await new Promise(resolve => {
        this.video.addEventListener("loadedmetadata", resolve, { once: true });
        setTimeout(resolve, 2000);
      });
    }
    return this;
  }

  stop() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    this.stream = null;
    this.video.srcObject = null;
  }

  async flip() {
    return this.start(this.facing === "environment" ? "user" : "environment");
  }

  hasTorch() {
    try {
      return !!this.track?.getCapabilities?.().torch;
    } catch {
      return false;
    }
  }

  async setTorch(on) {
    await this.track?.applyConstraints({ advanced: [{ torch: on }] });
  }

  /** Current frame as ImageData, downscaled so the longest side ≤ maxDim. */
  grab(maxDim = 1600) {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    const s = Math.min(1, maxDim / Math.max(vw, vh));
    const w = Math.round(vw * s);
    const h = Math.round(vh * s);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(this.video, 0, 0, w, h);
    return { image: this.ctx.getImageData(0, 0, w, h), scale: s };
  }
}
