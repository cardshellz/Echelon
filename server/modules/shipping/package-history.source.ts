import type { Pool } from "pg";
import { z } from "zod";
import type { CustomerReturnShopifySnapshotReader } from "../returns/application/customer-return-shopify-snapshot.ports";
import { CustomerReturnShopifySnapshotError } from "../returns/application/customer-return-shopify-snapshot.ports";
import { createShipStationLabelReconciliationClient } from "../oms/shipstation-label-reconciliation.client";
import type { ShipStationApiRequester } from "../oms/shipstation-api-request";
import { readBoundedResponseText } from "./shipstation-tracking-http";
import { normalizeShipStationLabelObservation } from "./carrier-tracking.domain";
import { ShippingPackageDimensionsReader } from "./package-dimensions.reader";
import {
  packageHistoryNativeFromShopify,
  packageHistoryScopeSchema,
  packageHistoryShipmentSchema,
  PackageHistoryError,
  type PackageHistoryScope,
  type RetainedPackageHistoryShipment,
} from "./package-history.domain";
import type { PackageHistorySource } from "./package-history.ports";

function digits(resource: string, value: string): string {
  const match = new RegExp(
    `^(?:gid://shopify/${resource}/)?([1-9][0-9]*)$`,
  ).exec(value);
  if (!match) throw new PackageHistoryError("PACKAGE_HISTORY_IDENTITY_INVALID");
  return match[1];
}
const positiveId = z.coerce.number().int().positive().safe();
/** Read-only source adapter: no database singleton and no operational services. */
export function createPackageHistorySource(dependencies: {
  pool: Pick<Pool, "query">;
  shopify: CustomerReturnShopifySnapshotReader;
  shipstation: ShipStationApiRequester;
  now(): Date;
}): PackageHistorySource {
  const provider = createShipStationLabelReconciliationClient(
    dependencies.shipstation,
    () => true,
  );
  return {
    async scope(rawId) {
      const omsOrderId = positiveId.parse(rawId);
      const headers = (
        await dependencies.pool.query(
          `SELECT o.channel_id AS "channelId",cc.id AS "connectionId",
        o.external_order_id AS "externalOrderId",o.external_customer_id AS "externalCustomerId",o.external_order_number AS "orderReference",
        cc.shop_domain AS "shopDomain",c.name AS "displayName"
        FROM oms.oms_orders o JOIN channels.channels c ON c.id=o.channel_id
        JOIN channels.channel_connections cc ON cc.channel_id=c.id
        WHERE o.id=$1 AND c.provider='shopify' AND c.type='internal' AND c.status='active'
        AND cc.shop_domain IS NOT NULL AND NULLIF(BTRIM(cc.access_token),'') IS NOT NULL LIMIT 2`,
          [omsOrderId],
        )
      ).rows;
      if (headers.length !== 1)
        throw new PackageHistoryError("PACKAGE_HISTORY_CONNECTION_AMBIGUOUS");
      const header = headers[0];
      const externalOrderId = digits(
        "Order",
        z.string().parse(header.externalOrderId),
      );
      const lines = (
        await dependencies.pool.query(
          `SELECT id AS "omsOrderLineId",external_line_item_id AS "externalLineId",sku,quantity,
        requires_shipping AS "requiresShipping" FROM oms.oms_order_lines WHERE order_id=$1 ORDER BY id LIMIT 201`,
          [omsOrderId],
        )
      ).rows;
      const aliases = (
        await dependencies.pool.query(
          `SELECT ol.id AS "omsOrderLineId",si.id AS "shipmentItemId"
        FROM wms.orders wo JOIN wms.order_items wi ON wi.order_id=wo.id
        JOIN oms.oms_order_lines ol ON ol.order_id=$1 AND (wi.oms_order_line_id=ol.id
          OR (wi.oms_order_line_id IS NULL AND wi.shopify_line_item_id=ol.external_line_item_id))
        JOIN wms.outbound_shipment_items si ON si.order_item_id=wi.id
        WHERE wo.channel_id=$2 AND (wi.shopify_line_item_id IS NULL OR wi.shopify_line_item_id=ol.external_line_item_id)
        AND ((wo.source='oms' AND wo.oms_fulfillment_order_id=$3 AND (wo.external_order_id IS NULL OR wo.external_order_id=ANY($4::text[])))
          OR (wo.source<>'oms' AND wo.external_order_id=ANY($4::text[])))
        AND si.shipment_item_purpose='customer_fulfillment' AND si.replacement_for_order_item_id IS NULL
        AND si.correction_for_shipment_item_id IS NULL ORDER BY si.id LIMIT 2001`,
          [
            omsOrderId,
            header.channelId,
            String(omsOrderId),
            [externalOrderId, `gid://shopify/Order/${externalOrderId}`],
          ],
        )
      ).rows;
      if (aliases.length > 2_000)
        throw new PackageHistoryError("PACKAGE_HISTORY_ALIAS_LIMIT");
      return packageHistoryScopeSchema.parse({
        ...header,
        omsOrderId,
        channelId: positiveId.parse(header.channelId),
        connectionId: positiveId.parse(header.connectionId),
        externalOrderId,
        externalCustomerId:
          header.externalCustomerId === null
            ? null
            : digits("Customer", z.string().parse(header.externalCustomerId)),
        lines: lines.map((line) => ({
          ...line,
          omsOrderLineId: positiveId.parse(line.omsOrderLineId),
          externalLineId: digits(
            "LineItem",
            z.string().parse(line.externalLineId),
          ),
          aliases: [
            ...new Set(
              aliases
                .filter(
                  (alias) =>
                    String(alias.omsOrderLineId) ===
                    String(line.omsOrderLineId),
                )
                .map(
                  (alias) =>
                    `wms-item-${positiveId.parse(alias.shipmentItemId)}`,
                ),
            ),
          ].sort(),
        })),
      });
    },
    async native(scope: PackageHistoryScope) {
      try {
        const snapshot = await dependencies.shopify.read({
          shop: {
            channelId: scope.channelId,
            connectionId: scope.connectionId,
            shopDomain: scope.shopDomain,
            displayName: scope.displayName,
          },
          externalOrderId: scope.externalOrderId,
        });
        return packageHistoryNativeFromShopify(snapshot);
      } catch (cause) {
        if (cause instanceof PackageHistoryError) throw cause;
        throw new PackageHistoryError(
          "PACKAGE_HISTORY_NATIVE_UNAVAILABLE",
          cause instanceof CustomerReturnShopifySnapshotError &&
          cause.failureClass !== "transient"
            ? "review"
            : "transient",
        );
      }
    },
    async shipments(trackingNumber) {
      const result = new Map<
        number,
        ReturnType<typeof packageHistoryShipmentSchema.parse>
      >();
      for (let page = 1; page <= 5; page++) {
        const response = await provider.listTrackingLabels(
          trackingNumber,
          page,
        );
        for (const raw of response.shipments) {
          if (raw.trackingNumber !== trackingNumber)
            throw new PackageHistoryError("PACKAGE_HISTORY_TRACKING_MISMATCH");
          // Voided/return labels remain provider facts; they can never become an
          // original outbound-box candidate. No operational observer is called.
          if (raw.voided === true || raw.voidDate || raw.isReturnLabel === true)
            continue;
          const parsed = packageHistoryShipmentSchema.safeParse(raw);
          if (!parsed.success)
            throw new PackageHistoryError("PACKAGE_HISTORY_PROVIDER_INVALID");
          if (result.has(parsed.data.shipmentId))
            throw new PackageHistoryError(
              "PACKAGE_HISTORY_PAGE_CHANGED",
              "transient",
            );
          result.set(parsed.data.shipmentId, parsed.data);
        }
        if (response.pages <= page) {
          const observations: RetainedPackageHistoryShipment[] = [];
          for (const shipment of result.values()) {
            const observation = {
              shipment,
              observationHash: normalizeShipStationLabelObservation(
                shipment,
                dependencies.now(),
              ).sourceObservationHash,
            };
            if (shipment.dimensions == null) {
              const saved = await new ShippingPackageDimensionsReader(
                dependencies.pool,
              ).read({
                provider: "shipstation",
                providerPhysicalShipmentId: String(shipment.shipmentId),
                trackingNumber: shipment.trackingNumber,
              });
              observations.push(
                saved.status === "verified"
                  ? { ...observation, recordedDimensions: saved.dimensions }
                  : observation,
              );
            } else observations.push(observation);
          }
          return observations;
        }
      }
      throw new PackageHistoryError("PACKAGE_HISTORY_PAGE_LIMIT");
    },
  };
}

/** Only bounded GET /shipments is exposed. Error bodies are never read/logged. */
export function createPackageHistoryShipStationRequester(dependencies: {
  apiKey: string;
  apiSecret: string;
  request?: typeof fetch;
}): ShipStationApiRequester {
  const credentials = z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value),
    );
  const key = credentials.parse(dependencies.apiKey),
    secret = credentials.parse(dependencies.apiSecret);
  if (key.includes(":"))
    throw new PackageHistoryError("PACKAGE_HISTORY_CREDENTIAL_INVALID");
  const authorization = `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;
  return async <T>(method: string, path: string): Promise<T> => {
    const url = new URL(path, "https://ssapi.shipstation.com");
    if (
      method !== "GET" ||
      url.origin !== "https://ssapi.shipstation.com" ||
      url.pathname !== "/shipments"
    )
      throw new PackageHistoryError("PACKAGE_HISTORY_REQUEST_INVALID");
    try {
      const response = await (dependencies.request ?? fetch)(url, {
        method: "GET",
        headers: { Authorization: authorization, Accept: "application/json" },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new PackageHistoryError(
          "PACKAGE_HISTORY_PROVIDER_UNAVAILABLE",
          response.status === 429 || response.status >= 500
            ? "transient"
            : "review",
        );
      }
      return JSON.parse(
        await readBoundedResponseText(response, 2_000_000),
      ) as T;
    } catch (cause) {
      if (cause instanceof PackageHistoryError) throw cause;
      throw new PackageHistoryError(
        "PACKAGE_HISTORY_PROVIDER_UNAVAILABLE",
        "transient",
      );
    }
  };
}
