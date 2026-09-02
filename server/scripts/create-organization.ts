import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Pool } from "pg";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { hashPassword, createUser } from "../src/users/users.js";

/**
 * Creates one brand-new organization plus its first admin user — the manual, repeatable tool a
 * platform operator runs to onboard a new customer beyond the bootstrapped organization (see
 * users/bootstrap.ts, which only ever creates the FIRST one, automatically, at boot). No self-serve
 * signup exists in this product yet — this script is the entire "provision a new org" mechanism.
 */
export async function createOrganizationWithAdmin(
  db: Pool,
  input: { organizationName: string; adminEmail: string; adminPassword: string }
): Promise<{ organizationId: string; userId: string }> {
  const organizationId = randomUUID();
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`, [organizationId, input.organizationName, new Date().toISOString()]);

  const user = await createUser(db, {
    organizationId,
    email: input.adminEmail,
    passwordHash: await hashPassword(input.adminPassword),
    role: "admin",
    name: "Admin",
  });

  return { organizationId, userId: user.id };
}

async function main() {
  const [organizationName, adminEmail, adminPassword] = process.argv.slice(2);
  if (!organizationName || !adminEmail || !adminPassword) {
    console.error("Usage: tsx scripts/create-organization.ts <organization-name> <admin-email> <admin-password>");
    process.exit(1);
  }

  const config = loadConfig();
  const pool = openDb(config.databaseUrl);

  const result = await createOrganizationWithAdmin(pool, { organizationName, adminEmail, adminPassword });
  console.log(`Created organization "${organizationName}" (${result.organizationId}) with admin ${adminEmail} (${result.userId})`);

  await pool.end();
}

// Cross-platform-safe direct-execution guard (see migrate-sqlite-to-postgres.ts's amendment note
// for why a naive `import.meta.url === file://${process.argv[1]}` comparison breaks on Windows).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Failed to create organization:", err);
    process.exit(1);
  });
}
