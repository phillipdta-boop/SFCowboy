import { randomUUID } from "node:crypto";
import { Router } from "express";
import type Database from "better-sqlite3";
import { createPkcePair, buildAuthorizeUrl, exchangeCodeForTokens } from "./oauth.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import type { Config } from "../config.js";

interface PendingAuth {
  verifier: string;
  nickname: string;
  orgType: "sandbox" | "production";
  loginUrl: string;
  createdAt: number;
}

export function createAuthRouter(db: Database.Database, config: Config): Router {
  const router = Router();
  const pending = new Map<string, PendingAuth>();

  router.get("/api/connections/org/start", (req, res) => {
    const nickname = String(req.query.nickname ?? "");
    const orgType = req.query.orgType === "sandbox" ? "sandbox" : "production";
    if (!nickname) {
      res.status(400).json({ error: "nickname is required" });
      return;
    }

    const loginUrl = orgType === "sandbox" ? "https://test.salesforce.com" : "https://login.salesforce.com";
    const { verifier, challenge } = createPkcePair();
    const state = randomUUID();
    pending.set(state, { verifier, nickname, orgType, loginUrl, createdAt: Date.now() });

    const url = buildAuthorizeUrl({
      loginUrl,
      state,
      challenge,
      callbackUrl: config.oauthCallbackUrl,
      clientId: config.sfClientId,
    });
    res.redirect(url);
  });

  router.get("/oauth/callback", async (req, res) => {
    // Prune entries older than 10 minutes
    const now = Date.now();
    const tenMinutes = 10 * 60 * 1000;
    for (const [stateKey, entry] of pending.entries()) {
      if (now - entry.createdAt > tenMinutes) {
        pending.delete(stateKey);
      }
    }

    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const entry = state ? pending.get(state) : undefined;

    if (!code || !entry) {
      if (entry) {
        pending.delete(state!);
      }
      res.status(400).json({ error: "invalid or expired oauth state" });
      return;
    }
    pending.delete(state!);

    try {
      const tokens = await exchangeCodeForTokens({
        loginUrl: entry.loginUrl,
        code,
        verifier: entry.verifier,
        callbackUrl: config.oauthCallbackUrl,
        clientId: config.sfClientId,
        clientSecret: config.sfClientSecret,
      });
      createOrgConnection(db, {
        nickname: entry.nickname,
        orgType: entry.orgType,
        instanceUrl: tokens.instanceUrl,
        refreshToken: tokens.refreshToken,
      });
      res.redirect("/connections?connected=1");
    } catch (err) {
      res.redirect(`/connections?error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  return router;
}
