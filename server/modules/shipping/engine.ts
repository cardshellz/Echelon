/**
 * ShippingEngine — canonical port interface (C9).
 *
 * The pipeline speaks this interface; engine-specific adapters
 * (ShipStation = adapter #1) implement it. No core, reconciler,
 * or route calls engine-specific methods directly.
 *
 * Design rules:
 *   - All methods accept/return canonical types (types.ts).
 *   - Engine-specific fields never leak past the adapter.
 *   - The adapter handles retries, auth, rate limiting internally.
 *   - Results are always returned (no void + side-effect patterns)
 *     so callers can branch on outcome (e.g. alreadyInState).
 */

import type {
  EnginePushResult,
  EngineCancelResult,
  EngineMarkShippedResult,
  EngineOrderState,
  EngineRef,
  ShipmentPushPayload,
  CanonicalShipmentEvent,
} from "./types";

export interface ShippingEngine {
  readonly engineName: string;

  isConfigured(): boolean;

  /**
   * Create or update a shipment in the external engine.
   * Idempotent: re-pushing the same shipment updates in place.
   */
  upsertShipment(payload: ShipmentPushPayload): Promise<EnginePushResult>;

  /**
   * Cancel a shipment in the engine. Returns { alreadyInState: true }
   * when the engine order is already in a terminal state (shipped/cancelled).
   */
  cancel(engineRef: EngineRef): Promise<EngineCancelResult>;

  /**
   * Place a shipment on indefinite hold in the engine.
   */
  hold(engineRef: EngineRef): Promise<void>;

  /**
   * Release a held shipment so the engine can process it.
   */
  releaseHold(engineRef: EngineRef): Promise<void>;

  /**
   * Mark a shipment as shipped in the engine (outbound push).
   */
  markShipped(
    engineRef: EngineRef,
    opts: {
      shipDate: Date | string;
      trackingNumber?: string | null;
      carrierCode?: string | null;
      notifyCustomer?: boolean;
    },
  ): Promise<EngineMarkShippedResult>;

  /**
   * Update sort rank / priority metadata on an engine order.
   */
  updatePriority(engineRef: EngineRef, sortRank: string): Promise<void>;

  /**
   * Query the current state of an order in the engine.
   * Returns null if the order doesn't exist.
   */
  getState(engineRef: EngineRef): Promise<EngineOrderState | null>;

  /**
   * Fetch shipments (tracking events) for an engine order.
   */
  getShipments(
    engineRef: EngineRef,
    opts?: { orderNumber?: string },
  ): Promise<CanonicalShipmentEvent[]>;

  /**
   * Apply all inbound physical-package facts for one sales order through the
   * engine adapter's authoritative webhook/package resolver. Reconcilers use
   * this instead of applying a single canonical event to a parent shipment,
   * which is unsafe when the engine has split the order into multiple packages.
   */
  applyInboundShipmentAuthority?(args: {
    engineRef: EngineRef;
    orderNumber: string;
  }): Promise<number>;

  /**
   * Normalize a raw webhook payload into canonical shipment events.
   * The adapter knows the vendor's webhook format; the pipeline
   * consumes only CanonicalShipmentEvent[].
   */
  normalizeWebhook(rawPayload: unknown): Promise<CanonicalShipmentEvent[]>;

  /**
   * Process a webhook notification end-to-end (fetch resource, apply
   * state changes, write DB). Returns the number of shipments processed.
   * Phase 3: delegates to the engine service's internal processing.
   */
  processWebhook(resourceUrl: string): Promise<number>;

  /**
   * Register a webhook endpoint with the engine.
   */
  registerWebhook(targetUrl: string): Promise<void>;

  /**
   * Run maintenance sweep on the engine's queue. Flags stranded orders
   * for review. Optional — engines without queues omit this.
   */
  sweepQueue?(): Promise<void>;
}
