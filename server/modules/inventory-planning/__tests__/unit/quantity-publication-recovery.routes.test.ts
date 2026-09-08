import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerQuantityPublicationRecoveryRoutes } from "../../interfaces/http/quantity-publication-recovery.routes";
import { QuantityPublicationRecoveryService } from "../../application/quantity-publication-recovery.service";
import { QuantityPublicationAdmissionError } from "../../domain/quantity-publication-admission";
import { CUTOVER_COMPLETION_NOW as NOW } from "../fixtures/inventory-cutover-completion.fixture";
import { pendingRecovery, recoveryRequest, recoveryResult } from "../fixtures/quantity-publication-recovery.fixture";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true) }));
vi.mock("../../../identity", () => ({ hasPermission }));
const ROOT = "/api/inventory-planning/admin/publication-recovery";
const actions = ["pending", "attest"] as const;

describe("publication recovery activation-role HTTP boundary", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let session: { user?: { id?: string } };
  let service: { pending: ReturnType<typeof vi.fn>; attest: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    session = { user: { id: "operator-1" } };
    service = { pending: vi.fn(async () => pendingRecovery()), attest: vi.fn(async () => recoveryResult()) };
    server = await startServer(service, () => session);
  });
  afterEach(async () => { await server.close(); vi.restoreAllMocks(); });

  it("requires activation permission and reports only recorded pending history", async () => {
    const response = await request(server.url + ROOT + "/pending", { activationRunId: "1" });
    expect(response).toMatchObject({ status: 200, body: pendingRecovery() });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(hasPermission).toHaveBeenCalledExactlyOnceWith("operator-1", "inventory_planning", "activate");
    expect(service.pending).toHaveBeenCalledExactlyOnceWith({ activationRunId: "1" }, "operator-1");
    expect(service.attest).not.toHaveBeenCalled();
  });

  it("accepts an omitted run to resolve retained aborted history after reload", async () => {
    const response = await request(server.url + ROOT + "/pending", {});
    expect(response).toMatchObject({ status: 200, body: { activationRunId: "1" } });
    expect(service.pending).toHaveBeenCalledExactlyOnceWith({}, "operator-1");
    expect(service.attest).not.toHaveBeenCalled();
  });

  it("returns an explicitly labeled operator attestation, not a provider-verified acknowledgement", async () => {
    const response = await request(server.url + ROOT + "/attest", recoveryRequest());
    expect(response).toMatchObject({ status: 201, body: recoveryResult() });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.attest).toHaveBeenCalledExactlyOnceWith(recoveryRequest(), "operator-1");
    expect(service.pending).not.toHaveBeenCalled();
  });

  it("returns 200 only for the owner's validated replay receipt", async () => {
    service.attest.mockResolvedValueOnce({ ...recoveryResult(), replay: true });
    const response = await request(server.url + ROOT + "/attest", recoveryRequest());
    expect(response).toMatchObject({ status: 200, body: { basis: "operator_attestation", replay: true } });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it.each(actions)("rejects missing authentication before %s or permission access", async action => {
    session = {};
    const response = await request(server.url + ROOT + `/${action}`, action === "attest" ? recoveryRequest() : { activationRunId: "1" });
    expect(response.status).toBe(401); expect(response.headers["cache-control"]).toBe("no-store");
    expect(hasPermission).not.toHaveBeenCalled(); expect(service.pending).not.toHaveBeenCalled(); expect(service.attest).not.toHaveBeenCalled();
  });

  it.each(actions)("requires current activation capability even for %s replay", async action => {
    hasPermission.mockResolvedValue(false); service.attest.mockResolvedValue({ ...recoveryResult(), replay: true });
    const response = await request(server.url + ROOT + `/${action}`, action === "attest" ? recoveryRequest() : { activationRunId: "1" });
    expect(response.status).toBe(403); expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.pending).not.toHaveBeenCalled(); expect(service.attest).not.toHaveBeenCalled();
  });

  it.each([{ activationRunId: "abc" }, { activationRunId: "0" }, { activationRunId: "9223372036854775808" },
    { activationRunId: "1", actor: "admin" }, { activationRunId: "1", limit: 1 },
  ])("rejects malformed or partial pending history requests before service access: %#", async body => {
    expect(await request(server.url + ROOT + "/pending", body)).toMatchObject({ status: 400, body: { error: { code: "PUBLICATION_RECOVERY_PENDING_REQUEST_INVALID" } } });
    expect(service.pending).not.toHaveBeenCalled();
  });

  it.each([{}, { ...recoveryRequest(), attemptId: "abc" }, { ...recoveryRequest(), evidenceKind: "timeout" },
    { ...recoveryRequest(), terminalOutcome: "probably_finished" }, { ...recoveryRequest(), evidenceHash: "bad" },
    { ...recoveryRequest(), reason: "short" }, { ...recoveryRequest(), evidenceReference: " " },
    { ...recoveryRequest(), actor: "admin" }, { ...recoveryRequest(), force: true }, { ...recoveryRequest(), idempotencyKey: "" },
  ])("rejects incomplete evidence, automatic clearing, or actor overrides: %#", async body => {
    expect(await request(server.url + ROOT + "/attest", body)).toMatchObject({ status: 400, body: { error: { code: "PUBLICATION_RECOVERY_REQUEST_INVALID" } } });
    expect(service.attest).not.toHaveBeenCalled();
  });

  it.each(actions)("does not accept query filters or actor overrides on %s", async action => {
    expect((await request(server.url + ROOT + `/${action}?actor=admin`, action === "attest" ? recoveryRequest() : { activationRunId: "1" })).status).toBe(400);
    expect(service.pending).not.toHaveBeenCalled(); expect(service.attest).not.toHaveBeenCalled();
  });

  it.each(actions)("passes only session identity to actual service validation for %s", async action => {
    session = { user: {} };
    const store = { pending: vi.fn(async () => pendingRecovery()), attest: vi.fn(async () => recoveryResult()) };
    const actual = new QuantityPublicationRecoveryService(store, { now: () => NOW });
    service.pending.mockImplementation((input, actor) => actual.pending(input, actor));
    service.attest.mockImplementation((input, actor) => actual.attest(input, actor));
    expect(await request(server.url + ROOT + `/${action}`, action === "attest" ? recoveryRequest() : { activationRunId: "1" }))
      .toMatchObject({ status: 401, body: { error: { code: "PUBLICATION_RECOVERY_ACTOR_REQUIRED" } } });
    expect(store.pending).not.toHaveBeenCalled(); expect(store.attest).not.toHaveBeenCalled();
  });

  it.each(["PUBLICATION_RECOVERY_REPLAY_CONFLICT", "PUBLICATION_RECOVERY_STATE_INVALID"])("classifies actual owner conflict %s without leaking evidence context", async code => {
    service.attest.mockRejectedValue(new QuantityPublicationAdmissionError(code, "private evidence reference", { evidence: "secret" }));
    const response = await request(server.url + ROOT + "/attest", recoveryRequest());
    expect(response).toMatchObject({ status: 409, body: { error: { code } } });
    expect(JSON.stringify(response.body)).not.toMatch(/private|secret/); expect(service.attest).toHaveBeenCalledTimes(1);
  });

  it("does not truncate oversized owner history or report a partial ready list", async () => {
    service.pending.mockRejectedValue(new QuantityPublicationAdmissionError("PUBLICATION_DRAIN_EVIDENCE_LIMIT", "private SQL"));
    const response = await request(server.url + ROOT + "/pending", { activationRunId: "1" });
    expect(response).toMatchObject({ status: 422, body: { error: { code: "PUBLICATION_DRAIN_EVIDENCE_LIMIT" } } });
    expect(JSON.stringify(response.body)).not.toContain("private");
  });

  it.each(["40001", "55P03", "57014", "QUANTITY_PUBLICATION_DRAIN_BUSY"])("returns a bounded conflict for %s without an automatic retry", async code => {
    service.attest.mockRejectedValue(Object.assign(new Error("private SQL"), { code }));
    expect(await request(server.url + ROOT + "/attest", recoveryRequest())).toMatchObject({ status: 409, body: { error: { code: "CUTOVER_CONCURRENT_CHANGE" } } });
    expect(service.attest).toHaveBeenCalledTimes(1);
  });

  it.each([new Error("secret SQL token"), new QuantityPublicationAdmissionError("PUBLICATION_GATE_MISSING", "secret SQL token"),
    Object.assign(new Error("secret SQL token"), { code: "PUBLICATION_RECOVERY_STATE_INVALID" }),
  ])("sanitizes internal or spoofed domain failures: %#", async error => {
    service.attest.mockRejectedValue(error);
    const response = await request(server.url + ROOT + "/attest", recoveryRequest());
    expect(response).toMatchObject({ status: 500, body: { error: { code: "CUTOVER_COMMAND_FAILED" } } });
    expect(JSON.stringify(response.body)).not.toMatch(/secret|token/);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/secret|token/);
  });

  it("rejects misleading or extra service output without exposing partial recovery", async () => {
    service.pending.mockResolvedValueOnce({ ...pendingRecovery(), providerWriteAttempted: true });
    expect((await request(server.url + ROOT + "/pending", { activationRunId: "1" })).status).toBe(500);
    service.attest.mockResolvedValueOnce({ ...recoveryResult(), basis: "provider_verified", secret: "private" });
    const response = await request(server.url + ROOT + "/attest", recoveryRequest());
    expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain("private");
  });
});

async function startServer(service: Pick<QuantityPublicationRecoveryService, "pending" | "attest">, session: () => unknown) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.defineProperty(req, "session", { configurable: true, value: session() }); next(); });
  registerQuantityPublicationRecoveryRoutes(app, service);
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
