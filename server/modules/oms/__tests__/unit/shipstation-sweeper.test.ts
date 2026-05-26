import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mockDb = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("../../../../db", () => ({
  db: mockDb,
}));

import { sweepShipStationQueue } from "../../shipstation-sweeper";

function sqlText(query: any): string {
  const chunks: unknown[] = query?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && Array.isArray((chunk as any).value)) {
        return (chunk as any).value.join("");
      }
      return "";
    })
    .join("");
}

describe("sweepShipStationQueue", () => {
  beforeEach(() => {
    mockDb.execute.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).fetch;
  });

  it("actively cancels stale ShipStation awaiting orders for final Echelon shipments", async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [{ warehouse_status: "shipped" }] })
      .mockResolvedValueOnce({ rows: [] });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          page: 1,
          pages: 1,
          orders: [
            {
              orderId: 740117299,
              orderNumber: "57771",
              orderKey: "echelon-wms-shp-1578",
              orderStatus: "awaiting_shipment",
              shipTo: {
                name: "Customer",
                street1: "1 Main St",
                city: "Test",
                state: "TX",
                postalCode: "75001",
                country: "US",
              },
              items: [],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ page: 1, pages: 1, orders: [] }),
      });
    globalThis.fetch = fetchMock as any;

    await sweepShipStationQueue("api-key", "api-secret");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/orders/createorder");
    const cancelBody = JSON.parse((fetchMock.mock.calls[1]![1] as any).body);
    expect(cancelBody).toMatchObject({
      orderId: 740117299,
      orderStatus: "cancelled",
      orderKey: "echelon-wms-shp-1578",
    });

    expect(mockDb.execute).toHaveBeenCalledTimes(2);
    expect(sqlText(mockDb.execute.mock.calls[1]![0])).toMatch(/UPDATE wms\.outbound_shipments/);
    expect(sqlText(mockDb.execute.mock.calls[1]![0])).toMatch(/status IN \('planned', 'queued', 'on_hold'\)/);
  });

  it("falls back to review when ShipStation cancellation fails", async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [{ warehouse_status: "cancelled" }] })
      .mockResolvedValueOnce({ rows: [] });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          page: 1,
          pages: 1,
          orders: [
            {
              orderId: 740117299,
              orderNumber: "57771",
              orderKey: "echelon-wms-shp-1578",
              orderStatus: "awaiting_shipment",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "boom",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ page: 1, pages: 1, orders: [] }),
      });
    globalThis.fetch = fetchMock as any;

    await sweepShipStationQueue("api-key", "api-secret");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mockDb.execute).toHaveBeenCalledTimes(2);
    const updateSql = sqlText(mockDb.execute.mock.calls[1]![0]);
    expect(updateSql).toMatch(/requires_review = true/);
    expect(updateSql).toMatch(/review_reason =/);
  });
});
