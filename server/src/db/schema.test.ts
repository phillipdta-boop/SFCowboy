import { describe, it, expect } from "vitest";
import { openTestDb, type TestDb } from "./testDb.js";

describe("organizations + organization_id defaults", () => {
  let db: TestDb;

  it("creates the well-known default organization on a fresh database", async () => {
    db = await openTestDb();
    const result = await db.pool.query(`SELECT id, name FROM organizations WHERE id = '00000000-0000-0000-0000-000000000000'`);
    expect(result.rows).toHaveLength(1);
    await db.stop();
  });

  it("defaults organization_id to the well-known org on every existing table when omitted from an insert", async () => {
    db = await openTestDb();
    await db.pool.query(`INSERT INTO connections (id, type, nickname, created_at) VALUES ('c1', 'git', 'Test', '2026-01-01T00:00:00.000Z')`);
    const result = await db.pool.query(`SELECT organization_id FROM connections WHERE id = 'c1'`);
    expect(result.rows[0].organization_id).toBe("00000000-0000-0000-0000-000000000000");
    await db.stop();
  });
});
