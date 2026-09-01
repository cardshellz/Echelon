import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerInventoryChannelExposureRoutes } from "../../interfaces/http/inventory-channel-exposure.routes";

const HASH = "a".repeat(64);
const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _req: unknown, _res: unknown, next: () => void,
    ) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({ requirePermission: requirePermissionMock }));

describe("inventory channel exposure routes", () => {
  let server: { url: string; close(): Promise<void> };
  let service: {
    getView: ReturnType<typeof vi.fn>;
    preview: ReturnType<typeof vi.fn>;
    savePolicyDraft: ReturnType<typeof vi.fn>;
    saveSourceBindingDraft: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    requirePermissionMock.mockClear();
    service = {
      getView: vi.fn(async () => ({
        products: [], selectedProduct: null, channels: [], publicationTargets: [],
        fulfillmentNodes: [], policyHeads: [], sourceBindingHeads: [],
        runtimeAuthority: "legacy_channel_allocation_rules", providerWriteEnabled: false,
      })),
      preview: vi.fn(),
      savePolicyDraft: vi.fn(async () => saveResult()),
      saveSourceBindingDraft: vi.fn(async () => saveResult()),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, "session", { value: { user: { id: "operator-1" } } });
      next();
    });
    registerInventoryChannelExposureRoutes(app, { service });
    server = await startServer(app);
  });

  afterEach(async () => server.close());

  it("gates the view with inventory-planning view permission", async () => {
    const response = await jsonRequest(`${server.url}/api/inventory-planning/admin/channel-exposure`);
    expect(response.status).toBe(200);
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "view");
    expect(service.getView).toHaveBeenCalledWith(null);
  });

  it("gates draft saves with edit permission and forwards the authenticated actor", async () => {
    const request = {
      scope: { scopeType: "channel", channelId: 3 },
      value: {
        allocationSemantics: "exposure", eligible: true, shareBps: 10000,
        holdbackSellableUnits: "0", maxPublish: { mode: "unlimited" },
        minPublishSellableUnits: "0",
      },
      expectedHeadRevision: "0",
      expectedDraftPolicyId: null,
      expectedDraftDefinitionHash: null,
      changeReason: "Initial reviewed channel default",
      idempotencyKey: "route-policy-1",
    };
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/policy-draft`,
      { method: "PUT", body: request },
    );
    expect(response.status).toBe(201);
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory_planning", "edit");
    expect(service.savePolicyDraft).toHaveBeenCalledWith(request, "operator-1");
  });

  it("rejects malformed source-binding inputs before the service", async () => {
    const response = await jsonRequest(
      `${server.url}/api/inventory-planning/admin/channel-exposure/source-binding-draft`,
      { method: "PUT", body: { publicationTargetId: 1, fulfillmentNodeIds: [] } },
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "INVENTORY_CHANNEL_EXPOSURE_INVALID_REQUEST" },
    });
    expect(service.saveSourceBindingDraft).not.toHaveBeenCalled();
  });
});

function saveResult() {
  return {
    definitionId: 1,
    version: 1,
    definitionHash: HASH,
    headRevision: "1",
    alreadyApplied: false,
    runtimeAuthorityChanged: false,
    providerWriteAttempted: false,
  };
}

async function startServer(app: express.Express) {
  const listener = http.createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => listener.close((error) =>
      error ? reject(error) : resolve())),
  };
}

async function jsonRequest(url: string, input?: { method: string; body: unknown }) {
  const target = new URL(url);
  const body = input ? JSON.stringify(input.body) : null;
  return new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: input?.method ?? "GET",
      headers: body === null ? {} : { "Content-Type": "application/json" },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>,
      }));
    });
    request.on("error", reject);
    if (body !== null) request.write(body);
    request.end();
  });
}
