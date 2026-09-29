import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReturnSubmissionCommand } from "../../application/customer-return-submission.service";
import type { CustomerReturnIntakeInspection } from "../../application/customer-return-live.service";
import type { CustomerReturnCustomerSession } from "../../application/customer-return-customer-auth.service";
import { CustomerReturnLabelSettingsService } from "../../application/customer-return-label-settings.service";
import { CustomerReturnLabelsService } from "../../application/customer-return-labels.service";
import { CustomerReturnLiveError } from "../../application/customer-return-live-error";
import { PostgresCustomerReturnSettingsStore } from "../../infrastructure/customer-return-label-settings.repository";
import { labelPolicy, labelPreparationFixture, labelSettings, LABEL_KEY } from "../support/label-fixtures";
import { LIVE_NOW } from "../support/live-inspection-fixtures";

const ports = vi.hoisted(() => ({
  live: vi.fn(), findOwnedOrder: vi.fn(), listOwnedOrders: vi.fn(), readOwnedAuthorization: vi.fn(), readOwnedCommand: vi.fn(),
  acquire: vi.fn(), read: vi.fn(), reject: vi.fn(), persist: vi.fn(),
}));
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../infrastructure/customer-return-live.composition", () => ({ createCustomerReturnLiveService: ports.live }));
vi.mock("../../infrastructure/customer-return-order-access.repository", () => ({
  PostgresCustomerReturnOrderAccessRepository: class { findOwnedOrder = ports.findOwnedOrder; listOwnedOrders = ports.listOwnedOrders; },
}));
vi.mock("../../infrastructure/customer-return-customer-ownership.repository", () => ({
  PostgresCustomerReturnCustomerOwnershipReader: class {
    readOwnedAuthorization = ports.readOwnedAuthorization;
    readOwnedCommand = ports.readOwnedCommand;
  },
}));
vi.mock("../../infrastructure/customer-return-submission.repository", () => ({
  PostgresCustomerReturnSubmissionStore: class { acquire = ports.acquire; read = ports.read; reject = ports.reject; },
}));
vi.mock("../../infrastructure/customer-return-intake.repository", () => ({
  PostgresCustomerReturnIntakeStore: class { persist = ports.persist; },
}));

const session: CustomerReturnCustomerSession = { channelId: 36, externalCustomerId: "123", shopDomain: "fixture.myshopify.com",
  sessionKey: "s".repeat(43), authenticatedAt: Date.parse(LIVE_NOW), expiresAt: Date.parse(LIVE_NOW) + 1_800_000 };
async function setup() {
  vi.clearAllMocks();
  vi.stubEnv("SHIPSTATION_V2_API_KEY", "");
  const fixture = await labelPreparationFixture();
  const inspectCanonicalForIntake = vi.fn(async (_scope: unknown): Promise<CustomerReturnIntakeInspection> => structuredClone(fixture.inspection));
  const inspectForIntake = vi.fn(async (): Promise<CustomerReturnIntakeInspection> => { throw new Error("Display-reference fallback must never run"); });
  const lookupCanonical = vi.fn(async () => structuredClone(fixture.inspection.order));
  ports.live.mockResolvedValue({ inspectCanonicalForIntake, inspectForIntake, lookupCanonical,
    getState: async () => ({ shops: [{ channelId: 36 }] }) });
  ports.findOwnedOrder.mockResolvedValue([{ channelId: 36, omsOrderId: 100, externalOrderId: fixture.inspection.local.order.externalOrderId,
    externalOrderNumber: fixture.inspection.local.order.externalOrderNumber, externalCustomerId: "123" }]);
  ports.listOwnedOrders.mockResolvedValue([{ channelId: 36, omsOrderId: 100, externalOrderId: fixture.inspection.local.order.externalOrderId,
    externalOrderNumber: fixture.inspection.local.order.externalOrderNumber, externalCustomerId: "123" }]);
  ports.readOwnedAuthorization.mockResolvedValue({ authorizationId: 1, omsOrderId: 100 });
  ports.readOwnedCommand.mockResolvedValue({ authorizationId: 1, omsOrderId: 100 });
  let command: ReturnSubmissionCommand | null = null;
  ports.acquire.mockImplementation(async (input) => {
    command ??= { request: input.request, omsOrderId: input.omsOrderId, status: "preparing", authorizationId: null,
      actor: input.actor, leaseToken: input.token };
    return structuredClone(command);
  });
  ports.read.mockImplementation(async () => structuredClone(command));
  ports.persist.mockImplementation(async () => {
    command!.status = "accepted";
    command!.authorizationId = 1;
    return { authorizationId: 1 };
  });
  const requireEnabled = vi.spyOn(CustomerReturnLabelSettingsService.prototype, "requireEnabled").mockResolvedValue({
    settings: labelSettings, operationalPolicy: { id: 1, version: 1, snapshot: labelPolicy },
  });
  vi.spyOn(CustomerReturnLabelsService.prototype, "status").mockResolvedValue({ channelId: 36, authorizationId: 1,
    authorizationNumber: "RMA-1", canProgress: true,
    parcels: [{ parcelId: 1, number: 1, status: "pending", trackingNumber: null, downloadPath: null }],
  });
  const progress = vi.spyOn(CustomerReturnLabelsService.prototype, "progress").mockRejectedValue(new Error("Submission must not purchase labels"));
  const { createCustomerReturnCustomerServices } = await import("../../infrastructure/customer-return-customer.composition");
  // Both production factories run here. The real submission orchestrator must
  // receive the canonical inspection method through the label-service factory.
  const services = await createCustomerReturnCustomerServices(session);
  const { channelId: _channelId, orderReference: _reference, ...input } = fixture.input;
  return { services, input, inspectCanonicalForIntake, inspectForIntake, lookupCanonical, requireEnabled, progress,
    markAccepted: () => { command!.status = "accepted"; command!.authorizationId = 1; } };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("customer returns production composition", () => {
  it("preserves the existing warning event and logs only safe inspection context", async () => {
    const s = await setup();
    vi.spyOn(PostgresCustomerReturnSettingsStore.prototype, "read").mockResolvedValue(null);
    vi.spyOn(PostgresCustomerReturnSettingsStore.prototype, "readControl").mockResolvedValue({ paused: false, version: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    s.lookupCanonical.mockRejectedValue(new CustomerReturnLiveError("RETURN_LIVE_DATA_UNVERIFIED", "private provider credential", 503));
    expect(await s.services.orders.list({})).toEqual({ orders: [], nextBeforeOmsOrderId: null, unavailableOrderCount: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0][0])).toEqual({ event: "return_customer_order_unavailable",
      code: "RETURN_ORDER_INSPECTION_UNAVAILABLE", channelId: 36, omsOrderId: 100,
      reason: "inspection_failed", causeCode: "RETURN_LIVE_DATA_UNVERIFIED" });
    expect(s.progress).not.toHaveBeenCalled();
    expect(ports.acquire).not.toHaveBeenCalled();
  });
  it("passes verified canonical ownership through the factory to intake without purchasing a label", async () => {
    const s = await setup();
    const result = await s.services.operations.submit(100, s.input);
    expect(s.inspectCanonicalForIntake).toHaveBeenCalledExactlyOnceWith({ channelId: 36, omsOrderId: 100,
      externalOrderId: "1001", externalCustomerId: "123" });
    expect(s.inspectForIntake).not.toHaveBeenCalled();
    expect(s.progress).not.toHaveBeenCalled();
    expect(ports.acquire).toHaveBeenCalledWith(expect.objectContaining({ omsOrderId: 100, actor: "customer:36:123" }));
    expect(ports.persist).toHaveBeenCalledWith(expect.objectContaining({ omsOrderId: 100, channelId: 36, actor: "customer:36:123" }));
    expect(result).toMatchObject({ authorizationId: 1, parcels: [{ status: "pending", downloadPath: null }] });
    expect(result).not.toHaveProperty("channelId");
  });
  it("refuses an unowned order before acquiring durable intent or inspecting providers", async () => {
    const s = await setup();
    ports.findOwnedOrder.mockResolvedValue([]);
    await expect(s.services.operations.submit(100, s.input)).rejects.toMatchObject({ code: "CUSTOMER_RETURN_ORDER_UNAVAILABLE" });
    expect(ports.acquire).not.toHaveBeenCalled();
    expect(s.inspectCanonicalForIntake).not.toHaveBeenCalled();
    expect(s.requireEnabled).not.toHaveBeenCalled();
  });
  it("recovers a lost intake response through the saved command without eligibility rechecks or another intake", async () => {
    const s = await setup();
    ports.persist.mockImplementation(async () => { s.markAccepted(); throw new Error("connection dropped after commit"); });
    await expect(s.services.operations.submit(100, s.input)).rejects.toMatchObject({ code: "RETURN_LABEL_SUBMISSION_PROCESSING" });
    s.inspectCanonicalForIntake.mockRejectedValue(new Error("provider now unavailable"));
    const saved = await s.services.operations.submissionStatus(LABEL_KEY);
    expect(saved.authorizationId).toBe(1);
    expect(s.inspectCanonicalForIntake).toHaveBeenCalledTimes(1);
    expect(s.requireEnabled).toHaveBeenCalledTimes(1);
    expect(ports.persist).toHaveBeenCalledTimes(1);
    expect(ports.reject).not.toHaveBeenCalled();
    expect(ports.readOwnedCommand).toHaveBeenCalledExactlyOnceWith({ channelId: 36, externalCustomerId: "123" }, LABEL_KEY);
  });
});
