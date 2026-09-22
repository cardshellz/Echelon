import { afterEach, describe, expect, it, vi } from "vitest";
import { EbayApiClient } from "../../adapters/ebay/ebay-api.client";
import { replaceEbayPackageTracking } from "../../adapters/ebay/ebay-package-tracking-replacement";

afterEach(() => vi.unstubAllEnvs());

const pkg = (trackingNumber: string, quantity: number, lineItemId = 'line-A') => ({ trackingNumber, shippingCarrierCode: 'UPS', shippedDate: '2026-09-17T12:00:00Z', lineItems: [{ lineItemId, quantity }] });
const remote = (value: ReturnType<typeof pkg>) => ({ fulfillmentId: `id-${value.trackingNumber}`, shipmentTrackingNumber: value.trackingNumber,
  shippingCarrierCode: value.shippingCarrierCode, lineItems: value.lineItems });
function fixture(shape: 'split' | 'merge' | 'sibling' = 'split') {
  const before = shape === 'merge' ? [pkg('OLD-A', 1), pkg('OLD-B', 1)] : [pkg('OLD-A', shape === 'sibling' ? 1 : 2)];
  const targets = shape === 'split' ? [pkg('NEW-A', 1), pkg('NEW-B', 1)] : [pkg('NEW-A', shape === 'merge' ? 2 : 1)];
  const siblings = shape === 'sibling' ? [pkg('KEEP', 1)] : [];
  // Other order lines are deliberately unfulfilled. A line-scoped amendment
  // must not send OrderID and turn their backorders into shipments.
  const order = { orderId: 'order-1', cancelStatus: { cancelState: 'NONE_REQUESTED', cancelRequests: [] },
    lineItems: [{ lineItemId: 'line-A', legacyItemId: 'listing-A', quantity: 2 }, { lineItemId: 'unshipped-B', legacyItemId: 'listing-B', quantity: 7 }] };
  let packages = [...before, ...siblings].map(remote);
  const read = vi.fn(async (path: string) => path.endsWith('/shipping_fulfillment') ? { fulfillments: structuredClone(packages) } : structuredClone(order));
  const trading = vi.fn(async (call: 'GetOrders' | 'CompleteSale', body: string): Promise<string> => {
    if (call === 'GetOrders') return '<GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><HasMoreOrders>false</HasMoreOrders><OrderArray><Order><OrderID>order-1</OrderID><TransactionArray><Transaction><OrderLineItemID>actual-trading-line</OrderLineItemID><QuantityPurchased>2</QuantityPurchased><Item><ItemID>listing-A</ItemID></Item></Transaction></TransactionArray></Order></OrderArray></GetOrdersResponse>';
    expect(body).toContain('<OrderLineItemID>actual-trading-line</OrderLineItemID>');
    expect(body).not.toContain('<OrderID>'); expect(body).not.toContain('unshipped-B');
    for (const value of [...targets, ...siblings]) expect(body).toContain(`<ShipmentTrackingNumber>${value.trackingNumber}</ShipmentTrackingNumber>`);
    packages = [...targets, ...siblings].map(remote);
    return '<CompleteSaleResponse><Ack>Success</Ack></CompleteSaleResponse>';
  });
  const input = { orderId: 'order-1', current: targets[0], previousTrackingNumbers: before.map(item => item.trackingNumber),
    batch: { packages: targets }, read, trading };
  return { input, order, read, trading, targets, get packages() { return packages; }, set packages(value) { packages = value; } };
}

describe('line-scoped eBay tracking corrections', () => {
  it('routes the real adapter through authenticated line-scoped HTTP requests and exact REST readback', async () => {
    vi.stubEnv('DRY_RUN', 'false');
    const f = fixture();
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      expect(parsed.origin).toBe('https://api.sandbox.ebay.com');
      if (parsed.pathname === '/ws/api.dll') {
        const headers = new Headers(init?.headers);
        expect(headers.get('X-EBAY-API-IAF-TOKEN')).toBe('test-token');
        const call = headers.get('X-EBAY-API-CALL-NAME');
        if (call !== 'GetOrders' && call !== 'CompleteSale') throw new Error('Unexpected Trading call');
        return new Response(await f.trading(call, String(init?.body)));
      }
      expect(init?.method ?? 'GET').toBe('GET');
      return Response.json(await f.read(parsed.pathname));
    });
    const client = new EbayApiClient({ getAccessToken: vi.fn().mockResolvedValue('test-token') }, 67, 'sandbox', { request, strictFulfillmentReadback: true });
    for (const current of f.targets) {
      expect(await client.replaceShippingFulfillmentTracking(f.input.orderId, current, f.input.previousTrackingNumbers, f.input.batch))
        .toEqual({ fulfillmentId: `id-${current.trackingNumber}` });
    }
    expect(f.trading.mock.calls.map(([call]) => call)).toEqual(['GetOrders', 'CompleteSale']);
    expect(request.mock.calls.some(([, init]) => init?.method === 'POST' && String(init.body).includes('<CompleteSaleRequest'))).toBe(true);
  });
  it.each(['split', 'merge', 'sibling'] as const)('amends a %s, preserves other tracking and replays without another write', async shape => {
    const f = fixture(shape);
    expect(await replaceEbayPackageTracking(f.input)).toEqual({ fulfillmentId: 'id-NEW-A' });
    for (const current of f.targets) expect(await replaceEbayPackageTracking({ ...f.input, current })).toEqual({ fulfillmentId: `id-${current.trackingNumber}` });
    expect(f.trading.mock.calls.filter(([call]) => call === 'CompleteSale')).toHaveLength(1);
    expect(f.packages.flatMap(pkg => pkg.lineItems).every(line => line.lineItemId === 'line-A')).toBe(true);
  });
  it('adopts a lost response from exact readback', async () => {
    const f = fixture(); const original = f.trading.getMockImplementation()!;
    f.trading.mockImplementation(async (...args) => { const result = await original(...args); if (args[0] === 'CompleteSale') throw new Error('lost response'); return result; });
    await expect(replaceEbayPackageTracking(f.input)).rejects.toThrow('lost response');
    await expect(replaceEbayPackageTracking(f.input)).resolves.toEqual({ fulfillmentId: 'id-NEW-A' });
    expect(f.trading.mock.calls.filter(([call]) => call === 'CompleteSale')).toHaveLength(1);
  });
  it('creates unsent batch members normally without repeating a completed member', async () => {
    const f = fixture(); f.packages = [];
    const create = vi.fn(async () => { f.packages = [remote(f.targets[0])]; return { fulfillmentId: 'id-NEW-A' }; });
    expect(await replaceEbayPackageTracking({ ...f.input, create })).toEqual({ fulfillmentId: 'id-NEW-A' });
    expect(await replaceEbayPackageTracking({ ...f.input, create })).toEqual({ fulfillmentId: 'id-NEW-A' });
    expect(create).toHaveBeenCalledOnce();
    const createSecond = vi.fn(async () => { f.packages.push(remote(f.targets[1])); return { fulfillmentId: 'id-NEW-B' }; });
    expect(await replaceEbayPackageTracking({ ...f.input, current: f.targets[1], create: createSecond })).toEqual({ fulfillmentId: 'id-NEW-B' });
    expect(f.trading).not.toHaveBeenCalled();
  });
  it('does not mark a partially fulfilled line fully shipped while changing tracking', async () => {
    const f = fixture(); f.order.lineItems[0].quantity = 3;
    await expect(replaceEbayPackageTracking(f.input)).rejects.toMatchObject({ code: 'EBAY_TRACKING_PARTIAL_LINE_UNSUPPORTED' });
    expect(f.trading).not.toHaveBeenCalled();
  });
  it('does not guess a Trading identity when a listing occurs twice in the order', async () => {
    const f = fixture(); f.order.lineItems.push({ lineItemId: 'duplicate', legacyItemId: 'listing-A', quantity: 2 });
    await expect(replaceEbayPackageTracking(f.input)).rejects.toMatchObject({ code: 'EBAY_TRACKING_LINE_IDENTITY_AMBIGUOUS' });
    expect(f.trading.mock.calls.filter(([call]) => call === 'CompleteSale')).toHaveLength(0);
  });
  it('rejects unknown package quantities instead of apportioning them', async () => {
    const f = fixture(); delete (f.packages[0].lineItems[0] as { quantity?: number }).quantity;
    await expect(replaceEbayPackageTracking(f.input)).rejects.toMatchObject({ code: 'EBAY_TRACKING_PACKAGE_QUANTITIES_UNPROVEN' });
    expect(f.trading).not.toHaveBeenCalled();
  });
  it.each(['<!DOCTYPE x [<!ENTITY unsafe SYSTEM "file:///secrets">]><x/>', '<GetOrdersResponse><Ack>Success</Ack>', '<GetOrdersResponse><Ack>Failure</Ack></GetOrdersResponse>'])('rejects untrusted XML before mutation', async response => {
    const f = fixture(); f.trading.mockResolvedValue(response);
    await expect(replaceEbayPackageTracking(f.input)).rejects.toMatchObject({ code: 'EBAY_TRACKING_TRADING_READBACK_INVALID' });
    expect(f.trading.mock.calls.filter(([call]) => call === 'CompleteSale')).toHaveLength(0);
  });
  it('does not accept an acknowledgement without the complete conserved readback', async () => {
    const f = fixture(); const original = f.trading.getMockImplementation()!;
    f.trading.mockImplementation(async (call, body) => call === 'GetOrders' ? original(call, body) : '<Ack>Success</Ack>');
    await expect(replaceEbayPackageTracking(f.input)).rejects.toMatchObject({ code: 'EBAY_TRACKING_AMENDMENT_UNVERIFIED', failureClass: 'transient' });
  });
  it('refuses provider changes between admission and write', async () => {
    const f = fixture(); const original = f.trading.getMockImplementation()!;
    f.trading.mockImplementation(async (call, body) => { const response = await original(call, body); f.packages.push(remote(pkg('foreign', 1, 'foreign-line'))); return response; });
    await expect(replaceEbayPackageTracking(f.input)).rejects.toMatchObject({ code: 'EBAY_TRACKING_READBACK_CHANGED' });
    expect(f.trading.mock.calls.filter(([call]) => call === 'CompleteSale')).toHaveLength(0);
  });
  it('rechecks cancellation immediately before an amendment', async () => {
    const f = fixture(); const original = f.trading.getMockImplementation()!;
    f.trading.mockImplementation(async (call, body) => {
      const response = await original(call, body);
      f.order.cancelStatus.cancelState = 'CANCEL_REQUESTED';
      return response;
    });
    await expect(replaceEbayPackageTracking(f.input)).rejects.toMatchObject({ code: 'EBAY_TRACKING_READBACK_CHANGED' });
    expect(f.trading.mock.calls.filter(([call]) => call === 'CompleteSale')).toHaveLength(0);
  });
  it('rejects extra target quantity and foreign current commands', async () => {
    const f = fixture(); f.targets[0].lineItems[0].quantity = 2;
    await expect(replaceEbayPackageTracking(f.input)).rejects.toMatchObject({ code: 'EBAY_TRACKING_PREDECESSOR_CONFLICT' });
    await expect(replaceEbayPackageTracking({ ...f.input, current: pkg('foreign', 1) })).rejects.toMatchObject({ code: 'EBAY_TRACKING_REPLACEMENT_INVALID' });
  });
});
