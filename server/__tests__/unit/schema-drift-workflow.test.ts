import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCTION_STRUCTURE_BRANCH } from "../../../scripts/migrations/production-structure.mjs";

const ROOT = resolve(__dirname, "../../..");
const source = (file: string) => readFileSync(resolve(ROOT, file), "utf8").replace(/\r\n/g, "\n");

const workflow = source(".github/workflows/schema-drift.yml");
const checkScript = source("scripts/ci/check-schema-drift.ts");

function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("schema drift workflow", () => {
  it("runs nightly and can be started by hand", () => {
    expect(workflow).toMatch(/\n {2}schedule:\n(?: {4}#.*\n)* {4}- cron: "\d+ \d+ \* \* \*"\n/);
    expect(workflow).toContain("\n  workflow_dispatch:\n");
  });

  // The decision this guards: production's structure is published from Heroku,
  // so GitHub never holds a credential that could read production's data.
  it("holds no database credential", () => {
    const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);

    expect(secrets).toEqual(["SCHEMA_DRIFT_ALERT_WEBHOOK_URL"]);
    expect(workflow).not.toMatch(/DATABASE_URL: \$\{\{/);
    expect(checkScript).not.toContain("SCHEMA_DRIFT_PRODUCTION_DATABASE_URL");
  });

  it("only talks to the disposable PostgreSQL on the runner", () => {
    expect(workflow).toContain("ECHELON_TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres");
    expect(workflow).toContain('ECHELON_TEST_DATABASE_DISPOSABLE: "true"');
  });

  it("gives the workflow read-only access to the repository", () => {
    expect(workflow).toContain("\npermissions:\n  contents: read\n");
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(3);
  });

  it("compares against the published production structure and refuses to run without an alert webhook", () => {
    const compare = job("compare-with-production");

    expect(compare).toContain("if: github.event_name != 'pull_request'");
    expect(compare).toContain(`ref: ${PRODUCTION_STRUCTURE_BRANCH}`);
    expect(compare).toContain(`--production-structure ${PRODUCTION_STRUCTURE_BRANCH}`);
    expect(compare).toContain("--require-alert");
    expect(compare).toContain("SCHEMA_DRIFT_ALERT_WEBHOOK_URL: ${{ secrets.SCHEMA_DRIFT_ALERT_WEBHOOK_URL }}");
  });

  it("self-checks on pull requests without production data or alerts", () => {
    const selfCheck = job("self-check");

    expect(selfCheck).toContain("if: github.event_name == 'pull_request'");
    expect(selfCheck).toContain("run: node --import tsx scripts/ci/check-schema-drift.ts --self-check");
    expect(selfCheck).not.toContain("secrets.");
    expect(selfCheck).not.toContain(PRODUCTION_STRUCTURE_BRANCH);
  });

  it("uses PostgreSQL 17, production's major version, for the database and for pg_dump", () => {
    expect(workflow.match(/image: postgres:17\n/g)).toHaveLength(2);
    expect(workflow).toContain("PG_DUMP_PATH: scripts/ci/pg-dump-17.sh");
    expect(source("scripts/ci/pg-dump-17.sh")).toContain("postgres:17 pg_dump");
  });

  it("re-runs the self-check when any file the check depends on changes", () => {
    for (const file of [
      ".github/workflows/schema-drift.yml",
      "migrations/baseline/**",
      "scripts/ci/check-schema-drift.ts",
      "scripts/ci/disposable-database.ts",
      "scripts/ci/pg-dump-17.sh",
      "scripts/ci/schema-drift-check-support.ts",
      "scripts/ci/structure-dump.ts",
      "scripts/migrations/baseline-format.mjs",
      "scripts/migrations/production-structure.mjs",
      "scripts/migrations/schema-drift.mjs",
    ]) {
      expect(workflow, file).toContain(`      - "${file}"\n`);
    }
  });
});
