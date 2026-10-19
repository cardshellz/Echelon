import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";
import { createShipmentInvoiceCommandSchema } from "@shared/procurement/shipment-invoice-command";
import type { FinancialCommandDescriptor, FinancialCommandRepository, FinancialCommandResult } from "../../../../platform/commands/transactional-command.service";
vi.mock("../../../../platform/commands/command-results.repository", () => ({ financialCommandRepository: {} }));
vi.mock("../../ap-ledger.service", () => ({ ApLedgerError: class ApLedgerError extends Error {
  constructor(message: string, public statusCode=400, public details?: Record<string, unknown>) { super(message); }
} }));
import { ApLedgerError, type ApLedgerDbClient } from "../../ap-ledger.service";
import { createShipmentInvoiceCommands, hashShipmentInvoiceCommandIdentity, shipmentInvoiceCommandScope, SHIPMENT_INVOICE_COMMAND_PRINCIPAL } from "../../shipment-invoice.commands";

const actorId="operator-one", key="shipment-invoice-123", now=new Date("2026-09-10T12:00:00Z");
const body={vendorId:6,invoiceNumber:" F-1 ",costRowIds:[31],invoiceDate:"2026-09-10"};
const invoice={id:5,inboundShipmentId:1,vendorId:6,invoiceNumber:"F-1",currency:"USD",invoicedAmountCents:990,lines:[{freightCostId:31}]};
function descriptor(input:unknown=body): FinancialCommandDescriptor {
  return {...shipmentInvoiceCommandScope(),actorType:"service",actorId:SHIPMENT_INVOICE_COMMAND_PRINCIPAL,idempotencyKey:key,contractVersion:1,
    requestHash:hashShipmentInvoiceCommandIdentity({shipmentId:1,body:input,actorId})};
}
function harness() {
  const statements:string[]=[];
  // Only execute is consumed by the boundary. The owner remains a spy; real
  // writes, rollback and constraints are covered by the PostgreSQL suite.
  const tx={execute:vi.fn(async query => {statements.push(new PgDialect().sqlToQuery(query).sql);return {rows:[]};})} as unknown as ApLedgerDbClient;
  const owner={createInvoiceFromShipmentCostsInTransaction:vi.fn(async()=>invoice)};
  const repository:FinancialCommandRepository<ApLedgerDbClient>={
    reserve:vi.fn(async()=>({kind:"claimed" as const,claim:{commandId:1,leaseToken:"lease"}})),
    executeClaim:vi.fn(async(_claim,_descriptor,work)=>({commandId:1,replayed:false,terminalState:"succeeded" as const,...await work(tx)})),
    rejectClaim:vi.fn(async(_claim,_descriptor,failure)=>({commandId:1,replayed:false,terminalState:"rejected" as const,httpStatus:failure.httpStatus,body:failure.body})),
    markRetryable:vi.fn(async()=>undefined),
  };
  return {tx,statements,owner,repository,commands:createShipmentInvoiceCommands(owner,repository,()=>now)};
}
describe("shipment invoice durable command",()=>{
  it("uses one transaction and injected instant, normalizes business input but hashes exact intent",async()=>{
    const h=harness();const result=await h.commands.execute(1,body,actorId,descriptor());
    expect(result).toMatchObject({httpStatus:200,body:{invoiceId:5,shipmentId:1,vendorId:6,invoiceNumber:"F-1",actorId,idempotencyKey:key,costRowIds:[31],totalCents:990}});
    expect(h.statements[0]).toContain("pg_advisory_xact_lock");
    expect(h.owner.createInvoiceFromShipmentCostsInTransaction).toHaveBeenCalledExactlyOnceWith(h.tx,1,{...body,invoiceNumber:"F-1",invoiceDate:new Date("2026-09-10T00:00:00Z"),dueDate:undefined},actorId,now);
  });
  it.each(["actorType","actorId","method","routeTemplate","resourceKey","commandName","contractVersion","idempotencyKey"] as const)("rejects invalid %s before reservation",async field=>{
    const h=harness();await expect(h.commands.execute(1,body,actorId,{...descriptor(),[field]:field==="contractVersion"?2:"bad"} as FinancialCommandDescriptor)).rejects.toMatchObject({code:"SHIPMENT_INVOICE_SCOPE_INVALID"});
    expect(h.repository.reserve).not.toHaveBeenCalled();
  });
  it.each(["", " actor", "x".repeat(101)])("rejects noncanonical actor %j",async actor=>{
    const h=harness();await expect(h.commands.execute(1,body,actor,descriptor())).rejects.toMatchObject({code:"SHIPMENT_INVOICE_ACTOR_REQUIRED"});expect(h.repository.reserve).not.toHaveBeenCalled();
  });
  it.each([{shipmentId:2,body,actorId},{shipmentId:1,body:{...body,invoiceNumber:"F-1"},actorId},{shipmentId:1,body,actorId:"other"}])("binds exact identity %j",async intent=>{
    const h=harness();await expect(h.commands.execute(intent.shipmentId,intent.body,intent.actorId,descriptor())).rejects.toMatchObject({code:"SHIPMENT_INVOICE_IDENTITY_INVALID"});expect(h.repository.reserve).not.toHaveBeenCalled();
  });
  it.each([{...body,costRowIds:[]},{...body,costRowIds:[31,31]},{...body,costRowIds:undefined},{...body,invoiceDate:"2026-02-30"},{...body,vendorId:"6"},{...body,extra:true},{...body,lineOverrides:[{freightCostId:32,qtyInvoiced:1,unitCostCents:2}]}])("durably rejects invalid request %j",async invalid=>{
    const h=harness();expect(await h.commands.execute(1,invalid,actorId,descriptor(invalid))).toMatchObject({httpStatus:400,terminalState:"rejected",body:{commandOutcome:"rejected",shipmentId:1,actorId,idempotencyKey:key}});expect(h.owner.createInvoiceFromShipmentCostsInTransaction).not.toHaveBeenCalled();
  });
  it("keeps business rejection distinct from uncertain infrastructure failure",async()=>{
    const h=harness();h.owner.createInvoiceFromShipmentCostsInTransaction.mockRejectedValueOnce(new ApLedgerError("Source already billed",409,{code:"SOURCE_BILLED"}));
    expect(await h.commands.execute(1,body,actorId,descriptor())).toMatchObject({httpStatus:409,body:{code:"SOURCE_BILLED",commandOutcome:"rejected"}});
    h.owner.createInvoiceFromShipmentCostsInTransaction.mockRejectedValueOnce(new Error("network"));
    await expect(h.commands.execute(1,body,actorId,descriptor())).rejects.toThrow("network");expect(h.repository.markRetryable).toHaveBeenCalledOnce();
  });
  it("does not classify an internal schema failure as a definitive request rejection",async()=>{
    const h=harness();const invalid=z.string().safeParse(2);if(invalid.success)throw new Error("fixture");
    h.owner.createInvoiceFromShipmentCostsInTransaction.mockRejectedValueOnce(invalid.error);await expect(h.commands.execute(1,body,actorId,descriptor())).rejects.toBe(invalid.error);expect(h.repository.rejectClaim).not.toHaveBeenCalled();
  });
  it.each([{id:0},{vendorId:7},{inboundShipmentId:2},{invoiceNumber:"other"},{invoicedAmountCents:0.5},{lines:[{freightCostId:32}]}])("rolls back malformed owner result %j",async patch=>{
    const h=harness();h.owner.createInvoiceFromShipmentCostsInTransaction.mockResolvedValue({...invoice,...patch});await expect(h.commands.execute(1,body,actorId,descriptor())).rejects.toMatchObject({details:{code:"SHIPMENT_INVOICE_RESULT_INVALID"}});expect(h.repository.markRetryable).toHaveBeenCalledOnce();
  });
  it.each([{actorId:"other"},{idempotencyKey:"other-key"},{costRowIds:[32]},{shipmentId:2},{invoiceId:7}])("refuses corrupt durable replay %j",async patch=>{
    const h=harness();const replay:FinancialCommandResult={commandId:1,replayed:true,terminalState:"succeeded",httpStatus:200,body:{...invoice,invoiceId:5,shipmentId:1,actorId,idempotencyKey:key,costRowIds:[31],totalCents:990,...patch}};
    vi.mocked(h.repository.reserve).mockResolvedValue({kind:"replay",result:replay});await expect(h.commands.execute(1,body,actorId,descriptor())).rejects.toMatchObject({code:"SHIPMENT_INVOICE_RESULT_INVALID"});expect(h.owner.createInvoiceFromShipmentCostsInTransaction).not.toHaveBeenCalled();
  });
  it("rejects corrupt rejection identity without dropping the saved intent",async()=>{
    const h=harness();vi.mocked(h.repository.reserve).mockResolvedValue({kind:"replay",result:{commandId:1,replayed:true,terminalState:"rejected",httpStatus:409,body:{code:"NO",error:"Blocked",commandOutcome:"rejected",shipmentId:1,actorId:"other",idempotencyKey:key}}});
    await expect(h.commands.execute(1,body,actorId,descriptor())).rejects.toMatchObject({code:"SHIPMENT_INVOICE_RESULT_INVALID"});
  });
  it("rolls back a result whose total differs from the explicit reviewed lines",async()=>{
    const h=harness();const explicit={...body,lineOverrides:[{freightCostId:31,qtyInvoiced:1,unitCostCents:991}]};
    await expect(h.commands.execute(1,explicit,actorId,descriptor(explicit))).rejects.toMatchObject({details:{code:"SHIPMENT_INVOICE_RESULT_INVALID"}});
    expect(h.repository.markRetryable).toHaveBeenCalledOnce();
  });
  it.each([
    {freightCostId:31,qtyInvoiced:1,unitCostCents:Number.MAX_SAFE_INTEGER},
    {freightCostId:31,qtyInvoiced:2147483647,unitCostMills:Number.MAX_SAFE_INTEGER},
    {freightCostId:31,qtyInvoiced:1,unitCostCents:99,unitCostMills:10000},
  ])("durably rejects nonrepresentable or contradictory explicit money %j",async line=>{
    const h=harness();const invalid={...body,lineOverrides:[line]};
    expect(await h.commands.execute(1,invalid,actorId,descriptor(invalid))).toMatchObject({httpStatus:400,terminalState:"rejected"});
    expect(h.owner.createInvoiceFromShipmentCostsInTransaction).not.toHaveBeenCalled();
  });
  it.each(["2026-02-28","2024-02-29","2026-09-10T12:00:00.000Z","2026-09-10T12:00:00-04:00"])("preserves accepted valid date contract %s",invoiceDate=>expect(createShipmentInvoiceCommandSchema.safeParse({...body,invoiceDate}).success).toBe(true));
});
