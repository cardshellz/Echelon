import { afterEach, describe, expect, it, vi } from "vitest";
import { createApPaymentCommandClient, createApPaymentRecoveryStore, formatPaymentAmount, parsePaymentAmount, paymentAllocationInputs, recordPaymentInputSchema, sumPaymentCents, type ApPaymentCommand } from "../../ap-payment-command";

const version = "a".repeat(64);
const apply: ApPaymentCommand = { operation: "apply_payment", paymentId: 7, vendorId: 2, paymentTotalAmountCents: 10000, reviewedUnappliedAmountCents: 7000, payload: { expectedVersion: version, reason: "Apply supplier deposit", allocations: [{ vendorInvoiceId: 21, appliedAmountCents: 2500 }] } };
const record: ApPaymentCommand = { operation: "record_payment", originInvoiceId: 21, payload: { vendorId: 2, totalAmountCents: 2500, paymentDate: "2026-10-19", paymentMethod: "ach", allocations: [{ vendorInvoiceId: 21, appliedAmountCents: 2500 }] } };
const voidCommand: ApPaymentCommand = { operation: "void_payment", paymentId: 7, payload: { reason: "Wrong payment" } };
function storage() { const map = new Map<string,string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key,value); }, removeItem: (key: string) => { map.delete(key); } }; }
function setup() { const memory = storage(); const store = createApPaymentRecoveryStore(() => memory, "buyer"); let serial = 0; return { memory, store, client: createApPaymentCommandClient(() => `payment-key-${++serial}`,store) }; }
function reply(command: ApPaymentCommand, key = "payment-key-1") {
  const common = { command: command.operation, actorId: "buyer", idempotencyKey: key, paymentId: 7 };
  if (command.operation === "void_payment") return { ...common, ok: true, status: "voided" };
  const applied = command.payload.allocations.reduce((sum,row) => sum + row.appliedAmountCents,0);
  const remaining = command.operation === "apply_payment" ? command.reviewedUnappliedAmountCents - applied : command.payload.totalAmountCents - applied;
  const paymentBalance = { state: remaining > 0 ? "available" : "fully_applied", appliedAmountCents: command.operation === "apply_payment" ? command.paymentTotalAmountCents - remaining : applied, unappliedAmountCents: remaining, version: "b".repeat(64), issue: null };
  const applications = command.payload.allocations.map((row,index) => ({ ...row, allocationId: index+1 }));
  if (command.operation === "record_payment") return { ...common, id: 7, vendorId: 2, totalAmountCents: command.payload.totalAmountCents, currency: "USD", status: "completed", paymentDate: "2026-10-19T00:00:00.000Z", paymentCalendarDate: "2026-10-19", paymentDateSource: "recorded_calendar_date", paymentMethod: "ach", referenceNumber: null, checkNumber: null, bankAccountLabel: null, notes: null, applications, paymentBalance };
  return { ...common, applications, paymentBalance, apLedgerOutcome: { command: "apply_payment", entityType: "payment", entityId: 7, affectedInvoiceIds: command.payload.allocations.map(row => row.vendorInvoiceId), affectedPaymentIds: [7], affectedPurchaseOrderIds: [], message: "Applied existing payment." } };
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
afterEach(() => vi.unstubAllGlobals());

describe("persistent payment command recovery", () => {
  it.each([record,apply,voidCommand])("validates and clears the confirmed $operation receipt", async command => {
    const { client, store } = setup(); const fetch = vi.fn(async (_url: string, _init: RequestInit) => json(reply(command))); vi.stubGlobal("fetch",fetch);
    await client.execute(command); expect(store.read()).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(command.payload);
  });
  it.each([record,apply,voidCommand])("restores exact $operation after navigation and session expiry", async command => {
    const { client,store,memory } = setup(); const requests: RequestInit[] = [];
    vi.stubGlobal("fetch",vi.fn(async (_url: string, init: RequestInit) => { requests.push(init); throw new Error("lost"); }));
    await expect(client.execute(command)).rejects.toThrow(); const saved = store.read()!;
    const restoredStore = createApPaymentRecoveryStore(() => memory,"buyer");
    const restored = createApPaymentCommandClient(() => "replacement-key",restoredStore);
    vi.stubGlobal("fetch",vi.fn(async (_url: string, init: RequestInit) => { requests.push(init); return json({error:"Sign in"},401); }));
    await expect(restored.execute(saved.body,saved)).rejects.toThrow("Sign in"); expect(restoredStore.read()).toEqual(saved);
    vi.stubGlobal("fetch",vi.fn(async (_url: string, init: RequestInit) => { requests.push(init); return json(reply(command)); }));
    await restored.execute(saved.body,saved); expect(restoredStore.read()).toBeNull();
    expect(requests.every(request => (request.headers as Record<string,string>)["Idempotency-Key"] === saved.key && request.body === JSON.stringify(saved.body.payload))).toBe(true);
  });
  it.each([403,409,429,500])("retains the original request after nonterminal HTTP %s", async status => {
    const { client,store }=setup(); vi.stubGlobal("fetch",vi.fn(async()=>json({error:"Denied"},status))); await expect(client.execute(apply)).rejects.toThrow(); expect(store.read()?.body).toEqual(apply);
  });
  it("does not allow record or void to replace an unresolved application",async()=>{
    const {client,store}=setup(); store.acquire(apply,()=>"original-key"); const fetch=vi.fn(); vi.stubGlobal("fetch",fetch);
    for(const command of [record,voidCommand]) await expect(client.execute(command)).rejects.toThrow("unresolved");
    expect(fetch).not.toHaveBeenCalled();expect(store.read()?.body).toEqual(apply);
  });
  it("isolates operators and rejects a pinned request from another actor",async()=>{
    const {client,store,memory}=setup(); const saved=store.acquire(apply,()=>"original-key"); const second=createApPaymentRecoveryStore(()=>memory,"other"); expect(() => second.read()).toThrow("another operator");
    await expect(createApPaymentCommandClient(()=>"new-key",second).execute(apply,saved)).rejects.toThrow("another operator"); expect(store.read()).toEqual(saved);
    await expect(client.execute({...apply,payload:{...apply.payload,reason:"changed"}},saved)).rejects.toThrow("another operator or command");
    for (const command of [record,apply,voidCommand]) await expect(createApPaymentCommandClient(()=>"replacement-key",second).execute(command)).rejects.toThrow("another operator");
    expect(store.read()).toEqual(saved);
  });
  it("clears only a matching durable business rejection",async()=>{
    const {client,store}=setup(); vi.stubGlobal("fetch",vi.fn(async()=>json({error:"Stale balance",details:{paymentCommandOutcome:"rejected",idempotencyKey:"payment-key-1",actorId:"buyer",command:"apply_payment"}},409)));
    await expect(client.execute(apply)).rejects.toThrow("Stale balance");expect(store.read()).toBeNull();
  });
  it("retains a matching rejection-shaped HTTP 503 as unresolved",async()=>{
    const {client,store}=setup();vi.stubGlobal("fetch",vi.fn(async()=>json({error:"Unknown",details:{paymentCommandOutcome:"rejected",idempotencyKey:"payment-key-1",actorId:"buyer",command:"apply_payment"}},503)));
    await expect(client.execute(apply)).rejects.toThrow();expect(store.read()).not.toBeNull();
  });
  it.each([{actorId:"other"},{idempotencyKey:"other-key"},{command:"record_payment"},{paymentCommandOutcome:"pending"}])("retains mismatched rejection proof %j",async mismatch=>{
    const {client,store}=setup();vi.stubGlobal("fetch",vi.fn(async()=>json({error:"Rejected",details:{paymentCommandOutcome:"rejected",idempotencyKey:"payment-key-1",actorId:"buyer",command:"apply_payment",...mismatch}},409)));
    await expect(client.execute(apply)).rejects.toThrow();expect(store.read()).not.toBeNull();
  });
  it.each([{actorId:"other"},{idempotencyKey:"other-key"},{paymentId:99},{applications:[{allocationId:1,vendorInvoiceId:22,appliedAmountCents:2500}]},{applications:[{allocationId:1,vendorInvoiceId:21,appliedAmountCents:2499}]},{paymentBalance:{state:"available",appliedAmountCents:5501,unappliedAmountCents:4499,version,issue:null}}])("retains an unverified successful application %j",async mismatch=>{
    const {client,store}=setup();vi.stubGlobal("fetch",vi.fn(async()=>json({...reply(apply),...mismatch})));
    await expect(client.execute(apply)).rejects.toThrow("could not be verified");expect(store.read()).not.toBeNull();
  });
  it.each([{vendorId:3},{totalAmountCents:2600},{paymentCalendarDate:"2026-10-18"},{paymentDateSource:"legacy_timestamp"},{paymentMethod:"check"},{referenceNumber:"other"}])("retains unverified recorded cash receipt %j",async mismatch=>{
    const {client,store}=setup();vi.stubGlobal("fetch",vi.fn(async()=>json({...reply(record),...mismatch})));
    await expect(client.execute(record)).rejects.toThrow("could not be verified");expect(store.read()).not.toBeNull();
  });
  it.each([record, { ...apply, reviewedUnappliedAmountCents: 2500 }])("retains a contradictory voided balance on a successful $operation receipt", async command => {
    const {client,store}=setup();const result=reply(command);
    if (!("paymentBalance" in result)) throw Error("fixture");
    vi.stubGlobal("fetch",vi.fn(async()=>json({...result,paymentBalance:{...result.paymentBalance,state:"voided"}})));
    await expect(client.execute(command)).rejects.toThrow("could not be verified");expect(store.read()).not.toBeNull();
  });
  it("does not send when storage cannot persist recovery",async()=>{
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);const store=createApPaymentRecoveryStore(()=>({getItem:()=>null,setItem:()=>{throw Error("full");},removeItem:()=>undefined}),"buyer");
    await expect(createApPaymentCommandClient(()=>"original-key",store).execute(record)).rejects.toThrow("not sent");expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects application beyond the reviewed balance before saving or sending",async()=>{
    const {client,store}=setup();const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    await expect(client.execute({...apply,reviewedUnappliedAmountCents:2400})).rejects.toThrow("exceeds");expect(store.read()).toBeNull();expect(fetch).not.toHaveBeenCalled();
  });
});
describe("exact payment amount input",()=>{
  it.each([["0",0],[".01",1],["0.29",29],["100.10",10010],["90071992547409.91",Number.MAX_SAFE_INTEGER]])("parses %s exactly",(input,cents)=>expect(parsePaymentAmount(input as string)).toBe(cents));
  it.each(["", "-1", "1.001", "1e3", "Infinity", "1,000", "1x", "90071992547409.92"])("rejects %s without truncation",input=>expect(()=>parsePaymentAmount(input)).toThrow());
  it("retains exact cents across pages and never rounds allocation totals",()=>{expect(paymentAllocationInputs({21:".10",22:".20",23:"",24:"0"})).toEqual([{vendorInvoiceId:21,appliedAmountCents:10},{vendorInvoiceId:22,appliedAmountCents:20}]);expect(sumPaymentCents([10,20])).toBe(30);expect(formatPaymentAmount(100010)).toBe("$1,000.10");expect(formatPaymentAmount(null)).toBe("Unavailable");});
  it.each([0.5, Number.MAX_SAFE_INTEGER+1, NaN, Infinity])("classifies invalid cents %s without throwing from schema validation",value=>{
    expect(()=>recordPaymentInputSchema.safeParse({...record.payload,totalAmountCents:value})).not.toThrow();
    expect(recordPaymentInputSchema.safeParse({...record.payload,allocations:[{vendorInvoiceId:21,appliedAmountCents:value}]}).success).toBe(false);
  });
  it("rejects unsafe aggregates and duplicate/overapplied record inputs",()=>{
    expect(()=>sumPaymentCents([Number.MAX_SAFE_INTEGER,1])).toThrow();if(record.operation!=="record_payment")throw Error("fixture");
    expect(recordPaymentInputSchema.safeParse({...record.payload,allocations:[{vendorInvoiceId:21,appliedAmountCents:Number.MAX_SAFE_INTEGER},{vendorInvoiceId:22,appliedAmountCents:1}]}).success).toBe(false);
    expect(recordPaymentInputSchema.safeParse({...record.payload,allocations:[{vendorInvoiceId:21,appliedAmountCents:1},{vendorInvoiceId:21,appliedAmountCents:1}]}).success).toBe(false);
  });
});
