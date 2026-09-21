import { describe, expect, it, vi } from "vitest";
import { planShopifyLabelCancellation, type ShopifyLabelPackage } from "../../shopify-label-lifecycle.domain";
import { cancelExactShopifyLabelPackage, readShopifyLabelPackages } from "../../shopify-label-lifecycle.client";
import { createShopifyLabelLifecycleService } from "../../shopify-label-lifecycle.service";
import type { ShopifyLabelVoidWork } from "../../shopify-label-lifecycle.repository";
import { ChannelFulfillmentProviderError } from "../../../channels/channel-fulfillment-provider.error";
import { shopifyOrderFulfillmentLockId } from "../../shopify-fulfillment-lock";

const lineId = 'gid://shopify/LineItem/1';
const fulfillmentId = 'gid://shopify/Fulfillment/5';
const orderId = 'gid://shopify/Order/10';
const original: ShopifyLabelPackage = { id: fulfillmentId, status: 'SUCCESS', trackingNumbers: ['OLD'], items: [{ lineId, quantity: 1 }] };
const scope = { trackingNumber: 'OLD', expectedFulfillmentIds: [fulfillmentId], items: original.items };
const work: ShopifyLabelVoidWork = { id: 1, omsOrderId: 10, channelId: 2, physicalShipmentId: 3, labelId: 4,
  attemptCount: 0, orderGid: orderId, trackingNumber: 'OLD', fulfillmentIds: [fulfillmentId], items: original.items,
  processing: false, carrierPossession: false, labelVoidProven: true };

function fixture(options: { work?: Partial<ShopifyLabelVoidWork>; failAfterCancel?: boolean; invalidRead?: boolean } = {}) {
  let cancelled = false;
  let failed = false;
  const request = vi.fn(async (query: string) => {
    if (query.includes('labelLifecyclePackages')) {
      if (options.failAfterCancel && cancelled && !failed) { failed = true; throw new ChannelFulfillmentProviderError('TIMEOUT', 'Read timed out', 'transient'); }
      return { order: { id: orderId, fulfillmentsCount: { count: options.invalidRead ? 2 : 1 }, fulfillments: [{
        id: fulfillmentId, status: cancelled ? 'CANCELLED' : 'SUCCESS', trackingInfo: [{ number: 'OLD' }],
      }] } };
    }
    if (query.includes('labelLifecycleLines')) return { fulfillment: { id: fulfillmentId, order: { id: orderId },
      fulfillmentLineItems: { nodes: [{ lineItem: { id: lineId }, quantity: 1 }], pageInfo: { hasNextPage: false, endCursor: null } } } };
    if (query.includes('cancelVoidedLabelPackage')) {
      cancelled = true;
      return { fulfillmentCancel: { fulfillment: { id: fulfillmentId, status: 'CANCELLED' }, userErrors: [] } };
    }
    throw new Error('Unexpected Shopify request');
  });
  const repository = { observe: vi.fn(), due: vi.fn().mockResolvedValue([{ id: 1, omsOrderId: 10 }]),
    load: vi.fn().mockResolvedValue({ ...work, ...options.work }), finish: vi.fn() };
  const shopify = vi.fn().mockResolvedValue({ channelId: 2, connectionId: 12, externalAccountId: 'second-store.myshopify.com', client: { request } });
  const runExclusive = vi.fn(async (_key: number, action: () => Promise<unknown>) => action());
  const service = createShopifyLabelLifecycleService({ repository, providerClients: { shopify, ebay: vi.fn() },
    runExclusive: runExclusive as never, clock: { now: () => new Date('2026-09-21T12:00:00Z') }, logger: { info: vi.fn(), error: vi.fn() } });
  return { request, repository, shopify, runExclusive, service };
}

describe('Shopify label lifecycle exact package scope', () => {
  it('cancels only the voided package, not an active sibling containing the same order line', () => {
    expect(planShopifyLabelCancellation({ ...scope, packages: [original, { ...original,
      id: 'gid://shopify/Fulfillment/6', trackingNumbers: ['SIBLING'] }] })).toEqual([fulfillmentId]);
  });
  it('replays a cancelled package without mutation', () => {
    expect(planShopifyLabelCancellation({ ...scope, packages: [{ ...original, status: 'CANCELLED' }] })).toEqual([]);
  });
  it('proves an unsent package absent without guessing a fulfillment handle', () => {
    expect(planShopifyLabelCancellation({ ...scope, expectedFulfillmentIds: [], packages: [] })).toEqual([]);
  });
  it.each([
    { ...original, trackingNumbers: ['NEW'] },
    { ...original, trackingNumbers: ['OLD', 'SIBLING'] },
    { ...original, items: [{ lineId, quantity: 2 }] },
    { ...original, items: [{ lineId: 'gid://shopify/LineItem/99', quantity: 1 }] },
    { ...original, status: 'PENDING' },
    { ...original, items: [{ lineId, quantity: 0 }] },
  ])('rejects changed or invalid package identity %j', value => {
    expect(() => planShopifyLabelCancellation({ ...scope, packages: [value] })).toThrow(ChannelFulfillmentProviderError);
  });
  it('does not treat a missing previously recorded handle as success', () => {
    expect(() => planShopifyLabelCancellation({ ...scope, packages: [] })).toThrow(ChannelFulfillmentProviderError);
  });
  it('pins the store, shares the create lock, and verifies cancellation by readback', async () => {
    const f = fixture(); await f.service.runDueBatch();
    expect(f.shopify).toHaveBeenCalledWith(2);
    expect(f.runExclusive).toHaveBeenCalledWith(shopifyOrderFulfillmentLockId(10), expect.any(Function));
    expect(f.request.mock.calls.filter(([query]) => query.includes('cancelVoidedLabelPackage'))).toHaveLength(1);
    expect(f.repository.finish).toHaveBeenCalledWith(work, expect.objectContaining({ state: 'complete',
      evidence: expect.objectContaining({ channelId: 2, cancelledFulfillmentIds: [fulfillmentId] }) }));
  });
  it('retries a lost response without sending another cancellation', async () => {
    const f = fixture({ failAfterCancel: true }); await f.service.runDueBatch();
    expect(f.repository.finish).toHaveBeenLastCalledWith(work, expect.objectContaining({ state: 'pending', errorCode: 'TIMEOUT' }));
    f.repository.load.mockResolvedValue({ ...work, attemptCount: 1 });
    await f.service.runDueBatch();
    expect(f.request.mock.calls.filter(([query]) => query.includes('cancelVoidedLabelPackage'))).toHaveLength(1);
    expect(f.repository.finish).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ state: 'complete' }));
  });
  it.each([{ carrierPossession: true }, { labelVoidProven: false }])('does not undo physically dispatched/unproven labels %j', async value => {
    const f = fixture({ work: value }); await f.service.runDueBatch();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.repository.finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'review' }));
  });
  it('waits for a create already in flight', async () => {
    const f = fixture({ work: { processing: true } }); await f.service.runDueBatch();
    expect(f.request).not.toHaveBeenCalled(); expect(f.repository.finish).not.toHaveBeenCalled();
  });
  it('fails closed on a truncated provider order', async () => {
    const f = fixture({ invalidRead: true }); await f.service.runDueBatch();
    expect(f.request.mock.calls.every(([query]) => !query.includes('mutation'))).toBe(true);
    expect(f.repository.finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'review' }));
  });
  it('never accepts a mutation response with no confirmed fulfillment', async () => {
    const client = { request: vi.fn().mockResolvedValue({ fulfillmentCancel: { fulfillment: null, userErrors: [] } }) };
    await expect(cancelExactShopifyLabelPackage(client, fulfillmentId)).rejects.toMatchObject({ code: 'SHOPIFY_VOID_NOT_CONFIRMED' });
  });
  it('paginates exact fulfillment lines and rejects a cursor loop', async () => {
    const f = fixture(); let page = 0;
    const request = vi.fn(async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes('labelLifecyclePackages')) return f.request(query);
      page++;
      expect(variables?.after).toBe(page === 1 ? null : 'cursor-1');
      return { fulfillment: { id: fulfillmentId, order: { id: orderId }, fulfillmentLineItems: {
        nodes: [{ lineItem: { id: lineId }, quantity: 1 }], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
      } } };
    });
    await expect(readShopifyLabelPackages({ request } as never, orderId, 'OLD', [fulfillmentId]))
      .rejects.toMatchObject({ code: 'SHOPIFY_VOID_LINES_READ_INCOMPLETE' });
    expect(page).toBe(2);
  });
});
