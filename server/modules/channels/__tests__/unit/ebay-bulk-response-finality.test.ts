import { describe, expect, it, vi } from "vitest";
import { executeEbayQuantityHttp, interpretEbayQuantityResponse } from "../../adapters/ebay/ebay-quantity-http";
import { QuantityProviderEvidenceCollector, observeEbayQuantityRequest,
  type QuantityProviderResponseEvidence } from "../../../inventory-planning/application/quantity-provider-request-evidence";
import { terminalEbayResponseEvidence } from "../../../inventory-planning/domain/quantity-provider-terminal-response";

const path = "/sell/inventory/v1/bulk_update_price_quantity";
const body = { requests: [{ sku: "SKU-A", shipToLocationAvailability: { quantity: 12 }, offers: [{ offerId: "offer-A", availableQuantity: 12 }] }] };
const success = { sku: "SKU-A", offerId: "offer-A", statusCode: 200 };
const failure = { sku: "SKU-A", offerId: "offer-A", statusCode: 400, errors: [{ errorId: 25004, category: "REQUEST", message: "Invalid quantity." }] };
const clock = () => new Date("2026-10-09T12:00:00Z");

describe("one eBay bulk response interpretation for completion and recovery", () => {
  it.each([200,207])("recognizes a complete successful bulk HTTP%s", status => {
    expect(interpretEbayQuantityResponse(status,{ responses: [success] },path,body)).toMatchObject({ completed:true, requestTerminated:true, rejected:false });
  });
  it.each([200,207,400])("retains nested refusal diagnostics instead of recording HTTP%s as success", status => {
    expect(interpretEbayQuantityResponse(status,{ responses: [failure] },path,body)).toMatchObject({ completed:false,requestTerminated:true,rejected:true,errorCodes:["25004"] });
  });
  it("distinguishes partial application from request termination", () => {
    const result = interpretEbayQuantityResponse(207,{ responses: [{ sku:"SKU-A",statusCode:200 },failure] },path,body);
    expect(result).toMatchObject({ completed:false,requestTerminated:true,rejected:false,errorCodes:["25004"] });
  });
  it.each([
    { statusCode: 401, errorId: 1001, code: "EBAY_AUTH_REQUIRED" },
    { statusCode: 403, errorId: 1100, code: "EBAY_OAUTH_SCOPE_MISSING" },
    { statusCode: 403, errorId: 25002, code: "EBAY_PROVIDER_ACCESS_DENIED" },
    { statusCode: 429, errorId: 2001, code: "EBAY_PROVIDER_RATE_LIMITED" },
  ])("preserves a complete bulk refusal's typed permission cause: $code", example => {
    expect(interpretEbayQuantityResponse(207, { responses: [{ sku: "SKU-A", offerId: "offer-A", statusCode: example.statusCode,
      errors: [{ errorId: example.errorId, category: "REQUEST" }] }] }, path, body))
      .toMatchObject({ completed: false, requestTerminated: true, rejected: true, rejectionCode: example.code });
  });
  it.each([
    {responses:[]}, {responses:[{sku:"SKU-A",statusCode:200}]},
    {responses:[success,success]}, {responses:[{...success,sku:"OTHER"}]},
    {responses:[{...success,offerId:"other"}]}, {responses:[{...success,statusCode:202}]},
    {responses:[{...failure,statusCode:408}]}, {responses:[{...success,statusCode:503}]},
  ])("does not release an incomplete, ambiguous, or asynchronous result %j", value => {
    expect(interpretEbayQuantityResponse(207,value,path,body)).toMatchObject({completed:false,requestTerminated:false});
  });
  it("does not invent proof for the historical 400 with no recorded error details", () => {
    expect(interpretEbayQuantityResponse(400,{},path,body)).toMatchObject({completed:false,requestTerminated:false,rejected:false,errorCodes:[]});
  });
  it("preserves error codes when eBay omits its optional message field", () => {
    expect(interpretEbayQuantityResponse(400,{errors:[{errorId:25004,category:"REQUEST"}]},path,body))
      .toMatchObject({requestTerminated:true,rejected:true,errorCodes:["25004"]});
  });
  it("keeps a mixed response uncertain while retaining finality and actionable detail for replay", async () => {
    const results:QuantityProviderResponseEvidence[]=[];
    const collector=new QuantityProviderEvidenceCollector({start:async()=>"1",finish:async(_id,evidence)=>{results.push(evidence);}},clock);
    const request=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({responses:[{sku:"SKU-A",statusCode:200},failure]}),{status:207}));
    await expect(collector.run(()=>observeEbayQuantityRequest({method:"POST",path,body},()=>executeEbayQuantityHttp({
      url:`https://api.ebay.com${path}`,method:"POST",path,body,headers:{},request,now:clock,
    })))).rejects.toThrow("25004 REQUEST: Invalid quantity.");
    expect(request).toHaveBeenCalledOnce();
    expect(results).toEqual([expect.objectContaining({outcome:"uncertain",httpStatus:207,requestTerminated:true,errorCodes:["25004"]})]);
    const evidence=results[0]!;
    const proof=terminalEbayResponseEvidence([{requestId:"1",ordinal:1,method:"POST",path,requestHash:"a".repeat(64),
      outcome:evidence.outcome,httpStatus:evidence.httpStatus,responseHash:evidence.responseHash,errorCodes:evidence.errorCodes,
      recordedAt:clock().toISOString(),requestTerminated:evidence.requestTerminated}]);
    expect(proof?.receipts[0].outcome).toBe("uncertain");
    expect(collector.provesTerminalRejection()).toBe(false);
  });
});
