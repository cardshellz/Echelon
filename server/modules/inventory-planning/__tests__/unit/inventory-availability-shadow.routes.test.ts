import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlannerShadowRunDto } from "@shared/types/inventory-availability-planner";
import { InventoryAvailabilityShadowServiceError } from "../../application/inventory-availability-shadow.service";
import {
  registerInventoryAvailabilityShadowRoutes,
} from "../../interfaces/http/inventory-availability-shadow.routes";

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: requirePermissionMock,
}));

describe("inventory availability shadow routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: ReturnType<typeof fakeService>;

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = fakeService();
    server = await startServer(buildApp(service));
  });

  afterEach(async () => server.close());

  it("gates and records a strict shadow request with the authenticated actor", async () => {
    service.runProductShadow.mockResolvedValue(run());
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/shadow-runs`,
      jsonPost({ idempotencyKey: "shadow-route-1" }),
    );

    expect(response.status).toBe(201);
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "edit");
    expect(service.runProductShadow).toHaveBeenCalledWith(
      10,
      { idempotencyKey: "shadow-route-1" },
      "operator-1",
    );
  });

  it("returns 200 for an idempotent replay", async () => {
    service.runProductShadow.mockResolvedValue({ ...run(), alreadyApplied: true });
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/shadow-runs`,
      jsonPost({ idempotencyKey: "shadow-route-1" }),
    );
    expect(response.status).toBe(200);
  });

  it("rejects malformed or unauthenticated requests before invoking the service", async () => {
    const malformed = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/shadow-runs`,
      jsonPost({ idempotencyKey: "valid", unexpected: true }),
    );
    expect(malformed).toMatchObject({
      status: 400,
      body: { error: { code: "INVENTORY_AVAILABILITY_INVALID_INPUT" } },
    });
    expect(service.runProductShadow).not.toHaveBeenCalled();

    await server.close();
    server = await startServer(buildApp(service, false));
    const unauthenticated = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/shadow-runs`,
      jsonPost({ idempotencyKey: "shadow-route-2" }),
    );
    expect(unauthenticated).toMatchObject({
      status: 401,
      body: { error: { code: "INVENTORY_AVAILABILITY_ACTOR_REQUIRED" } },
    });
    expect(service.runProductShadow).not.toHaveBeenCalled();
  });

  it("serves the latest immutable evidence under view permission", async () => {
    service.getLatestProductShadow.mockResolvedValue(run());
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/shadow-runs/latest`,
    );

    expect(response).toMatchObject({ status: 200, body: { runId: "1", productId: 10 } });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "view");
    expect(service.getLatestProductShadow).toHaveBeenCalledWith(10);
  });

  it("returns a structured 404 when no comparison exists", async () => {
    service.getLatestProductShadow.mockRejectedValue(new InventoryAvailabilityShadowServiceError(
      404,
      "INVENTORY_AVAILABILITY_SHADOW_RUN_NOT_FOUND",
      "No shadow comparison has been recorded for this product.",
    ));
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/supply-transformations/10/shadow-runs/latest`,
    );
    expect(response).toMatchObject({
      status: 404,
      body: { error: { code: "INVENTORY_AVAILABILITY_SHADOW_RUN_NOT_FOUND" } },
    });
  });
});

function fakeService() {
  return {
    runProductShadow: vi.fn(),
    getLatestProductShadow: vi.fn(),
  };
}

function buildApp(service: ReturnType<typeof fakeService>, authenticated = true): express.Express {
  const app = express();
  app.use(express.json());
  if (authenticated) {
    app.use((req, _res, next) => {
      Object.defineProperty(req, "session", {
        configurable: true,
        value: { user: { id: "operator-1" } },
      });
      next();
    });
  }
  registerInventoryAvailabilityShadowRoutes(app, { service });
  return app;
}

async function startServer(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function jsonRequest(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: init?.method ?? "GET",
      headers: init?.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body: rawBody === "" ? {} : JSON.parse(rawBody) as Record<string, unknown>,
        });
      });
    });
    request.on("error", reject);
    if (init?.body !== undefined) request.write(init.body);
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

function run(): PlannerShadowRunDto {
  return {
    runId: "1",
    productId: 10,
    legacyInventoryStrategy: "physical_only",
    status: "completed",
    snapshotFingerprint: "a".repeat(64),
    capturedAt: "2026-08-27T12:00:00.000Z",
    completedAt: "2026-08-27T12:00:01.000Z",
    requestedBy: "operator-1",
    modelId: null,
    modelVersion: null,
    modelDefinitionHash: null,
    blockerCodes: [],
    alreadyApplied: false,
    results: [{
      warehouseId: null,
      warehouseCodeSnapshot: null,
      productVariantId: 101,
      productVariantSkuSnapshot: "EA",
      productVariantNameSnapshot: "Each",
      productVariantUnitsPerVariantSnapshot: 1,
      legacyAtpUnits: "7",
      legacyAtpBaseUnits: "7",
      proposedAtpUnits: "7",
      differenceUnits: "0",
      readinessState: "ready",
      classifications: ["match"],
      proposedProjection: {
        targetVariantId: 101,
        scope: { kind: "network" },
        status: "ready",
        atpUnits: "7",
        atpBaseUnits: "7",
        exactPhysicalUnits: "7",
        claimedUnits: "0",
        protectedUnits: "0",
        directUnits: "7",
        convertibleUnits: "0",
        buildableUnits: "0",
        snapshotFingerprint: "a".repeat(64),
        modelEvidence: [],
        safetyEvidence: [],
        blockers: [],
      },
    }],
  };
}
