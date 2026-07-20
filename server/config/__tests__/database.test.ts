import { describe, expect, it } from "vitest";
import {
  databaseSsl,
  LOCAL_TEST_DATABASE_URL,
  requireDatabaseUrl,
  resolveDatabaseUrl,
} from "../database";

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv => ({ ...values });

describe("database environment", () => {
  it("requires the conventional DATABASE_URL variable", () => {
    expect(requireDatabaseUrl(env({ DATABASE_URL: " postgres://user:pass@localhost:5432/db " })))
      .toBe("postgres://user:pass@localhost:5432/db");
    expect(() => requireDatabaseUrl(env({}))).toThrow("DATABASE_URL environment variable is required");
  });

  it("fails closed outside tests when DATABASE_URL is missing", () => {
    expect(() => resolveDatabaseUrl(env({}))).toThrow(
      "DATABASE_URL environment variable is required",
    );
  });

  it("ignores inherited DATABASE_URL in tests and uses a deterministic local placeholder", () => {
    expect(resolveDatabaseUrl(env({
      VITEST: "true",
      DATABASE_URL: "postgres://production.example.invalid/should-not-be-used",
    }))).toBe(LOCAL_TEST_DATABASE_URL);
  });

  it("prefers the explicit TEST_DATABASE_URL in either supported test mode", () => {
    const testUrl = "postgres://localhost:5432/isolated_test";
    expect(resolveDatabaseUrl(env({
      VITEST: "true",
      TEST_DATABASE_URL: testUrl,
      DATABASE_URL: "postgres://production.example.invalid/should-not-be-used",
    }))).toBe(testUrl);
    expect(resolveDatabaseUrl(env({ NODE_ENV: "test", TEST_DATABASE_URL: testUrl }))).toBe(testUrl);
  });

  it("uses DATABASE_URL outside tests", () => {
    expect(resolveDatabaseUrl(env({ DATABASE_URL: " postgres://localhost:5432/runtime " })))
      .toBe("postgres://localhost:5432/runtime");
  });

  it("uses TLS for remote and production PostgreSQL connections", () => {
    expect(databaseSsl("postgres://user:pass@localhost:5432/db", env({ NODE_ENV: "development" })))
      .toBeUndefined();
    expect(databaseSsl("postgres://user:pass@db.example.test:5432/db", env({ NODE_ENV: "development" })))
      .toEqual({ rejectUnauthorized: false });
    expect(databaseSsl("postgres://user:pass@localhost:5432/db", env({ NODE_ENV: "production" })))
      .toEqual({ rejectUnauthorized: false });
  });

  it("rejects malformed connection strings without echoing them", () => {
    expect(() => databaseSsl("not-a-url", env({}))).toThrow(
      "DATABASE_URL must be a valid PostgreSQL connection URL",
    );
  });
});
