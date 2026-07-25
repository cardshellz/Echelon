import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  enqueueShippingGroupMetafields,
  type ShippingGroupSyncClient,
} from "../../shipping-group-sync";

const dialect = new PgDialect();

function createClient(
  rows: Array<{
    productId: number;
    shopifyProductId: string | null;
    shippingGroupId: number | null;
    code: string | null;
  }>,
) {
  const where = vi.fn().mockResolvedValue(rows);
  const leftJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ leftJoin }));
  const select = vi.fn(() => ({ from }));
  const execute = vi.fn().mockResolvedValue({ rows: [] });

  return {
    client: { select, execute } as unknown as ShippingGroupSyncClient,
    execute,
    select,
  };
}

describe("shipping-group Shopify metafield synchronization", () => {
  it("queues canonical group codes and reports products without Shopify mappings", async () => {
    const { client, execute } = createClient([
      {
        productId: 11,
        shopifyProductId: "12345",
        shippingGroupId: 1,
        code: "protection",
      },
      {
        productId: 12,
        shopifyProductId: null,
        shippingGroupId: 2,
        code: "storage_boxes",
      },
      {
        productId: 13,
        shopifyProductId: "gid://shopify/Product/67890",
        shippingGroupId: null,
        code: null,
      },
    ]);

    const result = await enqueueShippingGroupMetafields(client, [11, 12, 13]);

    expect(result).toEqual({
      requestedProductCount: 3,
      queuedProductCount: 2,
      skippedUnmappedProductCount: 1,
    });
    expect(execute).toHaveBeenCalledTimes(2);

    const setQuery = dialect.sqlToQuery(execute.mock.calls[0][0]);
    expect(setQuery.sql).toContain("INSERT INTO membership.shopify_metafield_outbox");
    expect(setQuery.params).toEqual(expect.arrayContaining([
      "gid://shopify/Product/12345",
      "cardshellz",
      "shipping_group",
      JSON.stringify("protection"),
      "set",
      "product:gid://shopify/Product/12345:cardshellz:shipping_group",
    ]));

    const deleteQuery = dialect.sqlToQuery(execute.mock.calls[1][0]);
    expect(deleteQuery.params).toEqual(expect.arrayContaining([
      "gid://shopify/Product/67890",
      "cardshellz",
      "shipping_group",
      "delete",
      "product:gid://shopify/Product/67890:cardshellz:shipping_group",
    ]));
    expect(deleteQuery.params).not.toContain("null");
  });

  it("surfaces an outbox failure instead of reporting a successful sync", async () => {
    const { client, execute } = createClient([
      {
        productId: 11,
        shopifyProductId: "12345",
        shippingGroupId: 1,
        code: "protection",
      },
    ]);
    execute.mockRejectedValueOnce(new Error("outbox unavailable"));

    await expect(enqueueShippingGroupMetafields(client, [11])).rejects.toThrow(
      "outbox unavailable",
    );
  });

  it("fails closed when a product references a group without a canonical code", async () => {
    const { client, execute } = createClient([
      {
        productId: 11,
        shopifyProductId: "12345",
        shippingGroupId: 999,
        code: null,
      },
    ]);

    await expect(enqueueShippingGroupMetafields(client, [11])).rejects.toMatchObject({
      code: "SHIPPING_GROUP_CODE_INVALID",
      context: {
        productId: 11,
        shippingGroupId: 999,
        shippingGroupCode: null,
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when the canonical group code is malformed", async () => {
    const { client, execute } = createClient([
      {
        productId: 11,
        shopifyProductId: "12345",
        shippingGroupId: 1,
        code: "Protection Group",
      },
    ]);

    await expect(enqueueShippingGroupMetafields(client, [11])).rejects.toMatchObject({
      code: "SHIPPING_GROUP_CODE_INVALID",
      context: {
        productId: 11,
        shippingGroupId: 1,
        shippingGroupCode: "Protection Group",
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects malformed Shopify product identities before writing the outbox", async () => {
    const { client, execute } = createClient([
      {
        productId: 11,
        shopifyProductId: "gid://shopify/Variant/12345",
        shippingGroupId: 1,
        code: "protection",
      },
    ]);

    await expect(enqueueShippingGroupMetafields(client, [11])).rejects.toMatchObject({
      code: "INVALID_SHOPIFY_PRODUCT_ID",
      context: { shopifyProductId: "gid://shopify/Variant/12345" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when any requested product cannot be loaded", async () => {
    const { client, execute } = createClient([
      {
        productId: 11,
        shopifyProductId: "12345",
        shippingGroupId: 1,
        code: "protection",
      },
    ]);

    await expect(enqueueShippingGroupMetafields(client, [11, 12])).rejects.toMatchObject({
      code: "PRODUCT_SET_INCOMPLETE",
      context: { missingProductIds: [12] },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not query or write for an empty product set", async () => {
    const { client, execute, select } = createClient([]);

    await expect(enqueueShippingGroupMetafields(client, [])).resolves.toEqual({
      requestedProductCount: 0,
      queuedProductCount: 0,
      skippedUnmappedProductCount: 0,
    });
    expect(select).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
