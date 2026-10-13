import { describe, it, expect, vi } from "vitest";
import { CustomerOrderEditService } from "../../application/customer-order-edit.service";
import { customerOrderEditActorId, orderEditAuditActor, readCustomerOrderEditActor } from "../../../order-edits/domain/order-edit-actor";
import { readCustomerAccountStagingConfig, requireCustomerAccountStaging } from "../../domain/customer-account-staging";
import { appendOrderEditAudit } from "../../../order-edits/infrastructure/order-edit-audit.writer";

const principal = { channelId: 2, externalCustomerId: "100", shopDomain: "fixture.myshopify.com", sessionKey: "a".repeat(43), authenticatedAt: 1, expiresAt: 1800001 };
const connection = { channelId: 2, connectionId: 4, shopDomain: principal.shopDomain, name: "Shopify", enabled: true, paymentWindowMinutes: 30 };
const uuid = "11111111-1111-4111-8111-111111111111";
function setup() {
  const owned = { omsOrderId: 9, channelId: 2, externalOrderId: "99", externalOrderNumber: "#10" };
  const access = { resolve: vi.fn(async () => owned), resolveOwned: vi.fn(async () => owned) };
  const store = { connections: vi.fn(async () => [connection]), get: vi.fn(async () => ({ actorId: "shopify:2:100", connectionId: 4, omsOrderId: 9, baseline: { channelId: 2, customerId: "gid://shopify/Customer/100" } })) };
  const edits = { order: vi.fn(async () => ({ activeOperationId: null, eligibility: { editable: true, reasons: [] } })), catalogCategories: vi.fn(), catalogProducts: vi.fn(), catalogVariants: vi.fn(), warmPreview: vi.fn(), preview: vi.fn(), quote: vi.fn(), get: vi.fn(), commit: vi.fn(), reconcile: vi.fn(), abandon: vi.fn() };
  const service = new CustomerOrderEditService({ principal, access, store, edits } as unknown as ConstructorParameters<typeof CustomerOrderEditService>[0]);
  return { access, store, edits, service };
}
describe("customer order edit ownership", () => {
  it("resolves native Shopify order IDs through the existing owned-order resolver", async () => {
    const fixture = setup();
    await expect(fixture.service.resolve({ orderReference: "#10", externalOrderId: "99" })).resolves.toEqual({ omsOrderId: 9, connectionId: 4, externalOrderId: "99" });
    expect(fixture.access.resolve).toHaveBeenCalledWith({ orderReference: "#10" });
    await expect(fixture.service.resolve({ orderReference: "#10", externalOrderId: "98" })).rejects.toMatchObject({ status: 404 });
  });
  it("denies foreign connections and missing ownership before any provider call", async () => {
    const fixture = setup();
    await expect(fixture.service.order(5, 9)).rejects.toMatchObject({ status: 404 });
    fixture.access.resolveOwned.mockRejectedValue(new Error("owned order unavailable"));
    await expect(fixture.service.order(4, 9)).rejects.toThrow("owned order unavailable");
    expect(fixture.edits.order).not.toHaveBeenCalled();
  });
  it.each(["shopify:2:101", "shopify:3:100", "staff-user"])("denies operation creator %s before reads or mutations", async actorId => {
    const fixture = setup();
    fixture.store.get.mockResolvedValue({ actorId, connectionId: 4, omsOrderId: 9, baseline: { channelId: 2, customerId: "gid://shopify/Customer/100" } });
    await expect(fixture.service.operation(uuid)).rejects.toMatchObject({ status: 404 });
    await expect(fixture.service.progress(uuid, "commit", uuid)).rejects.toMatchObject({ status: 404 });
    expect(fixture.edits.get).not.toHaveBeenCalled(); expect(fixture.edits.commit).not.toHaveBeenCalled();
  });
  it("checks the certified baseline and current OMS ownership, then reuses canonical commands", async () => {
    const fixture = setup();
    await fixture.service.progress(uuid, "commit", uuid);
    expect(fixture.access.resolveOwned).toHaveBeenCalledWith({ omsOrderId: 9 });
    expect(fixture.edits.commit).toHaveBeenCalledWith(uuid, uuid, "shopify:2:100");
    fixture.store.get.mockResolvedValue({ actorId: "shopify:2:100", connectionId: 4, omsOrderId: 9, baseline: { channelId: 2, customerId: "gid://shopify/Customer/101" } });
    await expect(fixture.service.operation(uuid)).rejects.toMatchObject({ status: 404 });
  });
  it("binds quote keys and scopes pricing previews to the owned order", async () => {
    const fixture = setup();
    const input = { connectionId: 4, omsOrderId: 9, expectedRevision: "revision", requestKey: uuid, changes: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 2 }], additions: [] };
    await expect(fixture.service.quote(input, "22222222-2222-4222-8222-222222222222")).rejects.toMatchObject({ code: "ORDER_EDIT_KEY_MISMATCH" });
    expect(fixture.edits.quote).not.toHaveBeenCalled();
    await fixture.service.quote(input, uuid);
    expect(fixture.edits.quote).toHaveBeenCalledWith(input, "shopify:2:100");
    fixture.access.resolveOwned.mockRejectedValue(new Error("foreign order"));
    await expect(fixture.service.preview({ ...input, requestKey: undefined })).rejects.toThrow();
    expect(fixture.edits.preview).not.toHaveBeenCalled();
  });
  it("rejects catalog pricing without an owned order context", async () => {
    const fixture = setup();
    await expect(fixture.service.catalogVariants(4, { productId: "gid://shopify/Product/1" })).rejects.toMatchObject({ status: 404 });
    expect(fixture.edits.catalogVariants).not.toHaveBeenCalled();
  });
});
describe("external Shopify edit audit identity", () => {
  it("retains staff and system identity without pretending shoppers are staff", () => {
    expect(customerOrderEditActorId({ channelId: 2, externalCustomerId: "100" })).toBe("shopify:2:100");
    expect(orderEditAuditActor("shopify:2:100")).toEqual({ staffId: null, customerChannelId: 2, externalCustomerId: "100" });
    expect(orderEditAuditActor("staff-user").staffId).toBe("staff-user");
    expect(orderEditAuditActor(null).staffId).toBeNull();
  });
  it.each(["shopify:0:100", "shopify:2:0", "shopify:2:x", "shopify:9007199254740992:1", `shopify:2:${"1".repeat(31)}`])("rejects malformed reserved actor %s", actor => {
    expect(() => readCustomerOrderEditActor(actor)).toThrow();
  });
  it("writes customer audit columns inside the supplied transaction", async () => {
    const tx = { query: vi.fn(async () => ({ rows: [], command: "INSERT", rowCount: 1, oid: 0, fields: [] })) };
    await appendOrderEditAudit(tx, { operationId: uuid, connectionId: 4, actorId: "shopify:2:100", action: "quoted", before: null, after: { status: "ready" }, occurredAt: "2026-10-12T00:00:00Z" });
    const [sql, values] = tx.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("customer_actor_channel_id,customer_actor_external_id");
    expect(sql).toContain("VALUES($1,$2,NULL"); expect(values.slice(-2)).toEqual([2, "100"]);
    expect(values).not.toContain("shopify:2:100");
  });
});
describe("default-off staging access", () => {
  const config = { themeId: "174740308127", shops: { [principal.shopDomain]: { customerIds: ["100"] } } };
  const authConfig = { storageSecret: "x".repeat(32), publicOrigin: "https://backend.test", shops: { [principal.shopDomain]: { proxyUrl: "https://shop.test/apps/echelon-returns", shopifySecret: "fixture-secret" } } };
  const input = { config, authConfig, principal, themeId: config.themeId, expectedCustomerId: "100", origin: "https://shop.test", commandHeader: "1", sessionKey: principal.sessionKey };
  it("defaults off and rejects malformed allowlists", () => {
    expect(readCustomerAccountStagingConfig(undefined)).toBeNull();
    expect(() => readCustomerAccountStagingConfig("{}")).toThrow();
    expect(() => readCustomerAccountStagingConfig(JSON.stringify({ ...config, shops: { [principal.shopDomain]: { customerIds: ["100", "100"] } } }))).toThrow();
    expect(() => requireCustomerAccountStaging({ ...input, config: null })).toThrow();
  });
  it("requires the allowed signed customer, expected account, exact theme and origin", () => {
    expect(() => requireCustomerAccountStaging(input)).not.toThrow();
    for (const override of [{ themeId: "1" }, { expectedCustomerId: "101" }, { sessionKey: "b".repeat(43) }, { origin: "https://evil.test" }, { commandHeader: undefined }, { principal: { ...principal, externalCustomerId: "101" } }]) {
      expect(() => requireCustomerAccountStaging({ ...input, ...override })).toThrow();
    }
  });
});
