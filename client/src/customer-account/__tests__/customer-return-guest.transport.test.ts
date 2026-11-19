import { describe, expect, it, vi } from "vitest";
import { createGuestReturnTransport } from "../customer-return-guest.transport";
import { CUSTOMER_RETURNS_API, RETURN_CUSTOMER_SESSION_HEADER } from "@shared/returns/customer-return-access.contract";
const config={themeId:"174740308127",proxyPath:"/apps/echelon-returns"};
const session={challengeId:"c1d149b8-72ce-47e9-8b62-4a9056473a03",browserKey:"b".repeat(43),grant:"g".repeat(43),sessionKey:"s".repeat(43),omsOrderId:10,expiresAt:"2099-11-01T12:30:00.000Z"};
describe("guest return storefront transport",()=>{
  it("uses the same-origin signed proxy and preserves verification/retry keys",async()=>{
    const request=vi.fn<typeof fetch>(async()=>Response.json({challengeId:session.challengeId,expiresAt:"2099-11-01T12:10:00.000Z"}));
    const api=createGuestReturnTransport(config,request);
    const input={requestKey:session.challengeId,browserKey:session.browserKey,orderReference:"1001",email:"guest@example.test"};
    await api.lookup(input);await api.lookup(input);
    expect(request.mock.calls[0][0]).toBe("/apps/echelon-returns/guest");
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual(JSON.parse(String(request.mock.calls[0][1]?.body)));
    expect(request.mock.calls[0][1]).toMatchObject({credentials:"same-origin",cache:"no-store",redirect:"error"});
  });
  it("forwards canonical return requests with the verified one-order proof, without putting it in a URL",async()=>{
    const request=vi.fn<typeof fetch>(async()=>Response.json({ok:true}));
    const gateway=createGuestReturnTransport(config,request).returns(session);
    await gateway.request(`${CUSTOMER_RETURNS_API}/orders/10`,{headers:{[RETURN_CUSTOMER_SESSION_HEADER]:session.sessionKey}});
    const body=JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body).toMatchObject({action:"returns",proof:{challengeId:session.challengeId,browserKey:session.browserKey,grant:session.grant},input:{path:"/returns/orders/10",method:"GET",query:{}}});
    expect(String(request.mock.calls[0][0])).not.toContain(session.grant);
  });
  it("rejects foreign URLs, invalid configuration, duplicate query parameters and stale browser sessions before sending",async()=>{
    const request=vi.fn<typeof fetch>();const gateway=createGuestReturnTransport(config,request).returns(session);
    expect(()=>createGuestReturnTransport({...config,proxyPath:"https://evil.test/apps/returns"},request)).toThrow();
    const headers={[RETURN_CUSTOMER_SESSION_HEADER]:session.sessionKey};
    for(const target of ["https://evil.test/returns",`${CUSTOMER_RETURNS_API}/orders/10?before=1&before=2`]) await expect(gateway.request(target,{headers})).rejects.toThrow();
    await expect(gateway.request(`${CUSTOMER_RETURNS_API}/orders/10`,{headers:{[RETURN_CUSTOMER_SESSION_HEADER]:"x".repeat(43)}})).rejects.toThrow("verified order changed");
    expect(request).not.toHaveBeenCalled();
  });
  it("does not automatically repeat a failed request, and gives useful malformed-response errors",async()=>{
    const request=vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("Network lost")).mockResolvedValueOnce(new Response("<html>bad gateway</html>",{status:502}));
    const api=createGuestReturnTransport(config,request);
    const input={requestKey:session.challengeId,browserKey:session.browserKey,orderReference:"1001",email:"guest@example.test"};
    await expect(api.lookup(input)).rejects.toThrow("Network lost");expect(request).toHaveBeenCalledTimes(1);
    await expect(api.lookup(input)).rejects.toThrow("We couldn't load your return. Please try again.");
  });
  it("rejects an unsafe account URL instead of presenting it as an activation link",async()=>{
    const request=vi.fn<typeof fetch>(async()=>Response.json({kind:"activate",url:"javascript:alert(1)"}));
    await expect(createGuestReturnTransport(config,request).account(session)).rejects.toThrow("couldn't verify the response");
  });
});
