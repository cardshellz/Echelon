import { describe, expect, it } from "vitest";

import {
  DEMAND_TRUST_REASON,
  InventoryDemandEvidenceError,
  completeUtcDemandWindow,
  planDemandEvidenceSnapshots,
  type DemandConsumptionEvent,
} from "../../domain/inventory-demand-evidence";

const windowStartedAt = new Date("2026-08-02T00:00:00.000Z");
const windowEndedAt = new Date("2026-08-30T00:00:00.000Z");
const calculatedAt = new Date("2026-08-30T12:30:00.000Z");

describe("inventory demand evidence", () => {
  it("uses complete UTC days for the deterministic observation window", () => {
    expect(completeUtcDemandWindow(calculatedAt, 28)).toEqual({
      windowStartedAt,
      windowEndedAt,
    });
  });

  it("trusts recent irreversible consumption with enough independent evidence", () => {
    const result = plan([event({
      eventKey: "shipment-item:2",
      sourceKey: "shipment:2",
      occurredAt: new Date("2026-08-25T16:00:00.000Z"),
      quantityUnits: BigInt(2),
    }), event({
      eventKey: "shipment-item:1",
      sourceKey: "shipment:1",
      occurredAt: new Date("2026-08-20T15:00:00.000Z"),
      quantityUnits: BigInt(3),
    })]);

    expect(result).toMatchObject({
      irreversibleConsumptionUnits: BigInt(5),
      observedDays: 28,
      dailyDemandMilliUnits: BigInt(179),
      trustStatus: "trusted",
      trustReasons: [],
    });
    expect(result.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("counts posted component consumption as demand for the consumed SKU", () => {
    const result = plan([event({
      eventKey: "build-consumption:1",
      sourceKey: "build-run:1",
      sourceType: "build_component",
      purpose: "build_component_consumption",
      occurredAt: new Date("2026-08-20T15:00:00.000Z"),
      quantityUnits: BigInt(2),
    }), event({
      eventKey: "build-consumption:2",
      sourceKey: "build-run:2",
      sourceType: "build_component",
      purpose: "build_component_consumption",
      occurredAt: new Date("2026-08-25T16:00:00.000Z"),
      quantityUnits: BigInt(3),
    })]);

    expect(result.irreversibleConsumptionUnits).toBe(BigInt(5));
    expect(result.trustStatus).toBe("trusted");
  });

  it("records explicit trust failures instead of silently accepting thin demand", () => {
    const result = plan([]);

    expect(result.trustStatus).toBe("untrusted");
    expect(result.trustReasons).toEqual([
      DEMAND_TRUST_REASON.insufficientActiveDays,
      DEMAND_TRUST_REASON.insufficientConsumptionUnits,
      DEMAND_TRUST_REASON.insufficientSourceEvents,
      DEMAND_TRUST_REASON.noRecentConsumption,
    ].sort());
  });

  it("keeps a young SKU and warehouse pair untrusted until 14 complete days exist", () => {
    const result = planDemandEvidenceSnapshots({
      resources: [{
        productVariantId: 101,
        warehouseId: 1,
        observationStartedAt: new Date("2026-08-25T00:00:00.000Z"),
      }],
      windowStartedAt,
      windowEndedAt,
      calculatedAt,
      events: [event({
        eventKey: "shipment-item:1",
        sourceKey: "shipment:1",
        occurredAt: new Date("2026-08-25T15:00:00.000Z"),
        quantityUnits: BigInt(3),
      }), event({
        eventKey: "shipment-item:2",
        sourceKey: "shipment:2",
        occurredAt: new Date("2026-08-27T16:00:00.000Z"),
        quantityUnits: BigInt(2),
      })],
    })[0]!;

    expect(result.observedDays).toBe(5);
    expect(result.trustStatus).toBe("untrusted");
    expect(result.trustReasons).toContain(DEMAND_TRUST_REASON.insufficientObservationDays);
  });

  it("does not attribute unresolved consumption units but marks the affected scope untrusted", () => {
    const exactEvents = [event({
      eventKey: "shipment-item:1",
      sourceKey: "shipment:1",
      occurredAt: new Date("2026-08-20T15:00:00.000Z"),
      quantityUnits: BigInt(3),
    }), event({
      eventKey: "shipment-item:2",
      sourceKey: "shipment:2",
      occurredAt: new Date("2026-08-25T16:00:00.000Z"),
      quantityUnits: BigInt(2),
    })];
    const result = plan([...exactEvents, event({
      eventKey: "shipment-item:unresolved",
      sourceKey: "shipment:3",
      productVariantId: null,
      occurredAt: new Date("2026-08-26T16:00:00.000Z"),
      quantityUnits: BigInt(9),
    })]);

    expect(result.irreversibleConsumptionUnits).toBe(BigInt(5));
    expect(result.trustStatus).toBe("untrusted");
    expect(result.trustReasons).toContain(DEMAND_TRUST_REASON.unresolvedVariant);
  });

  it("produces the same fingerprint regardless of query result order", () => {
    const first = event({
      eventKey: "shipment-item:1",
      sourceKey: "shipment:1",
      occurredAt: new Date("2026-08-20T15:00:00.000Z"),
      quantityUnits: BigInt(3),
    });
    const second = event({
      eventKey: "shipment-item:2",
      sourceKey: "shipment:2",
      occurredAt: new Date("2026-08-25T16:00:00.000Z"),
      quantityUnits: BigInt(2),
    });

    expect(plan([first, second]).inputFingerprint).toBe(plan([second, first]).inputFingerprint);
  });

  it("rejects duplicate, zero, and out-of-window evidence at the domain boundary", () => {
    const valid = event({
      eventKey: "shipment-item:1",
      sourceKey: "shipment:1",
      occurredAt: new Date("2026-08-20T15:00:00.000Z"),
      quantityUnits: BigInt(3),
    });
    expect(() => plan([valid, valid])).toThrowError(expect.objectContaining({
      code: "DUPLICATE_CONSUMPTION_EVENT",
    }) as InventoryDemandEvidenceError);
    expect(() => plan([event({ quantityUnits: BigInt(0) })])).toThrowError(expect.objectContaining({
      code: "INVALID_CONSUMPTION_QUANTITY",
    }) as InventoryDemandEvidenceError);
    expect(() => plan([event({ occurredAt: windowEndedAt })])).toThrowError(expect.objectContaining({
      code: "CONSUMPTION_EVENT_OUTSIDE_WINDOW",
    }) as InventoryDemandEvidenceError);
  });
});

function plan(events: DemandConsumptionEvent[]) {
  return planDemandEvidenceSnapshots({
    resources: [{
      productVariantId: 101,
      warehouseId: 1,
      observationStartedAt: windowStartedAt,
    }],
    windowStartedAt,
    windowEndedAt,
    calculatedAt,
    events,
  })[0]!;
}

function event(overrides: Partial<DemandConsumptionEvent> = {}): DemandConsumptionEvent {
  return {
    eventKey: "shipment-item:default",
    sourceKey: "shipment:default",
    sourceType: "physical_shipment",
    productVariantId: 101,
    warehouseId: 1,
    occurredAt: new Date("2026-08-25T12:00:00.000Z"),
    quantityUnits: BigInt(1),
    purpose: "customer_fulfillment",
    trustReasons: [],
    ...overrides,
  };
}
