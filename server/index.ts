import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createApp } from "./app.ts";
import { createBrain } from "./brain.ts";
import { Store } from "./store.ts";
import { Team } from "./team.ts";

try {
  process.loadEnvFile?.(".env");
} catch {
  // no .env file — fine
}

const store = new Store(path.resolve(process.env.MIKOPARK_DATA ?? "data/workspace.json"));
const team = new Team(store, createBrain(store));
const app = createApp(store, team);

// In production, serve the built web client from the same origin.
const webDir = path.resolve("dist/web");
if (fs.existsSync(webDir)) {
  app.use(express.static(webDir));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDir, "index.html")));
}

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`MikoPark server on http://localhost:${port} (${team.mode} mode)`);
  if (team.mode === "demo") console.log("No ANTHROPIC_API_KEY set — agents will give scripted demo replies.");
});
