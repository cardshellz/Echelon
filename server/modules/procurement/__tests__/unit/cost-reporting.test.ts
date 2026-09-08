import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { request } from "node:https";
import { describe,expect,it,vi } from "vitest";
import { inventoryCostReportEventSchema } from "@shared/procurement/cost-report-delivery";
import { buildCostReportEnvelope,CostReportingError,nextReportFailure,parseReportConfiguration,reportHash,verifyReportAcknowledgement,type ReportTransportConfiguration } from "../../cost-reporting.domain";
import { isPublicReportAddress,sendCostReport } from "../../cost-reporting.transport";
import { CostReportingService } from "../../cost-reporting.service";

export const configuration:ReportTransportConfiguration = {id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",sourceSystemId:"synthetic-echelon",endpoint:"https://reports.example.com/api/integrations/procurement-cost-reports",token:"synthetic-credential-00000000000000",enabled:true};
const now = new Date("2026-09-07T12:00:00Z");
const payload = {contractVersion:1,currency:"USD",sourceRevisionId:1,sourceFingerprint:"a".repeat(64),component:"product",
  changes:[{lotId:5,before:{productMills:200,packagingMills:2,landedMills:3},after:{productMills:100,packagingMills:2,landedMills:3,totalMills:105,component:"product",allocatedMills:302,quantity:3,remainderMills:2}}],
  cogsDeltaCents:-7,actorId:"synthetic-user",recordedAt:now.toISOString()};
const envelope = () => buildCostReportEnvelope({destination:configuration,deliveryId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",sourceEventId:"9223372036854775807",applicationId:"1",purchaseOrderId:10,purchaseOrderLineId:21,payload});
const acknowledgement = () => ({contractVersion:1,disposition:"accepted_evidence_only",sourceSystemId:configuration.sourceSystemId,destinationId:configuration.id,deliveryId:envelope().deliveryId,sourceEventId:envelope().sourceEventId,payloadHash:envelope().payloadHash,reportHash:envelope().reportHash,receiptId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",acceptedAt:now.toISOString()});

describe("exact cost reporting contract",() => {
  it("preserves signed COGS and component residuals without bigint ID rounding",() => {
    const value = envelope(); expect(value).toEqual(JSON.parse(readFileSync("test/fixtures/procurement-cost-report-v1.json","utf8"))); expect(value.payload).toEqual(payload);expect(value.sourceEventId).toBe("9223372036854775807");
    expect(value.payloadHash).toBe(reportHash(payload));const {reportHash:hash,...core}=value;expect(hash).toBe(reportHash(core));
    expect(reportHash({b:2,a:1})).toBe(reportHash({a:1,b:2}));
  });
  it.each([
    {cogsDeltaCents:0.1},{sourceRevisionId:Number.MAX_SAFE_INTEGER+1},{contractVersion:2},{unrecognized:true},
    {changes:[{...payload.changes[0],after:{...payload.changes[0].after,remainderMills:1}}]},
    {changes:[payload.changes[0],payload.changes[0]]},
  ])("rejects unsafe or inconsistent source evidence %j",(patch) => {expect(inventoryCostReportEventSchema.safeParse({...payload,...patch}).success).toBe(false);});
  it("accepts zero adjustments and signed source components",() => {
    const zero={...payload,cogsDeltaCents:0,changes:[]};expect(inventoryCostReportEventSchema.parse(zero)).toEqual(zero);
    const signed={...payload,component:"packaging",changes:[{...payload.changes[0],after:{productMills:100,packagingMills:-2,landedMills:3,totalMills:101,component:"packaging",allocatedMills:-6,quantity:3,remainderMills:0}}]};
    expect(inventoryCostReportEventSchema.safeParse(signed).success).toBe(true);
  });
  it.each(["sourceSystemId","destinationId","deliveryId","sourceEventId","payloadHash","reportHash"])("requires the exact acknowledgement %s",(key) => {
    expect(() => verifyReportAcknowledgement({...acknowledgement(),[key]:key.endsWith("Hash") ? "0".repeat(64) : "mismatch"},envelope())).toThrow(CostReportingError);
  });
  it("requires explicit HTTPS allowlist and credentials, and defaults disabled",() => {
    expect(parseReportConfiguration({})).toBeNull();
    const env={COST_REPORT_DESTINATION_ID:configuration.id,ECHELON_COST_REPORT_SOURCE_ID:configuration.sourceSystemId,ARCHON_COST_REPORT_URL:configuration.endpoint,ARCHON_COST_REPORT_TOKEN:configuration.token,COST_REPORT_ALLOWED_HOSTS:"reports.example.com"};
    expect(parseReportConfiguration(env)?.enabled).toBe(false);
    expect(parseReportConfiguration({...env,COST_REPORT_DELIVERY_ENABLED:"true"})?.enabled).toBe(true);
    for (const flag of ["DISABLE_SCHEDULERS","COST_REPORT_DELIVERY_DISABLED"]) {
      expect(parseReportConfiguration({...env,COST_REPORT_DELIVERY_ENABLED:"true",[flag]:"true"})?.enabled).toBe(false);
      expect(parseReportConfiguration({...env,COST_REPORT_DELIVERY_ENABLED:"true",[flag]:"false"})?.enabled).toBe(true);
    }
    for (const endpoint of ["http://reports.example.com", "https://user@reports.example.com", "https://reports.example.com?token=x","https://reports.example.com:444", "https://other.example.com"]) expect(() => parseReportConfiguration({...env,ARCHON_COST_REPORT_URL:endpoint})).toThrow();
  });
  it("backs off deterministically and exhausts the bounded retry cycle",() => {
    const failure=new CostReportingError("TEMPORARY","Unavailable",true);
    expect(nextReportFailure(1,failure,now)).toEqual({state:"retry_required",nextAttemptAt:new Date(now.getTime()+30_000)});
    expect(nextReportFailure(7,failure,now).nextAttemptAt?.getTime()).toBe(now.getTime()+1_920_000);
    expect(nextReportFailure(8,failure,now)).toEqual({state:"dead_letter",nextAttemptAt:null});
    expect(nextReportFailure(1,new CostReportingError("CONFLICT","Review"),now).state).toBe("dead_letter");
  });
});

describe("bounded authenticated report transport",() => {
  function fakeRequest(status:number,body:unknown,options:{oversize?:boolean;contentType?:string}={}) {
    const capture=vi.fn();
    const invoke=((_url:unknown,requestOptions:Record<string,any>,callback:(response:unknown) => void) => {
      capture(requestOptions);
      const req=new EventEmitter() as EventEmitter & {end:(body:string) => void};
      req.end=() => {const response=new PassThrough() as PassThrough & {statusCode:number;headers:Record<string,string>};response.statusCode=status;response.headers={"content-type":options.contentType ?? "application/json"};callback(response);response.end(options.oversize ? "x".repeat(17000) : JSON.stringify(body));};
      return req;
    }) as unknown as typeof request;
    return {invoke,capture};
  }
  it.each(["0.0.0.0","10.1.2.3","127.0.0.1","169.254.1.2","172.16.0.1","192.168.1.2","100.64.1.1","198.19.0.1","203.0.113.1","224.1.1.1","::1","2001:db8::1"])("blocks nonpublic address %s",(address) => expect(isPublicReportAddress(address)).toBe(false));
  it("pins the public DNS answer, validates TLS, sends bearer auth and verifies a retained ack",async () => {
    const fake=fakeRequest(200,acknowledgement());
    expect(await sendCostReport(configuration,envelope(),{resolve:async () => [{address:"8.8.8.8",family:4}],request:fake.invoke,timeoutMs:1000})).toEqual(acknowledgement());
    const options=fake.capture.mock.calls[0][0];expect(options).toMatchObject({method:"POST",rejectUnauthorized:true,servername:"reports.example.com",agent:false,family:4});
    expect(options.headers.authorization).toBe(`Bearer ${configuration.token}`);
    const pin=vi.fn();options.lookup("reports.example.com",{},pin);expect(pin).toHaveBeenCalledWith(null,"8.8.8.8",4);
  });
  it.each([[302,false],[401,false],[409,false],[408,true],[429,true],[503,true]])("classifies HTTP %i without following redirects",async (status,retryable) => {
    const fake=fakeRequest(status as number,{});
    await expect(sendCostReport(configuration,envelope(),{resolve:async () => [{address:"8.8.8.8",family:4}],request:fake.invoke,timeoutMs:1000})).rejects.toMatchObject({code:`COST_REPORT_HTTP_${status}`,retryable});
    expect(fake.capture).toHaveBeenCalledTimes(1);
  });
  it("refuses mixed public/private DNS answers before opening HTTP",async () => {
    const fake=fakeRequest(200,acknowledgement());
    await expect(sendCostReport(configuration,envelope(),{resolve:async () => [{address:"8.8.8.8",family:4},{address:"127.0.0.1",family:4}],request:fake.invoke,timeoutMs:1000})).rejects.toMatchObject({code:"COST_REPORT_ADDRESS_BLOCKED"});
    expect(fake.capture).not.toHaveBeenCalled();
  });
  it("bounds DNS time as part of the complete request deadline",async () => {
    const fake=fakeRequest(200,acknowledgement());
    await expect(sendCostReport(configuration,envelope(),{resolve:() => new Promise(() => {}),request:fake.invoke,timeoutMs:5})).rejects.toMatchObject({code:"COST_REPORT_TIMEOUT"});
    expect(fake.capture).not.toHaveBeenCalled();
  });
  it("bounds ack size and rejects wrong hashes even on HTTP 200",async () => {
    for (const fake of [fakeRequest(200,{}, {oversize:true}),fakeRequest(200,{...acknowledgement(),reportHash:"0".repeat(64)})]) {
      await expect(sendCostReport(configuration,envelope(),{resolve:async () => [{address:"8.8.8.8",family:4}],request:fake.invoke,timeoutMs:1000})).rejects.toBeInstanceOf(CostReportingError);
    }
  });
  it("starts a claimed batch concurrently so requests cannot expire while waiting in a serial queue",async () => {
    const started:number[]=[];let finish!:() => void;const barrier=new Promise<void>((resolve) => {finish=resolve;});
    const repository={enqueue:vi.fn(async () => 2),claim:vi.fn(async () => [1,2].map((n) => ({id:String(n),attemptCount:1,envelope:envelope()}))),finish:vi.fn(async () => true)};
    const service=new CostReportingService({repository:repository as never,configuration:() => configuration,clock:() => now,newId:() => "unused",log:vi.fn(),send:async () => {started.push(1);if (started.length===2) finish();await barrier;return acknowledgement() as never;}});
    expect(await service.tick()).toMatchObject({claimed:2,acknowledged:2,failed:0});expect(started).toHaveLength(2);
  });
});
