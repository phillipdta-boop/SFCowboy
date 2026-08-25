import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // gitConnections.test.ts shells out to real git (clone/fetch/push against a file:// remote)
    // and convert.test.ts runs real SDR conversions; both routinely exceed vitest's 5s default
    // on a cold filesystem, which showed up as a flaky commitAllAndPush timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
