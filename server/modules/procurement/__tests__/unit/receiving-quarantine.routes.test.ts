import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ServiceRegistry } from "../../../../services";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), view: vi.fn(), options: vi.fn(), run: vi.fn(), log: vi.fn(),
}));
vi.mock("../../../../db", () => ({ db: { transaction: mocks.transaction } }));
// Keep the real requireAuth middleware, but do not initialize identity storage.
vi.mock("../../../identity", () => ({ hasPermission: vi.fn() }));
vi.mock("../../../../platform/observability", () => ({ logger: { error: mocks.log } }));
vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: {} }));
vi.mock("../../../../platform/commands/transactional-command.service", async (original) => ({
  ...await original<typeof import("../../../../platform/commands/transactional-command.service")>(),
  runTransactionalFinancialCommand: mocks.run,
}));
vi.mock("../../receiving-quarantine.service", async (original) => ({
  ...await original<typeof import("../../receiving-quarantine.service")>(),
  readReceivingQuarantineView: mocks.view,
}));
vi.mock("../../receiving-quarantine-options.repository", async (original) => ({
  ...await original<typeof import("../../receiving-quarantine-options.repository")>(),
  readQuarantineAcceptanceOptions: mocks.options,
}));

import { FinancialCommandError } from "../../../../platform/commands/transactional-command.service";
import { ReceivingQuarantineError } from "../../domain/receiving-quarantine";
import { registerReceivingQuarantineRoutes } from "../../receiving-quarantine.routes";

const intake = { kind: "unidentified", condition: "unexpected", quantity: 2, unitLabel: "sealed cartons",
  description: "Unidentified delivery", observedSku: null, holdingLocationId: 6, reason: "Source requires review", evidenceReference: "PHOTO-42" };
const prepare = { expectedVersion: 0, observationQty: 1, targetReceivingOrderId: null,
  targetSourceReceivingLineId: 7, expectedTargetUnitVersion: "a".repeat(64), productVariantId: 2,
  expectedUnitsPerVariant: 10, acceptedVariantQty: 2, purchaseOrderLineId: 9, inboundShipmentLineId: null,
  putawayLocationId: 5, reason: "Product and source reviewed", countConversionReviewed: true };
const physicalReturn = { expectedVersion: 0, observationQty: 1, reason: "Carrier collected", evidenceReference: "RETURN-55" };
const cancel = { expectedVersion: 1, acceptanceId: 61, reason: "Review source again" };
const commands = [
  { command: "intake", path: "/api/receiving/31/quarantine", route: "/api/receiving/:orderId/quarantine", resource: "receiving_order:31", body: intake },
  { command: "prepare-acceptance", path: "/api/receiving/quarantine/41/prepare-acceptance", route: "/api/receiving/quarantine/:observationId/prepare-acceptance", resource: "receiving_custody:41", body: prepare },
  { command: "return", path: "/api/receiving/quarantine/41/return", route: "/api/receiving/quarantine/:observationId/return", resource: "receiving_custody:41", body: physicalReturn },
  { command: "cancel-acceptance", path: "/api/receiving/quarantine/41/cancel-acceptance", route: "/api/receiving/quarantine/:observationId/cancel-acceptance", resource: "receiving_custody:41", body: cancel },
] as const;
const key = "custody-http-command-001";

describe("receiving quarantine HTTP boundary", () => {
  let server: Server;
  let base: string;
  const tx = Object.freeze({ testTransaction: true });

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Session establishment is outside these routes. Authentication itself
      // still runs through production requireAuth on every registered endpoint.
      req.session = (req.headers["x-test-user"] ? { user: { id: req.headers["x-test-user"] } } : {}) as Request["session"];
      next();
    });
    const receiving = new Proxy({}, { get() { throw new Error("Unexpected receiving mutation outside the mocked transaction boundary"); } });
    app.locals.services = { receiving } as ServiceRegistry;
    registerReceivingQuarantineRoutes(app);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx));
    mocks.view.mockResolvedValue({ receivingOrderId: 31, observations: [] });
    mocks.options.mockResolvedValue({ items: [], nextCursor: null });
    mocks.run.mockResolvedValue({ commandId: 90, replayed: false, httpStatus: 200, terminalState: "succeeded", body: { saved: true } });
  });

  function request(path: string, options: { method?: string; body?: unknown; authenticated?: boolean; headers?: Record<string, string> } = {}) {
    return fetch(`${base}${path}`, { method: options.method ?? "GET",
      headers: { "content-type": "application/json", ...(options.authenticated === false ? {} : { "x-test-user": "custody-operator" }), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  }
  const post = (path: string, body: unknown, headers: Record<string, string> = { "Idempotency-Key": key }) => request(path, { method: "POST", body, headers });

  it.each([
    ["GET", "/api/receiving/31/quarantine"], ["GET", "/api/receiving/31/quarantine/acceptance-options"],
    ...commands.map(command => ["POST", command.path]),
  ])("requires an authenticated session for %s %s", async (method, path) => {
    const response = await request(path, { method, authenticated: false, body: method === "POST" ? intake : undefined });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
    expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(commands)("constructs the authenticated, resource-scoped $command descriptor", async command => {
    const response = await post(command.path, command.body);
    expect(response.status).toBe(200); expect(response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(await response.json()).toEqual({ saved: true });
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.run.mock.calls[0][0].descriptor).toEqual({
      actorType: "user", actorId: "custody-operator", method: "POST", routeTemplate: command.route,
      resourceKey: command.resource, idempotencyKey: key, contractVersion: 1,
      commandName: `procurement.receiving.custody.${command.command.replaceAll("-", "_")}`,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("preserves an identical retry hash and distinguishes a changed intent", async () => {
    await post(commands[0].path, intake); await post(commands[0].path, intake);
    await post(commands[0].path, { ...intake, quantity: 3 });
    const descriptors = mocks.run.mock.calls.map(call => call[0].descriptor);
    expect(descriptors[0]).toEqual(descriptors[1]);
    expect(descriptors[2].requestHash).not.toBe(descriptors[0].requestHash);
    expect(descriptors[2].idempotencyKey).toBe(key);
  });

  it.each([
    [{}, "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REQUIRED"],
    [{ "Idempotency-Key": "short" }, "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_INVALID"],
    [{ "Idempotency-Key": key, "X-Idempotency-Key": "different-key" }, "FINANCIAL_COMMAND_IDEMPOTENCY_HEADERS_CONFLICT"],
  ] as Array<[Record<string, string>, string]>)("rejects invalid command headers %j", async (headers, code) => {
    const response = await post(commands[0].path, intake, headers);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5", "01", "1e2", "2147483648", "invalid"])("rejects malformed resource ID %s before reads or commands", async id => {
    const paths = [`/api/receiving/${id}/quarantine`, `/api/receiving/${id}/quarantine/acceptance-options`];
    for (const path of paths) expect((await request(path)).status).toBe(400);
    expect((await post(paths[0], intake)).status).toBe(400);
    for (const command of commands.slice(1)) expect((await post(command.path.replace("/41/", `/${id}/`), command.body)).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([
    [commands[0].path, { ...intake, quantity: 0 }],
    [commands[0].path, { ...intake, quantity: 1.5 }],
    [commands[0].path, { ...intake, actorId: "spoofed-actor" }],
    [commands[0].path, { ...intake, holdingLocationId: null }],
    [commands[1].path, { ...prepare, countConversionReviewed: false }],
    [commands[1].path, { ...prepare, expectedTargetUnitVersion: "stale" }],
    [commands[2].path, { ...physicalReturn, evidenceReference: " " }],
    [commands[3].path, { ...cancel, expectedVersion: -1 }],
  ])("validates malformed body on %s before reserving a command", async (path, body) => {
    const response = await post(path as string, body);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "RECEIVING_CUSTODY_INPUT_INVALID" });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("reads custody and paginated options with the session actor in a consistent snapshot", async () => {
    expect((await request("/api/receiving/31/quarantine")).status).toBe(200);
    expect(mocks.view).toHaveBeenCalledWith(tx, 31, "custody-operator");
    const response = await request("/api/receiving/31/quarantine/acceptance-options?q=%20carton%20&cursor=50");
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(mocks.options).toHaveBeenCalledWith(tx, 31, "custody-operator", { q: "carton", cursor: 50 });
    for (const call of mocks.transaction.mock.calls) expect(call[1]).toEqual({ isolationLevel: "repeatable read" });
  });

  it.each(["cursor=0", "cursor=2147483648", "q=one&q=two", "unexpected=value", `q=${"x".repeat(101)}`])("rejects malformed option query %s", async query => {
    const response = await request(`/api/receiving/31/quarantine/acceptance-options?${query}`);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "RECEIVING_CUSTODY_INPUT_INVALID" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([200, 409])("preserves durable replay HTTP %s and response body", async status => {
    const body = status === 200 ? { recovered: true } : { error: "Custody changed. Refresh its quantities.", code: "RECEIVING_CUSTODY_STALE" };
    mocks.run.mockResolvedValueOnce({ commandId: 90, replayed: true, httpStatus: status, terminalState: status === 200 ? "succeeded" : "rejected", body });
    const response = await post(commands[2].path, physicalReturn);
    expect(response.status).toBe(status); expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(body);
  });

  it("preserves in-progress status, retry headers and machine-readable details", async () => {
    mocks.run.mockRejectedValueOnce(new FinancialCommandError("Command is still running", 409, "FINANCIAL_COMMAND_IN_PROGRESS", { retryable: true }, { "Retry-After": "2" }));
    const response = await post(commands[2].path, physicalReturn);
    expect(response.status).toBe(409); expect(response.headers.get("Retry-After")).toBe("2");
    expect(await response.json()).toEqual({ error: "Command is still running", code: "FINANCIAL_COMMAND_IN_PROGRESS", details: { retryable: true } });
  });

  it("preserves a classified permission denial without suggesting success", async () => {
    mocks.run.mockRejectedValueOnce(new ReceivingQuarantineError("RECEIVING_CUSTODY_FORBIDDEN", "An active purchasing approver is required.", 403));
    const response = await post(commands[2].path, physicalReturn);
    expect(response.status).toBe(403); expect(response.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await response.json()).toMatchObject({ code: "RECEIVING_CUSTODY_FORBIDDEN", error: "An active purchasing approver is required." });
  });

  it("classifies corrupt stored custody evidence as a review conflict, not bad request input", async () => {
    const invalid = z.object({ observedQty: z.number().int().positive() }).safeParse({ observedQty: -1 });
    if (invalid.success) throw new Error("Corrupt evidence fixture unexpectedly parsed");
    mocks.view.mockRejectedValueOnce(invalid.error);
    const response = await request("/api/receiving/31/quarantine");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "RECEIVING_CUSTODY_EVIDENCE_INVALID" });
    expect(mocks.log).toHaveBeenCalled();
  });

  it.each(["command", "view"])("classifies an unknown %s failure as 503 without leaking internal details", async boundary => {
    const internal = new Error("database password=SECRET internal connection detail");
    if (boundary === "command") mocks.run.mockRejectedValueOnce(internal); else mocks.view.mockRejectedValueOnce(internal);
    const response = boundary === "command" ? await post(commands[0].path, intake) : await request("/api/receiving/31/quarantine");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Quarantine is temporarily unavailable. Retry the same action without changing its command key.", code: "RECEIVING_CUSTODY_UNAVAILABLE" });
    expect(mocks.log).toHaveBeenCalledWith("receiving.custody.request_failed", { error_code: "RECEIVING_CUSTODY_UNAVAILABLE", error_type: "Error" });
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("SECRET");
  });
});
