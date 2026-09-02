import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { generateCodeVerifier, generateCodeChallenge, buildAuthorizationUrl, exchangeCodeForToken } from "./oauth.js";
import { createOrgConnection, reauthorizeOrgConnection, getConnectionRow } from "../connections/orgConnections.js";
import type { Config } from "../config.js";

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

interface PendingAuth {
  orgType: "sandbox" | "production";
  codeVerifier: string;
  loginUrl: string;
  createdAt: number;
  // Only set when creating a brand-new connection — a re-authorization keeps the existing nickname.
  nickname?: string;
  // Set when this authorization is meant to refresh credentials for an existing connection
  // (re-authorize) rather than create a new one.
  reauthorizeConnectionId?: string;
}

export function createAuthRouter(db: Pool, config: Config): Router {
  const router = Router();
  const pending = new Map<string, PendingAuth>();

  function loginUrlFor(orgType: "sandbox" | "production"): string {
    return orgType === "sandbox" ? "https://test.salesforce.com" : "https://login.salesforce.com";
  }

  router.post("/api/connections/org/authorize", async (req, res) => {
    const body = req.body as { nickname?: unknown; orgType?: unknown; connectionId?: unknown };

    let orgType: "sandbox" | "production";
    let nickname: string | undefined;
    let reauthorizeConnectionId: string | undefined;

    if (body.connectionId !== undefined) {
      if (typeof body.connectionId !== "string" || body.connectionId === "") {
        res.status(400).json({ error: "connectionId must be a non-empty string" });
        return;
      }
      const row = await getConnectionRow(db, body.connectionId);
      if (!row || row.type !== "org") {
        res.status(404).json({ error: "org connection not found" });
        return;
      }
      orgType = row.org_type;
      reauthorizeConnectionId = body.connectionId;
    } else {
      if (!body.nickname || typeof body.nickname !== "string") {
        res.status(400).json({ error: "nickname is required" });
        return;
      }
      if (body.orgType !== "sandbox" && body.orgType !== "production") {
        res.status(400).json({ error: "orgType must be 'sandbox' or 'production'" });
        return;
      }
      nickname = body.nickname;
      orgType = body.orgType;
    }

    const state = randomUUID();
    const codeVerifier = generateCodeVerifier();
    const loginUrl = loginUrlFor(orgType);
    pending.set(state, { nickname, orgType, codeVerifier, loginUrl, createdAt: Date.now(), reauthorizeConnectionId });

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

      if (entry.reauthorizeConnectionId) {
        await reauthorizeOrgConnection(db, entry.reauthorizeConnectionId, {
          instanceUrl: tokens.instanceUrl,
          refreshToken: tokens.refreshToken,
          username: tokens.username,
        });
        res.redirect("/connections?reconnected=1");
        return;
      }

      await createOrgConnection(db, {
        nickname: entry.nickname!,
        orgType: entry.orgType,
        instanceUrl: tokens.instanceUrl,
        refreshToken: tokens.refreshToken,
        clientId: config.sfClientId,
        username: tokens.username,
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
