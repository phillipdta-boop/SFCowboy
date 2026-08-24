import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { openDb, runMigrations } from "./client.js";

const testDbPath = "./test-sfcowboy.db";

afterEach(() => {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});

describe("db client", () => {
  it("creates all expected tables", () => {
    const db = openDb(testDbPath);
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining(["connections", "pipelines", "deployments", "deployment_items"])
    );
    db.close();
  });
});
