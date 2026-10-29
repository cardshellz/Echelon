import type { Pool } from "pg";
import type { CustomerReturnLabelSubmitInput } from "@shared/returns/customer-return-label.contract";
import type { CustomerReturnIntakeInspection } from "../../application/customer-return-live.service";
import type { CustomerReturnShopifySnapshot } from "../../application/customer-return-shopify-snapshot.ports";
import { liveGid, liveShopifyFixture } from "./live-inspection-fixtures";
import {
  INTAKE_NOW,
  seedIntakeTestSchema,
} from "./customer-return-intake-database";
import {
  buildPackageHistory,
  packageHistoryNativeFromShopify,
  type PackageHistoryScope,
} from "../../../shipping/package-history.domain";
import { customerReturnPublicLineId } from "../../application/customer-return-live-packaging";

export const COMPLEX_SCOPE = {
  channelId: 36,
  omsOrderId: 100,
  externalOrderId: "1000",
  externalCustomerId: "901",
};
export const COMPLEX_KEY = "19370000-0000-4000-8000-000000000001";
export const COMPLEX_LINES = [
  {
    id: 101,
    native: "500",
    sku: "SLEEVES",
    title: "Sleeves",
    quantity: 9,
    weight: 100,
  },
  {
    id: 102,
    native: "501",
    sku: "TOPLOADERS",
    title: "Toploaders",
    quantity: 6,
    weight: 200,
  },
  {
    id: 104,
    native: "503",
    sku: "STORAGE",
    title: "Storage box",
    quantity: 3,
    weight: 300,
  },
  {
    id: 105,
    native: "504",
    sku: "SLEEVES",
    title: "Separate purchased sleeve line",
    quantity: 1,
    weight: 100,
  },
] as const;
const parcelContents = [
  [101, 4, 102, 1, 104, 1],
  [101, 2, 102, 3, 104, 1, 105, 1],
] as const;

export function complexProvider(
  thirdDelivered = false,
): CustomerReturnShopifySnapshot {
  const base = liveShopifyFixture();
  const physical = COMPLEX_LINES.map((line) => ({
    id: liveGid("LineItem", line.native),
    title: line.title,
    variantTitle: null,
    sku: line.sku,
    quantity: line.quantity,
    currentQuantity: line.quantity,
    refundableQuantity: line.quantity,
    requiresShipping: true,
  }));
  return {
    ...base,
    observedAt: INTAKE_NOW.toISOString(),
    shop: {
      ...base.shop,
      shopDomain: "test-shop.myshopify.com",
      displayName: "Approved test shop",
    },
    order: {
      ...base.order,
      id: liveGid("Order", "1000"),
      name: "#TEST-1",
      customerId: liveGid("Customer", "901"),
      shippingAddress: {
        name: "Synthetic Customer",
        phone: null,
        company: null,
        address1: "2 Test Road",
        address2: null,
        city: "Austin",
        provinceCode: "TX",
        zip: "78702",
        countryCodeV2: "US",
      },
    },
    lines: [
      ...physical,
      {
        id: liveGid("LineItem", "502"),
        title: "Membership",
        variantTitle: null,
        sku: "CLUB",
        quantity: 1,
        currentQuantity: 1,
        refundableQuantity: 1,
        requiresShipping: false,
      },
    ],
    fulfillments: [1, 2, 3].map((shipment) => {
      const delivered = shipment !== 3 || thirdDelivered;
      const lines = COMPLEX_LINES.filter(
        (line) => line.id !== 105 || shipment === 2,
      ).map((line) => ({
        id: liveGid("FulfillmentLineItem", shipment * 1000 + line.id),
        lineItemId: liveGid("LineItem", line.native),
        quantity: line.id === 101 ? 3 : line.id === 102 ? 2 : 1,
      }));
      return {
        id: liveGid("Fulfillment", 600 + shipment),
        status: "SUCCESS",
        updatedAt: "2026-09-20T12:00:00.000Z",
        deliveredAt: delivered ? "2026-09-20T12:00:00.000Z" : null,
        inTransitAt: "2026-09-19T12:00:00.000Z",
        displayStatus: delivered ? "DELIVERED" : "IN_TRANSIT",
        totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
        tracking: [
          { number: `SYNTHETIC-OUTBOUND-${shipment}`, company: "UPS" },
        ],
        lines,
        events: [],
      };
    }),
  };
}

/** Fixture source writes use only the validated disposable test connection. */
export async function seedComplexSource(
  pool: Pool,
  legacy = false,
): Promise<void> {
  await seedIntakeTestSchema(pool);
  await pool.query("TRUNCATE wms.orders RESTART IDENTITY CASCADE");
  await pool.query(
    "UPDATE oms.oms_orders SET external_customer_id='901' WHERE id=100",
  );
  await pool.query(
    "UPDATE oms.oms_order_lines SET title='Membership',sku='CLUB' WHERE id=103",
  );
  for (const line of COMPLEX_LINES) {
    await pool.query(
      `INSERT INTO oms.oms_order_lines(id,order_id,external_line_item_id,title,sku,quantity,requires_shipping,product_variant_id)
      OVERRIDING SYSTEM VALUE VALUES($1,100,$2,$3,$4,$5,true,$6)
      ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,sku=EXCLUDED.sku,quantity=EXCLUDED.quantity,product_variant_id=EXCLUDED.product_variant_id`,
      [
        line.id,
        line.native,
        line.title,
        line.sku,
        line.quantity,
        500 + line.id,
      ],
    );
    await pool.query(
      `INSERT INTO catalog.product_variants(id,product_id,name,sku,weight_grams) OVERRIDING SYSTEM VALUE
      VALUES($1,1,$2,$3,$4)`,
      [500 + line.id, line.title, line.sku, line.weight],
    );
  }
  let itemId = 300;
  for (const shipment of [1, 2, 3]) {
    await pool.query(
      `INSERT INTO wms.orders(id,oms_fulfillment_order_id,source_table_id,channel_id,source,external_order_id,order_number,customer_name,warehouse_status)
      OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,36,'shopify',$4,$5,'Synthetic','shipped')`,
      [
        200 + shipment,
        legacy ? null : "100",
        legacy ? "gid://shopify/Order/1000" : null,
        legacy ? "gid://shopify/Order/1000" : "1000",
        `TEST-SHIPMENT-${shipment}`,
      ],
    );
    if (!legacy) {
      await pool.query(
        `INSERT INTO wms.fulfillment_plans(id,oms_order_id,wms_order_id) OVERRIDING SYSTEM VALUE VALUES($1,100,$2)`,
        [shipment, 200 + shipment],
      );
      await pool.query(
        `INSERT INTO wms.physical_shipments(id,provider,provider_physical_shipment_id,tracking_number,carrier,status)
        OVERRIDING SYSTEM VALUE VALUES($1,'shipstation',$2,$3,'UPS','shipped')`,
        [shipment, String(900 + shipment), `SYNTHETIC-OUTBOUND-${shipment}`],
      );
      await pool.query(
        `INSERT INTO oms.channel_fulfillment_receipts(id,receipt_key,request_hash,source_provider,source_channel_id,source_order_id,
        source_fulfillment_id,event_kind,source,processing_status,oms_order_id,physical_shipment_id)
        OVERRIDING SYSTEM VALUE VALUES($1,$2,repeat('a',64),'shopify',36,'1000',$3,'created','shopify_webhook','processed',100,$1)`,
        [shipment, `synthetic-receipt-${shipment}`, String(600 + shipment)],
      );
    }
    for (const line of COMPLEX_LINES.filter(
      (line) => line.id !== 105 || shipment === 2,
    )) {
      itemId++;
      const quantity = line.id === 101 ? 3 : line.id === 102 ? 2 : 1;
      await pool.query(
        `INSERT INTO wms.order_items(id,order_id,oms_order_line_id,source_item_id,sku,name,quantity,fulfilled_quantity,paid_price_cents)
        OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,$7,125)`,
        [
          itemId,
          200 + shipment,
          legacy ? null : line.id,
          legacy ? `legacy-native-${line.native}` : line.native,
          line.sku,
          line.title,
          quantity,
        ],
      );
      if (legacy) {
        await pool.query(
          "UPDATE wms.order_items SET shopify_line_item_id=$2 WHERE id=$1",
          [itemId, line.native],
        );
        continue;
      }
      await pool.query(
        `INSERT INTO wms.fulfillment_plan_lines(id,fulfillment_plan_id,oms_order_line_id,wms_order_item_id,sku,quantity_planned)
        OVERRIDING SYSTEM VALUE VALUES($1::bigint,$2,$3,$1::int,$4,$5)`,
        [itemId, shipment, line.id, line.sku, quantity],
      );
      await pool.query(
        `INSERT INTO wms.physical_shipment_items(id,physical_shipment_id,fulfillment_plan_line_id,wms_order_item_id,sku,quantity_shipped)
        OVERRIDING SYSTEM VALUE VALUES($1::bigint,$2,$1::bigint,$1::int,$3,$4)`,
        [itemId, shipment, line.sku, quantity],
      );
      await pool.query(
        `INSERT INTO oms.channel_fulfillment_receipt_items(receipt_id,source_fulfillment_line_id,channel_order_line_id,quantity,
        oms_order_line_id,wms_order_item_id,physical_shipment_item_id) VALUES($1,$2,$3,$4,$5,$6::int,$6::bigint)`,
        [
          shipment,
          String(shipment * 1000 + line.id),
          line.native,
          quantity,
          line.id,
          itemId,
        ],
      );
    }
  }
}

export function complexRequest(
  inspection: CustomerReturnIntakeInspection,
  settingsVersion: number,
  key = COMPLEX_KEY,
): CustomerReturnLabelSubmitInput {
  const publicId = (id: number) => {
    const line = inspection.local.lines.find(
      (line) => line.omsOrderLineId === id,
    );
    if (!line?.externalLineItemId)
      throw new Error(`Synthetic purchased line ${id} missing`);
    return customerReturnPublicLineId(
      36,
      inspection.provider.order.id,
      liveGid("LineItem", line.externalLineItemId),
    );
  };
  return {
    channelId: 36,
    orderReference: "TEST-1",
    sourceRevision: inspection.order.sourceRevision,
    settingsVersion,
    idempotencyKey: key,
    selections: [
      [101, 6],
      [102, 4],
      [104, 2],
      [105, 1],
    ].map(([id, quantity]) => ({
      lineId: publicId(id),
      quantity,
      reasonCode: null,
    })),
    parcels: parcelContents.map((contents) => ({
      dimensions: { lengthMm: 300, widthMm: 250, heightMm: 200 },
      originalBoxId: null,
      items: Array.from({ length: contents.length / 2 }, (_, index) => ({
        lineId: publicId(contents[index * 2]),
        quantity: contents[index * 2 + 1],
      })),
    })),
  };
}

export function complexHistory(provider: CustomerReturnShopifySnapshot) {
  const scope: PackageHistoryScope = {
    ...COMPLEX_SCOPE,
    connectionId: 4,
    externalCustomerId: "901",
    orderReference: "#TEST-1",
    shopDomain: "test-shop.myshopify.com",
    displayName: "Approved test shop",
    lines: provider.lines.map((line) => ({
      omsOrderLineId: line.id.endsWith("/502")
        ? 103
        : COMPLEX_LINES.find((candidate) =>
            line.id.endsWith(`/${candidate.native}`),
          )!.id,
      externalLineId: line.id.split("/").at(-1)!,
      sku: line.sku,
      quantity: line.quantity,
      requiresShipping: line.requiresShipping,
      aliases: [],
    })),
  };
  return buildPackageHistory(
    scope,
    packageHistoryNativeFromShopify(provider),
    provider.fulfillments.map((fulfillment, index) => ({
      observationHash: String(index + 1).repeat(64),
      shipment: {
        shipmentId: 901 + index,
        orderNumber: "TEST-1",
        trackingNumber: fulfillment.tracking[0].number!,
        isReturnLabel: false,
        voided: false,
        voidDate: null,
        dimensions: { units: "inches", length: 10, width: 8, height: 4 },
        shipmentItems: fulfillment.lines.map((item) => ({
          lineItemKey: item.lineItemId.split("/").at(-1)!,
          quantity: item.quantity,
          sku: provider.lines.find((line) => line.id === item.lineItemId)!.sku,
        })),
      },
    })),
  );
}
