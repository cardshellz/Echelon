import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  APPLIED_MIGRATIONS_FILENAME,
  HEARTBEAT_FILENAME,
  PRODUCTION_STRUCTURE_MAX_AGE_MS,
  STRUCTURE_FILENAME,
  buildPublication,
  stableStructureText,
  validateHeartbeat,
  verifyPublication,
} from "../../../scripts/migrations/production-structure.mjs";
import {
  GITHUB_REQUEST_ATTEMPTS,
  GITHUB_RETRY_BASE_DELAY_MS,
  publishFilesToBranch,
  type GitHubFetch,
  type GitHubResponse,
} from "../../../scripts/ci/github-branch-publisher";

const code = (expected: string) => expect.objectContaining({ code: expected });
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const RAW_DUMP = [
  "--",
  "-- PostgreSQL database dump",
  "--",
  "",
  "\\restrict tokenA",
  "",
  "SET statement_timeout = 0;",
  "CREATE SCHEMA wms;",
  "CREATE TABLE wms.orders (",
  "    id integer NOT NULL",
  ");",
  "",
  "\\unrestrict tokenA",
  "",
  "",
].join("\n");
const CAPTURED_AT = new Date("2026-11-18T08:00:00.000Z");

function publication(overrides: { rawDump?: string; applied?: string[]; capturedAt?: Date } = {}) {
  return buildPublication({ rawDump: RAW_DUMP, applied: ["0002_b.sql", "0001_a.sql"], capturedAt: CAPTURED_AT, ...overrides });
}

function verifyInput(files: Record<string, string>, now: Date) {
  return {
    structureText: files[STRUCTURE_FILENAME],
    appliedText: files[APPLIED_MIGRATIONS_FILENAME],
    heartbeatText: files[HEARTBEAT_FILENAME],
    now,
  };
}

describe("stableStructureText", () => {
  it("removes the random psql guard lines, so two dumps of the same structure are the same text", () => {
    const other = RAW_DUMP.replaceAll("tokenA", "tokenB");

    expect(stableStructureText(RAW_DUMP)).not.toContain("restrict");
    expect(stableStructureText(other)).toBe(stableStructureText(RAW_DUMP));
  });

  it("gives the same text for CRLF and LF dumps and ends with one newline", () => {
    const text = stableStructureText(RAW_DUMP.replace(/\n/g, "\r\n"));

    expect(text).toBe(stableStructureText(RAW_DUMP));
    expect(text).not.toContain("\r");
    expect(text.endsWith(");\n")).toBe(true);
  });

  it.each([
    ["an empty dump", "  \n", "PRODUCTION_STRUCTURE_DUMP_EMPTY"],
    ["a dump that creates nothing", "SET statement_timeout = 0;\n", "PRODUCTION_STRUCTURE_DUMP_HAS_NO_OBJECTS"],
    ["a dump that contains rows", `${RAW_DUMP}COPY wms.orders (id) FROM stdin;\n1\n\\.\n`, "PRODUCTION_STRUCTURE_DUMP_HAS_DATA"],
  ])("refuses %s", (_label, dump, expected) => {
    expect(() => stableStructureText(dump)).toThrowError(code(expected));
  });
});

describe("buildPublication", () => {
  it("builds the three files, with a heartbeat that records the capture time and a hash of each file", () => {
    const { files, heartbeat } = publication();

    expect(Object.keys(files).sort()).toEqual([APPLIED_MIGRATIONS_FILENAME, HEARTBEAT_FILENAME, STRUCTURE_FILENAME].sort());
    expect(JSON.parse(files[APPLIED_MIGRATIONS_FILENAME])).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(heartbeat).toEqual({
      version: 1,
      capturedAt: "2026-11-18T08:00:00.000Z",
      structureSha256: sha256(files[STRUCTURE_FILENAME]),
      appliedSha256: sha256(files[APPLIED_MIGRATIONS_FILENAME]),
    });
    expect(JSON.parse(files[HEARTBEAT_FILENAME])).toEqual(heartbeat);
  });

  it("writes the applied list sorted and without duplicates, whatever order the database returned", () => {
    const { files } = publication({ applied: ["0002_b.sql", "0001_a.sql", "0002_b.sql"] });

    expect(JSON.parse(files[APPLIED_MIGRATIONS_FILENAME])).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("changes only the heartbeat's capture time when the same structure is captured on another night", () => {
    const first = publication();
    const second = publication({ rawDump: RAW_DUMP.replaceAll("tokenA", "tokenB"), capturedAt: new Date("2026-11-19T08:00:00.000Z") });

    expect(second.files[STRUCTURE_FILENAME]).toBe(first.files[STRUCTURE_FILENAME]);
    expect(second.heartbeat.structureSha256).toBe(first.heartbeat.structureSha256);
    expect(second.heartbeat.capturedAt).toBe("2026-11-19T08:00:00.000Z");
  });

  it("does not change its inputs", () => {
    const applied = ["0002_b.sql", "0001_a.sql"];

    publication({ applied });

    expect(applied).toEqual(["0002_b.sql", "0001_a.sql"]);
  });

  it.each([
    ["an empty applied list", { applied: [] }, "PRODUCTION_STRUCTURE_APPLIED_LIST_INVALID"],
    ["an empty filename", { applied: [""] }, "PRODUCTION_STRUCTURE_APPLIED_LIST_INVALID"],
    ["an invalid capture time", { capturedAt: new Date("not a date") }, "PRODUCTION_STRUCTURE_CAPTURE_TIME_INVALID"],
  ])("refuses %s", (_label, overrides, expected) => {
    expect(() => publication(overrides)).toThrowError(code(expected));
  });
});

describe("validateHeartbeat", () => {
  const valid = publication().heartbeat;

  it("accepts a heartbeat it built", () => {
    expect(validateHeartbeat({ ...valid })).toEqual(valid);
  });

  it.each([
    ["a missing field", { version: 1, capturedAt: valid.capturedAt, structureSha256: valid.structureSha256 }],
    ["an extra field", { ...valid, note: "x" }],
    ["another version", { ...valid, version: 2 }],
    ["a date without a time", { ...valid, capturedAt: "2026-11-18" }],
    ["a time that does not exist", { ...valid, capturedAt: "2026-13-45T99:00:00.000Z" }],
    ["a short hash", { ...valid, structureSha256: "abc" }],
    ["an upper-case hash", { ...valid, appliedSha256: valid.appliedSha256.toUpperCase() }],
    ["an array", [valid]],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(() => validateHeartbeat(value)).toThrowError(code("PRODUCTION_STRUCTURE_HEARTBEAT_INVALID"));
  });
});

describe("verifyPublication", () => {
  const { files } = publication();
  const hoursAfterCapture = (hours: number) => new Date(CAPTURED_AT.getTime() + hours * 3_600_000);

  it("returns the structure and applied list of a fresh, intact publication", () => {
    expect(verifyPublication(verifyInput(files, hoursAfterCapture(1)))).toEqual({
      structure: files[STRUCTURE_FILENAME],
      applied: ["0001_a.sql", "0002_b.sql"],
      capturedAt: "2026-11-18T08:00:00.000Z",
    });
  });

  it("accepts files whose line endings a checkout rewrote", () => {
    const crlf = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, text.replace(/\n/g, "\r\n")]));

    expect(verifyPublication(verifyInput(crlf, hoursAfterCapture(1))).structure).toBe(files[STRUCTURE_FILENAME]);
  });

  it("accepts a publication exactly at the age limit and refuses one a millisecond older", () => {
    const atLimit = new Date(CAPTURED_AT.getTime() + PRODUCTION_STRUCTURE_MAX_AGE_MS);

    expect(() => verifyPublication(verifyInput(files, atLimit))).not.toThrow();
    expect(() => verifyPublication(verifyInput(files, new Date(atLimit.getTime() + 1))))
      .toThrowError(code("PRODUCTION_STRUCTURE_STALE"));
  });

  it("reports how old a stale publication is", () => {
    expect(() => verifyPublication(verifyInput(files, hoursAfterCapture(38)))).toThrowError(
      expect.objectContaining({ code: "PRODUCTION_STRUCTURE_STALE", context: { capturedAt: "2026-11-18T08:00:00.000Z", ageHours: 38 } }),
    );
  });

  it.each([
    ["the structure", STRUCTURE_FILENAME, (text: string) => `${text}-- changed\n`],
    ["the applied list", APPLIED_MIGRATIONS_FILENAME, (text: string) => text.replace("0001_a.sql", "0001_z.sql")],
  ])("refuses a publication whose heartbeat does not match %s", (_label, name, change) => {
    const altered = { ...files, [name]: change(files[name]) };

    expect(() => verifyPublication(verifyInput(altered, hoursAfterCapture(1)))).toThrowError(code("PRODUCTION_STRUCTURE_HASH_MISMATCH"));
  });

  it("refuses a heartbeat that is not JSON, and a missing clock", () => {
    expect(() => verifyPublication(verifyInput({ ...files, [HEARTBEAT_FILENAME]: "{" }, hoursAfterCapture(1))))
      .toThrowError(code("PRODUCTION_STRUCTURE_HEARTBEAT_INVALID"));
    expect(() => verifyPublication(verifyInput(files, new Date("nope")))).toThrowError(code("PRODUCTION_STRUCTURE_CLOCK_INVALID"));
  });
});

describe("publishFilesToBranch", () => {
  const FILES = { "b.txt": "second", "a.txt": "first" };

  function reply(status: number, body: unknown = {}): GitHubResponse {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  /** A fake GitHub: answers each call from `routes`, keyed by "METHOD path". */
  function github(routes: Record<string, Array<GitHubResponse | Error>>) {
    const calls: Array<{ key: string; body: unknown; authorization: string }> = [];
    const fetchImpl: GitHubFetch = async (url, init) => {
      const key = `${init.method} ${url.replace("https://api.github.com/repos/acme/widgets", "")}`;
      calls.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body), authorization: init.headers.Authorization });
      const next = routes[key]?.shift();
      if (next === undefined) throw new Error(`unexpected call ${key}`);
      if (next instanceof Error) throw next;
      return next;
    };
    return { fetchImpl, calls };
  }

  function input(fetchImpl: GitHubFetch, delay = vi.fn(async () => undefined)) {
    return { fetchImpl, delay, token: "token-value", repository: "acme/widgets", branch: "production-structure", files: FILES, message: "Captured" };
  }

  const uploads = () => [reply(201, { sha: "blob-a" }), reply(201, { sha: "blob-b" })];

  it("adds a commit on top of the existing branch and moves it forward without force", async () => {
    const { fetchImpl, calls } = github({
      "GET /git/ref/heads/production-structure": [reply(200, { object: { sha: "parent-sha" } })],
      "POST /git/blobs": uploads(),
      "POST /git/trees": [reply(201, { sha: "tree-sha" })],
      "POST /git/commits": [reply(201, { sha: "commit-sha" })],
      "PATCH /git/refs/heads/production-structure": [reply(200, {})],
    });

    await expect(publishFilesToBranch(input(fetchImpl))).resolves.toEqual({ commitSha: "commit-sha", branchExisted: true });

    expect(calls.map((call) => call.key)).toEqual([
      "GET /git/ref/heads/production-structure", "POST /git/blobs", "POST /git/blobs",
      "POST /git/trees", "POST /git/commits", "PATCH /git/refs/heads/production-structure",
    ]);
    expect(calls[1].body).toEqual({ content: Buffer.from("first").toString("base64"), encoding: "base64" });
    expect(calls[3].body).toEqual({ tree: [
      { path: "a.txt", mode: "100644", type: "blob", sha: "blob-a" },
      { path: "b.txt", mode: "100644", type: "blob", sha: "blob-b" },
    ] });
    expect(calls[4].body).toEqual({ message: "Captured", tree: "tree-sha", parents: ["parent-sha"] });
    expect(calls[5].body).toEqual({ sha: "commit-sha", force: false });
    expect(calls.every((call) => call.authorization === "Bearer token-value")).toBe(true);
  });

  it("creates the branch with a parentless commit when it does not exist yet", async () => {
    const { fetchImpl, calls } = github({
      "GET /git/ref/heads/production-structure": [reply(404)],
      "POST /git/blobs": uploads(),
      "POST /git/trees": [reply(201, { sha: "tree-sha" })],
      "POST /git/commits": [reply(201, { sha: "commit-sha" })],
      "POST /git/refs": [reply(201, {})],
    });

    await expect(publishFilesToBranch(input(fetchImpl))).resolves.toEqual({ commitSha: "commit-sha", branchExisted: false });

    expect(calls[4].body).toEqual({ message: "Captured", tree: "tree-sha", parents: [] });
    expect(calls[5]).toMatchObject({ key: "POST /git/refs", body: { ref: "refs/heads/production-structure", sha: "commit-sha" } });
  });

  it("retries a server error and a network failure with a growing delay, then carries on", async () => {
    const delay = vi.fn(async () => undefined);
    const { fetchImpl } = github({
      "GET /git/ref/heads/production-structure": [reply(503), new Error("socket hang up"), reply(200, { object: { sha: "parent-sha" } })],
      "POST /git/blobs": uploads(),
      "POST /git/trees": [reply(201, { sha: "tree-sha" })],
      "POST /git/commits": [reply(201, { sha: "commit-sha" })],
      "PATCH /git/refs/heads/production-structure": [reply(200, {})],
    });

    await expect(publishFilesToBranch(input(fetchImpl, delay))).resolves.toMatchObject({ commitSha: "commit-sha" });
    expect(delay.mock.calls).toEqual([[GITHUB_RETRY_BASE_DELAY_MS], [GITHUB_RETRY_BASE_DELAY_MS * 2]]);
  });

  it("gives up as transient once the attempts are used", async () => {
    const delay = vi.fn(async () => undefined);
    const { fetchImpl, calls } = github({
      "GET /git/ref/heads/production-structure": Array.from({ length: GITHUB_REQUEST_ATTEMPTS }, () => reply(429)),
    });

    await expect(publishFilesToBranch(input(fetchImpl, delay))).rejects.toMatchObject({
      code: "GITHUB_PUBLISH_UNAVAILABLE", context: { errorClass: "transient", status: 429 },
    });
    expect(calls).toHaveLength(GITHUB_REQUEST_ATTEMPTS);
    expect(delay).toHaveBeenCalledTimes(GITHUB_REQUEST_ATTEMPTS - 1);
  });

  it.each([401, 403, 422])("does not retry a permanent refusal (HTTP %i)", async (status) => {
    const delay = vi.fn(async () => undefined);
    const { fetchImpl, calls } = github({
      "GET /git/ref/heads/production-structure": [reply(200, { object: { sha: "parent-sha" } })],
      "POST /git/blobs": [reply(status)],
    });

    await expect(publishFilesToBranch(input(fetchImpl, delay))).rejects.toMatchObject({
      code: "GITHUB_PUBLISH_REJECTED", context: { errorClass: "permanent", status },
    });
    expect(calls).toHaveLength(2);
    expect(delay).not.toHaveBeenCalled();
  });

  it("treats a missing branch as permanent when it is not the branch lookup that is missing", async () => {
    const { fetchImpl } = github({
      "GET /git/ref/heads/production-structure": [reply(200, { object: { sha: "parent-sha" } })],
      "POST /git/blobs": [reply(404)],
    });

    await expect(publishFilesToBranch(input(fetchImpl))).rejects.toMatchObject({ code: "GITHUB_PUBLISH_REJECTED" });
  });

  it("never puts the token in an error", async () => {
    const { fetchImpl } = github({ "GET /git/ref/heads/production-structure": [reply(401)] });

    const error = await publishFilesToBranch(input(fetchImpl)).catch((caught: unknown) => caught);

    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain("token-value");
  });

  it("fails on a reply without the expected identifier", async () => {
    const { fetchImpl } = github({
      "GET /git/ref/heads/production-structure": [reply(200, { object: {} })],
    });

    await expect(publishFilesToBranch(input(fetchImpl))).rejects.toMatchObject({ code: "GITHUB_PUBLISH_UNEXPECTED_RESPONSE" });
  });

  it.each([
    ["an empty token", { token: " " }],
    ["a repository that is not owner/name", { repository: "widgets" }],
    ["a branch with a space", { branch: "production structure" }],
    ["no files", { files: {} }],
    ["an empty message", { message: "" }],
  ])("refuses %s before calling GitHub", async (_label, overrides) => {
    const { fetchImpl, calls } = github({});

    await expect(publishFilesToBranch({ ...input(fetchImpl), ...overrides })).rejects.toMatchObject({ code: "GITHUB_PUBLISH_INPUT_INVALID" });
    expect(calls).toHaveLength(0);
  });
});
