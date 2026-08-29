import path from "node:path";
import express from "express";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { createAuthRouter } from "./auth/routes.js";
import { createConnectionsRouter } from "./connections/routes.js";
import { createEngineRouter } from "./engine/routes.js";
import { createPipelinesRouter } from "./pipelines/routes.js";

export function createApp(db: Database.Database, config: Config, dataDir: string, webDistDir?: string): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createAuthRouter(db, config));
  app.use(createConnectionsRouter(db, config));
  app.use(createEngineRouter(db, config, dataDir));
  app.use(createPipelinesRouter(db, config, dataDir));

  if (webDistDir) {
    app.use(express.static(webDistDir));
    app.get(/^(?!\/api|\/oauth).*/, (_req, res) => {
      res.sendFile(path.join(webDistDir, "index.html"));
    });
  }

  return app;
}
