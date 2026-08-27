#!/usr/bin/env node
// Starts the already-built server serving the already-built frontend, without rebuilding or
// popping open an external browser — used by the in-app browser preview during development.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.join(repoRoot, "server");
const webDir = path.join(repoRoot, "web");
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

const server = spawn("node", ["dist/index.js"], {
  cwd: serverDir,
  stdio: "inherit",
  env: { ...process.env, WEB_DIST_DIR: path.join(webDir, "dist"), PORT: String(port) },
});

server.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => server.kill("SIGINT"));
process.on("SIGTERM", () => server.kill("SIGTERM"));
