import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), permission: vi.fn(), log: vi.fn() }));
vi.mock("../../../identity", () => ({ hasPermission: mocks.permission }));
vi.mock("../../../../platform/observability", () => ({ logger: { error: mocks.log } }));
vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: {} }));
vi.mock("../../receipt-reversal.commands", async (original) => ({
  ...await original<typeof import("../../receipt-reversal.commands")>(),
  createReceiptReversalCommands: () => ({ execute: mocks.execute }),
}));
import { FinancialCommandError } from "../../../../platform/commands/transactional-command.service";
import { hashReceiptReversalCommandIdentity, receiptReversalCommandScope, RECEIPT_REVERSAL_COMMAND_PRINCIPAL } from "../../receipt-reversal.commands";
import { registerReceiptReversalRoutes } from "../../receipt-reversal.routes";
import { ReceiptReversalService } from "../../receipt-reversal.service";
import type { ServiceRegistry } from "../../../../services";

const key = "receipt-reversal-http-001";
const lineBody = { qty: 2, reason: "Duplicate physical receipt", allowNegative: false };
const orderBody = { reason: "Wrong receiving record", allowNegative: false };
const commands = [
  { action: "line", path: "/api/procurement/receiving-lines/7/reverse", targetId: 7, body: lineBody },
  { action: "order", path: "/api/procurement/receiving-orders/31/reverse", targetId: 31, body: orderBody },
] as const;

describe("receipt reversal HTTP command boundary", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const actor = req.headers["x-test-actor"];
      req.session = (typeof actor === "string" ? { user: { id: actor } } : {}) as Request["session"];
      next();
    });
    const unexpectedDatabaseCall = async (): Promise<never> => { throw new Error("HTTP fixture must invoke the mocked command boundary"); };
    // This isolated route uses only receiptReversal; other registry owners are absent.
    app.locals.services = {
      receiptReversal: new ReceiptReversalService({ execute: unexpectedDatabaseCall, transaction: unexpectedDatabaseCall }),
    } as ServiceRegistry;
    registerReceiptReversalRoutes(app);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP address");
    base = `http://127.0.0.1:${(address as AddressInfo).port}`;
  });
  afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permission.mockResolvedValue(true);
    mocks.execute.mockResolvedValue({ commandId: 90, replayed: false, httpStatus: 200,
      terminalState: "succeeded", body: { reversalId: 42 } });
  });

  function post(path: string, body: unknown, headers: Record<string, string> = { "Idempotency-Key": key }, actor: string | null = "operator-1") {
    const payload = JSON.stringify(body);
    return new Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }>((resolve, reject) => {
      const request = httpRequest(new URL(path, base), { method: "POST", agent: false, headers: {
        "content-type": "application/json", "content-length": Buffer.byteLength(payload),
        ...(actor === null ? {} : { "x-test-actor": actor }), ...headers,
      } }, response => {
        let text = "";
        response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
        response.on("error", reject);
        response.on("end", () => {
          try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(text), headers: response.headers }); }
          catch (error) { reject(error); }
        });
      });
      request.setTimeout(5_000, () => request.destroy(new Error(`POST ${path} fixture timed out`)));
      request.on("error", reject); request.end(payload);
    });
  }

  it.each(commands)("requires authentication and purchasing approval for $action", async command => {
    expect((await post(command.path, command.body, { "Idempotency-Key": key }, null)).status).toBe(401);
    expect(mocks.execute).not.toHaveBeenCalled();
    mocks.permission.mockResolvedValueOnce(false);
    expect((await post(command.path, command.body)).status).toBe(403);
    expect(mocks.permission).toHaveBeenCalledWith("operator-1", "purchasing", "approve");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(commands)("passes exact $action intent and authenticated identity to the durable owner", async command => {
    const response = await post(command.path, command.body);
    expect(response.status).toBe(200); expect(response.headers["idempotency-replayed"]).toBe("false");
    expect(mocks.execute).toHaveBeenCalledWith(command.action, command.targetId, command.body, "operator-1", {
      ...receiptReversalCommandScope(), actorType: "service", actorId: RECEIPT_REVERSAL_COMMAND_PRINCIPAL,
      idempotencyKey: key, contractVersion: 1,
      requestHash: hashReceiptReversalCommandIdentity({ action: command.action, targetId: command.targetId, body: command.body, actorId: "operator-1" }),
    });
  });

  it("keeps the same-key namespace while distinguishing actor, action, resource and payload", async () => {
    await post(commands[0].path, lineBody); await post(commands[0].path, lineBody);
    await post(commands[0].path, { ...lineBody, qty: 3 });
    await post(commands[0].path.replace("/7/", "/8/"), lineBody);
    await post(commands[1].path, lineBody);
    await post(commands[0].path, lineBody, { "Idempotency-Key": key }, "operator-2");
    const descriptors = mocks.execute.mock.calls.map(call => call[4]);
    expect(descriptors[0]).toEqual(descriptors[1]);
    expect(new Set(descriptors.slice(1).map(descriptor => descriptor.requestHash)).size).toBe(5);
    for (const descriptor of descriptors) {
      expect(descriptor.idempotencyKey).toBe(key);
      expect(descriptor.resourceKey).toBe(descriptors[0].resourceKey);
      expect(descriptor.actorId).toBe(RECEIPT_REVERSAL_COMMAND_PRINCIPAL);
    }
  });

  it.each(["0", "-1", "1.5", "01", "1e2", "2147483648", "invalid"])("rejects malformed target %s without reserving a command", async id => {
    for (const command of commands) {
      const response = await post(command.path.replace(`/${command.targetId}/`, `/${id}/`), command.body);
      expect(response.status).toBe(400); expect(response.body.code).toBe("RECEIPT_REVERSAL_ID_INVALID");
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(commands)("rejects query parameters for $action before command reservation", async command => {
    const response = await post(command.path + "?qty=99", command.body);
    expect(response.status).toBe(400); expect(response.body.code).toBe("RECEIPT_REVERSAL_QUERY_INVALID");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REQUIRED"],
    [{ "Idempotency-Key": "short" }, "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_INVALID"],
    [{ "Idempotency-Key": key, "X-Idempotency-Key": "different-command" }, "FINANCIAL_COMMAND_IDEMPOTENCY_HEADERS_CONFLICT"],
  ] as Array<[Record<string, string>, string]>)("rejects invalid header identity %j", async (headers, code) => {
    const response = await post(commands[0].path, lineBody, headers);
    expect(response.status).toBe(400); expect(response.body.code).toBe(code);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("retains the legacy header alias and does not coerce or discard body fields", async () => {
    const body = { qty: "2", reason: false, allowNegative: "true", actorId: "spoofed" };
    await post(commands[0].path, body, { "X-Idempotency-Key": key });
    expect(mocks.execute.mock.calls[0].slice(0, 4)).toEqual(["line", 7, body, "operator-1"]);
  });

  it.each([200, 409, 422])("preserves durable replay HTTP %i and its original body", async status => {
    const body = status === 200 ? { reversalId: 42 } : { error: "Review the receipt", code: "REVERSAL_REJECTED" };
    mocks.execute.mockResolvedValueOnce({ commandId: 90, replayed: true, httpStatus: status,
      terminalState: status === 200 ? "succeeded" : "rejected", body });
    const response = await post(commands[0].path, lineBody);
    expect(response.status).toBe(status); expect(response.body).toEqual(body);
    expect(response.headers["idempotency-replayed"]).toBe("true");
  });

  it("preserves retry headers and conflict details without claiming completion", async () => {
    mocks.execute.mockRejectedValueOnce(new FinancialCommandError("Still running", 409, "FINANCIAL_COMMAND_IN_PROGRESS",
      { retryable: true }, { "Retry-After": "2" }));
    const response = await post(commands[0].path, lineBody);
    expect(response.status).toBe(409); expect(response.headers["retry-after"]).toBe("2");
    expect(response.headers["idempotency-replayed"]).toBeUndefined();
    expect(response.body).toEqual({ error: "Still running", code: "FINANCIAL_COMMAND_IN_PROGRESS", details: { retryable: true } });
  });

  it("logs invalid saved-result failures with the command identity", async () => {
    mocks.execute.mockRejectedValueOnce(new FinancialCommandError("Saved result requires review", 500, "RECEIPT_REVERSAL_RESULT_INVALID"));
    const response = await post(commands[0].path, lineBody);
    expect(response.status).toBe(500);
    expect(response.body.code).toBe("RECEIPT_REVERSAL_RESULT_INVALID");
    expect(mocks.log).toHaveBeenCalledWith("procurement.receipt_reversal.request_failed", {
      action: "line", targetId: "7", actorId: "operator-1", error_code: "RECEIPT_REVERSAL_RESULT_INVALID", error_type: "FinancialCommandError",
    });
  });

  it("sanitizes unexpected failures and records their command context", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("private database connection details"));
    const response = await post(commands[1].path, orderBody);
    expect(response.status).toBe(503); expect(response.body.code).toBe("RECEIPT_REVERSAL_UNAVAILABLE");
    expect(JSON.stringify(response.body)).not.toContain("private");
    expect(mocks.log).toHaveBeenCalledWith("procurement.receipt_reversal.request_failed", {
      action: "order", targetId: "31", actorId: "operator-1", error_code: "RECEIPT_REVERSAL_UNAVAILABLE", error_type: "Error",
    });
  });
});
