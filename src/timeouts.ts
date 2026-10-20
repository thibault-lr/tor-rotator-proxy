import type { Socket } from "node:net";

export function setConnectionTimeouts(
  socket: Socket,
  idleMs: number,
  maxMs: number,
  close: () => void,
) {
  let { bytesRead, bytesWritten } = socket;
  let activity = performance.now();

  const sample = () => {
    const received = socket.bytesRead - bytesRead;
    const sent = socket.bytesWritten - bytesWritten;
    if (received > 0 || sent > 0) {
      activity = performance.now();
    }
    bytesRead = socket.bytesRead;
    bytesWritten = socket.bytesWritten;
  };
  // An independent watch still fires when backpressure stops readable/writable callbacks.
  const idle = setInterval(
    () => {
      sample();
      if (performance.now() - activity >= idleMs) {
        close();
      }
    },
    Math.min(250, Math.max(1, idleMs / 4)),
  ).unref();
  const maximum = setTimeout(close, maxMs).unref();
  const stop = () => {
    sample();
    clearInterval(idle);
    clearTimeout(maximum);
  };
  socket.once("close", stop);
}
