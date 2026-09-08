import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInventoryCutoverCompletionRoutes } from "../../interfaces/http/inventory-cutover-completion.routes";
import { InventoryCutoverCompletionService } from "../../application/inventory-cutover-completion.service";
import { InventoryCutoverCommitError } from "../../application/inventory-cutover-commit.service";
import { CUTOVER_COMPLETION_NOW as NOW, CUTOVER_COMPLETION_REQUEST as REQUEST,
  completionResult, completionVerification } from "../fixtures/inventory-cutover-completion.fixture";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true) }));
vi.mock("../../../identity", () => ({ hasPermission }));
const ROOT = "/api/inventory-planning/admin/cutover";
const actions = ["verification", "finish"] as const;

describe("cutover verification and finish HTTP boundaries", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let session: { user?: { id?: string } };
  let service: { verify: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    session = { user: { id: "operator-1" } };
    service = { verify: vi.fn(async () => completionVerification()), finish: vi.fn(async () => completionResult()) };
    server = await startServer(service, () => session);
  });
  afterEach(async () => { await server.close(); vi.restoreAllMocks(); });

  it("uses activation permission and only the session actor for read-only verification", async () => {
    const response = await request(server.url + ROOT + "/verification", { activationRunId: "1" });
    expect(response).toMatchObject({ status: 200, body: completionVerification() });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(hasPermission).toHaveBeenCalledExactlyOnceWith("operator-1", "inventory_planning", "activate");
    expect(service.verify).toHaveBeenCalledExactlyOnceWith({ activationRunId: "1" }, "operator-1");
    expect(service.finish).not.toHaveBeenCalled();
  });

  it("returns 201 only for a new finish, 200 for a validated replay, both uncached", async () => {
    const first = await request(server.url + ROOT + "/finish", REQUEST);
    expect(first).toMatchObject({ status: 201, body: completionResult() });
    service.finish.mockResolvedValueOnce({ ...completionResult(), alreadyApplied: true });
    const replay = await request(server.url + ROOT + "/finish", REQUEST);
    expect(replay).toMatchObject({ status: 200, body: { alreadyApplied: true } });
    expect(service.finish).toHaveBeenCalledWith(REQUEST, "operator-1");
    expect(first.headers["cache-control"]).toBe("no-store"); expect(replay.headers["cache-control"]).toBe("no-store");
  });

  it.each(actions)("rejects missing authentication before %s access", async action => {
    session = {};
    const response = await request(server.url + ROOT + `/${action}`, action === "finish" ? REQUEST : { activationRunId: "1" });
    expect(response.status).toBe(401); expect(response.headers["cache-control"]).toBe("no-store");
    expect(hasPermission).not.toHaveBeenCalled(); expect(service.verify).not.toHaveBeenCalled(); expect(service.finish).not.toHaveBeenCalled();
  });

  it.each(actions)("does not let denied activation permission bypass %s or replay", async action => {
    hasPermission.mockResolvedValue(false); service.finish.mockResolvedValue({ ...completionResult(), alreadyApplied: true });
    const response = await request(server.url + ROOT + `/${action}`, action === "finish" ? REQUEST : { activationRunId: "1" });
    expect(response.status).toBe(403); expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.verify).not.toHaveBeenCalled(); expect(service.finish).not.toHaveBeenCalled();
  });

  it.each([{}, { activationRunId: "abc" }, { activationRunId: "0" }, { activationRunId: "9223372036854775808" },
    { activationRunId: "1", actor: "admin" },
  ])("rejects invalid verification bodies before service access: %#", async body => {
    expect(await request(server.url + ROOT + "/verification", body)).toMatchObject({ status: 400, body: { error: { code: "CUTOVER_VERIFICATION_REQUEST_INVALID" } } });
    expect(service.verify).not.toHaveBeenCalled();
  });

  it.each([{}, { ...REQUEST, activationRunId: "abc" }, { ...REQUEST, actor: "admin" }, { ...REQUEST, reason: " " },
    { ...REQUEST, idempotencyKey: "" }, { ...REQUEST, expectedVerificationHash: "bad" }, { ...REQUEST, force: true },
  ])("rejects invalid finish commands before service access: %#", async body => {
    expect(await request(server.url + ROOT + "/finish", body)).toMatchObject({ status: 400, body: { error: { code: "CUTOVER_FINISH_REQUEST_INVALID" } } });
    expect(service.finish).not.toHaveBeenCalled();
  });

  it.each(actions)("rejects query filters or actor overrides on %s", async action => {
    expect((await request(server.url + ROOT + `/${action}?actor=admin`, action === "finish" ? REQUEST : { activationRunId: "1" })).status).toBe(400);
    expect(service.verify).not.toHaveBeenCalled(); expect(service.finish).not.toHaveBeenCalled();
  });

  it.each(actions)("uses real service validation when the session user lacks an ID: %s", async action => {
    session = { user: {} };
    const store = { verify: vi.fn(async () => completionVerification()), finish: vi.fn(async () => completionResult()) };
    const actual = new InventoryCutoverCompletionService(store, { now: () => NOW });
    service.verify.mockImplementation((input, actor) => actual.verify(input, actor));
    service.finish.mockImplementation((input, actor) => actual.finish(input, actor));
    expect(await request(server.url + ROOT + `/${action}`, action === "finish" ? REQUEST : { activationRunId: "1" }))
      .toMatchObject({ status: 401, body: { error: { code: "CUTOVER_ACTOR_REQUIRED" } } });
    expect(store.verify).not.toHaveBeenCalled(); expect(store.finish).not.toHaveBeenCalled();
  });

  it.each(["40001", "40P01", "55P03", "57014", "QUANTITY_PUBLICATION_DRAIN_BUSY", "PUBLICATION_ADMISSION_CAPACITY_BUSY"])(
    "sanitizes retryable concurrency error %s without retrying inside HTTP", async code => {
      service.finish.mockRejectedValue(Object.assign(new Error("secret SQL token"), { code }));
      const response = await request(server.url + ROOT + "/finish", REQUEST);
      expect(response).toMatchObject({ status: 409, body: { error: { code: "CUTOVER_CONCURRENT_CHANGE" } } });
      expect(response.headers["cache-control"]).toBe("no-store"); expect(service.finish).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(response.body)).not.toContain("secret");
    },
  );

  it.each(["CUTOVER_VERIFICATION_CHANGED", "CUTOVER_FULL_PUBLICATION_NOT_VERIFIED", "CUTOVER_IDEMPOTENCY_CONFLICT"])(
    "returns actionable typed completion conflict %s without claiming success", async code => {
      service.finish.mockRejectedValue(new InventoryCutoverCommitError(code, "Refresh the reviewed evidence."));
      expect(await request(server.url + ROOT + "/finish", REQUEST)).toMatchObject({ status: 409, body: { error: { code } } });
    },
  );

  it.each([new Error("secret SQL token"), new InventoryCutoverCommitError("PRIVATE_FAILURE", "secret SQL token", 500),
    Object.assign(new Error("secret SQL token"), { code: "CUTOVER_VERIFICATION_CHANGED" }),
  ])("sanitizes unknown/internal/forged typed failures: %#", async error => {
    service.finish.mockRejectedValue(error);
    const response = await request(server.url + ROOT + "/finish", REQUEST);
    expect(response).toMatchObject({ status: 500, body: { error: { code: "CUTOVER_COMMAND_FAILED" } } });
    expect(JSON.stringify(response.body)).not.toMatch(/secret|token|PRIVATE_FAILURE/);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/secret|token/);
  });

  it("rejects contradictory/extra service responses instead of exposing partial completion", async () => {
    service.verify.mockResolvedValueOnce({ ...completionVerification(), publicationRows: [] });
    expect((await request(server.url + ROOT + "/verification", { activationRunId: "1" })).status).toBe(500);
    service.finish.mockResolvedValueOnce({ ...completionResult(), configurationFreezeReleased: false, private: "secret" });
    const response = await request(server.url + ROOT + "/finish", REQUEST);
    expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});

async function startServer(service: Pick<InventoryCutoverCompletionService, "verify" | "finish">, session: () => unknown) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.defineProperty(req, "session", { configurable: true, value: session() }); next(); });
  registerInventoryCutoverCompletionRoutes(app, service);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
async function request(url: string, value: unknown) {
  const target = new URL(url); const body = JSON.stringify(value);
  return new Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: res.headers }));
      res.on("error", reject);
    });
    req.on("error", reject); req.end(body);
  });
}
