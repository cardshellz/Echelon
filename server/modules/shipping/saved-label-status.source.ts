import type { Pool } from "pg";
import { z } from "zod";
import type { PackageHistoryDocument } from "@shared/shipping/package-history";
import {
  CustomerReturnShopifySnapshotError,
  type CustomerReturnShopifySnapshotReader,
  type CustomerReturnShopifySnapshot,
} from "../returns/application/customer-return-shopify-snapshot.ports";
import {
  deriveSalesChannelDeliveryEvidence,
  type SalesChannelDeliveryEvidence,
} from "./sales-channel-delivery.domain";
import { returnLabelRecordSchema } from "../shipping-engine/application/return-label-provider.port";
import { createShipStationLabelReconciliationClient } from "../oms/shipstation-label-reconciliation.client";
import { createPackageHistoryShipStationRequester } from "./package-history.source";
import { PostgresPackageHistoryStore } from "./package-history.repository";
import { readBoundedResponseText } from "./shipstation-tracking-http";
import {
  createShipStationTrackingEventsClient,
  ShipStationTrackingEventsError,
  type ShipStationTrackingSnapshotResult,
  isRetryableTrackingEventsError,
  createShipStationLabelTrackingRequest,
} from "./shipstation-tracking-events.client";
import {
  normalizeTrackingNumber,
  normalizeShipStationLabelObservation,
} from "./carrier-tracking.domain";
import {
  savedLabelStatusFactsSchema,
  verifyHistoricalStatusLabelAlias,
  savedLabelStatusSourceSchema,
  type SavedLabelStatusSource,
  type SavedLabelStatusFacts,
} from "./saved-label-status.domain";

export class SavedLabelStatusSourceError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}
export interface SavedLabelStatusSourceReader {
  read(
    source: SavedLabelStatusSource,
  ): Promise<
    | {
        facts: SavedLabelStatusFacts;
        snapshot: Record<string, unknown> | null;
        channelEvidence?: SalesChannelDeliveryEvidence[];
      }
    | { finished: true }
  >;
}
/** Authenticated provider reads only. Nothing in account
 * rendering invokes this adapter; a durable shipping worker owns the calls. */
export function createSavedLabelStatusSource(dependencies: {
  pool: Pick<Pool, "query" | "connect">;
  now(): Date;
  v1Key?: string;
  v1Secret?: string;
  v2Key?: string;
  request?: typeof fetch;
  shopify?: CustomerReturnShopifySnapshotReader;
}): SavedLabelStatusSourceReader {
  const fetchFn = dependencies.request ?? fetch;
  const v1 =
    dependencies.v1Key && dependencies.v1Secret
      ? createShipStationLabelReconciliationClient(
          createPackageHistoryShipStationRequester({
            apiKey: dependencies.v1Key,
            apiSecret: dependencies.v1Secret,
            request: fetchFn,
          }),
          () => true,
        )
      : null;
  const tracking = createShipStationTrackingEventsClient({
    apiKey: dependencies.v2Key ?? "",
    nowMs: () => dependencies.now().getTime(),
    fetchImpl: (target, options) =>
      fetchFn(target, { ...options, redirect: "error", cache: "no-store" }),
  });
  async function v2(path: string): Promise<unknown> {
    if (!dependencies.v2Key)
      throw new SavedLabelStatusSourceError(
        "SAVED_LABEL_STATUS_CONFIGURATION",
        true,
      );
    let response: Response;
    try {
      response = await fetchFn(`https://api.shipstation.com/v2${path}`, {
        method: "GET",
        headers: { "API-Key": dependencies.v2Key, Accept: "application/json" },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new SavedLabelStatusSourceError(
        "SAVED_LABEL_STATUS_TRANSPORT",
        true,
      );
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new SavedLabelStatusSourceError(
        `SAVED_LABEL_STATUS_HTTP_${response.status}`,
        response.status === 429 ||
          response.status >= 500 ||
          response.status === 401 ||
          response.status === 403,
      );
    }
    return JSON.parse(await readBoundedResponseText(response, 1_000_000));
  }
  return {
    async read(raw) {
      const source = savedLabelStatusSourceSchema.parse(raw);
      let facts: SavedLabelStatusFacts;
      let historical: PackageHistoryDocument | null = null;
      let trackingLabelReference = source.providerReference;
      if (source.kind === "return") {
        const rows = (
          await dependencies.pool.query(
            `SELECT result_snapshot,EXISTS(SELECT 1 FROM returns.customer_return_parcel_items WHERE parcel_id=attempt.parcel_id)
        AND NOT EXISTS(SELECT 1 FROM returns.customer_return_parcel_items manifest WHERE manifest.parcel_id=attempt.parcel_id
          AND manifest.quantity>COALESCE((SELECT sum(receipt.quantity) FROM returns.customer_return_parcel_receipt_allocations receipt
            JOIN returns.customer_return_authorization_allocations allocation ON allocation.id=receipt.allocation_id
            WHERE receipt.parcel_id=attempt.parcel_id AND allocation.authorization_line_id=manifest.authorization_line_id),0)) AS physically_received
        FROM returns.customer_return_label_attempts attempt WHERE id=$1 AND status='succeeded'`,
            [source.sourceId],
          )
        ).rows;
        if (rows.length !== 1)
          throw new SavedLabelStatusSourceError(
            "SAVED_LABEL_STATUS_SOURCE_CHANGED",
            false,
          );
        const saved = returnLabelRecordSchema.parse(rows[0].result_snapshot);
        if (
          saved.labelId !== source.providerReference ||
          saved.trackingNumber !== source.trackingNumber
        )
          throw new SavedLabelStatusSourceError(
            "SAVED_LABEL_STATUS_SOURCE_CHANGED",
            false,
          );
        if (rows[0].physically_received === true) return { finished: true };
        const label = z
          .object({
            label_id: z.string(),
            shipment_id: z.string(),
            carrier_id: z.string(),
            service_code: z.string(),
            tracking_number: z.string(),
            is_return_label: z.boolean(),
            voided: z.boolean(),
            voided_at: z.string().datetime({ offset: true }).nullish(),
            status: z.string(),
          })
          .parse(await v2(`/labels/${encodeURIComponent(saved.labelId)}`));
        if (
          label.label_id !== saved.labelId ||
          label.shipment_id !== saved.shipmentId ||
          label.carrier_id !== saved.carrierId ||
          label.service_code !== saved.serviceCode ||
          label.tracking_number !== saved.trackingNumber ||
          !label.is_return_label
        )
          throw new SavedLabelStatusSourceError(
            "SAVED_LABEL_STATUS_IDENTITY_MISMATCH",
            false,
          );
        const carrier = z
          .object({ carrier_id: z.string(), carrier_code: z.string() })
          .parse(await v2(`/carriers/${encodeURIComponent(saved.carrierId)}`));
        if (carrier.carrier_id !== saved.carrierId)
          throw new SavedLabelStatusSourceError(
            "SAVED_LABEL_STATUS_IDENTITY_MISMATCH",
            false,
          );
        if ((label.voided || label.status === "voided") && !label.voided_at)
          throw new SavedLabelStatusSourceError(
            "SAVED_LABEL_STATUS_VOID_TIME_UNAVAILABLE",
            true,
          );
        facts = savedLabelStatusFactsSchema.parse({
          providerReference: saved.labelId,
          trackingNumber: saved.trackingNumber,
          carrierCode: carrier.carrier_code,
          serviceCode: saved.serviceCode,
          direction: "return",
          voided: label.voided || label.status === "voided",
          voidedAt: label.voided_at ?? null,
        });
      } else {
        const rows = (
          await dependencies.pool.query(
            `SELECT channel_id,external_order_id FROM oms.oms_orders WHERE id=$1`,
            [source.sourceId],
          )
        ).rows;
        if (rows.length !== 1)
          throw new SavedLabelStatusSourceError(
            "SAVED_LABEL_STATUS_SOURCE_CHANGED",
            false,
          );
        const history = await new PostgresPackageHistoryStore(
          dependencies.pool,
          dependencies.now,
        ).read({
          omsOrderId: source.sourceId,
          channelId: z.number().int().positive().parse(rows[0].channel_id),
          externalOrderId: z.string().parse(rows[0].external_order_id),
        });
        if (!history)
          throw new SavedLabelStatusSourceError(
            "SAVED_LABEL_STATUS_SOURCE_REFRESHING",
            true,
          );
        if (
          !history.packages.some(
            (p) =>
              p.providerShipmentId === source.providerReference &&
              p.trackingNumber === source.trackingNumber,
          )
        )
          throw new SavedLabelStatusSourceError(
            "SAVED_LABEL_STATUS_SOURCE_CHANGED",
            false,
          );
        historical = history;
        if (!v1)
          throw new SavedLabelStatusSourceError(
            "SAVED_LABEL_STATUS_CONFIGURATION",
            true,
          );
        const label = await v1.getLabel(
          z.coerce
            .number()
            .int()
            .positive()
            .safe()
            .parse(source.providerReference),
          source.trackingNumber,
        );
        if (label.isReturnLabel !== false)
          throw new SavedLabelStatusSourceError(
            "SAVED_LABEL_STATUS_IDENTITY_MISMATCH",
            false,
          );
        const observed = normalizeShipStationLabelObservation(
          label,
          dependencies.now(),
        );
        if (label.voided === true || label.voidDate) {
          if (observed.voidedAt === null)
            throw new SavedLabelStatusSourceError(
              "SAVED_LABEL_STATUS_VOID_TIME_UNAVAILABLE",
              true,
            );
          facts = savedLabelStatusFactsSchema.parse({
            providerReference: String(label.shipmentId),
            trackingNumber: label.trackingNumber,
            carrierCode: label.carrierCode,
            serviceCode: label.serviceCode ?? null,
            direction: "outbound",
            voided: true,
            voidedAt: observed.voidedAt.toISOString(),
          });
          return { facts, snapshot: null };
        }
        let alias: ReturnType<typeof verifyHistoricalStatusLabelAlias>;
        try {
          alias = verifyHistoricalStatusLabelAlias(
            label,
            await v2(
              `/labels/se-${encodeURIComponent(source.providerReference)}`,
            ),
          );
        } catch (error) {
          if (error instanceof SavedLabelStatusSourceError) throw error;
          throw new SavedLabelStatusSourceError(
            "SAVED_LABEL_STATUS_ALIAS_UNVERIFIED",
            false,
          );
        }
        trackingLabelReference = alias.providerApiLabelId;
        facts = savedLabelStatusFactsSchema.parse({
          providerReference: String(label.shipmentId),
          trackingNumber: label.trackingNumber,
          carrierCode: label.carrierCode,
          serviceCode: label.serviceCode ?? null,
          direction: "outbound",
          voided: false,
          verifiedAlias: alias,
        });
      }
      if (facts.voided) return { facts, snapshot: null };
      if (!tracking.isConfigured())
        throw new SavedLabelStatusSourceError(
          "SAVED_LABEL_STATUS_CONFIGURATION",
          true,
        );
      const identity = {
        providerLabelId: trackingLabelReference,
        carrierCode: facts.carrierCode,
        trackingNumber: facts.trackingNumber,
      };
      let result: ShipStationTrackingSnapshotResult;
      try {
        result = await tracking.getLabelTrackingSnapshot!(
          createShipStationLabelTrackingRequest(identity),
        );
      } catch (error) {
        if (!(error instanceof ShipStationTrackingEventsError)) throw error;
        const httpStatus = Number(error.context.status);
        throw new SavedLabelStatusSourceError(
          error.code === "HTTP" &&
          Number.isSafeInteger(httpStatus) &&
          httpStatus >= 100 &&
          httpStatus <= 599
            ? `SAVED_LABEL_STATUS_TRACKING_HTTP_${httpStatus}`
            : `SAVED_LABEL_STATUS_TRACKING_${error.code}`,
          isRetryableTrackingEventsError(error) ||
            error.code === "CONFIGURATION" ||
            httpStatus === 401 ||
            httpStatus === 403,
        );
      }
      const payload = result.payload;
      // Every request is anchored to a provider-confirmed immutable V2 label;
      // account carrier aliases cannot substitute a different package.
      if (
        typeof payload.tracking_number !== "string" ||
        normalizeTrackingNumber(payload.tracking_number) !==
          normalizeTrackingNumber(source.trackingNumber) ||
        (payload.label_id != null &&
          String(payload.label_id) !== trackingLabelReference)
      )
        throw new SavedLabelStatusSourceError(
          "SAVED_LABEL_STATUS_TRACKING_MISMATCH",
          false,
        );
      // Historical tracking may retain an old in-transit event instead of UN.
      // Reconcile both dated sources until the carrier confirms final delivery.
      if (historical && dependencies.shopify && payload.status_code !== "DE") {
        const scope = historical.sourceEvidence;
        let snapshot: CustomerReturnShopifySnapshot;
        try {
          snapshot = await dependencies.shopify.read({
            shop: {
              channelId: scope.channelId,
              connectionId: scope.connectionId,
              shopDomain: scope.shopDomain,
              displayName: scope.displayName,
            },
            externalOrderId: historical.externalOrderId,
          });
        } catch (error) {
          if (!(error instanceof CustomerReturnShopifySnapshotError))
            throw error;
          throw new SavedLabelStatusSourceError(
            `SAVED_LABEL_STATUS_${error.code}`,
            error.failureClass === "transient" ||
              [
                "RETURN_SHOPIFY_SCOPE_MISSING",
                "RETURN_SHOPIFY_CONNECTION_UNAVAILABLE",
              ].includes(error.code),
          );
        }
        const channelEvidence = deriveSalesChannelDeliveryEvidence(
          historical,
          source.providerReference,
          snapshot,
          dependencies.now(),
        );
        return { facts, snapshot: payload, channelEvidence };
      }
      return { facts, snapshot: payload };
    },
  };
}
