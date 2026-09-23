import { describe, expect, it } from "vitest";
import { resolveReturnsTestDatabase } from "../support/disposable-database";

const portalUrl = "postgresql://returns_test:secret@127.0.0.1:55473/returns_portal_test";
const accessUrl = "postgresql://returns_test:secret@127.0.0.1:55473/returns_access_test";
const inspectionUrl = "postgresql://returns_test:secret@127.0.0.1:55474/returns_inspection_test";
const ciUrl = "postgresql://returns_test:secret@127.0.0.1:55473/echelon_ci_s4_00000000000040008000000000000001";
const localEnv: NodeJS.ProcessEnv = {
  ECHELON_TEST_DATABASE_DISPOSABLE: "true", ECHELON_TEST_DATABASE_URL: portalUrl,
  RETURNS_ACCESS_TEST_DATABASE_URL: accessUrl,
  RETURNS_INSPECTION_TEST_DATABASE_URL: inspectionUrl,
};

describe("returns disposable PostgreSQL boundary", () => {
  it("selects separate local databases so schema rebuilds cannot overlap", () => {
    expect(resolveReturnsTestDatabase(localEnv, "authorization")).toBe(portalUrl);
    expect(resolveReturnsTestDatabase(localEnv, "access")).toBe(accessUrl);
    expect(resolveReturnsTestDatabase(localEnv, "inspection")).toBe(inspectionUrl);
    expect(resolveReturnsTestDatabase({ ECHELON_TEST_DATABASE_URL: portalUrl }, "access")).toBeNull();
    expect(resolveReturnsTestDatabase({ ECHELON_TEST_DATABASE_URL: portalUrl }, "inspection")).toBeNull();
    expect(resolveReturnsTestDatabase({}, "authorization")).toBeNull();
  });

  it("uses the CI runner's per-file database rather than an inherited local override", () => {
    const env = { ...localEnv, ECHELON_TEST_DATABASE_URL: ciUrl };
    expect(resolveReturnsTestDatabase(env, "authorization")).toBe(ciUrl);
    expect(resolveReturnsTestDatabase(env, "access")).toBe(ciUrl);
    expect(resolveReturnsTestDatabase(env, "inspection")).toBe(ciUrl);
  });

  it.each([
    { ECHELON_TEST_DATABASE_DISPOSABLE: "false" },
    { ECHELON_TEST_DATABASE_DISPOSABLE: undefined },
    { ECHELON_TEST_DATABASE_URL: "not-a-url-secret" },
    { ECHELON_TEST_DATABASE_URL: portalUrl.replace("127.0.0.1", "production.example") },
    { ECHELON_TEST_DATABASE_URL: portalUrl.replace("postgresql:", "https:") },
    { ECHELON_TEST_DATABASE_URL: portalUrl.replace("returns_portal_test", "production") },
    { ECHELON_TEST_DATABASE_URL: portalUrl + "?host=production.example" },
    { ECHELON_TEST_DATABASE_URL: portalUrl + "#secret" },
    { ECHELON_TEST_DATABASE_URL: accessUrl },
    { ECHELON_TEST_DATABASE_URL: ciUrl.replace("_s4_", "_s9_") },
    { DATABASE_URL: portalUrl.replace("127.0.0.1", "localhost").replace("returns_test:secret", "other:credential") },
    { EXTERNAL_DATABASE_URL: portalUrl.replace("127.0.0.1", "[::1]") },
    { DATABASE_URL: "malformed-secret" },
  ])("rejects unsafe schema-reset targets without printing credentials: %j", (overrides) => {
    expect(() => resolveReturnsTestDatabase({ ...localEnv, ...overrides }, "authorization"))
      .toThrow("Returns integration tests require an explicitly disposable local suite database");
  });

  it("treats omitted and default ports as the same application database", () => {
    const env = { ...localEnv, ECHELON_TEST_DATABASE_URL: portalUrl.replace(":55473", ""),
      DATABASE_URL: portalUrl.replace(":55473", ":5432") };
    expect(() => resolveReturnsTestDatabase(env, "authorization")).toThrow();
  });

  it("applies the same query-override protection to the access database", () => {
    expect(() => resolveReturnsTestDatabase({ ...localEnv, RETURNS_ACCESS_TEST_DATABASE_URL: accessUrl + "?host=remote" }, "access"))
      .toThrow();
  });

  it.each([accessUrl, portalUrl, inspectionUrl + "?host=remote", inspectionUrl.replace("127.0.0.1", "remote.example")])(
    "rejects cross-suite and remote inspection targets %s", url => {
      expect(() => resolveReturnsTestDatabase({ ...localEnv, RETURNS_INSPECTION_TEST_DATABASE_URL: url }, "inspection")).toThrow();
    });
});
