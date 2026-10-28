import { createHash } from "node:crypto";
import { type PackageHistoryDocument } from "@shared/shipping/package-history";
import type { CustomerReturnBoxOption } from "@shared/returns/customer-return-parcel";
import {
  packageHistoryNativeFromShopify,
  packageHistoryNativeRevision,
  verifyPackageHistoryDocument,
} from "../../shipping/package-history.domain";
import type { CustomerReturnLocalInspectionSnapshot } from "./customer-return-local-inspection.ports";
import type { CustomerReturnShopifySnapshot } from "./customer-return-shopify-snapshot.ports";
import { customerReturnProviderGid as gid } from "./customer-return-live-identity";
import { customerReturnPublicLineId } from "./customer-return-live-packaging";

/** Historical facts can default packaging only. Current native eligibility and
 * claims still decide which units may be returned. Known canonical packages
 * retain ownership, including packages whose current evidence is unusable. */
export function projectHistoricalReturnBoxes(
  local: CustomerReturnLocalInspectionSnapshot,
  provider: CustomerReturnShopifySnapshot,
  raw: PackageHistoryDocument,
): CustomerReturnBoxOption[] {
  const document = verifyPackageHistoryDocument(raw);
  if (local.issues.some((issue) => issue.omsOrderLineId === null)) return [];
  if (
    document.omsOrderId !== local.order.omsOrderId ||
    document.channelId !== local.shop.channelId ||
    gid("Order", document.externalOrderId) !== provider.order.id ||
    gid("Order", local.order.externalOrderId) !== provider.order.id ||
    document.nativeRevision !==
      packageHistoryNativeRevision(packageHistoryNativeFromShopify(provider))
  )
    return [];
  const knownPackages = new Set(
    local.packageItems.map((item) => item.providerPhysicalShipmentId),
  );
  const result: CustomerReturnBoxOption[] = [];
  for (const box of document.packages) {
    if (
      knownPackages.has(box.providerShipmentId) ||
      box.measurementStatus !== "verified" ||
      box.dimensions === null
    )
      continue;
    if (
      box.lines.some((item) => {
        const line = local.lines.find(
          (line) => line.omsOrderLineId === item.omsOrderLineId,
        );
        return (
          !line ||
          line.requiresShipping !== true ||
          line.externalLineItemId === null ||
          gid("LineItem", line.externalLineItemId) !==
            gid("LineItem", item.externalLineId) ||
          item.quantity > line.quantity
        );
      })
    )
      return [];
    const identity = JSON.stringify([
      local.shop.channelId,
      provider.order.id,
      "shipstation",
      box.providerShipmentId,
    ]);
    result.push({
      id: `box-${createHash("sha256").update(identity).digest("hex")}`,
      dimensions: box.dimensions,
      items: box.lines
        .map((item) => ({
          lineId: customerReturnPublicLineId(
            local.shop.channelId,
            provider.order.id,
            gid("LineItem", item.externalLineId),
          ),
          quantity: item.quantity,
        }))
        .sort((a, b) => a.lineId.localeCompare(b.lineId)),
    });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
