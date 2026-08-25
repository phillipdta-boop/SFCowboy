import { Router } from "express";
import type Database from "better-sqlite3";
import { bootstrapOrgConnection } from "./bootstrap.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import type { Config } from "../config.js";

export function createAuthRouter(db: Database.Database, config: Config): Router {
  const router = Router();

  router.post("/api/connections/org/bootstrap", async (req, res) => {
    const body = req.body as { nickname?: unknown; orgType?: unknown; username?: unknown; password?: unknown; securityToken?: unknown };

    if (!body.nickname || typeof body.nickname !== "string") {
      res.status(400).json({ error: "nickname is required" });
      return;
    }
    if (body.orgType !== "sandbox" && body.orgType !== "production") {
      res.status(400).json({ error: "orgType must be 'sandbox' or 'production'" });
      return;
    }
    if (!body.username || typeof body.username !== "string") {
      res.status(400).json({ error: "username is required" });
      return;
    }
    if (!body.password || typeof body.password !== "string") {
      res.status(400).json({ error: "password is required" });
      return;
    }
    const securityToken = typeof body.securityToken === "string" && body.securityToken.length > 0 ? body.securityToken : undefined;

    try {
      const result = await bootstrapOrgConnection({
        orgType: body.orgType,
        username: body.username,
        password: body.password,
        securityToken,
        callbackUrl: config.oauthCallbackUrl,
      });

      const connection = createOrgConnection(db, {
        nickname: body.nickname,
        orgType: body.orgType,
        instanceUrl: result.instanceUrl,
        refreshToken: result.refreshToken,
        clientId: result.clientId,
      });

      res.status(201).json(connection);
    } catch (err) {
      // The failure detail can carry Salesforce error text (which may echo the username back),
      // so it stays in the server log; the client only gets a generic, actionable message.
      console.error("Salesforce org bootstrap failed", err);
      res.status(400).json({
        error: "Could not connect to Salesforce. Check the username, password, and security token, then try again.",
      });
    }
  });

  return router;
}
