import { describe, expect, it, vi } from "vitest";
import type { InboundFreightCost } from "@shared/schema";
import { shipmentCostCreateSchema } from "@shared/procurement/shipment-cost-command";
import { shipmentCostVersion, versionShipmentCost } from "../../shipment-cost-version";
import { ShipmentTrackingError } from "../../shipment-tracking.service";
import {
  classifyShipmentCostCommandFailure, createShipmentCostCommands,
  shipmentCostCommandScope, SHIPMENT_COST_COMMAND_PRINCIPAL, type ShipmentCostCommand,
} from "../../shipment-cost-commands";
import type { FinancialCommandDescriptor, FinancialCommandRepository } from "../../../../platform/commands/transactional-command.service";

vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: {} }));

const NOW = new Date("2026-09-06T12:00:00.000Z");
const command: ShipmentCostCommand = { operation: "create", resourceId: 7, body: { costType: "freight", actualCents: 100 } };
const descriptor: FinancialCommandDescriptor = {
  ...shipmentCostCommandScope(command), actorType: "service", actorId: SHIPMENT_COST_COMMAND_PRINCIPAL,
  idempotencyKey: "fixture-cost-command", requestHash: "a".repeat(64), contractVersion: 1,
};

function fixture() {
  const tx = { name: "reserved-command-transaction" };
  const repository = {
    reserve: vi.fn().mockResolvedValue({ kind: "claimed", claim: { commandId: 1, leaseToken: "fixture-lease" } }),
    executeClaim: vi.fn(async (_claim, _descriptor, work) => ({
      commandId: 1, replayed: false, terminalState: "succeeded", ...await work(tx),
    })),
    rejectClaim: vi.fn(async (_claim, _descriptor, rejection) => ({
      commandId: 1, replayed: false, terminalState: "rejected", httpStatus: rejection.httpStatus, body: rejection.body,
    })),
    markRetryable: vi.fn().mockResolvedValue(undefined),
  };
  const service = { executeCostCommandInTransaction: vi.fn().mockResolvedValue({ id: 31 }) };
  const clock = vi.fn(() => NOW);
  const api = createShipmentCostCommands(service, repository as FinancialCommandRepository<typeof tx>, clock);
  return { api, repository, service, clock, tx };
}

describe("shipment cost application command boundary", () => {
  it("passes the transaction, authenticated actor, and injected clock to the domain", async () => {
    const { api, repository, service, tx } = fixture();
    const bodyBefore = structuredClone(command);
    const result = await api.execute(command, "owner-1", descriptor);
    expect(result).toMatchObject({ httpStatus: 201, body: { id: 31 }, replayed: false });
    expect(service.executeCostCommandInTransaction).toHaveBeenCalledWith(tx, command, "owner-1", NOW);
    expect(repository.reserve).toHaveBeenCalledWith(descriptor);
    expect(command).toEqual(bodyBefore);
  });

  it.each([
    ["actorType", "user"], ["actorId", "owner-1"], ["method", "DELETE"],
    ["routeTemplate", "/api/another-owner/:id"], ["resourceKey", "shipment:8"],
    ["commandName", "procurement.shipment_cost.delete"],
  ])("rejects mismatched %s before reservation", async (field, value) => {
    const { api, repository, service } = fixture();
    await expect(api.execute(command, "owner-1", { ...descriptor, [field]: value })).rejects.toMatchObject({ code: "SHIPMENT_COST_SCOPE_INVALID" });
    expect(repository.reserve).not.toHaveBeenCalled();
    expect(service.executeCostCommandInTransaction).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER, Number.NaN])("rejects invalid database ID %s before reservation", async (resourceId) => {
    const { api, repository } = fixture();
    await expect(api.execute({ ...command, resourceId }, "owner-1", descriptor)).rejects.toMatchObject({ code: "SHIPMENT_COST_ID_INVALID", statusCode: 400 });
    expect(repository.reserve).not.toHaveBeenCalled();
  });

  it.each(["", "   ", undefined, 7])("requires an authenticated human even for a possible replay: %s", async (actor) => {
    const { api, repository } = fixture();
    await expect(api.execute(command, actor as string, descriptor)).rejects.toMatchObject({ code: "SHIPMENT_COST_ACTOR_REQUIRED", statusCode: 401 });
    expect(repository.reserve).not.toHaveBeenCalled();
  });

  it("returns a stored result without redoing the domain or reading a new clock", async () => {
    const { api, repository, service, clock } = fixture();
    const replay = { commandId: 17, replayed: true, terminalState: "succeeded", httpStatus: 201, body: { id: 31, actualCents: 100 } };
    repository.reserve.mockResolvedValue({ kind: "replay", result: replay });
    expect(await api.execute(command, "delegate-2", descriptor)).toEqual(replay);
    expect(service.executeCostCommandInTransaction).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
  });

  it("records a definitive domain rejection instead of marking it retryable", async () => {
    const { api, repository, service } = fixture();
    service.executeCostCommandInTransaction.mockRejectedValue(new ShipmentTrackingError("Cost changed", 409, { code: "SHIPMENT_COST_VERSION_CONFLICT" }));
    expect(await api.execute(command, "owner-1", descriptor)).toMatchObject({ httpStatus: 409, terminalState: "rejected", body: { code: "SHIPMENT_COST_VERSION_CONFLICT" } });
    expect(repository.rejectClaim).toHaveBeenCalledOnce();
    expect(repository.markRetryable).not.toHaveBeenCalled();
  });

  it("keeps an unexpected transaction failure retryable and propagates it", async () => {
    const { api, repository, service } = fixture();
    const failure = new Error("fixture database unavailable");
    service.executeCostCommandInTransaction.mockRejectedValue(failure);
    await expect(api.execute(command, "owner-1", descriptor)).rejects.toBe(failure);
    expect(repository.markRetryable).toHaveBeenCalledOnce();
    expect(repository.rejectClaim).not.toHaveBeenCalled();
  });

  it("classifies invalid inputs without forwarding database exception details", () => {
    const invalid = shipmentCostCreateSchema.safeParse({ costType: "freight", vendorInvoiceId: 7 });
    if (invalid.success) throw new Error("Expected strict schema rejection");
    expect(classifyShipmentCostCommandFailure(invalid.error)).toMatchObject({ kind: "rejected", httpStatus: 400, errorCode: "SHIPMENT_COST_INPUT_INVALID" });
    const failure = new Error("private SQL data", { cause: { code: "23503", schema: "procurement", table: "inbound_freight_costs", detail: "private record" } });
    const result = classifyShipmentCostCommandFailure(failure);
    expect(result).toMatchObject({ kind: "rejected", httpStatus: 422, errorCode: "SHIPMENT_COST_REFERENCE_INVALID" });
    expect(JSON.stringify(result)).not.toMatch(/private/);
    expect(classifyShipmentCostCommandFailure(new Error("Audit failure", { cause: { code: "23514", schema: "public", table: "audit_events" } }))).toMatchObject({ kind: "retryable", errorCode: "SHIPMENT_COST_TRANSIENT_FAILURE" });
  });
});

const recordedCost: InboundFreightCost = {
  id: 31, inboundShipmentId: 7, costType: "freight", description: null,
  estimatedCents: 100, actualCents: null, currency: "USD", exchangeRate: "1.0000",
  allocationMethod: null, costStatus: "estimated", invoiceNumber: null, invoiceDate: null,
  dueDate: null, paidDate: null, performedByName: null, vendorId: null,
  vendorInvoiceId: null, notes: null, createdAt: NOW, updatedAt: NOW,
};

describe("shipment cost content versions", () => {
  it("uses only stored evidence and preserves enriched fields", () => {
    const enriched = { ...recordedCost, vendorName: "Fixture supplier", invoiceDisplay: "Fixture invoice" };
    const result = versionShipmentCost(enriched, true);
    expect(result).toMatchObject({ vendorName: "Fixture supplier", hasInvoiceSourceReference: true });
    expect(result.version).toBe(shipmentCostVersion(recordedCost));
    expect(result.version).toMatch(/^[a-f0-9]{64}$/);
    expect(enriched).not.toHaveProperty("version");
  });

  it.each([
    ["actualCents", 0], ["estimatedCents", -100], ["vendorInvoiceId", 19],
    ["vendorId", 23], ["invoiceNumber", "INV-fixture"], ["notes", "Corrected"],
    ["costStatus", "paid"], ["exchangeRate", "0.9000"], ["currency", "EUR"],
    ["paidDate", new Date("2026-09-07T00:00:00.000Z")],
  ])("detects a change to %s even with an unchanged updatedAt", (field, value) => {
    expect(shipmentCostVersion({ ...recordedCost, [field]: value })).not.toBe(shipmentCostVersion(recordedCost));
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("fails closed on inexact recorded cents %s", (actualCents) => {
    expect(() => shipmentCostVersion({ ...recordedCost, actualCents })).toThrow(/safe integer cents/);
  });
});
