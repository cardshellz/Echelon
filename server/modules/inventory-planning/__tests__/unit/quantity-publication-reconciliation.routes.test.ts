import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerQuantityPublicationReconciliationRoutes } from "../../interfaces/http/quantity-publication-reconciliation.routes";
import { InventoryCutoverCommitError } from "../../application/inventory-cutover-commit.service";
import { reconciliationRequest, reconciliationResult, reconciliationReview } from "../fixtures/quantity-publication-reconciliation.fixture";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true) }));
vi.mock("../../../identity", () => ({ hasPermission }));
const root = "/api/inventory-planning/admin/publication-recovery";

describe("current-state reconciliation activation-role HTTP boundary", () => {
  let server: http.Server;
  let url: string;
  let session: { user?: { id: string } };
  const service = { review: vi.fn(), reconcile: vi.fn() };
  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    hasPermission.mockReset().mockResolvedValue(true);
    service.review.mockReset().mockResolvedValue(reconciliationReview());
    service.reconcile.mockReset().mockResolvedValue(reconciliationResult());
    session = { user: { id: "operator" } };
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { Object.defineProperty(req, "session", { configurable: true, value: session }); next(); });
    registerQuantityPublicationReconciliationRoutes(app, service);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${root}`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); vi.restoreAllMocks(); });
  it("uses the authenticated activation operator and never caches review evidence", async () => {
    const response = await post(`${url}/review-reconciliation`, { activationRunId: "8" });
    expect(response).toMatchObject({ status: 200, body: reconciliationReview() });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(hasPermission).toHaveBeenCalledWith("operator", "inventory_planning", "activate");
    expect(service.review).toHaveBeenCalledWith({ activationRunId: "8" }, "operator");
    expect(service.reconcile).not.toHaveBeenCalled();
  });
  it("returns an unknown-outcome receipt, with 200 reserved for a validated replay", async () => {
    expect(await post(`${url}/reconcile-current`, reconciliationRequest())).toMatchObject({ status: 201, body: reconciliationResult() });
    service.reconcile.mockResolvedValueOnce({ ...reconciliationResult(), replay: true });
    expect(await post(`${url}/reconcile-current`, reconciliationRequest())).toMatchObject({ status: 200, body: { replay: true } });
    expect(service.reconcile).toHaveBeenCalledWith(reconciliationRequest(), "operator");
  });
  it.each(["review-reconciliation", "reconcile-current"])("requires authentication and activation permission for %s", async action => {
    session = {};
    expect((await post(`${url}/${action}`, reconciliationRequest())).status).toBe(401);
    session = { user: { id: "operator" } }; hasPermission.mockResolvedValue(false);
    expect((await post(`${url}/${action}`, reconciliationRequest())).status).toBe(403);
    expect(service.review).not.toHaveBeenCalled(); expect(service.reconcile).not.toHaveBeenCalled();
  });
  it.each([{ acceptUnknownRemoteOutcomes: false }, { activationRunId: "bad" }, { actor: "admin" }, { force: true }, { quantity: 42 }, { reason: "" }])(
    "rejects incomplete or overreaching recovery input %#", async change => {
      expect((await post(`${url}/reconcile-current`, { ...reconciliationRequest(), ...change })).status).toBe(400);
      expect(service.reconcile).not.toHaveBeenCalled();
    });
  it("does not accept query filters or replace stale evidence silently", async () => {
    expect((await post(`${url}/review-reconciliation?connectionId=7`, { activationRunId: "8" })).status).toBe(400);
    service.reconcile.mockRejectedValueOnce(new InventoryCutoverCommitError("PUBLICATION_RECONCILIATION_REVIEW_CHANGED", "Refresh the review."));
    expect(await post(`${url}/reconcile-current`, reconciliationRequest())).toMatchObject({ status: 409, body: { error: { code: "PUBLICATION_RECONCILIATION_REVIEW_CHANGED" } } });
  });
  it("validates output and sanitizes unexpected persistence failures", async () => {
    service.reconcile.mockResolvedValueOnce({ ...reconciliationResult(), historicalOutcome: "succeeded" });
    expect((await post(`${url}/reconcile-current`, reconciliationRequest())).status).toBe(500);
    service.reconcile.mockRejectedValueOnce(new Error("private database connection"));
    const result = await post(`${url}/reconcile-current`, reconciliationRequest());
    expect(result.status).toBe(500); expect(JSON.stringify(result.body)).not.toContain("private");
  });
});

async function post(url: string, value: unknown) {
  const body = JSON.stringify(value);
  return new Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: response.headers }));
      response.on("error", reject);
    });
    request.on("error", reject); request.end(body);
  });
}
