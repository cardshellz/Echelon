import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CustomerReturnGuestService } from "../../application/customer-return-guest.service";
import { CustomerReturnCustomerAccessError } from "../../application/customer-return-customer-auth.service";
import type { GuestChallenge, GuestVerificationStore } from "../../application/customer-return-guest.ports";

function fixture() {
  let now = new Date("2026-11-01T12:00:00Z");
  const rows = new Map<string, GuestChallenge>(), attempts = new Map<string, number>(), sent = new Set<string>();
  const revoked = new Set<string>();
  const store: GuestVerificationStore = {
    reserve: async input => { const row = rows.get(input.id) ?? input; rows.set(input.id, row); return row; },
    read: async (id, hash) => { const row = rows.get(id); return row?.browserHash === hash && !revoked.has(id) ? row : null; },
    claimDelivery: async (id) => { if (sent.has(id)) return null; sent.add(id); return rows.get(id) ?? null; },
    finishDelivery: async () => {},
    verify: async (id, hash, correct, at) => {
      const row = await store.read(id,hash); if (!row) return null;
      if (row.verifiedAt) return correct && row.verifiedAt.getTime()+1_800_000>at.getTime() ? row : null;
      const count = attempts.get(id) ?? 0;
      if (row.expiresAt <= at || count >= 5) return null;
      attempts.set(id,count+1);
      if (!correct || !row.purchase) return null;
      const verified = { ...row, verifiedAt: at }; rows.set(id,verified); return verified;
    },
    revoke: async id => { revoked.add(id); },
    account: async (_id,_hash,_now,build) => build(null),
  };
  const purchase = { channelId: 1, shopDomain: "test.myshopify.com", omsOrderId: 10, externalOrderId: "1001", externalCustomerId: "9001", email: "guest@example.test", verifiedPurchase: { email:"guest@example.test", customerId:"gid://shopify/Customer/9001" } };
  const email = { send: vi.fn(async (_input: { code: string }) => {}) };
  const purchases = { find: vi.fn(async () => purchase as typeof purchase | null), current: vi.fn(async () => true),
    account: vi.fn(async () => ({ kind: "activate" as const, url: "https://store.test/account/activate/9001/token" })) };
  const service = new CustomerReturnGuestService({ secret: "s".repeat(64), store, purchases, email, now: () => now, randomId: randomUUID });
  const input = { requestKey: randomUUID(), browserKey: "a".repeat(43), orderReference: "1001", email: purchase.email };
  async function verified() {
    await service.lookup(1,purchase.shopDomain,input);
    const code = email.send.mock.calls[0][0].code;
    return service.verify(1,{ challengeId: input.requestKey, browserKey: input.browserKey, code });
  }
  return { service, store, input, email, purchases, purchase, verified, advance: (ms: number) => { now = new Date(now.getTime()+ms); } };
}
describe("email-verified single-order return access", () => {
  it("requires the email code and yields a stable grant on a lost verification response", async () => {
    const f = fixture(); const session = await f.verified();
    const replay = await f.service.verify(1,{ challengeId:f.input.requestKey,browserKey:f.input.browserKey,code:f.email.send.mock.calls[0][0].code });
    expect(replay).toEqual(session);
    expect(await f.service.authorize(1, { challengeId:session.challengeId,browserKey:session.browserKey,grant:session.grant })).toMatchObject({ purchase: f.purchase });
    expect(f.purchases.current).toHaveBeenCalledTimes(3);
  });
  it("reuses lookup and code without duplicate delivery after a lost lookup reply", async () => {
    const f=fixture(); const one=await f.service.lookup(1,f.purchase.shopDomain,f.input);
    expect(await f.service.lookup(1,f.purchase.shopDomain,f.input)).toEqual(one);
    expect(f.email.send).toHaveBeenCalledTimes(1); expect(f.purchases.find).toHaveBeenCalledTimes(1);
    await expect(f.service.lookup(1,f.purchase.shopDomain,{...f.input,email:"other@example.test"})).rejects.toMatchObject({code:"RETURN_GUEST_REQUEST_CONFLICT"});
  });
  it("returns the same challenge response for missing purchases without mailing an arbitrary address", async () => {
    const f=fixture(); f.purchases.find.mockResolvedValue(null);
    expect(await f.service.lookup(1,f.purchase.shopDomain,f.input)).toMatchObject({challengeId:f.input.requestKey});
    expect(f.email.send).not.toHaveBeenCalled();
    await expect(f.service.verify(1,{challengeId:f.input.requestKey,browserKey:f.input.browserKey,code:"00000000"})).rejects.toMatchObject({status:401});
  });
  it("limits wrong codes and does not reset attempts by replaying lookup", async () => {
    const f=fixture(); await f.service.lookup(1,f.purchase.shopDomain,f.input);
    const code=f.email.send.mock.calls[0][0].code, wrong=code==="00000000"?"11111111":"00000000";
    for(let i=0;i<5;i++) await expect(f.service.verify(1,{challengeId:f.input.requestKey,browserKey:f.input.browserKey,code:wrong})).rejects.toMatchObject({status:401});
    await f.service.lookup(1,f.purchase.shopDomain,f.input);
    await expect(f.service.verify(1,{challengeId:f.input.requestKey,browserKey:f.input.browserKey,code})).rejects.toMatchObject({status:401});
  });
  it("rejects an expired code and an expired grant without extending their lifetimes", async () => {
    const f=fixture(); await f.service.lookup(1,f.purchase.shopDomain,f.input); f.advance(600_000);
    await expect(f.service.verify(1,{challengeId:f.input.requestKey,browserKey:f.input.browserKey,code:f.email.send.mock.calls[0][0].code})).rejects.toMatchObject({status:401});
    const g=fixture(), session=await g.verified(); g.advance(1_800_000);
    await expect(g.service.authorize(1,{challengeId:session.challengeId,browserKey:session.browserKey,grant:session.grant})).rejects.toMatchObject({status:401});
  });
  it("rejects cross-browser, forged and cross-channel grants, plus source ownership changes", async () => {
    const f=fixture(),session=await f.verified(); const proof={challengeId:session.challengeId,browserKey:session.browserKey,grant:session.grant};
    for(const bad of [{...proof,browserKey:"b".repeat(43)},{...proof,grant:"b".repeat(43)}]) await expect(f.service.authorize(1,bad)).rejects.toMatchObject({status:401});
    await expect(f.service.authorize(2,proof)).rejects.toMatchObject({status:401});
    f.purchases.current.mockResolvedValue(false); await expect(f.service.authorize(1,proof)).rejects.toMatchObject({status:401});
    expect(f.purchases.account).not.toHaveBeenCalled();
  });
  it("activates only explicitly, and signing out revokes the proof", async () => {
    const f=fixture(),session=await f.verified(),proof={challengeId:session.challengeId,browserKey:session.browserKey,grant:session.grant};
    expect(f.purchases.account).not.toHaveBeenCalled();
    expect(await f.service.activate(1,proof)).toMatchObject({kind:"activate"});
    expect(await f.service.logout(1,proof)).toEqual({ok:true});
    expect(await f.service.logout(1,proof)).toEqual({ok:true});
    await expect(f.service.authorize(1,proof)).rejects.toMatchObject({status:401});
  });
  it("allows a verified purchase without a customer record, and never invents one", async () => {
    const f=fixture(); f.purchases.find.mockResolvedValue({...f.purchase,externalCustomerId:null} as unknown as typeof f.purchase);
    const session=await f.verified(); expect(session.omsOrderId).toBe(10);
    expect(f.purchases.account).not.toHaveBeenCalled();
  });
  it("classifies an invalid clock as unavailable before sending any email", async () => {
    const f=fixture();f.advance(Number.NaN);
    await expect(f.service.lookup(1,f.purchase.shopDomain,f.input)).rejects.toMatchObject({code:"RETURN_GUEST_CLOCK_UNAVAILABLE",status:503});
    expect(f.email.send).not.toHaveBeenCalled();expect(f.purchases.find).not.toHaveBeenCalled();
  });
  it("rejects a grant that expires while the provider read is in progress", async () => {
    const f=fixture(),session=await f.verified();
    f.purchases.current.mockImplementationOnce(async()=>{f.advance(1_800_000);return true;});
    await expect(f.service.authorize(1,{challengeId:session.challengeId,browserKey:session.browserKey,grant:session.grant})).rejects.toMatchObject({status:401});
  });
  it("keeps the verified return available when optional account setup fails", async () => {
    const f=fixture(),session=await f.verified(),proof={challengeId:session.challengeId,browserKey:session.browserKey,grant:session.grant};
    f.purchases.account.mockRejectedValue(new CustomerReturnCustomerAccessError("RETURN_GUEST_PURCHASE_UNAVAILABLE","private provider diagnostic",503));
    await expect(f.service.activate(1,proof)).rejects.toMatchObject({code:"RETURN_GUEST_ACCOUNT_UNAVAILABLE",message:expect.stringContaining("continue your return as a guest")});
    expect(await f.service.authorize(1,proof)).toMatchObject({purchase:f.purchase});
  });
});
