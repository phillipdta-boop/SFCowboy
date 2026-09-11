import "dotenv/config";
import { describe, it, expect } from "vitest";
import { createSupabaseAdminClient, verifySupabaseJwt } from "./supabase.js";
import { loadConfig } from "./config.js";

const hasRealSupabaseProject = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!hasRealSupabaseProject)("verifySupabaseJwt", () => {
  it("verifies a real access token minted by the dev project and rejects a tampered one", async () => {
    const config = loadConfig();
    const admin = createSupabaseAdminClient(config);

    const email = `supabase-test-${Date.now()}@example.com`;
    const { data: userData, error: createError } = await admin.auth.admin.createUser({
      email,
      password: "a-good-test-password-1",
      email_confirm: true,
    });
    expect(createError).toBeNull();

    try {
      const { data: sessionData, error: signInError } = await admin.auth.signInWithPassword({
        email,
        password: "a-good-test-password-1",
      });
      expect(signInError).toBeNull();
      const token = sessionData.session!.access_token;

      const verified = await verifySupabaseJwt(config, token);
      expect(verified.userId).toBe(userData.user!.id);

      await expect(verifySupabaseJwt(config, token + "tampered")).rejects.toThrow();
    } finally {
      await admin.auth.admin.deleteUser(userData.user!.id);
    }
  });
});
