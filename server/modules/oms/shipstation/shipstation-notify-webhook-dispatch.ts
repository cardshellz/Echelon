import { sql } from "drizzle-orm";
import { createShipStationLabelReconciliationClient } from "../shipstation-label-reconciliation.client";
import type { ShipStationLabelSnapshot } from "../shipstation-label-reconciliation.service";
import { createShipStationReplacementLabelRefresh } from "../shipstation-replacement-label-refresh.service";
import { resolveRecoveredShipNotifyNoMatchExceptions } from "../ship-notify-reconciliation.service";
import { resolveShipStationUnmappedPhysicalExceptionForReturnLabel } from "../shipstation-unmapped-physical";
import {
  CarrierDispatchAuthorityError,
  normalizeTrackingNumber,
  type ConfirmCarrierDispatchInput,
  type ConfirmCarrierDispatchResult,
  type ShippingProviderLabelObserver,
  type StoredShippingProviderLabelObservation,
} from "../../shipping/carrier-tracking-and-dispatch.api";
import { isPositivePostgresInteger } from "../../shipping/shipstation-provider-reconciliation.api";
import { normalizeShipStationWebhookPayload } from "../../shipping/engine-and-reconcile.api";
import {
  ShipStationUnmappedItemsError,
  ShipStationWebhookProcessingError,
  mapShipStationCarrier,
  normalizeManualShipmentContentsAuthority,
  normalizeProviderExactShipmentContentsAuthority,
  parseEchelonOrderKey,
  providerExactAuthorityMatchesShipment,
  shipStationShipmentExternalFulfillmentId,
  withShipmentItemsIncluded,
  type ManualShipmentNotificationInput,
  type ShipNotifyV2Result,
  type ShipmentAuthorityContext,
  type ShipStationRuntimeContext,
  type ShipStationShipment,
} from "./shipstation-contracts";
import type { ShipStationNotifyPackageResolution } from "./shipstation-notify-package-resolution";
import type { ShipStationNotifyV2Execution } from "./shipstation-notify-v2-execution";

export function createShipStationNotifyWebhookDispatch(
  ctx: ShipStationRuntimeContext,
  resolution: ShipStationNotifyPackageResolution,
  v2Execution: ShipStationNotifyV2Execution,
) {
  const { db, baseUrl, dependencies, apiRequest, isConfigured, getShipmentById } = ctx;
  const {
    deriveEventFromSSShipment,
    resolveShipmentByOrderKey,
    resolveCombinedShipmentGroupsFromShipStationItems,
  } = resolution;
  const {
    finalizeCanonicalShipNotifyPackage,
    processShipNotifyV2,
    applyShipNotifyV2EventToResolvedShipment,
  } = v2Execution;

  function nullableExternalRef(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text.length > 0 ? text : null;
  }

  function buildShipNotifyNoMatchIdempotencyKey(
    shipment: ShipStationShipment,
  ): string {
    const key = [
      "shipstation_notify",
      "ship_notify_no_match",
      nullableExternalRef(shipment.orderId) ?? "no-order-id",
      nullableExternalRef(shipment.shipmentId) ?? "no-shipment-id",
      nullableExternalRef(shipment.orderKey) ?? "no-order-key",
      nullableExternalRef(shipment.trackingNumber) ?? "no-tracking",
    ].join(":");

    return key.length <= 500 ? key : key.slice(0, 500);
  }

  async function recordShipNotifyNoMatchException(
    shipment: ShipStationShipment,
    v2Fallback: boolean,
  ): Promise<void> {
    const ssOrderRef = nullableExternalRef(shipment.orderId);
    const ssShipmentRef = nullableExternalRef(shipment.shipmentId);
    const details = {
      ssShipmentId: shipment.shipmentId ?? null,
      ssOrderId: shipment.orderId ?? null,
      ssOrderKey: shipment.orderKey ?? null,
      orderNumber: shipment.orderNumber ?? null,
      trackingNumber: shipment.trackingNumber ?? null,
      carrierCode: shipment.carrierCode ?? null,
      serviceCode: shipment.serviceCode ?? null,
      shipDate: shipment.shipDate ?? null,
      v2Fallback,
      requiresReview: true,
      shipmentItems: Array.isArray(shipment.shipmentItems)
        ? shipment.shipmentItems.map((item) => ({
            orderItemId: item.orderItemId ?? null,
            lineItemKey: item.lineItemKey ?? null,
            sku: item.sku,
            quantity: item.quantity,
          }))
        : [],
    };
    const summary = `Unmatched ShipStation SHIP_NOTIFY callback for order ${ssOrderRef ?? "unknown"} shipment ${ssShipmentRef ?? "unknown"}`;

    await db.execute(sql`
      INSERT INTO wms.reconciliation_exceptions (
        source,
        classification,
        rule,
        status,
        severity,
        external_system,
        external_order_ref,
        external_shipment_ref,
        external_order_key,
        idempotency_key,
        summary,
        details
      )
      VALUES (
        'shipstation_notify',
        'manual_review',
        'ship_notify_no_match',
        'open',
        'review',
        'shipstation',
        ${ssOrderRef},
        ${ssShipmentRef},
        ${nullableExternalRef(shipment.orderKey)},
        ${buildShipNotifyNoMatchIdempotencyKey(shipment)},
        ${summary},
        ${JSON.stringify(details)}::jsonb
      )
      ON CONFLICT (idempotency_key)
        WHERE status IN ('open', 'acknowledged')
      DO UPDATE SET
        last_seen_at = NOW(),
        updated_at = NOW(),
        occurrence_count = wms.reconciliation_exceptions.occurrence_count + 1,
        details = wms.reconciliation_exceptions.details || EXCLUDED.details
    `);
  }

  /**
   * Legacy (pre-Commit 15) per-shipment handler. The body of the
   * original `for (const shipment of shipments)` loop, extracted into
   * a helper with `continue` rewritten as early returns. No behavioral
   * change versus C13; every log string, DB operation, and branch
   * guard is preserved.
   *
   * Returns `{ processed }` where `processed=true` matches the legacy
   * `processed++` increment on the tail of the try block.
   */
  async function recordLegacyShipNotifyAuthorityReview(
    omsOrderId: number,
    shipment: ShipStationShipment,
    reason: string,
    context: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const details = {
      reason,
      shipstationShipmentId: shipment.shipmentId ?? null,
      shipstationOrderId: shipment.orderId ?? null,
      shipstationOrderKey: shipment.orderKey ?? null,
      trackingNumber: shipment.trackingNumber ?? null,
      ...context,
    };
    await db.execute(sql`
      INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
      SELECT id, 'ship_notify_unresolved', ${JSON.stringify(details)}::jsonb, NOW()
      FROM oms.oms_orders
      WHERE id = ${omsOrderId}
    `);
    console.error(JSON.stringify({
      code: "SHIP_NOTIFY_LEGACY_AUTHORITY_REVIEW_REQUIRED",
      omsOrderId,
      ...details,
    }));
  }

  /**
   * Compatibility resolver for pre-cutover OMS-level ShipStation order keys.
   *
   * It owns no fulfillment behavior. It may only identify an existing,
   * unambiguous WMS package and then delegate to the same V2 package handler
   * used by current ShipStation callbacks. Unknown or ambiguous callbacks are
   * quarantined; they never create WMS rows or mark all OMS lines fulfilled.
   */
  async function processShipNotifyLegacy(
    shipment: ShipStationShipment,
    authorityContext: ShipmentAuthorityContext,
  ): Promise<{ processed: boolean }> {
    const parsed = parseEchelonOrderKey(shipment.orderKey);
    if (!parsed || parsed.source !== "oms") {
      return { processed: false };
    }

    const omsOrderId = parsed.omsOrderId;
    const carrier = mapShipStationCarrier(shipment.carrierCode);
    const event = deriveEventFromSSShipment(shipment, carrier);
    if (!event) {
      return { processed: false };
    }

    if (event.kind === "shipped") {
      const recoveredGroups = (
        await resolveCombinedShipmentGroupsFromShipStationItems(null, shipment)
      ).filter((group) => group.row);
      if (recoveredGroups.length > 0) {
        const results: ShipNotifyV2Result[] = [];
        for (const group of recoveredGroups) {
          results.push(await applyShipNotifyV2EventToResolvedShipment(
            group.row,
            shipment,
            event,
            authorityContext,
            group.sourceShipmentItemIds,
          ));
        }
        const finalized = await finalizeCanonicalShipNotifyPackage(
          shipment,
          event,
          results,
          authorityContext,
        );
        return { processed: finalized.processed };
      }
    }

    const wmsOrdersResult: any = await db.execute(sql`
      SELECT id, warehouse_status
      FROM wms.orders
      WHERE (
          source IN ('oms', 'ebay')
          AND oms_fulfillment_order_id = ${String(omsOrderId)}
        )
        OR (
          source = 'shopify'
          AND source_table_id = ${String(omsOrderId)}
        )
      ORDER BY id ASC
    `);
    const wmsOrderRows = wmsOrdersResult?.rows ?? [];
    if (wmsOrderRows.length !== 1) {
      await recordLegacyShipNotifyAuthorityReview(
        omsOrderId,
        shipment,
        wmsOrderRows.length === 0
          ? "legacy_wms_order_missing"
          : "legacy_wms_order_ambiguous",
        { wmsOrderIds: wmsOrderRows.map((row: any) => Number(row.id)) },
      );
      return { processed: false };
    }

    const wmsOrderId = Number(wmsOrderRows[0].id);
    const candidateResult: any = await db.execute(sql`
      SELECT id, order_id, channel_id, source, status, shipstation_order_id,
             shipstation_order_key, external_fulfillment_id, tracking_number,
             requires_review, review_reason, shipment_purpose,
             replaces_shipment_id, replacement_reason
      FROM wms.outbound_shipments
      WHERE order_id = ${wmsOrderId}
        AND status NOT IN ('cancelled', 'voided')
      ORDER BY id ASC
    `);
    const candidates = candidateResult?.rows ?? [];
    const trackingNumber = String(shipment.trackingNumber ?? "").trim();
    const exactTracking = trackingNumber.length === 0
      ? []
      : candidates.filter(
          (row: any) => String(row.tracking_number ?? "").trim() === trackingNumber,
        );
    const active = candidates.filter(
      (row: any) => ["planned", "queued", "labeled", "on_hold"].includes(
        String(row.status ?? ""),
      ),
    );
    const selected = exactTracking.length === 1
      ? exactTracking[0]
      : exactTracking.length === 0 && active.length === 1
        ? active[0]
        : null;

    if (!selected) {
      await recordLegacyShipNotifyAuthorityReview(
        omsOrderId,
        shipment,
        exactTracking.length > 1 || active.length > 1
          ? "legacy_wms_shipment_ambiguous"
          : "legacy_wms_shipment_missing",
        {
          wmsOrderId,
          candidateShipmentIds: candidates.map((row: any) => Number(row.id)),
          exactTrackingShipmentIds: exactTracking.map((row: any) => Number(row.id)),
          activeShipmentIds: active.map((row: any) => Number(row.id)),
        },
      );
      return { processed: false };
    }

    const externalFulfillmentId = shipStationShipmentExternalFulfillmentId(
      shipment.shipmentId,
    );
    const resolved = await resolveShipmentByOrderKey(
      Number(selected.id),
      shipment,
      externalFulfillmentId,
    );
    if (!resolved.row) {
      await recordLegacyShipNotifyAuthorityReview(
        omsOrderId,
        shipment,
        "legacy_wms_shipment_resolution_failed",
        { wmsOrderId, candidateShipmentId: Number(selected.id) },
      );
      return { processed: false };
    }

    const result = await applyShipNotifyV2EventToResolvedShipment(
      resolved.row,
      shipment,
      event,
      authorityContext,
      undefined,
    );
    if (event.kind !== "shipped") {
      return { processed: result.processed };
    }
    const finalized = await finalizeCanonicalShipNotifyPackage(
      shipment,
      event,
      [result],
      authorityContext,
    );
    return { processed: finalized.processed };
  }

  // ─── processShipNotify entry point ─────────────────────────────

  async function resolveRecoveredNoMatchException(
    shipment: ShipStationShipment,
  ): Promise<void> {
    if (!Number.isInteger(shipment.shipmentId) || Number(shipment.shipmentId) <= 0) {
      return;
    }

    try {
      const recovery = await resolveRecoveredShipNotifyNoMatchExceptions(db, {
        externalShipmentRef: shipment.shipmentId,
        limit: 10,
        resolvedBy: "system:shipstation_webhook",
      });
      if (recovery.resolvedCount > 0) {
        console.log(JSON.stringify({
          level: "info",
          action: "ship_notify_no_match_resolved",
          outcome: "recovered",
          ss_shipment_id: shipment.shipmentId,
          ss_order_id: shipment.orderId ?? null,
          resolved_count: recovery.resolvedCount,
          exception_ids: recovery.recovered.map((row) => row.exceptionId),
        }));
      }
    } catch (error: any) {
      // The fulfillment event already committed. Exception housekeeping must
      // remain retryable without turning a successful provider callback into a
      // failed webhook delivery.
      console.error(JSON.stringify({
        level: "error",
        action: "ship_notify_no_match_resolve_failed",
        outcome: "error",
        ss_shipment_id: shipment.shipmentId,
        ss_order_id: shipment.orderId ?? null,
        error: error?.message ?? String(error),
      }));
    }
  }
  async function processShipmentNotification(
    shipment: ShipStationShipment,
    authorityContext: ShipmentAuthorityContext,
  ): Promise<{ processed: boolean }> {
    if (shipment.orderId != null && !isPositivePostgresInteger(shipment.orderId)) {
      throw new Error("ShipStation orderId does not fit the WMS PostgreSQL integer column");
    }

    const authorityEvent = deriveEventFromSSShipment(
      shipment,
      mapShipStationCarrier(shipment.carrierCode),
    );
    if (authorityEvent?.kind === "shipped") {
      if (
        authorityContext.source === "carrier_tracking_confirmed_dispatch"
        && authorityContext.contentsAuthority?.source !== "provider_exact"
      ) {
        throw new Error("Automatic carrier authority requires exact provider contents");
      }
      if (authorityContext.contentsAuthority === null) {
        throw new ShipStationUnmappedItemsError(
          "Shipped fulfillment requires explicit package contents authority",
        );
      }
      if (
        authorityContext.contentsAuthority.source === "provider_exact"
        && !providerExactAuthorityMatchesShipment(
          shipment,
          authorityContext.contentsAuthority,
        )
      ) {
        throw new ShipStationUnmappedItemsError(
          "Fulfillment requires exact ShipStation item IDs and quantities",
        );
      }
    }

    const v2Result = await processShipNotifyV2(shipment, authorityContext);
    if (v2Result.processed) {
      await resolveRecoveredNoMatchException(shipment);
      return { processed: true };
    }
    if (v2Result.handled) {
      return { processed: false };
    }
    if (v2Result.fallback) {
      const legacyResult = await processShipNotifyLegacy(
        shipment,
        authorityContext,
      );
      if (legacyResult.processed) {
        await resolveRecoveredNoMatchException(shipment);
        return legacyResult;
      }
    }

    // D-NOMATCH: Both V2 and legacy paths failed to match this
    // shipment. Log a structured warning so ops can investigate.
    // Previously this was silent — the webhook returned 200 and
    // ShipStation would not retry, stranding the shipment.
    console.error(
      JSON.stringify({
        level: "error",
        action: "ship_notify_no_match",
        outcome: "unmatched",
        ss_shipment_id: shipment.shipmentId ?? null,
        ss_order_id: shipment.orderId ?? null,
        ss_order_key: shipment.orderKey ?? null,
        tracking: shipment.trackingNumber ?? null,
        carrier: shipment.carrierCode ?? null,
        v2_fallback: v2Result.fallback,
      }),
    );

    try {
      await recordShipNotifyNoMatchException(shipment, v2Result.fallback);
    } catch (exceptionErr: any) {
      console.error(
        `[ShipStation Webhook] Failed to persist no-match reconciliation exception for SS shipment ${shipment.shipmentId}: ${exceptionErr?.message}`,
      );
    }

    return { processed: false };
  }

  async function processManualShipmentNotification(
    shipment: ShipStationShipment,
    input: ManualShipmentNotificationInput,
  ): Promise<{ processed: boolean }> {
    const operator = requiredAuthorityText(input.operator, "operator", 200);
    const reason = requiredAuthorityText(input.reason, "reason", 120);
    const notificationEvent = deriveEventFromSSShipment(
      shipment,
      mapShipStationCarrier(shipment.carrierCode),
    );
    const contentsAuthority = input.contentsAuthority.source === "provider_exact"
      ? notificationEvent?.kind === "shipped"
        ? normalizeProviderExactShipmentContentsAuthority(shipment)
        : null
      : normalizeManualShipmentContentsAuthority(shipment, input.contentsAuthority);
    return processShipmentNotification(shipment, {
      source: "shipstation_manual_remediation",
      dispatchOccurredAt: null,
      carrierTrackingEventId: null,
      carrierDispatchCommandId: null,
      shippingProviderLabelId: null,
      providerLabelId: null,
      reviewedRepair: null,
      actor: operator,
      reason,
      contentsAuthority,
    });
  }

  function requireProviderLabelObserver(): ShippingProviderLabelObserver {
    const observer = dependencies.providerLabelObserver;
    if (!observer || typeof observer.observeShipStationLabel !== "function") {
      throw Object.assign(
        new Error("Carrier label authority is not initialized"),
        { code: "CARRIER_LABEL_AUTHORITY_UNAVAILABLE" },
      );
    }
    return observer;
  }

  async function hydrateReturnLabelDirection(
    shipment: ShipStationLabelSnapshot,
  ): Promise<ShipStationLabelSnapshot> {
    if (typeof shipment.isReturnLabel === "boolean") return shipment;

    const shipmentId = Number(shipment.shipmentId);
    if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
      throw new Error("ShipStation shipment is missing isReturnLabel and a valid shipmentId");
    }

    const detailedShipment = await getShipmentById(shipmentId);
    if (!detailedShipment || typeof detailedShipment.isReturnLabel !== "boolean") {
      throw new Error(`ShipStation shipment ${shipmentId} did not provide return-label direction`);
    }
    return detailedShipment;
  }

  async function observeProviderLabel(
    shipment: ShipStationLabelSnapshot,
  ): Promise<StoredShippingProviderLabelObservation> {
    return requireProviderLabelObserver().observeShipStationLabel(shipment);
  }

  async function observeProviderLabels(shipments: ShipStationShipment[]): Promise<void> {
    for (const shipment of shipments) {
      const detailedShipment = await hydrateReturnLabelDirection(shipment);
      await observeProviderLabel(detailedShipment);
    }
  }

  async function processShipNotify(resourceUrl: string): Promise<number> {
    // SHIP_NOTIFY announces label creation, not a guaranteed void notification.
    // Its fetched snapshots may include voids, but prove no carrier possession.
    // Persist every label as
    // provider evidence; an explicit outbound observation records only the
    // package-level business-shipped fact. Exact outbound contents may also
    // create audited commercial-only channel commands; carrier possession and
    // inventory remain under the carrier tracking dispatcher.
    const data = await apiRequest<{ shipments: ShipStationShipment[] }>(
      "GET",
      withShipmentItemsIncluded(baseUrl, resourceUrl),
    );

    const shipments = data.shipments || [];
    // Normalize incoming provider shipment payloads through the canonical
    // ShippingEngine webhook normalizer (`P3.3`) while keeping label observation
    // decoupled from carrier-possession dispatch.
    normalizeShipStationWebhookPayload({ shipments });
    if (dependencies.labelCommercialFulfillment && !dependencies.relatedLabelReader) {
      throw Object.assign(new Error("Related-label refresh is not initialized"),
        { code: "SHIPSTATION_LABEL_REFRESH_UNAVAILABLE" });
    }
    const refresh = dependencies.relatedLabelReader ? createShipStationReplacementLabelRefresh({
      reader: dependencies.relatedLabelReader,
      source: createShipStationLabelReconciliationClient(apiRequest, isConfigured),
      observeVoids: processProviderLabelSnapshots,
    }) : null;
    return processProviderLabelSnapshots(shipments, refresh?.beforeActiveLabel);
  }

  /** Shared webhook/poll intake. This records provider evidence and commercial
   * commands only; it never invokes carrier dispatch or inventory movement. */
  async function processProviderLabelSnapshots(shipments: ShipStationLabelSnapshot[],
    beforeActiveLabel?: (label: ShipStationLabelSnapshot) => Promise<void>): Promise<number> {
    let observed = 0;
    const failures: Array<{ shipmentId: number | null; message: string }> = [];

    for (const shipment of shipments) {
      try {
        const detailedShipment = await hydrateReturnLabelDirection(shipment);
        await beforeActiveLabel?.(detailedShipment);
        const labelObservation = await observeProviderLabel(detailedShipment);
        if (dependencies.labelCommercialFulfillment) {
          await dependencies.labelCommercialFulfillment.process(
            detailedShipment,
            labelObservation,
          );
        }
        if (detailedShipment.isReturnLabel === true) {
          await resolveShipStationUnmappedPhysicalExceptionForReturnLabel(db, {
            shipment: { ...detailedShipment, shipmentItems: undefined },
            resolvedBy: "system:shipstation_notify",
            notes: "Automatically classified from ShipStation return-label direction.",
          });
        }
        observed += 1;
      } catch (err: any) {
        failures.push({
          shipmentId: Number.isInteger(shipment.shipmentId) ? shipment.shipmentId : null,
          message: err?.message || String(err),
        });
        console.error(
          `[ShipStation Webhook] Error processing shipment ${shipment.shipmentId}: ${err?.message || String(err)}`,
        );
      }
    }

    if (failures.length > 0) {
      const failureSummary = failures
        .slice(0, 5)
        .map((failure) =>
          `shipment ${failure.shipmentId ?? "unknown"}: ${failure.message}`,
        )
        .join("; ");
      const suffix = failureSummary ? ` (${failureSummary})` : "";
      throw new ShipStationWebhookProcessingError(
        `ShipStation SHIP_NOTIFY observed ${observed}/${shipments.length} label(s); ${failures.length} failed${suffix}`,
        failures,
        observed,
      );
    }

    return observed;
  }

  async function confirmDispatch(
    input: ConfirmCarrierDispatchInput,
  ): Promise<ConfirmCarrierDispatchResult> {
    if (input.provider !== "shipstation") {
      throw new CarrierDispatchAuthorityError(
        "CARRIER_DISPATCH_PROVIDER_UNSUPPORTED",
        `ShipStation dispatch authority cannot process provider ${input.provider}`,
        {
          retryable: false,
          context: {
            commandId: input.commandId,
            provider: input.provider,
          },
        },
      );
    }

    const shipmentId = Number(input.providerLabelId);
    if (
      !Number.isSafeInteger(shipmentId)
      || shipmentId <= 0
      || String(shipmentId) !== input.providerLabelId
    ) {
      throw new CarrierDispatchAuthorityError(
        "CARRIER_DISPATCH_PROVIDER_LABEL_INVALID",
        "ShipStation provider label id must be a positive integer",
        {
          retryable: false,
          context: {
            commandId: input.commandId,
            providerLabelId: input.providerLabelId,
          },
        },
      );
    }

    let shipment: ShipStationShipment | null;
    try {
      shipment = await getShipmentById(shipmentId);
    } catch (error) {
      throw shipStationDispatchError(
        "CARRIER_DISPATCH_PROVIDER_LOOKUP_FAILED",
        "ShipStation shipment could not be loaded for confirmed carrier dispatch",
        input,
        error,
      );
    }
    if (!shipment) {
      throw new CarrierDispatchAuthorityError(
        "CARRIER_DISPATCH_PROVIDER_LABEL_NOT_FOUND",
        "ShipStation shipment was not readable for confirmed carrier dispatch",
        {
          retryable: true,
          context: {
            commandId: input.commandId,
            providerLabelId: input.providerLabelId,
          },
        },
      );
    }
    if (shipment.shipmentId !== shipmentId) {
      throw new CarrierDispatchAuthorityError(
        "CARRIER_DISPATCH_PROVIDER_LABEL_MISMATCH",
        "ShipStation returned a different shipment identity",
        {
          retryable: false,
          context: {
            commandId: input.commandId,
            expectedProviderLabelId: input.providerLabelId,
            actualProviderLabelId: shipment.shipmentId,
          },
        },
      );
    }
    try {
      await observeProviderLabel(shipment);
    } catch (error) {
      throw shipStationDispatchError(
        "CARRIER_DISPATCH_PROVIDER_OBSERVATION_FAILED",
        "ShipStation shipment evidence could not be persisted before confirmed carrier dispatch",
        input,
        error,
      );
    }

    if (shipment.voidDate) {
      throw new CarrierDispatchAuthorityError(
        "CARRIER_DISPATCH_PROVIDER_LABEL_VOIDED",
        "Carrier possession matched a ShipStation label that is now voided",
        {
          retryable: false,
          context: {
            commandId: input.commandId,
            providerLabelId: input.providerLabelId,
            voidDate: shipment.voidDate,
          },
        },
      );
    }
    if (shipment.isReturnLabel !== false) {
      throw new CarrierDispatchAuthorityError(
        "CARRIER_DISPATCH_RETURN_LABEL_NOT_OUTBOUND",
        "Carrier possession matched a ShipStation return label, which cannot authorize outbound fulfillment",
        {
          retryable: false,
          context: {
            commandId: input.commandId,
            providerLabelId: input.providerLabelId,
          },
        },
      );
    }

    let actualNormalizedTracking: string;
    try {
      actualNormalizedTracking = normalizeTrackingNumber(
        String(shipment.trackingNumber ?? ""),
      );
    } catch (error) {
      throw new CarrierDispatchAuthorityError(
        "CARRIER_DISPATCH_TRACKING_IDENTITY_INVALID",
        "ShipStation shipment has no usable tracking identity",
        {
          retryable: false,
          context: {
            commandId: input.commandId,
            providerLabelId: input.providerLabelId,
            error: error instanceof Error ? error.message : String(error),
          },
          cause: error,
        },
      );
    }
    if (actualNormalizedTracking !== input.normalizedTrackingNumber) {
      throw new CarrierDispatchAuthorityError(
        "CARRIER_DISPATCH_TRACKING_IDENTITY_MISMATCH",
        "ShipStation shipment tracking no longer matches the confirmed carrier event",
        {
          retryable: false,
          context: {
            commandId: input.commandId,
            providerLabelId: input.providerLabelId,
            expectedTrackingSuffix: trackingIdentitySuffix(
              input.normalizedTrackingNumber,
            ),
            actualTrackingSuffix: trackingIdentitySuffix(
              actualNormalizedTracking,
            ),
          },
        },
      );
    }

    const authoritativeShipment: ShipStationShipment = {
      ...shipment,
      shipDate: input.dispatchOccurredAt.toISOString(),
    };
    let result: { processed: boolean };
    try {
      const replacement = await dependencies.fulfillmentAuthority?.reconcileEbayLabelReplacement?.(Number(input.shippingProviderLabelId));
      if (replacement && replacement.outcome !== "applied" && replacement.outcome !== "skipped") {
        throw new CarrierDispatchAuthorityError("CARRIER_DISPATCH_APPLICATION_FAILED", replacement.reason, {
          retryable: replacement.outcome === "waiting", context: { shippingProviderLabelId: input.shippingProviderLabelId },
        });
      }
      result = await processShipmentNotification(authoritativeShipment, {
        source: "carrier_tracking_confirmed_dispatch",
        dispatchOccurredAt: input.dispatchOccurredAt,
        carrierTrackingEventId: input.carrierTrackingEventId,
        carrierDispatchCommandId: input.commandId,
        shippingProviderLabelId: input.shippingProviderLabelId,
        providerLabelId: input.providerLabelId,
        reviewedRepair: input.reviewedRepair ?? null,
        actor: "system:carrier_tracking",
        reason: "carrier_possession_confirmed",
        contentsAuthority: normalizeProviderExactShipmentContentsAuthority(
          authoritativeShipment,
        ),
      });
    } catch (error) {
      if (error instanceof CarrierDispatchAuthorityError) throw error;
      if (error instanceof ShipStationUnmappedItemsError) {
        throw new CarrierDispatchAuthorityError(
          "CARRIER_DISPATCH_PACKAGE_CONTENTS_UNPROVEN",
          error.message,
          {
            retryable: false,
            context: {
              commandId: input.commandId,
              providerLabelId: input.providerLabelId,
            },
            cause: error,
          },
        );
      }
      throw shipStationDispatchError(
        "CARRIER_DISPATCH_APPLICATION_FAILED",
        "Confirmed carrier dispatch could not be applied to WMS fulfillment",
        input,
        error,
      );
    }
    if (!result.processed) {
      throw new CarrierDispatchAuthorityError(
        "CARRIER_DISPATCH_PACKAGE_NOT_RESOLVED",
        "Confirmed carrier dispatch did not resolve to an authoritative WMS package",
        {
          retryable: false,
          context: {
            commandId: input.commandId,
            providerLabelId: input.providerLabelId,
            providerOrderId: shipment.orderId ?? null,
            providerOrderKey: shipment.orderKey ?? null,
          },
        },
      );
    }

    return {
      processed: true,
      evidence: Object.freeze({
        provider: "shipstation",
        providerLabelId: input.providerLabelId,
        providerOrderId: String(shipment.orderId),
        providerOrderKey: shipment.orderKey?.trim() || null,
        trackingSuffix: trackingIdentitySuffix(actualNormalizedTracking),
        carrierTrackingEventId: input.carrierTrackingEventId,
        carrierDispatchCommandId: input.commandId,
        dispatchOccurredAt: input.dispatchOccurredAt.toISOString(),
        reviewedRepair: input.reviewedRepair
          ? {
              ...input.reviewedRepair,
              requeuedAt: input.reviewedRepair.requeuedAt.toISOString(),
            }
          : null,
      }),
    };
  }

  function shipStationDispatchError(
    code: string,
    message: string,
    input: ConfirmCarrierDispatchInput,
    error: unknown,
  ): CarrierDispatchAuthorityError {
    if (error instanceof CarrierDispatchAuthorityError) return error;
    const source = error && typeof error === "object"
      ? error as { code?: unknown; name?: unknown; message?: unknown }
      : {};
    const sourceCode = typeof source.code === "string" ? source.code : null;
    if (sourceCode === "PICK_CORRECTION_REQUIRED") {
      return new CarrierDispatchAuthorityError(sourceCode,
        "Shipment inventory is waiting for a corrective pick.", {
          retryable: true, context: { commandId: input.commandId, providerLabelId: input.providerLabelId }, cause: error,
        });
    }
    const sourceName = typeof source.name === "string" ? source.name : null;
    const sourceMessage = error instanceof Error
      ? error.message
      : typeof source.message === "string"
        ? source.message
        : String(error);
    const retryableDatabaseCode =
      sourceCode !== null
      && (
        sourceCode.startsWith("08")
        || ["40001", "40P01", "53300", "57P01", "57P02", "57P03"].includes(
          sourceCode,
        )
      );
    const retryableTransportCode =
      sourceCode !== null
      && [
        "ECONNRESET",
        "ECONNREFUSED",
        "EAI_AGAIN",
        "ENETUNREACH",
        "ENOTFOUND",
        "ETIMEDOUT",
      ].includes(sourceCode);
    const retryableHttpStatus =
      /\((?:408|425|429|500|502|503|504)\)/.test(sourceMessage);
    const retryable =
      retryableDatabaseCode
      // Canonical dispatch rolls back when the provider worker owns this
      // target/variant publication lock. Its exhausted local attempts require
      // the durable carrier retry schedule, not permanent operator review.
      || sourceCode === "INVENTORY_PUBLICATION_TARGET_BUSY"
      || retryableTransportCode
      || retryableHttpStatus
      || sourceName === "AbortError";

    return new CarrierDispatchAuthorityError(code, message, {
      retryable,
      context: {
        commandId: input.commandId,
        providerLabelId: input.providerLabelId,
        sourceCode,
        sourceName,
        sourceMessage,
      },
      cause: error,
    });
  }

  function trackingIdentitySuffix(normalizedTrackingNumber: string): string {
    return normalizedTrackingNumber.slice(-8);
  }

  function requiredAuthorityText(
    value: string,
    field: string,
    maxLength: number,
  ): string {
    const normalized = value?.trim();
    if (!normalized || normalized.length > maxLength) {
      throw new Error(
        `Manual shipment authority ${field} must contain 1 through ${maxLength} characters`,
      );
    }
    return normalized;
  }

  return {
    processManualShipmentNotification,
    processShipNotify,
    processProviderLabelSnapshots,
    observeProviderLabels,
    confirmDispatch,
  };
}
