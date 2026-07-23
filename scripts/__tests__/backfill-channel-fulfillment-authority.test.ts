import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  buildCandidateQuery,
  parseFlags,
  runBackfill,
  type BackfillCandidate,
} from "../backfill-channel-fulfillment-authority";

const candidate: BackfillCandidate = Object.freeze({
  representativeShipmentId: 4842,
  shippingProvider: "shipstation",
  providerPhysicalShipmentId: "444087291",
  legacyShipmentIds: Object.freeze([4842, 6001]),
  orderNumbers: Object.freeze(["#59564", "#59582"]),
  trackingNumber: "9400150206217777402897",
  missingPhysicalShipment: false,
  missingCommandItemCount: 1,
});

const resolvedPackage = Object.freeze({
  legacyWmsShipmentIds: Object.freeze([4842, 6001]),
  shippingProvider: "shipstation",
  providerPhysicalShipmentId: "444087291",
  providerOrderId: "755802673",
  providerOrderKey: "echelon-wms-shp-4842",
  trackingNumber: candidate.trackingNumber,
  carrier: "USPS",
  trackingUrl: null,
  serviceCode: null,
  shippedAt: new Date("2026-06-28T14:08:50.000Z"),
});

describe("backfill-channel-fulfillment-authority", () => {
  it("does not import dev-only dotenv in the production operator script", () => {
    const source = readFileSync(
      new URL("../backfill-channel-fulfillment-authority.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/(?:import|require\s*\()\s*["']dotenv(?:\/config)?["']/);
  });

  it("defaults to a bounded dry-run and validates mutation flags", () => {
    expect(parseFlags([])).toEqual({
      help: false,
      mode: "dry-run",
      limit: 100,
      orderNumber: null,
      wmsShipmentId: null,
      json: false,
    });
    expect(parseFlags([
      "--execute",
      "--limit=all",
      "--order-number=#59564",
      "--wms-shipment-id=4842",
      "--json",
    ])).toMatchObject({
      mode: "execute",
      limit: null,
      orderNumber: "#59564",
      wmsShipmentId: 4842,
      json: true,
    });
    expect(() => parseFlags(["--execute", "--dry-run"])).toThrow(/Cannot pass both/);
    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--order-number="])).toThrow(/cannot be blank/);
    expect(() => parseFlags(["--unknown"])).toThrow(/Unknown flag/);
  });

  it("builds a parameterized read-only package and command coverage query", () => {
    const query = buildCandidateQuery(parseFlags([
      "--order-number=#59564",
      "--wms-shipment-id=4842",
      "--limit=25",
    ]));

    expect(query.values).toEqual(["#59564", 4842, 25]);
    expect(query.text).toContain("wms.physical_shipments");
    expect(query.text).toContain("oms.channel_fulfillment_push_items");
    expect(query.text).toContain("legacy_wms_shipment_item_id");
    expect(query.text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it("validates lineage without materializing in dry-run mode", async () => {
    const repository = {
      resolveLegacyPhysicalPackage: vi.fn(async () => resolvedPackage),
      materializePhysicalPackage: vi.fn(),
    };
    const summary = await runBackfill(parseFlags([]), {
      loadCandidates: vi.fn(async () => [candidate]),
      repository: repository as any,
      log: vi.fn(),
    });

    expect(summary).toMatchObject({
      candidates: 1,
      lineageValidated: 1,
      materialized: 0,
      commandsCreated: 0,
      reviewRequired: 0,
    });
    expect(repository.resolveLegacyPhysicalPackage).toHaveBeenCalledWith(4842);
    expect(repository.materializePhysicalPackage).not.toHaveBeenCalled();
  });

  it("reports dry-run lineage failures for manual review without materializing", async () => {
    const error = Object.assign(new Error("stable package identity is missing"), {
      code: "PACKAGE_IDENTITY_CONFLICT",
    });
    const repository = {
      resolveLegacyPhysicalPackage: vi.fn(async () => { throw error; }),
      materializePhysicalPackage: vi.fn(),
    };
    const summary = await runBackfill(parseFlags([]), {
      loadCandidates: vi.fn(async () => [candidate]),
      repository: repository as any,
      log: vi.fn(),
    });

    expect(summary).toMatchObject({
      candidates: 1,
      lineageValidated: 0,
      materialized: 0,
      reviewRequired: 1,
      failures: [expect.objectContaining({
        representativeShipmentId: 4842,
        code: "PACKAGE_IDENTITY_CONFLICT",
        message: "stable package identity is missing",
      })],
    });
    expect(repository.materializePhysicalPackage).not.toHaveBeenCalled();
  });

  it("materializes canonical rows without dispatching a provider call", async () => {
    const repository = {
      resolveLegacyPhysicalPackage: vi.fn(async () => resolvedPackage),
      materializePhysicalPackage: vi.fn(async () => ({
        fulfillmentPlanIds: Object.freeze([1]),
        shipmentRequestIds: Object.freeze([2]),
        shippingEngineOrderId: 3,
        physicalShipmentId: 4,
        channelCommands: Object.freeze([
          { id: 5, commandKey: "command-5", pushStatus: "pending", replayed: false },
        ]),
      })),
    };
    const summary = await runBackfill(parseFlags(["--execute"]), {
      loadCandidates: vi.fn(async () => [candidate]),
      repository: repository as any,
      log: vi.fn(),
    });

    expect(repository.resolveLegacyPhysicalPackage).toHaveBeenCalledWith(4842);
    expect(repository.materializePhysicalPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyWmsShipmentIds: [4842, 6001],
        source: "script:backfill-channel-fulfillment-authority",
      }),
    );
    expect(summary).toMatchObject({
      lineageValidated: 1,
      materialized: 1,
      commandsCreated: 1,
      commandsReplayed: 0,
      reviewRequired: 0,
    });
  });
});
