import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupplierCreditClient, createSupplierCreditRecoveryStore, type SupplierCreditIntent } from "../../supplier-credit-command";
import { supplierCreditFixture, creditAllowed, creditDenied, creditVersion } from "../../../../../test/fixtures/supplier-credit";

const create: SupplierCreditIntent = {command:"create",payload:{sourceInvoiceId:71,expectedSourceVersion:creditVersion,supplierReference:"CN-100",creditCalendarDate:"2026-10-19",reason:"Supplier price reduction",lines:[{invoiceLineId:701,amountCents:10000,disposition:{kind:"price_reduction",component:"product"}}]}};
const review = {expectedVersion:creditVersion,reason:"Reviewed supplier document"};
const approve: SupplierCreditIntent = {command:"approve",creditId:9,payload:review};
const apply: SupplierCreditIntent = {command:"apply",creditId:9,payload:{...review,allocations:[{vendorInvoiceId:71,appliedAmountCents:2500}]}};
const reverse: SupplierCreditIntent = {command:"reverse",creditId:9,applicationId:31,payload:review};
const voided: SupplierCreditIntent = {command:"void",creditId:9,payload:review};
const reconcile: SupplierCreditIntent = {command:"reconcile_costs",creditId:9,payload:review};
const commands = [create,approve,apply,reverse,voided,reconcile];
function storage(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
function setup(){const memory=storage();const store=createSupplierCreditRecoveryStore(()=>memory,"ap-reader");return {memory,store,client:createSupplierCreditClient(()=>"credit-key-1",store)};}
function reply(intent:SupplierCreditIntent){
 const credit=supplierCreditFixture();
 if(intent.command==="create"){credit.status="draft";credit.balanceState="draft";credit.unappliedAmountCents=0;credit.lines=intent.payload.lines.map((line,index)=>({...line,id:index+1,label:"Toploader cases",sourceEvidence:{},costState:"pending",costIssues:[]}));credit.totalAmountCents=intent.payload.lines.reduce((sum,line)=>sum+line.amountCents,0);credit.replacesCreditId=intent.payload.replacesCreditId??null;}
 if(intent.command==="apply"||intent.command==="reverse"){
  credit.applications=[{id:31,vendorInvoiceId:71,invoiceNumber:"INV-71",appliedAmountCents:2500,actorId:"ap-reader",recordedAt:"2026-10-19T16:00:00.000Z",reason:review.reason,reversal:intent.command==="reverse"?{id:51,actorId:"ap-reader",recordedAt:"2026-10-19T17:00:00.000Z",reason:review.reason}:null,canReverse:intent.command==="reverse"?creditDenied:creditAllowed}];
  credit.appliedAmountCents=intent.command==="apply"?2500:0;credit.unappliedAmountCents=10000-credit.appliedAmountCents;
 }
 if(intent.command==="void"){credit.status="voided";credit.balanceState="voided";credit.unappliedAmountCents=0;credit.voidedBy="ap-reader";credit.voidReason=intent.payload.reason;}
 return {command:intent.command,actorId:"ap-reader",idempotencyKey:"credit-key-1",creditId:9,request:intent.payload,applicationIds:intent.command==="apply"?[31]:[],reversedApplicationId:intent.command==="reverse"?31:null,credit};
}
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
afterEach(()=>vi.unstubAllGlobals());
describe("supplier credit persisted command evidence",()=>{
 it.each(commands)("confirms exact $command result",async intent=>{const{client,store}=setup();const fetch=vi.fn(async()=>json(reply(intent)));vi.stubGlobal("fetch",fetch);await client.execute(intent);expect(store.read()).toBeNull();expect(fetch).toHaveBeenCalledTimes(1);});
 it.each(commands)("recovers $command after a lost response and session expiry",async intent=>{
  const{client,store,memory}=setup();const requests:RequestInit[]=[];
  vi.stubGlobal("fetch",vi.fn(async(_url:string,init:RequestInit)=>{requests.push(init);throw Error("lost");}));await expect(client.execute(intent)).rejects.toThrow();const saved=store.read()!;
  const restored=createSupplierCreditRecoveryStore(()=>memory,"ap-reader");const recovery=createSupplierCreditClient(()=>"replacement-key",restored);
  vi.stubGlobal("fetch",vi.fn(async(_url:string,init:RequestInit)=>{requests.push(init);return json({error:"Expired"},401);}));await expect(recovery.execute(saved.body,saved)).rejects.toThrow("Expired");expect(restored.read()).toEqual(saved);
  vi.stubGlobal("fetch",vi.fn(async(_url:string,init:RequestInit)=>{requests.push(init);return json(reply(intent));}));await recovery.execute(saved.body,saved);expect(restored.read()).toBeNull();expect(requests.every(request=>request.body===JSON.stringify(intent.payload)&&(request.headers as Record<string,string>)["Idempotency-Key"]===saved.key)).toBe(true);
 });
 it.each(commands)("blocks another actor from replacing saved $command",async intent=>{const{store,memory}=setup();store.acquire(intent,()=>"credit-key-1");const other=createSupplierCreditRecoveryStore(()=>memory,"other");const fetch=vi.fn();vi.stubGlobal("fetch",fetch);for(const command of commands)await expect(createSupplierCreditClient(()=>"replacement-key",other).execute(command)).rejects.toThrow("another operator");expect(fetch).not.toHaveBeenCalled();});
 it.each([401,403,409,429,500,503])("retains nonterminal HTTP%s",async status=>{const{client,store}=setup();vi.stubGlobal("fetch",vi.fn(async()=>json({error:"Failure"},status)));await expect(client.execute(apply)).rejects.toThrow();expect(store.read()).not.toBeNull();});
 it.each([409,503])("only durable 4xx rejection clears; HTTP%s",async status=>{const{client,store}=setup();vi.stubGlobal("fetch",vi.fn(async()=>json({error:"Rejected",details:{creditCommandOutcome:"rejected",command:"apply",actorId:"ap-reader",idempotencyKey:"credit-key-1"}},status)));await expect(client.execute(apply)).rejects.toThrow();expect(store.read()===null).toBe(status===409);});
 it.each([{actorId:"other"},{creditId:99},{idempotencyKey:"wrong-key"},{request:{...review,allocations:[{vendorInvoiceId:99,appliedAmountCents:2500}]}},{applicationIds:[31,31]},{applicationIds:[31,99]},{reversedApplicationId:51}])("retains mismatched success %j",async mismatch=>{const{client,store}=setup();vi.stubGlobal("fetch",vi.fn(async()=>json({...reply(apply),...mismatch})));await expect(client.execute(apply)).rejects.toThrow("could not be verified");expect(store.read()).not.toBeNull();});
 it("retains a reverse receipt for a different application",async()=>{const{client,store}=setup();vi.stubGlobal("fetch",vi.fn(async()=>json({...reply(reverse),reversedApplicationId:99})));await expect(client.execute(reverse)).rejects.toThrow();expect(store.read()).not.toBeNull();});
 it("retains a created credit with changed economics",async()=>{const{client,store}=setup();const result=reply(create);result.credit.totalAmountCents=9999;vi.stubGlobal("fetch",vi.fn(async()=>json(result)));await expect(client.execute(create)).rejects.toThrow();expect(store.read()).not.toBeNull();});
 it("supports product and packaging on the same source line and checks duplicate treatments",async()=>{const{client}=setup();const intent:SupplierCreditIntent={...create,payload:{...create.payload,lines:[{invoiceLineId:701,amountCents:5000,disposition:{kind:"price_reduction",component:"product"}},{invoiceLineId:701,amountCents:5000,disposition:{kind:"price_reduction",component:"packaging"}}]}};vi.stubGlobal("fetch",vi.fn(async()=>json(reply(intent))));await client.execute(intent);await expect(client.execute({...intent,payload:{...intent.payload,lines:[intent.payload.lines[0],intent.payload.lines[0]]}})).rejects.toThrow("only once");});
 it("blocks requests if durable storage cannot be saved",async()=>{const fetch=vi.fn();vi.stubGlobal("fetch",fetch);const store=createSupplierCreditRecoveryStore(()=>({getItem:()=>null,setItem:()=>{throw Error("full");},removeItem:()=>undefined}),"ap-reader");await expect(createSupplierCreditClient(()=>"credit-key-1",store).execute(create)).rejects.toThrow("not sent");expect(fetch).not.toHaveBeenCalled();});
 it.each([0.1,Number.MAX_SAFE_INTEGER+1,NaN,Infinity])("rejects invalid cents %s before sending",async value=>{const{client}=setup();const fetch=vi.fn();vi.stubGlobal("fetch",fetch);await expect(client.execute({...apply,payload:{...apply.payload,allocations:[{vendorInvoiceId:71,appliedAmountCents:value}]}})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();});
});

describe("supplier credit cost recheck command", () => {
 it("uses the approved credit cost endpoint without creating an invoice application", async () => {
  const {client,store}=setup(); const fetch=vi.fn(async(_url:string,_init?:RequestInit)=>json(reply(reconcile))); vi.stubGlobal("fetch",fetch);
  const result=await client.execute(reconcile);
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/supplier-credits/9/reconcile_costs");
  expect(result.applicationIds).toEqual([]); expect(result.reversedApplicationId).toBeNull(); expect(store.read()).toBeNull();
 });
 it.each(["draft","voided"])("retains a cost recheck result claiming %s instead of approved", async status => {
  const {client,store}=setup(); const result=reply(reconcile);
  Object.assign(result.credit,{status,balanceState:status,unappliedAmountCents:0});
  vi.stubGlobal("fetch",vi.fn(async()=>json(result)));
  await expect(client.execute(reconcile)).rejects.toThrow("could not be verified"); expect(store.read()).not.toBeNull();
 });
 it.each([{applicationIds:[31]},{reversedApplicationId:31},{command:"approve"},{creditId:10}])("retains a mismatched cost recheck result %j", async mismatch => {
  const {client,store}=setup(); vi.stubGlobal("fetch",vi.fn(async()=>json({...reply(reconcile),...mismatch})));
  await expect(client.execute(reconcile)).rejects.toThrow("could not be verified"); expect(store.read()).not.toBeNull();
 });
});

describe("cost recheck response balance integrity", () => {
 it.each([
  {balanceState:"draft"}, {balanceState:"voided"}, {balanceState:"review_required"},
  {appliedAmountCents:null}, {unappliedAmountCents:null},
  {balanceIssues:[{code:"CREDIT_BALANCE_REVIEW",message:"Credit ledger requires review."}]},
  {appliedAmountCents:10000,unappliedAmountCents:0,balanceState:"available"},
  {balanceState:"fully_applied"},
 ])("retains recovery for inconsistent balance evidence %j",async mismatch=>{
  const {client,store}=setup(); const result=reply(reconcile); Object.assign(result.credit,mismatch);
  vi.stubGlobal("fetch",vi.fn(async()=>json(result)));
  await expect(client.execute(reconcile)).rejects.toThrow("could not be verified"); expect(store.read()).not.toBeNull();
 });
 it("accepts a verified fully-applied credit without inventing new availability",async()=>{
  const {client,store}=setup(); const result=reply(reconcile);
  Object.assign(result.credit,{appliedAmountCents:10000,unappliedAmountCents:0,balanceState:"fully_applied"});
  vi.stubGlobal("fetch",vi.fn(async()=>json(result)));
  expect((await client.execute(reconcile)).credit.unappliedAmountCents).toBe(0); expect(store.read()).toBeNull();
 });
});
