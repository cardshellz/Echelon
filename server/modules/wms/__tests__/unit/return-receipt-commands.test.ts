import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { receiveExpectedWmsReturn } from "../../return-receipt-commands";

const NOW = new Date("2026-08-22T15:00:00.000Z");

const dialect = new PgDialect();

function qtext(query: unknown): string {
  return dialect.sqlToQuery(query as any).sql
    .replace(/\s+/g, " ")
    .trim();
}

function input() {
  return {
    returnId: 701,
    items: [
      {
        returnItemId: 902,
        expectedCurrentReceivedQty: 0,
        targetReceivedQty: 1,
      },
      {
        returnItemId: 901,
        expectedCurrentReceivedQty: 1,
        targetReceivedQty: 2,
      },
    ],
    now: NOW,
  };
}

function partialReceiptExecutor() {
  return vi.fn(async (query: any) => {
    const text = qtext(query);
    if (text.startsWith("SELECT id, status, received_at FROM wms.returns")) {
      return { rows: [{ id: 701, status: "expected", received_at: null }] };
    }
    if (text.startsWith("SELECT id, expected_qty, received_qty, status FROM wms.return_items")) {
      return {
        rows: [
          { id: 901, expected_qty: 2, received_qty: 1, status: "partially_received" },
          { id: 902, expected_qty: 3, received_qty: 0, status: "expected" },
        ],
      };
    }
    if (text.includes("WITH targets(return_item_id, target_received_qty)")) {
      return { rows: [{ id: 901 }, { id: 902 }] };
    }
    if (text.startsWith("UPDATE wms.return_items AS return_item SET status = CASE")) {
      return {
        rows: [
          { id: 902, expected_qty: 3, received_qty: 1, status: "partially_received" },
          { id: 901, expected_qty: 2, received_qty: 2, status: "received" },
        ],
      };
    }
    if (text.startsWith("UPDATE wms.returns SET status =")) {
      return {
        rows: [{ id: 701, status: "partially_received", received_at: NOW }],
      };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  });
}

describe("receiveExpectedWmsReturn", () => {
  it("locks the aggregate in order and applies absolute targets atomically", async () => {
    const execute = partialReceiptExecutor();

    const result = await receiveExpectedWmsReturn({ execute }, input());

    expect(result).toEqual({
      returnId: 701,
      status: "partially_received",
      receivedAt: NOW,
      items: [
        {
          returnItemId: 901,
          expectedQty: 2,
          previousReceivedQty: 1,
          receivedQty: 2,
          status: "received",
        },
        {
          returnItemId: 902,
          expectedQty: 3,
          previousReceivedQty: 0,
          receivedQty: 1,
          status: "partially_received",
        },
      ],
    });

    const calls = execute.mock.calls.map(([query]) => qtext(query));
    expect(calls).toHaveLength(5);
    expect(calls[0]).toContain("FROM wms.returns");
    expect(calls[0]).toContain("FOR UPDATE");
    expect(calls[1]).toContain("FROM wms.return_items");
    expect(calls[1]).toContain("ORDER BY id ASC FOR UPDATE");
    expect(calls[2]).toContain("WITH targets(return_item_id, target_received_qty)");
    expect(calls[2]).toContain(
      "VALUES ( $1::bigint, $2::integer ), ( $3::bigint, $4::integer )",
    );
    expect(calls[3]).toContain("UPDATE wms.return_items AS return_item SET status = CASE");
    expect(calls[4]).toContain("COALESCE(received_at,");
    expect(calls.every((text) => !text.includes("inventory."))).toBe(true);
    expect(calls.every((text) => !text.includes("restocked ="))).toBe(true);
  });

  it("derives a fully received parent and preserves an existing received timestamp", async () => {
    const firstReceivedAt = new Date("2026-08-21T10:00:00.000Z");
    const execute = vi.fn(async (query: any) => {
      const text = qtext(query);
      if (text.startsWith("SELECT id, status, received_at FROM wms.returns")) {
        return {
          rows: [{ id: 701, status: "partially_received", received_at: firstReceivedAt }],
        };
      }
      if (text.startsWith("SELECT id, expected_qty, received_qty, status FROM wms.return_items")) {
        return {
          rows: [
            { id: 901, expected_qty: 2, received_qty: 1, status: "partially_received" },
            { id: 902, expected_qty: 3, received_qty: 2, status: "partially_received" },
          ],
        };
      }
      if (text.includes("WITH targets(return_item_id, target_received_qty)")) {
        return { rows: [{ id: 901 }, { id: 902 }] };
      }
      if (text.startsWith("UPDATE wms.return_items AS return_item SET status = CASE")) {
        return {
          rows: [
            { id: 901, expected_qty: 2, received_qty: 2, status: "received" },
            { id: 902, expected_qty: 3, received_qty: 3, status: "received" },
          ],
        };
      }
      if (text.startsWith("UPDATE wms.returns SET status =")) {
        return { rows: [{ id: 701, status: "received", received_at: firstReceivedAt }] };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    const result = await receiveExpectedWmsReturn({ execute }, {
      returnId: 701,
      items: [
        { returnItemId: 901, expectedCurrentReceivedQty: 1, targetReceivedQty: 2 },
        { returnItemId: 902, expectedCurrentReceivedQty: 2, targetReceivedQty: 3 },
      ],
      now: NOW,
    });

    expect(result.status).toBe("received");
    expect(result.receivedAt).toEqual(firstReceivedAt);
    expect(result.items.every((item) => item.status === "received")).toBe(true);
  });

  it.each([
    {
      name: "duplicate item ids",
      mutate: (value: ReturnType<typeof input>) => {
        value.items[1].returnItemId = value.items[0].returnItemId;
      },
      message: "duplicate returnItemId",
    },
    {
      name: "a decreasing target",
      mutate: (value: ReturnType<typeof input>) => {
        value.items[0].expectedCurrentReceivedQty = 2;
        value.items[0].targetReceivedQty = 1;
      },
      message: "cannot reduce",
    },
    {
      name: "an unsafe target",
      mutate: (value: ReturnType<typeof input>) => {
        value.items[0].targetReceivedQty = Number.MAX_SAFE_INTEGER + 1;
      },
      message: "positive safe integer",
    },
    {
      name: "an invalid clock value",
      mutate: (value: ReturnType<typeof input>) => {
        value.now = new Date("invalid");
      },
      message: "valid date",
    },
  ])("rejects $name before issuing SQL", async ({ mutate, message }) => {
    const execute = vi.fn();
    const value = input();
    mutate(value);

    await expect(receiveExpectedWmsReturn({ execute }, value)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining(message),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an item outside the locked return before issuing updates", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = qtext(query);
      if (text.includes("FROM wms.returns")) {
        return { rows: [{ id: 701, status: "expected", received_at: null }] };
      }
      if (text.includes("FROM wms.return_items")) {
        return {
          rows: [{ id: 901, expected_qty: 2, received_qty: 0, status: "expected" }],
        };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(receiveExpectedWmsReturn({ execute }, {
      returnId: 701,
      items: [{ returnItemId: 999, expectedCurrentReceivedQty: 0, targetReceivedQty: 1 }],
      now: NOW,
    })).rejects.toMatchObject({ code: "RETURN_ITEM_NOT_FOUND" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale optimistic quantity before issuing updates", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = qtext(query);
      if (text.includes("FROM wms.returns")) {
        return { rows: [{ id: 701, status: "partially_received", received_at: NOW }] };
      }
      if (text.includes("FROM wms.return_items")) {
        return {
          rows: [{ id: 901, expected_qty: 3, received_qty: 2, status: "partially_received" }],
        };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(receiveExpectedWmsReturn({ execute }, {
      returnId: 701,
      items: [{ returnItemId: 901, expectedCurrentReceivedQty: 1, targetReceivedQty: 3 }],
      now: NOW,
    })).rejects.toMatchObject({
      code: "STALE_RECEIPT_STATE",
      context: {
        expectedCurrentReceivedQty: 1,
        actualCurrentReceivedQty: 2,
      },
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects a target above the locked expected quantity before issuing updates", async () => {
    const execute = vi.fn(async (query: any) => {
      const text = qtext(query);
      if (text.includes("FROM wms.returns")) {
        return { rows: [{ id: 701, status: "expected", received_at: null }] };
      }
      if (text.includes("FROM wms.return_items")) {
        return {
          rows: [{ id: 901, expected_qty: 2, received_qty: 0, status: "expected" }],
        };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(receiveExpectedWmsReturn({ execute }, {
      returnId: 701,
      items: [{ returnItemId: 901, expectedCurrentReceivedQty: 0, targetReceivedQty: 3 }],
      now: NOW,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not reopen a closed WMS return", async () => {
    const execute = vi.fn(async () => ({
      rows: [{ id: 701, status: "closed", received_at: NOW }],
    }));

    await expect(receiveExpectedWmsReturn({ execute }, {
      returnId: 701,
      items: [{ returnItemId: 901, expectedCurrentReceivedQty: 0, targetReceivedQty: 1 }],
      now: NOW,
    })).rejects.toMatchObject({
      name: "WmsReturnReceiptCommandError",
      code: "INVALID_RETURN_STATE",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
