import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryCutoverCommitResult, InventoryCutoverReview } from "@shared/types/inventory-cutover-commit";
import { registerInventoryCutoverCommitRoutes } from "../../interfaces/http/inventory-cutover-commit.routes";
import { InventoryCutoverCommitError, InventoryCutoverCommitService } from "../../application/inventory-cutover-commit.service";
import { InventoryCutoverManifestError } from "../../domain/inventory-cutover-manifest";
import { CutoverReconstructionError } from "../../infrastructure/inventory-cutover-reconstruction.repository";
import { InventoryAvailabilityActivationRepositoryError } from "../../infrastructure/inventory-availability-activation.repository";
import { InventoryCutoverCaptureError } from "../../infrastructure/inventory-cutover-capture-stage";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true) }));
vi.mock("../../../identity", () => ({ hasPermission }));
const ROOT = "/api/inventory-planning/admin/cutover";
const HASH = "a".repeat(64);
const REQUEST = { activationRunId: "1", expectedAuthorityRevision: "2", expectedReviewHash: HASH, idempotencyKey: "commit-1", reason: "Reviewed catalog cutover" };
const NOW = new Date("2026-09-07T20:00:00.000Z");
function result(): InventoryCutoverCommitResult {
  return { activationRunId: "1", runtimeAuthority: "canonical", authorityRevision: "3", reviewHash: HASH,
    selectionManifestHash: HASH, reconstructionHash: HASH, fullPublicationRows: 0, publicationVerification: "pending", alreadyApplied: false };
}
function review(): InventoryCutoverReview {
  return { contractVersion: "inventory_cutover_review_v1", activationRunId: "1", authorityRevision: "2", capturedAt: NOW.toISOString(),
    reviewHash: HASH, selectionManifestHash: HASH, reconstructionHash: HASH, freshClaimImpactHash: HASH, ready: false,
    manifest: { contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [1], publicationTargetIds: [],
      selections: [{ kind: "model", key: "1", definitionId: 10, definitionHash: HASH }] },
    summary: { orders: 0, lines: 0, retainedIndependentBuildHolds: 0 }, publicationRows: [],
    blockers: [{ code: "CUTOVER_LEGACY_PUBLICATION_DRAIN_UNPROVEN", subject: "publications", message: "Writer lifecycle proof required" }],
    operationalWriteAttempted: false, providerWriteAttempted: false };
}

describe("cutover review and commit routes", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let session: { user?: { id?: string } };
  let service: { preview: ReturnType<typeof vi.fn>; commit: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    session = { user: { id: "operator-1" } };
    service = { preview: vi.fn(async () => review()), commit: vi.fn(async () => result()) };
    server = await startServer(service, () => session);
  });
  afterEach(async () => { await server.close(); vi.restoreAllMocks(); });

  it("requires activate permission for read-only review and uses only the session actor", async () => {
    const response = await request(server.url + ROOT + "/review", { activationRunId: "1" });
    expect(response).toMatchObject({ status: 200, body: review() });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(hasPermission).toHaveBeenCalledExactlyOnceWith("operator-1", "inventory_planning", "activate");
    expect(service.preview).toHaveBeenCalledExactlyOnceWith({ activationRunId: "1" }, "operator-1");
    expect(service.commit).not.toHaveBeenCalled();
  });

  it("returns201 for a new commit and200 only for a validated replay receipt", async () => {
    const first = await request(server.url + ROOT + "/commit", REQUEST);
    expect(first).toMatchObject({ status: 201, body: result() });
    service.commit.mockResolvedValueOnce({ ...result(), alreadyApplied: true });
    const replay = await request(server.url + ROOT + "/commit", REQUEST);
    expect(replay).toMatchObject({ status: 200, body: { alreadyApplied: true } });
    expect(service.commit).toHaveBeenCalledWith(REQUEST, "operator-1");
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(replay.headers["cache-control"]).toBe("no-store");
  });

  it.each(["review", "commit"])("does not call %s service for missing authentication", async (action) => {
    session = {};
    const response = await request(server.url + ROOT + `/${action}`, action === "review" ? { activationRunId: "1" } : REQUEST);
    expect(response.status).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(hasPermission).not.toHaveBeenCalled();
    expect(service.preview).not.toHaveBeenCalled(); expect(service.commit).not.toHaveBeenCalled();
  });

  it.each(["review", "commit"])("does not bypass denied activate permission for %s", async (action) => {
    hasPermission.mockResolvedValue(false);
    const response = await request(server.url + ROOT + `/${action}`, action === "review" ? { activationRunId: "1" } : REQUEST);
    expect(response.status).toBe(403); expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.preview).not.toHaveBeenCalled(); expect(service.commit).not.toHaveBeenCalled();
  });

  it.each([{}, { activationRunId: "abc" }, { activationRunId: "0" }, { activationRunId: "1", actor: "admin" }])(
    "rejects malformed review/actor overrides before service access: %j", async (body) => {
      const response = await request(server.url + ROOT + "/review", body);
      expect(response).toMatchObject({ status: 400, body: { error: { code: "CUTOVER_REVIEW_REQUEST_INVALID" } } });
      expect(service.preview).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { ...REQUEST, expectedAuthorityRevision: "abc" }, { ...REQUEST, expectedReviewHash: "bad" },
    { ...REQUEST, actor: "admin" }, { ...REQUEST, reason: " " }, { ...REQUEST, idempotencyKey: "" },
  ])("rejects malformed commit before service access: %#", async (body) => {
    expect(await request(server.url + ROOT + "/commit", body)).toMatchObject({ status: 400, body: { error: { code: "CUTOVER_COMMIT_REQUEST_INVALID" } } });
    expect(service.commit).not.toHaveBeenCalled();
  });

  it("does not silently accept query filters on a full cutover command", async () => {
    expect((await request(server.url + ROOT + "/commit?productId=1", REQUEST)).status).toBe(400);
    expect(service.commit).not.toHaveBeenCalled();
  });

  it("uses actual service validation to reject a missing session actor before store access", async () => {
    session = { user: {} };
    const store = { preview: vi.fn(async () => review()), commit: vi.fn(async () => result()) };
    const actual = new InventoryCutoverCommitService(store, { now: () => NOW });
    service.commit.mockImplementation((input, actor) => actual.commit(input, actor));
    expect(await request(server.url + ROOT + "/commit", REQUEST)).toMatchObject({ status: 401, body: { error: { code: "CUTOVER_ACTOR_REQUIRED" } } });
    expect(store.commit).not.toHaveBeenCalled();
  });

  it.each(["40001", "40P01", "55P03", "57014", "INVENTORY_PUBLICATION_TARGET_BUSY"])("sanitizes concurrent/timeout error %s without auto-retrying", async (code) => {
    service.commit.mockRejectedValue(Object.assign(new Error("secret SQL password"), { code }));
    const response = await request(server.url + ROOT + "/commit", REQUEST);
    expect(response).toMatchObject({ status: 409, body: { error: { code: "CUTOVER_CONCURRENT_CHANGE" } } });
    expect(service.commit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response.body)).not.toContain("secret");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it.each([
    ["57014", 503, "CUTOVER_EVIDENCE_CAPTURE_TIMEOUT"],
    ["40001", 409, "CUTOVER_EVIDENCE_CAPTURE_CONFLICT"],
    ["OMS_CUTOVER_CENSUS_LIMIT_EXCEEDED", 422, "CUTOVER_EVIDENCE_CAPTURE_LIMIT_EXCEEDED"],
    ["CUTOVER_JOURNAL_ROW_LIMIT_EXCEEDED", 422, "CUTOVER_EVIDENCE_CAPTURE_LIMIT_EXCEEDED"],
    ["XX000", 500, "CUTOVER_EVIDENCE_CAPTURE_FAILED"],
  ])("reports a named capture stage for %s without exposing evidence or retrying", async (databaseCode, status, code) => {
    const cause = Object.assign(new Error("secret SQL password and customer payload"), { code: databaseCode, detail: "private" });
    service.preview.mockRejectedValue(new InventoryCutoverCaptureError("oms_demand_and_receipts", cause));
    const response = await request(server.url + ROOT + "/review", { activationRunId: "1" });
    expect(response).toMatchObject({ status, body: { error: { code, context: { stage: "oms_demand_and_receipts" } } } });
    expect(response.body.error.message).toContain("sales-channel demand and shipment acknowledgments");
    expect(response.body.error.message).toContain("No complete review");
    expect(response.body).not.toHaveProperty("ready");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.preview).toHaveBeenCalledTimes(1);
    expect(service.commit).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toMatch(/secret|password|private|payload/);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/secret|password|private|payload/);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"event":"inventory_cutover_capture_failed"'));
  });

  it("does not trust a spoofed capture-stage exception", async () => {
    service.preview.mockRejectedValue(Object.assign(new Error("private SQL"), {
      code: "CUTOVER_EVIDENCE_CAPTURE_TIMEOUT", stage: "oms_demand_and_receipts", status: 503,
    }));
    expect(await request(server.url + ROOT + "/review", { activationRunId: "1" })).toMatchObject({
      status: 500, body: { error: { code: "CUTOVER_COMMAND_FAILED" } },
    });
  });

  it.each([
    new InventoryCutoverCommitError("CUTOVER_IDEMPOTENCY_CONFLICT", "The command belongs to a different actor."),
    new InventoryCutoverManifestError("CUTOVER_REVIEWED_HEAD_CHANGED", "private row data", { private: "data" }),
    new CutoverReconstructionError("CUTOVER_RECONSTRUCTION_EVIDENCE_CHANGED", "private row data", { private: "data" }),
    new InventoryAvailabilityActivationRepositoryError("ACTIVATION_PUBLICATION_TARGET_CHANGED", "private row data", { private: "data" }),
  ])("classifies actual typed stale-evidence owner error %# as conflict", async (error) => {
    service.commit.mockRejectedValue(error);
    const response = await request(server.url + ROOT + "/commit", REQUEST);
    expect(response).toMatchObject({ status: 409, body: { error: { code: error.code } } });
    expect(JSON.stringify(response.body)).not.toContain("private");
  });

  it("returns a nonpartial422 for an owner census limit", async () => {
    service.preview.mockRejectedValue(new CutoverReconstructionError("CUTOVER_VARIANT_CENSUS_LIMIT_EXCEEDED", "private"));
    expect(await request(server.url + ROOT + "/review", { activationRunId: "1" })).toMatchObject({ status: 422,
      body: { error: { code: "CUTOVER_VARIANT_CENSUS_LIMIT_EXCEEDED" } } });
  });

  it.each([new Error("secret SQL password"), new InventoryCutoverCommitError("PRIVATE_FAILURE", "secret SQL password", 500, { password: "secret" }),
    Object.assign(new Error("secret SQL password"), { code: "CUTOVER_REVIEWED_HEAD_CHANGED" }),
  ])("sanitizes unknown/internal failures and does not trust a spoofed domain code: %#", async (error) => {
    service.commit.mockRejectedValue(error);
    const response = await request(server.url + ROOT + "/commit", REQUEST);
    expect(response).toMatchObject({ status: 500, body: { error: { code: "CUTOVER_COMMAND_FAILED" } } });
    expect(JSON.stringify(response.body)).not.toMatch(/secret|password|PRIVATE_FAILURE/);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/secret|password/);
  });

  it("rejects misleading or extra service output instead of reporting partial success", async () => {
    service.commit.mockResolvedValueOnce({ ...result(), runtimeAuthority: "legacy", secret: "private" });
    const response = await request(server.url + ROOT + "/commit", REQUEST);
    expect(response).toMatchObject({ status: 500, body: { error: { code: "CUTOVER_COMMAND_FAILED" } } });
    expect(JSON.stringify(response.body)).not.toContain("private");
    service.preview.mockResolvedValueOnce({ ...review(), ready: true });
    expect((await request(server.url + ROOT + "/review", { activationRunId: "1" })).status).toBe(500);
  });
});

async function startServer(service: Pick<InventoryCutoverCommitService, "preview" | "commit">, session: () => unknown) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.defineProperty(req, "session", { configurable: true, value: session() }); next(); });
  registerInventoryCutoverCommitRoutes(app, service);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
async function request(url: string, value: unknown) {
  const target = new URL(url); const body = JSON.stringify(value);
  return new Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: res.headers }));
      res.on("error", reject);
    });
    req.on("error", reject); req.end(body);
  });
}
