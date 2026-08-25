#!/usr/bin/env node
// One-command local launch: builds both packages, starts the server serving the built
// frontend, waits for it to come up, then opens it in your default browser.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.join(repoRoot, "server");
const webDir = path.join(repoRoot, "web");
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

// npm ships as npm.cmd on Windows, which node's spawn/spawnSync can only launch through a
// shell. Every argument passed through `run()` in this script is a fixed literal we wrote
// ("install", "run", "build") — never anything from user input or the environment — so the
// shell-injection risk the shell:true deprecation warning warns about doesn't apply here.
const npmCommand = "npm";

function run(command, args, cwd) {
  console.log(`\n> ${command} ${args.join(" ")}  (in ${path.relative(repoRoot, cwd) || "."})`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    console.error(`\nCommand failed: ${command} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

function ensureEnvFile() {
  const envPath = path.join(serverDir, ".env");
  const examplePath = path.join(serverDir, ".env.example");
  if (existsSync(envPath)) return;

  console.log("\nNo server/.env found — creating one from server/.env.example with a fresh ENCRYPTION_KEY.");
  const template = readFileSync(examplePath, "utf-8");
  const withKey = template.replace("ENCRYPTION_KEY=", `ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`);
  writeFileSync(envPath, withKey);
}

function ensureInstalled(dir) {
  if (!existsSync(path.join(dir, "node_modules"))) {
    run(npmCommand, ["install"], dir);
  }
}

function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const req = http.get(`http://localhost:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on("error", retry);
      req.setTimeout(1000, () => req.destroy());
    }
    function retry() {
      if (Date.now() > deadline) {
        reject(new Error("Server did not become healthy within the expected time."));
        return;
      }
      setTimeout(attempt, 300);
    }
    attempt();
  });
}

function openBrowser(url) {
  const platform = process.platform;
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

ensureEnvFile();
ensureInstalled(serverDir);
ensureInstalled(webDir);

run(npmCommand, ["run", "build"], webDir);
run(npmCommand, ["run", "build"], serverDir);

console.log("\nStarting SFCowboy…");
const server = spawn("node", ["dist/index.js"], {
  cwd: serverDir,
  stdio: "inherit",
  env: { ...process.env, WEB_DIST_DIR: path.join(webDir, "dist"), PORT: String(port) },
});

server.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => server.kill("SIGINT"));
process.on("SIGTERM", () => server.kill("SIGTERM"));

try {
  await waitForHealth();
  const url = `http://localhost:${port}`;
  console.log(`\nSFCowboy is running at ${url} — opening it in your browser.`);
  openBrowser(url);
} catch (err) {
  console.error(`\n${err.message} Check the server output above for errors.`);
}
