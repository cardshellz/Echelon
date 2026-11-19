import { describe, expect, it, vi } from "vitest";
import {
  findUnreleasedMigrations,
  parseAppliedMigrations,
  parseDriftCheckArguments,
  sendAlert,
  type AlertFetch,
} from "../../../scripts/ci/schema-drift-check-support";
import { libpqEnvironment, redactValues } from "../../../scripts/ci/structure-dump";

const code = (expected: string) => expect.objectContaining({ code: expected });

describe("parseDriftCheckArguments", () => {
  it("reads the self-check source", () => {
    expect(parseDriftCheckArguments(["--self-check"])).toEqual({
      source: { kind: "self-check" }, reportFile: null, alertRequired: false,
    });
  });

  it("reads the two production files, a report path and the alert requirement in any order", () => {
    expect(parseDriftCheckArguments([
      "--require-alert", "--production-applied", "applied.json", "--report", "out.json", "--production-dump", "prod.sql",
    ])).toEqual({
      source: { kind: "files", dumpFile: "prod.sql", appliedFile: "applied.json" },
      reportFile: "out.json",
      alertRequired: true,
    });
  });

  it("reads a checkout of the published production structure", () => {
    expect(parseDriftCheckArguments(["--production-structure", "production-structure"]).source)
      .toEqual({ kind: "published", directory: "production-structure" });
  });

  it.each([
    ["no source", []],
    ["two sources", ["--self-check", "--production-structure", "dir"]],
    ["a dump without its applied list", ["--production-dump", "prod.sql"]],
    ["an applied list without its dump", ["--production-applied", "applied.json"]],
    ["files together with a published copy", ["--production-dump", "a", "--production-applied", "b", "--production-structure", "dir"]],
    ["an unknown argument", ["--self-check", "--verbose"]],
    ["a repeated argument", ["--self-check", "--self-check"]],
    ["a value option at the end", ["--self-check", "--report"]],
    ["a value option followed by another option", ["--report", "--self-check"]],
  ])("rejects %s", (_label, argv) => {
    expect(() => parseDriftCheckArguments(argv)).toThrowError(code("SCHEMA_DRIFT_USAGE"));
  });
});

describe("libpqEnvironment", () => {
  it("splits a URL into libpq variables and decodes the user and password", () => {
    const url = new URL("postgresql://drift%40ro:p%40ss%2Fword@db.example.invalid:6543/echelon");

    expect(libpqEnvironment(url, { production: false })).toEqual({
      PGHOST: "db.example.invalid", PGPORT: "6543", PGUSER: "drift@ro", PGPASSWORD: "p@ss/word", PGDATABASE: "echelon",
    });
  });

  it("defaults the port", () => {
    expect(libpqEnvironment(new URL("postgres://u:p@localhost/db"), { production: false }).PGPORT).toBe("5432");
  });

  it("requires TLS and a read-only session for production, whatever the URL says", () => {
    const environment = libpqEnvironment(new URL("postgres://u:p@db.example.invalid/db?sslmode=disable"), { production: true });

    expect(environment.PGSSLMODE).toBe("require");
    expect(environment.PGOPTIONS).toBe("-c default_transaction_read_only=on");
  });

  it("does not force TLS or read-only on a local scratch database", () => {
    const environment = libpqEnvironment(new URL("postgres://u:p@localhost/db"), { production: false });

    expect(environment).not.toHaveProperty("PGSSLMODE");
    expect(environment).not.toHaveProperty("PGOPTIONS");
  });

  it.each([
    ["another protocol", "https://u:p@db.example.invalid/db"],
    ["no database name", "postgres://u:p@db.example.invalid/"],
  ])("rejects a URL with %s", (_label, text) => {
    expect(() => libpqEnvironment(new URL(text), { production: true })).toThrowError(code("STRUCTURE_DUMP_DATABASE_URL_INVALID"));
  });
});

describe("parseAppliedMigrations", () => {
  it("accepts an array of filenames", () => {
    expect(parseAppliedMigrations('["0001_a.sql","0002_b.sql"]')).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("accepts an array of rows with a filename field", () => {
    expect(parseAppliedMigrations('[{"filename":"0001_a.sql","applied_at":"2026-01-01"}]')).toEqual(["0001_a.sql"]);
  });

  it.each([
    ["text that is not JSON", "not json"],
    ["an empty list", "[]"],
    ["an object", '{"filename":"0001_a.sql"}'],
    ["a row without a filename", '[{"name":"0001_a.sql"}]'],
    ["an empty filename", '[""]'],
    ["a null entry", "[null]"],
  ])("rejects %s", (_label, json) => {
    expect(() => parseAppliedMigrations(json)).toThrowError(code("SCHEMA_DRIFT_APPLIED_LIST_INVALID"));
  });
});

describe("findUnreleasedMigrations", () => {
  it("returns nothing when production has applied every repository migration", () => {
    expect(findUnreleasedMigrations(["0001_a.sql", "0002_b.sql"], ["0002_b.sql", "0001_a.sql"])).toEqual([]);
  });

  it("returns the repository migrations production has not applied, sorted", () => {
    expect(findUnreleasedMigrations(["0003_c.sql", "0001_a.sql", "0002_b.sql"], ["0001_a.sql"])).toEqual(["0002_b.sql", "0003_c.sql"]);
  });

  it("ignores migrations production recorded that the repository no longer holds", () => {
    expect(findUnreleasedMigrations(["0001_a.sql"], ["0001_a.sql", "backfill-order-lines.sql"])).toEqual([]);
  });

  it("does not change its inputs", () => {
    const repository = ["0002_b.sql", "0001_a.sql"];

    findUnreleasedMigrations(repository, []);

    expect(repository).toEqual(["0002_b.sql", "0001_a.sql"]);
  });
});

describe("redactValues", () => {
  it("removes every occurrence of each value", () => {
    expect(redactValues('connection to "db.example.invalid" failed for user "driftuser" on db.example.invalid', ["db.example.invalid", "driftuser"]))
      .toBe('connection to "<redacted>" failed for user "<redacted>" on <redacted>');
  });

  it("replaces a longer value before a shorter one it contains", () => {
    expect(redactValues("host=prod-db-primary user=prod-db", ["prod-db", "prod-db-primary"])).toBe("host=<redacted> user=<redacted>");
  });

  it("leaves very short, empty and missing values alone", () => {
    expect(redactValues("port 5432 for db", ["db", "", undefined])).toBe("port 5432 for db");
  });
});

describe("sendAlert", () => {
  const WEBHOOK = "https://alerts.example.invalid/hook/secret-token";

  it("posts the message as Discord-compatible JSON", async () => {
    const fetchImpl = vi.fn<AlertFetch>(async () => ({ ok: true, status: 204 }));

    await sendAlert(WEBHOOK, "drift found", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "drift found" }),
    });
  });

  it("fails when the webhook rejects the message, with the status", async () => {
    const fetchImpl = vi.fn<AlertFetch>(async () => ({ ok: false, status: 429 }));

    await expect(sendAlert(WEBHOOK, "drift found", fetchImpl)).rejects.toMatchObject({
      code: "SCHEMA_DRIFT_ALERT_NOT_DELIVERED", context: { status: 429 },
    });
  });

  it("fails when the webhook cannot be reached, without repeating the webhook address", async () => {
    const fetchImpl = vi.fn<AlertFetch>(async () => { throw new TypeError(`fetch failed for ${WEBHOOK}`); });

    const error = await sendAlert(WEBHOOK, "drift found", fetchImpl).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "SCHEMA_DRIFT_ALERT_NOT_DELIVERED", context: { errorName: "TypeError" } });
    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain("secret-token");
  });
});
