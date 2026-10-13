import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { validateMigrationDirectory } from "../../../scripts/migrations/migration-policy.mjs";

/**
 * Migration prefix collision guard — the CI twin of the check in
 * migrations/run-migrations.ts (which only runs in the Heroku release phase
 * and has already killed four deploys post-merge: prefixes 116 and 119, twice
 * each). Two PRs can each pass CI in isolation and only collide once both are
 * on main; this test makes the collision fail the second PR's CI instead of
 * the deploy — provided the branch is up to date with main (enable "Require
 * branches to be up to date before merging" so GitHub forces the re-run).
 *
 * The release runner and pre-install CI command use the same policy validator.
 * Existing prefixes remain frozen; new migrations use PR-owned identifiers
 * with dependency generations so independent branches cannot claim one ID.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "migrations");

describe("migration prefix collision guard", () => {
  it("no two migration files share a numeric prefix", () => {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    expect(files.length).toBeGreaterThan(100); // sanity: we found the real dir

    expect(validateMigrationDirectory(migrationsDir)).toEqual(files);
  });
});
