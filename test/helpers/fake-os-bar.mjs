// A stand-in for agent/app-mac-bar.js and agent/app-win-bar.ps1, the Stop bar: what it would show is written to
// $CLAUDECONNECT_FAKE_DIR/bar.json, and a test presses Stop by making $CLAUDECONNECT_FAKE_DIR/bar-press.
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const DIR = process.env.CLAUDECONNECT_FAKE_DIR;
let bar = { text: "", label: "" };
try {
  bar = { ...bar, ...JSON.parse(process.env.CLAUDECONNECT_BAR || "{}") };
} catch {}
const show = shown => writeFileSync(join(DIR, "bar.json"), JSON.stringify({ shown, text: bar.text, label: bar.label }));
const end = () => {
  show(false);
  process.exit(0);
};
show(true);
process.stdout.write("ready\n");
createInterface({ input: process.stdin }).on("line", line => {
  if (line.trim() === "quit") end();
  if (line.startsWith("text ")) {
    try {
      const t = JSON.parse(line.slice(5));
      bar = { text: t.text || bar.text, label: t.label || bar.label };
      show(true);
    } catch {}
  }
});
process.stdin.on("end", end);
setInterval(() => {
  if (existsSync(join(DIR, "bar-press"))) {
    unlinkSync(join(DIR, "bar-press"));
    process.stdout.write("stop\n");
    end();
  }
}, 50);
