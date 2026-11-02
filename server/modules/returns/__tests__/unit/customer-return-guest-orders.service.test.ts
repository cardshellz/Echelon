import { describe, expect, it, vi } from "vitest";
import { CustomerReturnGuestOrdersService } from "../../application/customer-return-guest-orders.service";
describe("verified-order guest chooser", () => {
  it("returns only the verified purchase, its cancellation state and no customer-wide query", async () => {
    const owned = { omsOrderId:10,channelId:1,externalOrderId:"1001",externalOrderNumber:"#1001",cancelledAt:null as string|null };
    const resolveOwned=vi.fn(async()=>owned);
    const orders={order:vi.fn(),review:vi.fn()};
    const service=new CustomerReturnGuestOrdersService({omsOrderId:10,access:{resolveOwned},orders});
    expect((await service.choices({})).orders).toEqual([{omsOrderId:10,orderReference:"#1001",purchasedAt:null,eligibleItemCount:null}]);
    expect(resolveOwned).toHaveBeenCalledExactlyOnceWith({omsOrderId:10});
    expect(orders.order).not.toHaveBeenCalled();expect(orders.review).not.toHaveBeenCalled();
    expect((await service.choices({beforeOmsOrderId:10})).orders).toEqual([]);
    owned.cancelledAt="2026-11-01T12:00:00.000Z";
    expect((await service.choices({})).orders).toEqual([]);
  });
});
