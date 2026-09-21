import { describe, expect, it, vi } from "vitest";
import type { WalmartChannelStatus } from "@shared/types/walmart-channel";
import type { FulfillmentProviderCredentialCipher } from "../../../shipping-engine/application/connected-fulfillment-method-catalog.service";
import { WalmartChannelService } from "../../adapters/walmart/walmart-channel.service";
import { WalmartConnectionRepository, type WalmartConnectionRecord } from "../../adapters/walmart/walmart-connection.repository";
import { WalmartUsApi, type WalmartShipNode } from "../../adapters/walmart/walmart-us-api";

const now = new Date("2026-09-21T12:00:00.000Z");
const keys = { clientId: "test-client", clientSecret: "test-secret", environment: "production" as const };
const command = { ...keys, expectedPartnerId: "PARTNER-1", shipNodeId: "NODE-1", warehouseId: 4,
  importSince: "2026-09-20T12:00:00.000Z" };
const node = (nodeType: string, status = "ACTIVE", shipNode = "NODE-1"): WalmartShipNode => ({
  shipNode, shipNodeName: "Seller location", nodeType, status,
});

function setup(nodes: WalmartShipNode[], partnerId = command.expectedPartnerId) {
  // Exercise the provider response parser as well as the service policy. No live
  // API or database calls are allowed by this fixture.
  const request = vi.fn(async (method: string, path: string): Promise<unknown> => {
    if (method !== "GET") throw new Error("Unexpected provider write");
    if (path === "/v3/settings/partnerprofile") return { partner: { partnerId, partnerDisplayName: "Seller" } };
    if (path === "/v3/settings/shipping/shipnodes") return nodes;
    if (path.startsWith("/v3/orders?")) return { list: { meta: {}, elements: { order: [] } } };
    throw new Error(`Unexpected provider path: ${path}`);
  });
  const api = new WalmartUsApi({ request });
  const encrypted = { connectionId: 7, keyId: "test", ciphertext: "sealed", iv: "iv", authTag: "tag" };
  const cipher: FulfillmentProviderCredentialCipher = {
    seal: vi.fn(() => encrypted),
    open: vi.fn(() => JSON.stringify({ ...keys, market: "us" })),
  };
  const row: WalmartConnectionRecord = {
    channel_id: 2, connection_id: 7, partner_id: command.expectedPartnerId, partner_name: "Seller",
    channel_status: "active", environment: "production", ship_node_id: command.shipNodeId,
    warehouse_id: command.warehouseId, encrypted_credentials: encrypted, orders_enabled: false,
    import_since: new Date(command.importSince), checkpoint_at: null, last_poll_at: null,
    last_success_at: null, last_error_code: null, revision: 1,
  };
  const status: WalmartChannelStatus = {
    channelId: 2, connectionId: 7, partnerId: command.expectedPartnerId, partnerName: "Seller",
    environment: "production", shipNodeId: command.shipNodeId, warehouseId: command.warehouseId,
    ordersEnabled: false, importSince: command.importSince, lastPollAt: null, lastSuccessAt: null,
    lastErrorCode: null, revision: 1, mappedSkus: 1,
  };
  const repository = new WalmartConnectionRepository({ connect: vi.fn(() => { throw new Error("Unexpected database access"); }) });
  vi.spyOn(repository, "withLock").mockImplementation(async (_channelId, work) => work());
  vi.spyOn(repository, "get").mockResolvedValue(row);
  vi.spyOn(repository, "status").mockResolvedValue(status);
  const save = vi.spyOn(repository, "save").mockResolvedValue();
  const control = vi.spyOn(repository, "control").mockResolvedValue();
  vi.spyOn(repository, "assertWarehouse").mockResolvedValue();
  const service = new WalmartChannelService(repository, cipher, { liveEnabled: true, productionServer: true },
    () => now, () => api);
  return { service, repository, request, save, control };
}

describe("Walmart seller fulfillment-center eligibility", () => {
  it.each(["VIRTUAL", "PHYSICAL"])("verifies, saves and enables an active %s center", async nodeType => {
    const center = node(nodeType);
    const s = setup([center]);
    await expect(s.service.preview(keys)).resolves.toMatchObject({ nodes: [center] });
    await s.service.connect(2, command, "operator");
    expect(s.save).toHaveBeenCalledWith(command, 2, "Seller", "operator", now, expect.any(Function));
    await s.service.control(2, { ordersEnabled: true, expectedRevision: 1 }, "operator");
    expect(s.control).toHaveBeenCalledWith(2, true, 1, "operator", now);
    const orderRequests = s.request.mock.calls.filter(([, path]) => path.startsWith("/v3/orders?"));
    expect(orderRequests).toHaveLength(2);
    for (const [, path] of orderRequests) {
      expect(new URL(path, "https://marketplace.walmartapis.com").searchParams.get("shipNodeType")).toBe("SellerFulfilled");
    }
  });

  it("keeps every eligible provider ID and name without changing the provider response", async () => {
    const centers = [node("VIRTUAL"), node("PHYSICAL", "ACTIVE", "NODE-2"), node("3PL", "ACTIVE", "NODE-3")];
    const before = structuredClone(centers);
    const { nodes } = await setup(centers).service.preview(keys);
    expect(nodes).toEqual(centers.slice(0, 2));
    expect(centers).toEqual(before);
  });

  it.each([
    ["VIRTUAL", "INACTIVE"], ["PHYSICAL", "INACTIVE"], ["3PL", "ACTIVE"],
    ["WFS", "ACTIVE"], ["UNKNOWN", "ACTIVE"], ["VIRTUAL", "UNKNOWN"],
    ["", "ACTIVE"], ["VIRTUAL", ""], ["virtual", "ACTIVE"], ["VIRTUAL", "active"],
  ])("rejects %s / %s during verification, saving and activation", async (nodeType, status) => {
    const s = setup([node(nodeType, status)]);
    await expect(s.service.preview(keys)).resolves.toMatchObject({ nodes: [] });
    await expect(s.service.connect(2, command, "operator")).rejects.toMatchObject({ code: "WALMART_SHIP_NODE_INVALID" });
    await expect(s.service.control(2, { ordersEnabled: true, expectedRevision: 1 }, "operator"))
      .rejects.toMatchObject({ code: "WALMART_ACCOUNT_CHANGED" });
    expect(s.save).not.toHaveBeenCalled();
    expect(s.control).not.toHaveBeenCalled();
  });

  it.each([{ nodes: [] }, { nodes: [node("VIRTUAL", "ACTIVE", "OTHER-NODE")] }])("does not invent or substitute a missing selected node: %j", async ({ nodes }) => {
    const s = setup(nodes);
    await expect(s.service.connect(2, command, "operator")).rejects.toMatchObject({ code: "WALMART_SHIP_NODE_INVALID" });
    await expect(s.service.control(2, { ordersEnabled: true, expectedRevision: 1 }, "operator"))
      .rejects.toMatchObject({ code: "WALMART_ACCOUNT_CHANGED" });
    expect(s.save).not.toHaveBeenCalled();
    expect(s.control).not.toHaveBeenCalled();
  });

  it("rejects an active virtual node when the verified account identity changes", async () => {
    const s = setup([node("VIRTUAL")], "OTHER-PARTNER");
    await expect(s.service.connect(2, command, "operator")).rejects.toMatchObject({ code: "WALMART_ACCOUNT_CHANGED" });
    await expect(s.service.control(2, { ordersEnabled: true, expectedRevision: 1 }, "operator"))
      .rejects.toMatchObject({ code: "WALMART_ACCOUNT_CHANGED" });
    expect(s.save).not.toHaveBeenCalled();
    expect(s.control).not.toHaveBeenCalled();
  });

  it("returns an empty list when Walmart returns no centers", async () => {
    await expect(setup([]).service.preview(keys)).resolves.toMatchObject({ nodes: [] });
  });

  it("rejects malformed node responses without saving or enabling the connection", async () => {
    const s = setup([node("VIRTUAL")]);
    s.request.mockImplementation(async (_method, path) => path === "/v3/settings/partnerprofile"
      ? { partner: { partnerId: command.expectedPartnerId, partnerDisplayName: "Seller" } }
      : [{ shipNode: "NODE-1", nodeType: "VIRTUAL", shipNodeName: "Seller" }]);
    await expect(s.service.preview(keys)).rejects.toMatchObject({ code: "WALMART_RESPONSE_INVALID" });
    await expect(s.service.connect(2, command, "operator")).rejects.toMatchObject({ code: "WALMART_RESPONSE_INVALID" });
    await expect(s.service.control(2, { ordersEnabled: true, expectedRevision: 1 }, "operator"))
      .rejects.toMatchObject({ code: "WALMART_RESPONSE_INVALID" });
    expect(s.save).not.toHaveBeenCalled();
    expect(s.control).not.toHaveBeenCalled();
  });
});
