import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { POSTGRES_SHARD_COUNT, POSTGRES_TEST_FILES } from "../../../scripts/ci/postgres-test-manifest";
import {
  POSTGRES_REPOSITORY_ROOT,
  buildPostgresVitestArgs,
  createOwnedDatabaseName,
  parsePostgresShard,
  runPostgresShard,
  selectPostgresShardFiles,
  validatePostgresManifest,
  validatePostgresTestEnvironment,
  type PostgresAdminConnection,
  type PostgresRunnerDependencies,
} from "../../../scripts/ci/postgres-tests";

const disposableEnvironment: NodeJS.ProcessEnv = {
  ECHELON_TEST_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/echelon_test",
  ECHELON_TEST_DATABASE_DISPOSABLE: "true",
};

function runnerFixture() {
  const connections: Array<{
    connect: ReturnType<typeof vi.fn<PostgresAdminConnection["connect"]>>;
    query: ReturnType<typeof vi.fn<PostgresAdminConnection["query"]>>;
    end: ReturnType<typeof vi.fn<PostgresAdminConnection["end"]>>;
  }> = [];
  const events: string[] = [];
  let nextId = 0;
  const createAdminConnection = vi.fn((connectionString: string) => {
    expect(connectionString).toBe(disposableEnvironment.ECHELON_TEST_DATABASE_URL);
    const connection = {
      connect: vi.fn(async () => { events.push("connect"); }),
      query: vi.fn(async (statement: string) => { events.push(statement); }),
      end: vi.fn(async () => { events.push("end"); }),
    };
    connections.push(connection);
    return connection;
  });
  const dependencies: PostgresRunnerDependencies = {
    createAdminConnection,
    randomId: vi.fn(() => "00000000-0000-4000-8000-" + String(++nextId).padStart(12, "0")),
    runTest: vi.fn(() => {
      events.push("run");
      return { status: 0, signal: null, pid: 1, output: [], stdout: null, stderr: null };
    }),
    info: vi.fn(),
    error: vi.fn(),
  };
  return { dependencies, createAdminConnection, connections, events };
}

describe("PostgreSQL CI coverage and isolation", () => {
  it("preserves all 70 prior files plus two read regressions and three controlled procurement suites plus background capture and OMS identity", () => {
    const addedSuites = [
      "server/modules/oms/__tests__/integration/order-line-catalog-identity.integration.test.ts",
      "server/modules/inventory-planning/__tests__/integration/inventory-opening-capture.integration.test.ts",
      "server/modules/inventory/__tests__/integration/cost-report-reads.integration.test.ts",
      "server/modules/procurement/__tests__/integration/shipment-purchase-orders.integration.test.ts",
      "server/modules/procurement/__tests__/integration/procurement-rfq-controlled-acceptance.integration.test.ts",
      "server/modules/procurement/__tests__/integration/procurement-flow-cost-controlled-acceptance.integration.test.ts",
      "server/modules/procurement/__tests__/integration/procurement-payment-controlled-acceptance.integration.test.ts",
    ];
    expect(POSTGRES_TEST_FILES).toHaveLength(77);
    expect(new Set(POSTGRES_TEST_FILES).size).toBe(77);
    expect(POSTGRES_TEST_FILES).toEqual(expect.arrayContaining(addedSuites));
    // Preserve the original inventory digest as well as the seven additions;
    // adding procurement coverage must not silently remove an older suite.
    const priorFiles = POSTGRES_TEST_FILES.filter((file) => !addedSuites.includes(file));
    expect(priorFiles).toHaveLength(70);
    const digest = createHash("sha256").update([...priorFiles].sort().join("\n")).digest("hex");
    expect(digest).toBe("8d6c96c5651ea0352e914985eb98ce15267503b535b50d63dec5a0780a80868a");
    expect(() => validatePostgresManifest(POSTGRES_REPOSITORY_ROOT, POSTGRES_TEST_FILES)).not.toThrow();
  });

  it("assigns every file exactly once across 8 deterministic balanced shards", () => {
    const shards = Array.from({ length: POSTGRES_SHARD_COUNT }, (_, index) => selectPostgresShardFiles({ index: index + 1, count: 8 }));
    expect(shards.map((files) => files.length)).toEqual([10, 10, 10, 10, 10, 9, 9, 9]);
    expect(shards.flat().sort()).toEqual([...POSTGRES_TEST_FILES].sort());
    expect(new Set(shards.flat()).size).toBe(POSTGRES_TEST_FILES.length);
    expect(selectPostgresShardFiles({ index: 1, count: 8 })).toEqual(shards[0]);
    expect(shards[0][0]).toBe(POSTGRES_TEST_FILES[0]);
    expect(shards[0][1]).toBe(POSTGRES_TEST_FILES[8]);
    expect(() => selectPostgresShardFiles({ index: 0, count: 8 })).toThrow();
  });

  it.each([[], ["0/8"], ["9/8"], ["1/0"], ["1/4"], ["01/8"], ["1/08"], ["1.5/8"], ["NaN/8"], ["1/8", "--passWithNoTests"], ["1/8; echo unsafe"], ["9007199254740992/8"]])("rejects invalid shard input %j", (...args: string[]) => {
    expect(() => parsePostgresShard(args)).toThrow();
  });

  it("runs one explicit file per isolated serial process with a unique JUnit output", () => {
    const reports: string[] = [];
    for (let index = 1; index <= POSTGRES_SHARD_COUNT; index += 1) {
      const shard = parsePostgresShard([index + "/8"]);
      const files = selectPostgresShardFiles(shard);
      for (const [fileIndex, file] of files.entries()) {
        const args = buildPostgresVitestArgs(shard, file);
        expect(args).toEqual([
          resolve(POSTGRES_REPOSITORY_ROOT, "node_modules/vitest/vitest.mjs"), "run", file,
          "--no-file-parallelism", "--maxWorkers=1", "--isolate",
          "--allowOnly=false", "--passWithNoTests=false", "--reporter=default", "--reporter=junit",
          "--outputFile.junit=test-results/postgres-hardening-" + index + "/" + (fileIndex + 1) + ".xml",
        ]);
        reports.push(args.at(-1)!);
      }
    }
    expect(new Set(reports).size).toBe(77);
    expect(() => buildPostgresVitestArgs({ index: 1, count: 8 }, POSTGRES_TEST_FILES[1])).toThrow();
    const source = readFileSync(resolve(POSTGRES_REPOSITORY_ROOT, "scripts/ci/postgres-tests.ts"), "utf8");
    expect(source).toContain("spawnSync(process.execPath, [...args]");
    expect(source).toContain("shell: false");
  });

  it.each([
    {},
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_DISPOSABLE: "false" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_DISPOSABLE: "TRUE" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "not-a-url-secret" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "postgres://user:secret@production.example/test" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "postgres://user:secret@localhost.example/test" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "postgres://localhost/test?host=production.example" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "postgres://localhost/test#fragment" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "https://localhost/test" },
    { ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "postgres://localhost/" },
    { ...disposableEnvironment, DATABASE_URL: "postgresql://different:secret@localhost/echelon_test" },
    { ...disposableEnvironment, EXTERNAL_DATABASE_URL: "postgres://127.0.0.1:5432/echelon_test" },
  ])("rejects unsafe or absent DB configuration without exposing secrets", (env) => {
    let message = "";
    try { validatePostgresTestEnvironment(env); } catch (error) { message = (error as Error).message; }
    expect(message).not.toBe("");
    expect(message).not.toContain("secret");
  });

  it.each(["localhost", "127.0.0.1"])("allows an explicitly disposable database on %s", (host) => {
    expect(() => validatePostgresTestEnvironment({ ...disposableEnvironment, ECHELON_TEST_DATABASE_URL: "postgresql://postgres@" + host + ":55459/ci_shard_1" })).not.toThrow();
  });

  it("rejects missing, duplicate, wildcard and escaping manifest paths", () => {
    const invalidPaths = ["../other.test.ts", "server/**/integration/*.test.ts", "--exclude=anything", "server/modules/missing/__tests__/integration/missing.test.ts"];
    for (const invalid of invalidPaths) {
      expect(() => validatePostgresManifest(POSTGRES_REPOSITORY_ROOT, [...POSTGRES_TEST_FILES.slice(0, 8), invalid])).toThrow();
    }
    expect(() => validatePostgresManifest(POSTGRES_REPOSITORY_ROOT, [...POSTGRES_TEST_FILES, POSTGRES_TEST_FILES[0]])).toThrow();
    expect(() => validatePostgresManifest(POSTGRES_REPOSITORY_ROOT, [])).toThrow();
  });

  it("restricts owned names to a generated, bounded prefix; rejects identifier injection", () => {
    const name = createOwnedDatabaseName({ index: 8, count: 8 }, "00000000-0000-4000-8000-000000000001");
    expect(name).toBe("echelon_ci_s8_00000000000040008000000000000001");
    expect(name.length).toBeLessThan(63);
    expect(() => createOwnedDatabaseName({ index: 1, count: 8 }, 'postgres"; DROP DATABASE other;--')).toThrow();
    expect(() => createOwnedDatabaseName({ index: 1, count: 8 }, "postgres")).toThrow();
  });

  it("creates/runs/drops each file database serially, overrides only the child URL and leaves caller env unchanged", async () => {
    const fixture = runnerFixture();
    const environment: NodeJS.ProcessEnv = {
      ...disposableEnvironment,
      DATABASE_URL: "postgres://app:secret@application.example/production",
      EXTERNAL_DATABASE_URL: "postgres://app:secret@external.example/production",
      CI: "true",
    };
    const originalEnv = { ...environment };
    expect(await runPostgresShard(["1/8"], environment, fixture.dependencies)).toBe(0);
    expect(fixture.connections).toHaveLength(10);
    expect(fixture.dependencies.runTest).toHaveBeenCalledTimes(10);
    expect(fixture.dependencies.error).not.toHaveBeenCalled();
    expect(environment).toEqual(originalEnv);
    const databaseNames: string[] = [];
    for (const [index, connection] of fixture.connections.entries()) {
      const calls = connection.query.mock.calls.map(([statement]) => statement);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatch(/^CREATE DATABASE "echelon_ci_s1_[0-9a-f]{32}"$/);
      const identifier = calls[0].slice("CREATE DATABASE ".length);
      expect(calls[1]).toBe("DROP DATABASE " + identifier + " WITH (FORCE)");
      expect(connection.end).toHaveBeenCalledOnce();
      const [args, childEnv] = vi.mocked(fixture.dependencies.runTest).mock.calls[index];
      expect(args[2]).toBe(selectPostgresShardFiles({ index: 1, count: 8 })[index]);
      const childUrl = new URL(childEnv.ECHELON_TEST_DATABASE_URL!);
      expect(childUrl.pathname).toBe("/" + identifier.replaceAll('"', ""));
      expect(childUrl.hostname).toBe("127.0.0.1");
      expect(childUrl.port).toBe("5432");
      expect(childEnv.ECHELON_TEST_DATABASE_DISPOSABLE).toBe("true");
      expect(childEnv).not.toHaveProperty("DATABASE_URL");
      expect(childEnv).not.toHaveProperty("EXTERNAL_DATABASE_URL");
      expect(childEnv.CI).toBe("true");
      databaseNames.push(childUrl.pathname);
      expect(fixture.events.slice(index * 5, index * 5 + 5)).toEqual(["connect", calls[0], "run", calls[1], "end"]);
    }
    expect(new Set(databaseNames).size).toBe(10);
  });

  it("never drops a database when CREATE fails or collides, and continues the remaining files", async () => {
    const fixture = runnerFixture();
    const ordinaryCreate = fixture.createAdminConnection.getMockImplementation()!;
    fixture.createAdminConnection.mockImplementationOnce((url) => {
      const connection = ordinaryCreate(url);
      connection.query.mockRejectedValueOnce(Object.assign(new Error("contains secret"), { code: "42P04" }));
      return connection;
    });
    expect(await runPostgresShard(["1/8"], disposableEnvironment, fixture.dependencies)).toBe(1);
    expect(fixture.connections[0].query.mock.calls).toHaveLength(1);
    expect(fixture.connections[0].query.mock.calls[0][0]).toMatch(/^CREATE DATABASE /);
    expect(fixture.connections[0].end).toHaveBeenCalledOnce();
    expect(fixture.dependencies.runTest).toHaveBeenCalledTimes(9);
    expect(fixture.connections).toHaveLength(10);
    const failure = JSON.parse(vi.mocked(fixture.dependencies.error).mock.calls[0][0]);
    expect(failure).toMatchObject({ phase: "database create", detail: "42P04" });
    expect(failure.database).toMatch(/^echelon_ci_s1_/);
    expect(vi.mocked(fixture.dependencies.error).mock.calls.flat().join(" ")).not.toContain("contains secret");
  });

  it.each([
    { status: 1, signal: null },
    { status: null, signal: "SIGTERM" },
    { status: null, signal: null, error: Object.assign(new Error("secret"), { code: "ENOENT" }) },
    { status: null, signal: null },
  ] as const)("cleans owned DB after failed child execution and continues all files: %j", async (result) => {
    const fixture = runnerFixture();
    vi.mocked(fixture.dependencies.runTest).mockReturnValueOnce({ pid: 0, output: [], stdout: null, stderr: null, ...result });
    expect(await runPostgresShard(["1/8"], disposableEnvironment, fixture.dependencies)).toBe(1);
    expect(fixture.connections[0].query.mock.calls[1][0]).toMatch(/^DROP DATABASE "echelon_ci_s1_/);
    expect(fixture.connections[0].end).toHaveBeenCalledOnce();
    expect(fixture.dependencies.runTest).toHaveBeenCalledTimes(10);
    expect(vi.mocked(fixture.dependencies.error).mock.calls.flat().join(" ")).not.toContain("secret");
  });

  it("cleans owned DB after a thrown child startup error", async () => {
    const fixture = runnerFixture();
    vi.mocked(fixture.dependencies.runTest).mockImplementationOnce(() => { throw new Error("secret"); });
    expect(await runPostgresShard(["1/8"], disposableEnvironment, fixture.dependencies)).toBe(1);
    expect(fixture.connections[0].query.mock.calls[1][0]).toMatch(/^DROP DATABASE /);
    expect(fixture.dependencies.runTest).toHaveBeenCalledTimes(10);
  });

  it("reports cleanup and connection-close failures without hiding passing child status", async () => {
    const fixture = runnerFixture();
    const ordinaryCreate = fixture.createAdminConnection.getMockImplementation()!;
    fixture.createAdminConnection.mockImplementationOnce((url) => {
      const connection = ordinaryCreate(url);
      connection.query.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error("secret"), { code: "55006" }));
      connection.end.mockRejectedValueOnce(Object.assign(new Error("secret"), { code: "ECONNRESET" }));
      return connection;
    });
    expect(await runPostgresShard(["1/8"], disposableEnvironment, fixture.dependencies)).toBe(1);
    expect(fixture.dependencies.runTest).toHaveBeenCalledTimes(10);
    const failures = vi.mocked(fixture.dependencies.error).mock.calls.map(([event]) => JSON.parse(event));
    expect(failures.map((event) => event.phase)).toEqual(["database cleanup", "admin connection close"]);
    expect(failures[0].database).toMatch(/^echelon_ci_s1_/);
  });

  it("does not issue CREATE, DROP or a test after connection failure", async () => {
    const fixture = runnerFixture();
    const ordinaryCreate = fixture.createAdminConnection.getMockImplementation()!;
    fixture.createAdminConnection.mockImplementationOnce((url) => {
      const connection = ordinaryCreate(url);
      connection.connect.mockRejectedValueOnce(Object.assign(new Error("secret"), { code: "ECONNREFUSED" }));
      return connection;
    });
    expect(await runPostgresShard(["1/8"], disposableEnvironment, fixture.dependencies)).toBe(1);
    expect(fixture.connections[0].query).not.toHaveBeenCalled();
    expect(fixture.connections[0].end).toHaveBeenCalledOnce();
    expect(fixture.dependencies.runTest).toHaveBeenCalledTimes(9);
  });

  it("does not connect without safe configuration or a valid generated DB name", async () => {
    const fixture = runnerFixture();
    await expect(runPostgresShard(["1/8"], {}, fixture.dependencies)).rejects.toThrow();
    expect(fixture.createAdminConnection).not.toHaveBeenCalled();
    vi.mocked(fixture.dependencies.randomId).mockReturnValue("postgres");
    expect(await runPostgresShard(["1/8"], disposableEnvironment, fixture.dependencies)).toBe(1);
    expect(fixture.createAdminConnection).not.toHaveBeenCalled();
    expect(fixture.dependencies.runTest).not.toHaveBeenCalled();
  });

  it("keeps all shards on every PR/main push and retains both stable check identities", () => {
    const workflow = readFileSync(resolve(POSTGRES_REPOSITORY_ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toMatch(/on:\s*pull_request:\s*push:\s*branches: \[main\]/);
    expect(workflow).not.toMatch(/paths(?:-ignore)?:|continue-on-error:/);
    expect(workflow).toContain("name: Typecheck + unit tests");
    expect(workflow).toContain("run: npm run check");
    expect(workflow).toContain("run: npm run test:unit");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("timeout-minutes: 20");
    expect(workflow).toContain("shard: [1, 2, 3, 4, 5, 6, 7, 8]");
    expect(workflow).toContain("POSTGRES_SHARD: " + "$" + "{{ matrix.shard }}/8");
    expect(workflow).toContain('node --import tsx scripts/ci/postgres-tests.ts "$POSTGRES_SHARD"');
    expect(workflow).toContain("image: postgres:16");
    expect(workflow).toContain('ECHELON_TEST_DATABASE_DISPOSABLE: "true"');
    expect(workflow).toContain("path: test-results/postgres-hardening-" + "$" + "{{ matrix.shard }}/");
    expect(workflow).toContain("name: PostgreSQL hardening tests");
    expect(workflow).toContain("needs: [postgres-hardening-shard]");
    expect(workflow).toContain("if: " + "$" + "{{ always() }}");
    expect(workflow).toContain('if [ "$SHARD_RESULT" != "success" ]; then');
    expect(workflow).toMatch(/exit 1\s+fi/);
  });
});
