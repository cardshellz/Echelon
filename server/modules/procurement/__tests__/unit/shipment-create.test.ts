import { describe, expect, it, vi } from "vitest";
import { shipmentCreateSchema, shipmentCreateResultSchema } from "@shared/procurement/shipment-create-command";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import type { FinancialCommandDescriptor, FinancialCommandRepository } from "../../../../platform/commands/transactional-command.service";
import { createShipmentCreateCommands, shipmentCreateCommandScope, SHIPMENT_CREATE_COMMAND_PRINCIPAL, classifyShipmentCreateFailure } from "../../shipment-create.commands";
import { ShipmentCreateError, type CreatedShipment } from "../../shipment-create.service";
import type { ShipmentCreateTransaction } from "../../shipment-create.repository";
import { nextShipmentNumber, shipmentNumberPrefix, shipmentDefaultAllocation } from "../../domain/shipment-create";

vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: {} }));
const NOW = new Date("2026-10-18T12:00:00.000Z");
const body = { mode: "sea_lcl", notes: "Reviewed shipment" };
function descriptor(input: unknown = body): FinancialCommandDescriptor {
  const scope = shipmentCreateCommandScope();
  return { ...scope, actorType: "service", actorId: SHIPMENT_CREATE_COMMAND_PRINCIPAL, idempotencyKey: "shipment-create-fixture", requestHash: hashHttpFinancialCommand({ ...scope, body: input }), contractVersion: 1 };
}
const created = { id: 7, shipmentNumber: "SHP-20261018-001", status: "draft", createdBy: "operator", createdAt: NOW, updatedAt: NOW, lineCount: 0 } as CreatedShipment;
function fixture() {
  const tx = {} as ShipmentCreateTransaction;
  const repository = {
    reserve: vi.fn().mockResolvedValue({ kind: "claimed", claim: { commandId: 8, leaseToken: "fixture-lease" } }),
    executeClaim: vi.fn(async (_claim, _descriptor, work) => ({ commandId: 8, replayed: false, terminalState: "succeeded", ...await work(tx) })),
    rejectClaim: vi.fn(async (_claim, _descriptor, rejection) => ({ commandId: 8, replayed: false, terminalState: "rejected", httpStatus: rejection.httpStatus, body: rejection.body })),
    markRetryable: vi.fn().mockResolvedValue(undefined),
  };
  const service = { executeCreateShipmentInTransaction: vi.fn().mockResolvedValue(created) };
  const clock = vi.fn(() => NOW);
  const commands = createShipmentCreateCommands(service, repository as FinancialCommandRepository<ShipmentCreateTransaction>, clock);
  return { tx, repository, service, clock, commands };
}

describe("shipment creation reviewed contract", () => {
  it("retains plain header callers and explicit PO quantities without mutating input", () => {
    const input = { ...body, purchaseOrder: { purchaseOrderId: 11, lineSelections: [{ poLineId: 21, qty: 35 }] } };
    const before = structuredClone(input);
    expect(shipmentCreateSchema.parse(input)).toEqual(input);
    expect(input).toEqual(before);
    expect(shipmentCreateSchema.parse(body)).toEqual(body);
  });
  it.each([
    { purchaseOrderId: 11 }, { purchaseOrderId: 11, lineIds: [21] }, { purchaseOrderId: 11, lineSelections: [] },
    { purchaseOrderId: 11, lineSelections: [{ poLineId: 21, qty: 0 }] },
    { purchaseOrderId: 11, lineSelections: [{ poLineId: 21, qty: 2 }, { poLineId: 21, qty: 3 }] },
    { purchaseOrderId: 11, lineSelections: [{ poLineId: 21, qty: 2.5 }] },
    { purchaseOrderId: 11, lineSelections: [{ poLineId: 21, qty: 2_147_483_648 }] },
    { purchaseOrderId: 11, lineSelections: [{ poLineId: 21, qty: 2 }], lineIds: [21] },
  ])("rejects ambiguous or invalid reviewed selection %#", purchaseOrder => {
    expect(shipmentCreateSchema.safeParse({ ...body, purchaseOrder }).success).toBe(false);
  });
  it.each([{ status: "closed" }, { createdBy: "forged" }, { totalPieces: 7 }, { surprise: 1 }])("rejects service-owned header fields %j", extra => {
    expect(shipmentCreateSchema.safeParse({ ...body, ...extra }).success).toBe(false);
  });
  it("validates required recovery identity", () => {
    const wire = JSON.parse(JSON.stringify(created));
    expect(shipmentCreateResultSchema.safeParse(wire).success).toBe(true);
    for (const patch of [{ id: 0 }, { shipmentNumber: "" }, { status: "closed" }, { lineCount: -1 }, { createdAt: "tomorrow" }]) {
      expect(shipmentCreateResultSchema.safeParse({ ...wire, ...patch }).success).toBe(false);
    }
  });
});

describe("durable shipment creation application", () => {
  it("passes the exact original request and transaction to the owner with injected actor/clock", async () => {
    const { commands, repository, service, tx } = fixture();
    const before = structuredClone(body);
    const result = await commands.execute(body, "operator", descriptor());
    expect(result).toMatchObject({ httpStatus: 201, replayed: false, body: { id: 7, lineCount: 0, createdAt: NOW.toISOString() } });
    expect(repository.reserve).toHaveBeenCalledWith(descriptor());
    expect(service.executeCreateShipmentInTransaction).toHaveBeenCalledWith(tx, body, "operator", NOW);
    expect(body).toEqual(before);
  });
  it.each([["actorType", "user"], ["actorId", "operator"], ["method", "PATCH"], ["routeTemplate", "/api/other"], ["resourceKey", "shipment:7"], ["commandName", "procurement.shipment.update"]])("rejects mismatched %s before reservation", async (field, value) => {
    const { commands, repository } = fixture();
    await expect(commands.execute(body, "operator", { ...descriptor(), [field]: value })).rejects.toMatchObject({ code: "SHIPMENT_CREATE_SCOPE_INVALID" });
    expect(repository.reserve).not.toHaveBeenCalled();
  });
  it.each(["", "  ", " operator", "operator ", "x".repeat(101), undefined, 7])("requires the authenticated actor even for replay %#", async actor => {
    const { commands, repository } = fixture();
    await expect(commands.execute(body, actor as string, descriptor())).rejects.toMatchObject({ code: "SHIPMENT_CREATE_ACTOR_REQUIRED" });
    expect(repository.reserve).not.toHaveBeenCalled();
  });
  it("rejects a descriptor that hashes a changed or normalized request", async () => {
    const { commands, repository } = fixture();
    await expect(commands.execute({ ...body, notes: "Changed" }, "operator", descriptor())).rejects.toMatchObject({ code: "SHIPMENT_CREATE_IDENTITY_INVALID" });
    await expect(commands.execute({ shipmentNumber: "  Manual  " }, "operator", descriptor({ shipmentNumber: "Manual" }))).rejects.toMatchObject({ code: "SHIPMENT_CREATE_IDENTITY_INVALID" });
    expect(repository.reserve).not.toHaveBeenCalled();
  });
  it("replays saved success without reading clock, rereading shipment or writing audit", async () => {
    const { commands, repository, service, clock } = fixture();
    const replay = { commandId: 8, replayed: true, terminalState: "succeeded", httpStatus: 201, body: JSON.parse(JSON.stringify(created)) };
    repository.reserve.mockResolvedValue({ kind: "replay", result: replay });
    expect(await commands.execute(body, "delegate", descriptor())).toEqual(replay);
    expect(service.executeCreateShipmentInTransaction).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
  });
  it("durably rejects invalid input without starting the mutation owner", async () => {
    const { commands, repository, service } = fixture();
    const invalid = { ...body, status: "closed" };
    expect(await commands.execute(invalid, "operator", descriptor(invalid))).toMatchObject({ httpStatus: 400, terminalState: "rejected", body: { code: "SHIPMENT_CREATE_INPUT_INVALID" } });
    expect(repository.rejectClaim).toHaveBeenCalledOnce();
    expect(service.executeCreateShipmentInTransaction).not.toHaveBeenCalled();
  });
  it.each([{ id: 0 }, { lineCount: 1 }, { createdBy: "someone-else" }, { status: "closed" }, { createdAt: "invalid" }])("retains malformed output for recovery rather than reporting input rejection %j", async patch => {
    const { commands, repository, service } = fixture();
    service.executeCreateShipmentInTransaction.mockResolvedValue({ ...created, ...patch });
    await expect(commands.execute(body, "operator", descriptor())).rejects.toMatchObject({ code: "SHIPMENT_CREATE_RESULT_INVALID" });
    expect(repository.markRetryable).toHaveBeenCalledOnce();
    expect(repository.rejectClaim).not.toHaveBeenCalled();
  });
  it("checks returned manual number and exact selected line count", async () => {
    const { commands, service } = fixture();
    const manual = { shipmentNumber: "MANUAL" };
    await expect(commands.execute(manual, "operator", descriptor(manual))).rejects.toMatchObject({ code: "SHIPMENT_CREATE_RESULT_INVALID" });
    const selected = { purchaseOrder: { purchaseOrderId: 11, lineSelections: [{ poLineId: 21, qty: 35 }] } };
    await expect(commands.execute(selected, "operator", descriptor(selected))).rejects.toMatchObject({ code: "SHIPMENT_CREATE_RESULT_INVALID" });
    service.executeCreateShipmentInTransaction.mockResolvedValue({ ...created, lineCount: 1 });
    expect(await commands.execute(selected, "operator", descriptor(selected))).toMatchObject({ httpStatus: 201, body: { lineCount: 1 } });
  });
  it("durably rejects exhausted automatic numbering instead of retaining an impossible retry", async () => {
    const { commands, service, repository } = fixture();
    service.executeCreateShipmentInTransaction.mockImplementation(async () => {
      return { ...created, shipmentNumber: nextShipmentNumber(shipmentNumberPrefix(NOW), "99999999999999999") };
    });
    expect(await commands.execute(body, "operator", descriptor())).toMatchObject({
      httpStatus: 409, terminalState: "rejected",
      body: { code: "SHIPMENT_CREATE_NUMBER_EXHAUSTED", error: expect.stringContaining("Choose a manual shipment number") },
    });
    expect(repository.rejectClaim).toHaveBeenCalledOnce();
    expect(repository.markRetryable).not.toHaveBeenCalled();
  });
  it("does not classify unrelated audit or ledger constraints as duplicate shipment input", () => {
    expect(classifyShipmentCreateFailure({ code: "23505", constraint: "inbound_shipments_shipment_number_active_uidx" })).toMatchObject({ kind: "rejected", httpStatus: 409, errorCode: "SHIPMENT_CREATE_NUMBER_CONFLICT" });
    expect(classifyShipmentCreateFailure({ code: "23505", constraint: "audit_event_constraint" })).toMatchObject({ kind: "retryable" });
    expect(classifyShipmentCreateFailure({ code: "23514", schema: "public", table: "audit_events" })).toMatchObject({ kind: "retryable" });
    expect(classifyShipmentCreateFailure(new ShipmentCreateError("CAPACITY", "Selection changed", 409))).toMatchObject({ kind: "rejected", httpStatus: 409, errorCode: "CAPACITY" });
  });
});

describe("deterministic shipment number allocation", () => {
  it("uses the injected UTC date and numeric suffix across 999/1000", () => {
    const prefix = shipmentNumberPrefix(NOW);
    expect(prefix).toBe("SHP-20261018-");
    expect(nextShipmentNumber(prefix, null)).toBe("SHP-20261018-001");
    expect(nextShipmentNumber(prefix, "999")).toBe("SHP-20261018-1000");
    expect(nextShipmentNumber(prefix, "1000")).toBe("SHP-20261018-1001");
    expect(nextShipmentNumber(prefix, "9007199254740993")).toBe("SHP-20261018-9007199254740994");
    expect(nextShipmentNumber(prefix, "99999999999999998")).toBe("SHP-20261018-99999999999999999");
  });
  it.each(["-1", "1.5", "1e3", "NaN", "", "999999999999999999"])("rejects invalid or exhausted numbering evidence %s", suffix => {
    expect(() => nextShipmentNumber(shipmentNumberPrefix(NOW), suffix)).toThrow();
  });
  it("rejects an invalid injected clock", () => {
    expect(() => shipmentNumberPrefix(new Date("invalid"))).toThrow();
  });
  it("retains existing mode allocation policy", () => {
    expect(shipmentDefaultAllocation("air")).toBe("by_chargeable_weight");
    expect(shipmentDefaultAllocation("ground")).toBe("by_weight");
    expect(shipmentDefaultAllocation("sea_fcl")).toBe("by_volume");
    expect(shipmentDefaultAllocation("ocean")).toBe("by_volume");
    expect(shipmentDefaultAllocation(undefined)).toBe("by_volume");
  });
});
