import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerInventoryAvailabilityPhase4Routes } from "../../interfaces/http/inventory-availability-phase4.routes";
import { InventoryAvailabilityShadowRepositoryError } from "../../infrastructure/inventory-availability-shadow.repository";

const HASH = "a".repeat(64);
const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({ requirePermission: requirePermissionMock }));

describe("inventory availability Phase 4 admin routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let claimSimulationService: { runSimulation: ReturnType<typeof vi.fn> };
  let activationDryRunService: { runDryRun: ReturnType<typeof vi.fn> };
  let activationService: {
    prepare: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    getOpenStatus: ReturnType<typeof vi.fn>;
  };
  let publicationReadbackService: { capture: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    claimSimulationService = { runSimulation: vi.fn(async () => claimRun()) };
    activationDryRunService = { runDryRun: vi.fn(async () => activationRun()) };
    activationService = {
      prepare: vi.fn(async () => activationCommand("prepare", "publishing")),
      abort: vi.fn(async () => activationCommand("abort", "failed")),
      getStatus: vi.fn(async () => activationStatus()),
      getOpenStatus: vi.fn(async () => activationStatus()),
    };
    publicationReadbackService = { capture: vi.fn(async () => readbackRun()) };
    server = await startServer(buildApp(
      claimSimulationService,
      activationDryRunService,
      activationService,
      publicationReadbackService,
    ));
  });

  afterEach(async () => server.close());

  it("gates whole-order simulations with edit permission and records the actor", async () => {
    const body = {
      idempotencyKey: "claim-route-1",
      reason: "Synthetic basket",
      claim: {
        requestKey: "order:1",
        scope: { kind: "network" },
        lines: [{ lineKey: "line:1", targetVariantId: 101, requestedQty: "1" }],
      },
    };
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/claim-simulations`,
      jsonPost(body),
    );

    expect(response.status).toBe(201);
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "edit");
    expect(claimSimulationService.runSimulation).toHaveBeenCalledWith(body, "operator-1");
  });

  it("gates the full-catalog dry run with the dedicated activate permission", async () => {
    const body = {
      expectedCatalogInputHash: HASH,
      expectedCatalogResultHash: HASH,
      idempotencyKey: "activation-route-1",
      reason: "Full catalog review",
    };
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/activation-runs/dry-run`,
      jsonPost(body),
    );

    expect(response.status).toBe(201);
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "activate");
    expect(activationDryRunService.runDryRun).toHaveBeenCalledWith(body, "operator-1");
  });

  it("returns a conflict when a claim targets an internal-only variant", async () => {
    claimSimulationService.runSimulation.mockRejectedValueOnce(
      new InventoryAvailabilityShadowRepositoryError(
        "TARGET_VARIANT_NOT_CUSTOMER_SELLABLE",
        "Claim simulation cannot target an internal inventory/transformation identity.",
        { targetVariantIds: [101] },
      ),
    );

    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/claim-simulations`,
      jsonPost({}),
    );

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: {
        code: "INVENTORY_AVAILABILITY_TARGET_VARIANT_NOT_CUSTOMER_SELLABLE",
        message: "Claim simulation cannot target an internal inventory/transformation identity.",
      },
    });
  });

  it("role-gates conservative activation preparation without exposing authority commit", async () => {
    const body = {
      sourceDryRunId: "7",
      expectedDryRunResultHash: HASH,
      idempotencyKey: "prepare-route-1",
      reason: "Prepare conservative publication",
    };
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/activation-runs/prepare`,
      jsonPost(body),
    );
    expect(response.status).toBe(201);
    expect(activationService.prepare).toHaveBeenCalledWith(body, "operator-1");
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "activate");
  });

  it("captures exact provider readback evidence through the activation permission", async () => {
    const body = { idempotencyKey: "readback-route-1", reason: "Refresh provider evidence" };
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/publication-readbacks/capture`,
      jsonPost(body),
    );

    expect(response.status).toBe(201);
    expect(publicationReadbackService.capture).toHaveBeenCalledWith(body, "operator-1");
  });

  it("loads the durable open preparation through the activation permission", async () => {
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/activation-runs/open`,
      { method: "GET", headers: {}, body: "" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ activation: activationStatus() });
    expect(activationService.getOpenStatus).toHaveBeenCalledOnce();
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "activate");
  });
});

function buildApp(
  claimSimulationService: { runSimulation: ReturnType<typeof vi.fn> },
  activationDryRunService: { runDryRun: ReturnType<typeof vi.fn> },
  activationService: {
    prepare: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    getOpenStatus: ReturnType<typeof vi.fn>;
  },
  publicationReadbackService: { capture: ReturnType<typeof vi.fn> },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, "session", {
      configurable: true,
      value: { user: { id: "operator-1" } },
    });
    next();
  });
  registerInventoryAvailabilityPhase4Routes(app, {
    claimSimulationService,
    activationDryRunService,
    activationService,
    publicationReadbackService,
  });
  return app;
}

function activationCommand(
  commandType: "prepare" | "abort",
  state: "publishing" | "failed",
) {
  return {
    activationRunId: "12",
    commandType,
    state,
    sourceDryRunId: "7",
    revalidationDryRunId: null,
    conservativePublicationRows: 1,
    fullPublicationRows: 0,
    runtimeAuthority: "legacy" as const,
    alreadyApplied: false,
  };
}

function readbackRun() {
  return {
    readbackRunId: "5",
    state: "completed" as const,
    requestedBy: "operator-1",
    reason: "Refresh provider evidence",
    startedAt: "2026-09-01T18:00:00.000Z",
    completedAt: "2026-09-01T18:00:01.000Z",
    targetRows: 1,
    observedRows: 1,
    failedRows: 0,
    failures: [],
    alreadyApplied: false,
  };
}

function activationStatus() {
  return {
    activationRunId: "12",
    state: "publishing" as const,
    sourceDryRunId: "7",
    runtimeAuthority: "legacy" as const,
    providerWriteAttempted: false,
    configurationFrozen: true,
    outbox: {
      total: 1,
      queued: 1,
      leased: 0,
      verified: 0,
      retryableOrDrifted: 0,
      deadLetter: 0,
      cancelled: 0,
    },
  };
}

function claimRun() {
  const claim = {
    requestKey: "order:1",
    scope: { kind: "network" as const },
    lines: [{ lineKey: "line:1", targetVariantId: 101, requestedQty: "1" }],
  };
  return {
    simulationRunId: "1",
    requestHash: HASH,
    requestedBy: "operator-1",
    reason: "Synthetic basket",
    capturedAt: "2026-08-28T17:00:00.000Z",
    completedAt: "2026-08-28T17:00:01.000Z",
    claim,
    plan: {
      ...claim,
      status: "satisfied" as const,
      lines: [{
        lineKey: "line:1",
        targetVariantId: 101,
        requestedQty: "1",
        plannedQty: "1",
        shortfallQty: "0",
      }],
      resourceClaims: [],
      operations: [],
      fulfillmentGroups: [],
      modelEvidence: [],
      blockers: [],
      snapshotFingerprint: HASH,
    },
    legacyLivePathRetained: true as const,
    operationalWriteAttempted: false as const,
    alreadyApplied: false,
  };
}

function activationRun() {
  return {
    activationRunId: "1",
    mode: "dry_run" as const,
    scope: "full_catalog" as const,
    state: "ready_for_publication" as const,
    requestHash: HASH,
    resultHash: HASH,
    catalogInputHash: HASH,
    catalogResultHash: HASH,
    requestedBy: "operator-1",
    reason: "Full catalog review",
    startedAt: "2026-08-28T17:00:00.000Z",
    completedAt: "2026-08-28T17:00:01.000Z",
    summary: { totalProducts: 0, readyProducts: 0, blockedProducts: 0, publicationRows: 0 },
    products: [],
    blockers: [],
    runtimeAuthorityChanged: false as const,
    providerWriteAttempted: false as const,
    outboxEnqueued: false as const,
    alreadyApplied: false,
  };
}

async function startServer(app: express.Express) {
  const listener = http.createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      listener.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function jsonRequest(url: string, init: { method: string; headers: Record<string, string>; body: string }) {
  const target = new URL(url);
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: init.method,
      headers: init.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      }));
    });
    request.on("error", reject);
    request.write(init.body);
    request.end();
  });
}

function jsonPost(body: unknown) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
