import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { openDb, runMigrations } from "./db/client.js";
import { createApp } from "./app.js";

const config = loadConfig();
const dataDir = process.env.DATA_DIR ?? "./data";
fs.mkdirSync(dataDir, { recursive: true });

const db = openDb(config.dbPath);
runMigrations(db);

const app = createApp(db, config, dataDir);

app.listen(config.port, () => {
  console.log(`SFCowboy server listening on :${config.port}`);
});
