import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * The web process must never change table structure while it starts.
 *
 * It used to: `server/index.ts` awaited about 170 `ALTER TABLE` / `CREATE
 * INDEX` fallbacks before listening. Those need exclusive locks on live
 * tables, so one session holding a table kept every dyno from starting
 * (outages on 2026-11-10 and 2026-11-11). Schema now changes only in the
 * release phase. These checks keep it that way.
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
  it("the web entry point does not reference the schema fallbacks", () => {
    const entry = withoutComments(read("server/index.ts"));
    expect(entry).not.toMatch(/runReleaseSchemaFallbacks|runStartupMigrations/);
    expect(entry).not.toMatch(/SKIP_STARTUP_MIGRATIONS/);
  });

  it("nothing under server/ calls the schema fallbacks; only the release script does", () => {
    const callers = productionFiles(join(ROOT, "server"))
      .filter((path) => relative(ROOT, path).replace(/\\/g, "/") !== "server/db.ts")
      .filter((path) => /runReleaseSchemaFallbacks|runStartupMigrations/.test(withoutComments(readFileSync(path, "utf8"))))
      .map((path) => relative(ROOT, path).replace(/\\/g, "/"));
    expect(callers).toEqual([]);
    expect(withoutComments(read("scripts/release-schema-fallbacks.ts"))).toMatch(/runReleaseSchemaFallbacks\(\)/);
  });

  it("the release phase runs the fallbacks after tracked migrations and before the smoke check", () => {
    const steps = read("scripts/release.sh").split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    const migrations = steps.indexOf("migrations/run-migrations.ts");
    const fallbacks = steps.indexOf("scripts/release-schema-fallbacks.ts");
    const smoke = steps.indexOf("scripts/release-smoke-order-edit.ts");
    expect(migrations).toBeGreaterThanOrEqual(0);
    expect(fallbacks).toBeGreaterThan(migrations);
    expect(smoke).toBeGreaterThan(fallbacks);
  });

  it("the fallbacks keep their lock and time limits", () => {
    const routine = withoutComments(read("server/db.ts"));
    expect(routine).toMatch(/await boundStartupMigrationClient\(connection\)/);
    expect(routine).not.toMatch(/runStartupMigrations/);
  });
});
