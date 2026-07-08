import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

/**
 * Migration prefix collision guard — the CI twin of the check in
 * migrations/run-migrations.ts (which only runs in the Heroku release phase
 * and has already killed four deploys post-merge: prefixes 116 and 119, twice
 * each). Two PRs can each pass CI in isolation and only collide once both are
 * on main; this test makes the collision fail the second PR's CI instead of
 * the deploy — provided the branch is up to date with main (enable "Require
 * branches to be up to date before merging" so GitHub forces the re-run).
 *
 * Mirrors run-migrations.ts exactly: top-level *.sql files, numeric prefix
 * per /^(\d+)_/, compared as strings.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "migrations");

describe("migration prefix collision guard", () => {
  it("no two migration files share a numeric prefix", () => {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    expect(files.length).toBeGreaterThan(100); // sanity: we found the real dir

    const prefixMap = new Map<string, string>();
    const collisions: string[] = [];
    for (const file of files) {
      const match = file.match(/^(\d+)_/);
      if (!match) continue;
      const prefix = match[1];
      const existing = prefixMap.get(prefix);
      if (existing) {
        collisions.push(`${existing} vs ${file}`);
      } else {
        prefixMap.set(prefix, file);
      }
    }

    expect(collisions, `Duplicate migration prefixes (rename yours to the next free number): ${collisions.join("; ")}`).toEqual([]);
  });
});
