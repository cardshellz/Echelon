import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * The web process must never change table structure while it starts.
 *
 * It used to: `server/index.ts` awaited about 170 `ALTER TABLE` / `CREATE
 * INDEX` fallbacks before listening. Those need exclusive locks on live
 * tables, so one session holding a table kept every dyno from starting
 * (outages on 2026-11-10 and 2026-11-11). Schema now changes only through the
 * tracked migrations, in the release phase. The fallback routine itself was
 * retired block by block and deleted (REFACTOR-PLAN-2026-07.md, P4.1). These
 * checks keep it from coming back.
 */
const ROOT = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

function productionFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return name === "__tests__" || name === "node_modules" ? [] : productionFiles(path);
    }
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe("web boot does not change schema", () => {
  const FALLBACK_NAMES = /runReleaseSchemaFallbacks|runStartupMigrations|SKIP_STARTUP_MIGRATIONS/;

  it("the web entry point does not reference the schema fallbacks", () => {
    expect(withoutComments(read("server/index.ts"))).not.toMatch(FALLBACK_NAMES);
  });

  it("no production code under server/ or scripts/ references the deleted fallback routine", () => {
    const referrers = [...productionFiles(join(ROOT, "server")), ...productionFiles(join(ROOT, "scripts"))]
      .filter((path) => FALLBACK_NAMES.test(withoutComments(readFileSync(path, "utf8"))))
      .map((path) => relative(ROOT, path).replace(/\\/g, "/"));
    expect(referrers).toEqual([]);
  });

  it("the release phase runs tracked migrations, then the smoke check, and no schema fallback step", () => {
    const steps = read("scripts/release.sh").split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    const migrations = steps.indexOf("migrations/run-migrations.ts");
    const smoke = steps.indexOf("scripts/release-smoke-order-edit.ts");
    expect(migrations).toBeGreaterThanOrEqual(0);
    expect(smoke).toBeGreaterThan(migrations);
    expect(steps).not.toMatch(/schema-fallbacks/);
  });

  it("server/db.ts runs no SQL of its own and contains no DDL", () => {
    const source = withoutComments(read("server/db.ts"));
    expect(source).not.toMatch(/\.query\(/);
    expect(source).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|(?:UNIQUE\s+)?INDEX|SCHEMA|TYPE|SEQUENCE)\b/i);
  });
});
