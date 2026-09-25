// Starts the local voice engine if it has been installed (npm run voice:setup); otherwise explains how.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = path.join(root, "voice-engine", ".venv", "bin", "python");

if (!existsSync(python) && process.env.VOICE_ENGINE_FAKE !== "1") {
  console.log("Voice engine not installed — agents will use your Mac's built-in voices.");
  console.log("To use custom voices, run: npm run voice:setup");
  // Stay alive so `concurrently -k` doesn't stop the rest of the app.
  setInterval(() => {}, 1 << 30);
} else {
  const child = spawn(existsSync(python) ? python : "python3", [path.join(root, "voice-engine", "server.py")], { stdio: "inherit" });
  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => {
    if (code) console.log(`Voice engine stopped (exit ${code}). Agents will use your Mac's built-in voices.`);
    setInterval(() => {}, 1 << 30);
  });
}
