import { z } from "zod";
import { shipStationV1Instant } from "@shared/utils/shipstation-date";
import { normalizeTrackingNumber } from "../shipping/carrier-tracking.domain";
import { parseExactPositiveWmsShipmentItems } from "../shipping/shipstation-provider-contents.domain";
import type { ShipStationRelatedLabelIdentity, ShipStationRelatedLabelReader } from "../shipping/shipstation-related-labels.reader";
import { LabelReconciliationError, type LabelScanSource, type ShipStationLabelPage,
  type ShipStationLabelSnapshot } from "./shipstation-label-reconciliation.service";

const MAX_REFRESH_PAGES = 5;
const MAX_CACHED_SCOPES = 10;
export interface ShipStationLabelRefreshSource extends Pick<LabelScanSource, "listOrderLabels"> {
  listTrackingLabels(trackingNumber: string, page: number): Promise<ShipStationLabelPage>;
}

/** One instance per webhook delivery. Cache only within that delivery, never
 * across events: an earlier "active" read must not hide a subsequent void. */
export function createShipStationReplacementLabelRefresh(dependencies: {
  reader: ShipStationRelatedLabelReader;
  source: ShipStationLabelRefreshSource;
  observeVoids(labels: ShipStationLabelSnapshot[]): Promise<unknown>;
}) {
  const snapshots = new Map<string, Promise<readonly ShipStationLabelSnapshot[]>>();

  async function readRelated(identity: ShipStationRelatedLabelIdentity): Promise<readonly ShipStationLabelSnapshot[]> {
    const labels: ShipStationLabelSnapshot[] = [];
    let expectedTotal: number | null = null;
    for (let page = 1; page <= MAX_REFRESH_PAGES; page++) {
      const result = identity.providerOrderId !== null
        ? await dependencies.source.listOrderLabels(Number(identity.providerOrderId), page)
        : await dependencies.source.listTrackingLabels(identity.trackingNumber, page);
      if (expectedTotal !== null && expectedTotal !== result.total) {
        throw new LabelReconciliationError("SHIPSTATION_RELATED_LABEL_PAGE_CHANGED");
      }
      expectedTotal = result.total;
      labels.push(...result.shipments);
      if (new Set(labels.map(label => label.shipmentId)).size !== labels.length) {
        throw new LabelReconciliationError("SHIPSTATION_ORDER_LABEL_PAGE_OVERLAP");
      }
      if (result.page >= result.pages) return labels;
    }
    throw new LabelReconciliationError("SHIPSTATION_ORDER_LABEL_LIMIT");
  }

  return {
    async beforeActiveLabel(incoming: ShipStationLabelSnapshot): Promise<void> {
      if (incoming.isReturnLabel !== false || incoming.voidDate) return;
      z.number().int().positive().safe().parse(incoming.shipmentId);
      const orderId = z.number().int().positive().safe().nullish().parse(incoming.orderId);
      const related = await dependencies.reader.findRelatedActiveLabels({
        providerLabelId: String(incoming.shipmentId),
        providerOrderId: orderId == null ? null : String(orderId),
        sourceWmsShipmentItemIds: parseExactPositiveWmsShipmentItems(incoming.shipmentItems)
          ?.map(item => item.sourceShipmentItemId) ?? [],
      });
      for (const identity of related) {
        const key = identity.providerOrderId === null ? `tracking:${identity.trackingNumber}` : `order:${identity.providerOrderId}`;
        let pending = snapshots.get(key);
        if (!pending) {
          // Batch webhooks must not retain the full label history of every order.
          if (snapshots.size >= MAX_CACHED_SCOPES) snapshots.delete(snapshots.keys().next().value!);
          pending = readRelated(identity);
          snapshots.set(key, pending);
        }
        const labels = await pending;
        const label = labels.find(candidate => String(candidate.shipmentId) === identity.providerLabelId);
        if (!label) throw new LabelReconciliationError("SHIPSTATION_RELATED_LABEL_NOT_FOUND");
        if (normalizeTrackingNumber(label.trackingNumber) !== normalizeTrackingNumber(identity.trackingNumber)
          || (identity.providerOrderId !== null && String(label.orderId) !== identity.providerOrderId)
          || label.isReturnLabel === true) {
          throw new LabelReconciliationError("SHIPSTATION_RELATED_LABEL_IDENTITY_CONFLICT");
        }
        const voidedAt = shipStationV1Instant(label.voidDate, "voidDate");
        if ((label.voided === true && !voidedAt) || (label.voided === false && voidedAt)) {
          throw new LabelReconciliationError("SHIPSTATION_VOID_EVIDENCE_MISSING");
        }
        // A second label can be a legitimate split. Only explicit provider void
        // evidence retires the predecessor; active siblings are left untouched.
        // Observe before the new label's commercial allocation is evaluated.
        if (voidedAt) await dependencies.observeVoids([label]);
      }
    },
  };
}
