import { describe, it, expect } from "vitest";
import { deriveReconcileEvent } from "../../reconcile-derive";
import type { EngineOrderState, CanonicalShipmentEvent } from "../../types";

function makeInput(overrides: {
  engineState?: Partial<EngineOrderState>;
  currentWmsShipmentStatus?: string;
  currentTrackingNumber?: string | null;
  currentCarrier?: string | null;
  shipments?: CanonicalShipmentEvent[];
} = {}) {
  return {
    engineState: {
      status: "awaiting_shipment",
      trackingNumber: null,
      carrier: null,
      shipDate: null,
      ...overrides.engineState,
    } as EngineOrderState,
    currentWmsShipmentStatus: overrides.currentWmsShipmentStatus ?? "queued",
    currentTrackingNumber: overrides.currentTrackingNumber ?? null,
    currentCarrier: overrides.currentCarrier ?? null,
    shipments: overrides.shipments ?? [],
  };
}

describe("deriveReconcileEvent", () => {
  it("returns shipped when engine has shipped shipments and WMS is not shipped", () => {
    const result = deriveReconcileEvent(makeInput({
      shipments: [{
        kind: "shipped",
        trackingNumber: "1Z999",
        carrierRaw: "ups",
        shipDate: new Date("2025-01-15"),
        items: [],
      }],
    }));
    expect(result).toEqual({
      kind: "shipped",
      trackingNumber: "1Z999",
      carrier: "ups",
      shipDate: new Date("2025-01-15"),
    });
  });

  it("returns null when shipped and WMS already shipped (idempotent)", () => {
    const result = deriveReconcileEvent(makeInput({
      currentWmsShipmentStatus: "shipped",
      shipments: [{
        kind: "shipped",
        trackingNumber: "1Z999",
        carrierRaw: "ups",
        shipDate: new Date("2025-01-15"),
        items: [],
      }],
    }));
    expect(result).toBeNull();
  });

  it("returns voided when all shipments are voided", () => {
    const result = deriveReconcileEvent(makeInput({
      shipments: [
        { kind: "voided", voidedAt: new Date(), items: [] },
      ],
    }));
    expect(result).toEqual({ kind: "voided", reason: "engine_label_void" });
  });

  it("returns null when all voided but WMS already voided", () => {
    const result = deriveReconcileEvent(makeInput({
      currentWmsShipmentStatus: "voided",
      shipments: [
        { kind: "voided", voidedAt: new Date(), items: [] },
      ],
    }));
    expect(result).toBeNull();
  });

  it("returns cancelled when engine status is cancelled and WMS not cancelled", () => {
    const result = deriveReconcileEvent(makeInput({
      engineState: { status: "cancelled" },
    }));
    expect(result).toEqual({ kind: "cancelled", reason: "engine_cancelled" });
  });

  it("returns null when engine cancelled and WMS already cancelled", () => {
    const result = deriveReconcileEvent(makeInput({
      engineState: { status: "cancelled" },
      currentWmsShipmentStatus: "cancelled",
    }));
    expect(result).toBeNull();
  });

  it("shipped wins over voided when mixed (replacement label)", () => {
    const result = deriveReconcileEvent(makeInput({
      shipments: [
        { kind: "voided", voidedAt: new Date("2025-01-14"), items: [] },
        { kind: "shipped", trackingNumber: "REPLACE1", carrierRaw: "fedex", shipDate: new Date("2025-01-15"), items: [] },
      ],
    }));
    expect(result).toEqual({
      kind: "shipped",
      trackingNumber: "REPLACE1",
      carrier: "fedex",
      shipDate: new Date("2025-01-15"),
    });
  });

  it("returns null when no divergence detected", () => {
    const result = deriveReconcileEvent(makeInput());
    expect(result).toBeNull();
  });

  it("falls back to current tracking/carrier when shipment data is empty", () => {
    const result = deriveReconcileEvent(makeInput({
      currentTrackingNumber: "FALLBACK123",
      currentCarrier: "usps",
      shipments: [{
        kind: "shipped",
        trackingNumber: "",
        carrierRaw: "",
        shipDate: new Date("2025-01-15"),
        items: [],
      }],
    }));
    expect(result).toEqual({
      kind: "shipped",
      trackingNumber: "FALLBACK123",
      carrier: "usps",
      shipDate: new Date("2025-01-15"),
    });
  });

  it("uses latest shipped event for tracking number", () => {
    const result = deriveReconcileEvent(makeInput({
      shipments: [
        { kind: "shipped", trackingNumber: "FIRST", carrierRaw: "ups", shipDate: new Date("2025-01-14"), items: [] },
        { kind: "shipped", trackingNumber: "SECOND", carrierRaw: "fedex", shipDate: new Date("2025-01-15"), items: [] },
      ],
    }));
    expect(result?.kind).toBe("shipped");
    expect((result as any).trackingNumber).toBe("SECOND");
    expect((result as any).carrier).toBe("fedex");
  });
});
