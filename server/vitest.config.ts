import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // gitConnections.test.ts shells out to real git (clone/fetch/push against a file:// remote)
    // and convert.test.ts runs real SDR conversions; both routinely exceed vitest's 5s default
    // on a cold filesystem, which showed up as a flaky commitAllAndPush timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // organizations/app_users are shared, project-wide tables in the real Supabase project (see
    // schema.sql's comments) -- unlike every other table, they are NOT isolated per test file's
    // own throwaway schema. Running test files in parallel risks one file's test data racing
    // against another's, most acutely bootstrapIfNeeded's "is app_users empty" check against any
    // other file creating real rows in that same shared table at the same time.
    fileParallelism: false,
    // schema.sql now unconditionally references auth.users (Supabase-only), so every test file's
    // openTestDb() call needs a real Supabase project reachable via TEST_DATABASE_URL, not just
    // the auth-specific test files that previously remembered to `import "dotenv/config"`
    // themselves. Loading it globally here means server/.env's values are available to every test
    // file automatically.
    setupFiles: ["dotenv/config"],
  },
});
