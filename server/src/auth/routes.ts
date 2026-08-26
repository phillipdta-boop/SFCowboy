import { randomUUID } from "node:crypto";
import { Router } from "express";
import type Database from "better-sqlite3";
import { generateCodeVerifier, generateCodeChallenge, buildAuthorizationUrl, exchangeCodeForToken } from "./oauth.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import type { Config } from "../config.js";

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

interface PendingAuth {
  nickname: string;
  orgType: "sandbox" | "production";
  codeVerifier: string;
  loginUrl: string;
  createdAt: number;
}

export function createAuthRouter(db: Database.Database, config: Config): Router {
  const router = Router();
  const pending = new Map<string, PendingAuth>();

  function loginUrlFor(orgType: "sandbox" | "production"): string {
    return orgType === "sandbox" ? "https://test.salesforce.com" : "https://login.salesforce.com";
  }

  router.post("/api/connections/org/authorize", (req, res) => {
    const body = req.body as { nickname?: unknown; orgType?: unknown };

    if (!body.nickname || typeof body.nickname !== "string") {
      res.status(400).json({ error: "nickname is required" });
      return;
    }
    if (body.orgType !== "sandbox" && body.orgType !== "production") {
      res.status(400).json({ error: "orgType must be 'sandbox' or 'production'" });
      return;
    }

    const state = randomUUID();
    const codeVerifier = generateCodeVerifier();
    const loginUrl = loginUrlFor(body.orgType);
    pending.set(state, { nickname: body.nickname, orgType: body.orgType, codeVerifier, loginUrl, createdAt: Date.now() });

    const authorizeUrl = buildAuthorizationUrl({
      loginUrl,
      clientId: config.sfClientId,
      redirectUri: config.oauthCallbackUrl,
      state,
      codeChallenge: generateCodeChallenge(codeVerifier),
    });

    res.json({ authorizeUrl });
  });

  router.get("/oauth/callback", async (req, res) => {
    const { code, state, error: sfError } = req.query as { code?: string; state?: string; error?: string };

    if (!state || !pending.has(state)) {
      res.redirect("/connections?error=" + encodeURIComponent("The connection attempt expired or was invalid. Please try again."));
      return;
    }

    const entry = pending.get(state)!;
    pending.delete(state);

    if (sfError || !code || Date.now() - entry.createdAt > PENDING_AUTH_TTL_MS) {
      res.redirect("/connections?error=" + encodeURIComponent("Salesforce did not authorize the connection. Please try again."));
      return;
    }

    try {
      const tokens = await exchangeCodeForToken({
        loginUrl: entry.loginUrl,
        code,
        clientId: config.sfClientId,
        redirectUri: config.oauthCallbackUrl,
        codeVerifier: entry.codeVerifier,
      });

      createOrgConnection(db, {
        nickname: entry.nickname,
        orgType: entry.orgType,
        instanceUrl: tokens.instanceUrl,
        refreshToken: tokens.refreshToken,
        clientId: config.sfClientId,
      });

      res.redirect("/connections?connected=1");
    } catch (err) {
      // The failure detail is a Salesforce OAuth error body, kept server-side only.
      console.error("Salesforce org authorization failed", err);
      res.redirect("/connections?error=" + encodeURIComponent("Could not connect to Salesforce. Please try again."));
    }
  });

  return router;
}
