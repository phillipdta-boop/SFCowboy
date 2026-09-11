import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.js";

/**
 * Server-side client using the service_role key -- full admin access, bypasses every Auth
 * restriction. Never expose this client or its key to the browser. Used only for admin
 * operations: inviting users, listing users to join with app_users, generating password-reset
 * links. See the design spec's Security Considerations section.
 */
export function createSupabaseAdminClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Cached per Config instance rather than module-level global, so tests using different fixture
// configs (different supabaseUrl) each get their own JWKS fetcher instead of silently sharing one
// pointed at the wrong project.
const jwksCache = new WeakMap<Config, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(config: Config) {
  let jwks = jwksCache.get(config);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`));
    jwksCache.set(config, jwks);
  }
  return jwks;
}

export interface VerifiedSupabaseUser {
  userId: string;
}

/**
 * Verifies a Supabase-issued access token's signature locally against the project's published
 * signing keys (cached, not re-fetched per call) -- no network call to Supabase on the request's
 * hot path. Throws if the token is malformed, expired, or signed by a different project.
 */
export async function verifySupabaseJwt(config: Config, token: string): Promise<VerifiedSupabaseUser> {
  const { payload } = await jwtVerify(token, getJwks(config), {
    issuer: `${config.supabaseUrl}/auth/v1`,
  });
  if (typeof payload.sub !== "string") throw new Error("Token payload missing sub claim");
  return { userId: payload.sub };
}
