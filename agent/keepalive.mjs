// Staying up. `run` and `start` are a small watcher that runs the program itself as a second process, and starts it again
// whenever it stops without being asked to: a crash, the computer ending it (out of memory, say), or no sign of life for a
// few minutes while the computer was awake. The watcher does almost nothing itself, so there's little in it that can fail.
//
// The program ending with code 0 means it was asked to stop (Ctrl+C, or `stop`), and code 3 that it can't run here at all;
// either way the watcher ends with it. Anything else is started again after a pause that grows while it keeps failing
// straight away (1s, 2s, 4s … up to 30s), and goes back to 1s once a start has lasted a couple of minutes.
export const CANT_RUN = 3;

export function keepRunning({ start, log, end, name = "ClaudeConnect", hangMs = 180000, tickMs = 10000, maxDelay = 30000, steadyMs = 120000, now = () => Date.now() }) {
  let child = null;
  let stopping = false;
  let delay = 1000;
  let startedAt = 0;
  let beat = 0;
  let tick = now();
  let pending = null;
  let ended = false;
  const finish = code => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    clearTimeout(pending);
    end(code);
  };
  const launch = () => {
    pending = null;
    startedAt = beat = now();
    const c = start();
    child = c;
    // the program says it's alive every few seconds; a hung one stops saying so
    c.on("message", m => {
      if (m === "alive") beat = now();
    });
    c.on("error", () => {});
    c.on("exit", (code, signal) => {
      if (child !== c) return;
      child = null;
      if (stopping || code === 0 || code === CANT_RUN) return finish(stopping ? 0 : code);
      if (now() - startedAt > steadyMs) delay = 1000;
      log(`${name} stopped unexpectedly (${signal ? "ended by the computer, " + signal : "exit code " + code}). Starting it again${delay > 1000 ? ` in ${delay / 1000} seconds` : ""}.`);
      pending = setTimeout(launch, delay);
      delay = Math.min(delay * 2, maxDelay);
    });
  };
  const timer = setInterval(() => {
    const t = now();
    // this watcher's own clock jumped: the computer was asleep, and nothing could answer while it was
    if (t - tick > tickMs * 3) beat = t;
    tick = t;
    if (child && t - beat > hangMs) {
      log(`${name} stopped answering for ${Math.round((t - beat) / 60000)} minutes. Starting it again.`);
      beat = t;
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }, tickMs);
  launch();
  return {
    get child() {
      return child;
    },
    // asked to stop: the program stops (its runs with it), then the watcher ends
    stop() {
      if (stopping) return;
      stopping = true;
      if (!child) return finish(0);
      const c = child;
      try {
        c.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {}
        finish(0);
      }, 5000).unref?.();
    }
  };
}
