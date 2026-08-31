import "dotenv/config";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { openDb, runMigrations } from "./db/client.js";
import { createApp } from "./app.js";
import { startScheduler } from "./scheduler.js";

const config = loadConfig();
const dataDir = process.env.DATA_DIR ?? "./data";
fs.mkdirSync(dataDir, { recursive: true });

const db = openDb(config.dbPath);
runMigrations(db);

const app = createApp(db, config, dataDir, process.env.WEB_DIST_DIR);

// Catches up on anything scheduled while the server wasn't running, then polls for newly-due
// scheduled deployments every 30s — see scheduler.ts.
startScheduler(db, config, dataDir, 30_000);

app.listen(config.port, () => {
  console.log(`SFCowboy server listening on :${config.port}`);
});
