// Must be imported before any router is created — it patches Express's router prototype so a
// rejected promise from an async handler reaches error-handling middleware via next(err), the
// same way a synchronous throw always has. Without this, an async route handler's rejected
// promise is an unhandled rejection that crashes the process instead of producing a response —
// see this task's amendment note for why this became necessary during the Postgres migration.
import "express-async-errors";
import path from "node:path";
import express from "express";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { createAuthRouter } from "./auth/routes.js";
import { createConnectionsRouter } from "./connections/routes.js";
import { createEngineRouter } from "./engine/routes.js";
import { createPipelinesRouter } from "./pipelines/routes.js";

export function createApp(db: Pool, config: Config, dataDir: string, webDistDir?: string): express.Express {
  const app = express();
  // Raised from Express's 100kb default so an imported deployment's zip (sent as base64 JSON —
  // see /api/deployments/import) doesn't get rejected before it ever reaches validation.
  app.use(express.json({ limit: "50mb" }));

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

  // Terminal error handler — restores the pre-migration behavior where an uncaught error (then:
  // a synchronous throw from the old SQLite driver; now: a rejected promise from an async handler,
  // forwarded here by express-async-errors above) becomes a 500 instead of crashing the process
  // or hanging the request. Must be registered last, and must have all 4 parameters (Express
  // only treats a 4-arg function as error-handling middleware).
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Unhandled error in request handler", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
