// Only the native supervisor's private stdin pipe opts into this protocol.
// While ownership is being published, remember the stop instead of exiting
// halfway through mkdir -> owner.json and leaving an ownerless lock behind.
export function hostedWatcherStop({ enabled, input = process.stdin }) {
  let requested = false, shutdown = null, delivered = false, frame = "", overflow = false;
  const request = () => {
    requested = true;
    if (shutdown && !delivered) { delivered = true; shutdown(); }
  };
  const data = chunk => {
    for (const byte of chunk) {
      if (byte === 10) {
        if (!overflow && frame.replace(/\r$/, "") === "codex-pulse-stop") request();
        frame = ""; overflow = false;
      } else if (!overflow) {
        if (frame.length >= 128) { frame = ""; overflow = true; }
        else frame += String.fromCharCode(byte);
      }
    }
  };
  if (enabled) { input.on("data", data); input.on("end", request); input.on("error", request); }
  return {
    get requested() { return requested; },
    ready(callback) { shutdown = callback; if (requested) request(); },
    close() {
      if (!enabled) return;
      input.off("data", data); input.off("end", request); input.off("error", request);
      input.destroy();
    },
  };
}
