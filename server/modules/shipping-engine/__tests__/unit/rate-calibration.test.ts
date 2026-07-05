import { describe, expect, it } from "vitest";
import {
  CALIBRATION_BAND_CEILINGS_GRAMS,
  CALIBRATION_SAMPLE_WEIGHTS_GRAMS,
  defaultDestinations,
  runCalibration,
  type CalibrationDeps,
  type CalibrationDestination,
} from "../../application/rate-calibration.service";
import type {
  ShipStationV2RatingAdapter,
  V2NormalizedRate,
  V2RateRequest,
} from "../../infrastructure/shipstation-v2-rating.adapter";
import type {
  RateTableImportInput,
  RateTableImportOutcome,
} from "../../application/rate-table-import.service";

// ---------------------------------------------------------------------------
// Fakes — no network, no DB
// ---------------------------------------------------------------------------

function rate(overrides: Partial<V2NormalizedRate> = {}): V2NormalizedRate {
  return {
    carrier: "USPS",
    serviceCode: "usps_ground_advantage",
    serviceName: "Ground Advantage",
    amountCents: 500,
    currency: "USD",
    deliveryDays: 3,
    estimatedDeliveryDate: null,
    ...overrides,
  };
}

interface FakeAdapterOptions {
  configured?: boolean;
  /** Rates per call; postalCode+weight are available to compute amounts. */
  quote?: (request: V2RateRequest) => V2NormalizedRate[];
  /** Throw on these 0-based call indexes. */
  failOnCalls?: Set<number>;
}

function fakeAdapter(options: FakeAdapterOptions = {}) {
  const calls: V2RateRequest[] = [];
  const adapter: ShipStationV2RatingAdapter = {
    isConfigured: () => options.configured ?? true,
    async getRates(request) {
      const index = calls.length;
      calls.push(request);
      if (options.failOnCalls?.has(index)) {
        throw new Error(`boom on call ${index}`);
      }
      return { configured: true, rates: options.quote ? options.quote(request) : [rate()] };
    },
    async listCarriers() {
      return { configured: true, carriers: [] };
    },
  };
  return { adapter, calls };
}

function fakeDeps(
  adapterOptions: FakeAdapterOptions = {},
  overrides: Partial<CalibrationDeps> = {},
) {
  const { adapter, calls } = fakeAdapter(adapterOptions);
  const imports: RateTableImportInput[] = [];
  let nextTableId = 100;
  const deps: CalibrationDeps = {
    adapter,
    importTable: async (input): Promise<RateTableImportOutcome> => {
      imports.push(input);
      return {
        ok: true,
        rateTable: { id: nextTableId++ } as never,
        rowCount: input.rows.length,
        warnings: [],
      };
    },
    loadOriginWarehouse: async (warehouseId) => ({
      warehouseId,
      postalCode: "17701",
      state: "PA",
      country: "US",
    }),
    getActiveTable: async () => null,
    clock: () => new Date("2026-07-05T12:00:00Z"),
    sleep: async () => {},
    ...overrides,
  };
  return { deps, calls, imports };
}

/** One destination per zone keeps call counts small for most tests. */
const SINGLE_DESTS: CalibrationDestination[] = [
  { zone: "US-48", postalCode: "66044", state: "KS" },
  { zone: "US-HIPRAK", postalCode: "96813", state: "HI" },
];

// ---------------------------------------------------------------------------
// Not-configured path
// ---------------------------------------------------------------------------

describe("runCalibration — not configured", () => {
  it("no-ops with configured:false and never quotes or writes", async () => {
    const { deps, calls, imports } = fakeDeps({ configured: false });
    const report = await runCalibration({ dryRun: false }, deps);

    expect(report.configured).toBe(false);
    expect(report.message).toMatch(/SHIPSTATION_V2_API_KEY/);
    expect(report.carriers).toEqual([]);
    expect(report.written).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(imports).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Band construction / sample→band mapping
// ---------------------------------------------------------------------------

describe("runCalibration — band construction", () => {
  it("quotes every sample midpoint and maps them 1:1 onto contiguous ceilings", async () => {
    const { deps, calls } = fakeDeps();
    const report = await runCalibration({ destinations: SINGLE_DESTS }, deps);

    // Every (band, destination) pair was quoted with the midpoint weight.
    expect(calls).toHaveLength(CALIBRATION_SAMPLE_WEIGHTS_GRAMS.length * SINGLE_DESTS.length);
    const weightsQuoted = calls.map((c) => c.parcels[0].weightGrams);
    expect(new Set(weightsQuoted)).toEqual(new Set(CALIBRATION_SAMPLE_WEIGHTS_GRAMS));

    // One combo, both zones, all 10 bands per zone.
    expect(report.carriers).toHaveLength(1);
    const table = report.carriers[0];
    expect(table.zones).toEqual(["US-48", "US-HIPRAK"]);
    expect(table.rows).toHaveLength(CALIBRATION_BAND_CEILINGS_GRAMS.length * 2);

    // Bands are contiguous [prev_ceiling+1 .. ceiling], starting at 0.
    const us48 = table.rows.filter((r) => r.destinationZone === "US-48");
    expect(us48.map((r) => [r.minWeightGrams, r.maxWeightGrams])).toEqual([
      [0, 170], [171, 340], [341, 567], [568, 1134], [1135, 1701],
      [1702, 2722], [2723, 5443], [5444, 10886], [10887, 16329], [16330, 27216],
    ]);
    // Rows are scoped to the sampled origin warehouse.
    expect(new Set(table.rows.map((r) => r.originWarehouseId))).toEqual(new Set([1]));
  });

  it("rejects a weight override that does not align 1:1 with the ceilings", async () => {
    const { deps, calls } = fakeDeps();
    const report = await runCalibration({ weightBandsGrams: [100, 200] }, deps);

    expect(report.errors.some((e) => e.includes("1:1 with the band ceilings"))).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MAX-across-destinations aggregation
// ---------------------------------------------------------------------------

describe("runCalibration — aggregation", () => {
  it("takes the MAX quote across a zone's sample destinations (never undercharge)", async () => {
    const dests: CalibrationDestination[] = [
      { zone: "US-48", postalCode: "66044" },
      { zone: "US-48", postalCode: "17701" },
    ];
    const { deps } = fakeDeps({
      quote: (request) => [
        // The near-origin ZIP quotes cheaper; the mid-country ZIP must win.
        rate({ amountCents: request.to.postalCode === "66044" ? 950 : 425 }),
      ],
    });
    const report = await runCalibration({ destinations: dests }, deps);

    const rows = report.carriers[0].rows;
    expect(rows).toHaveLength(CALIBRATION_BAND_CEILINGS_GRAMS.length);
    expect(new Set(rows.map((r) => r.rateCents))).toEqual(new Set([950]));
    expect(report.carriers[0].minRateCents).toBe(950);
    expect(report.carriers[0].maxRateCents).toBe(950);
  });

  it("aggregates per (carrier, serviceCode) separately", async () => {
    const { deps } = fakeDeps({
      quote: () => [
        rate({ amountCents: 500 }),
        rate({ carrier: "UPS", serviceCode: "ups_ground", amountCents: 700 }),
      ],
    });
    const report = await runCalibration({ destinations: SINGLE_DESTS }, deps);

    expect(report.carriers.map((c) => `${c.carrier} ${c.serviceCode}`)).toEqual([
      "UPS ups_ground",
      "USPS usps_ground_advantage",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Dry run + manual-table protection
// ---------------------------------------------------------------------------

describe("runCalibration — write gating", () => {
  it("dry run (the default) writes nothing but reports the would-be tables", async () => {
    const { deps, imports } = fakeDeps();
    const report = await runCalibration({ destinations: SINGLE_DESTS }, deps);

    expect(report.dryRun).toBe(true);
    expect(report.carriers).toHaveLength(1);
    expect(report.carriers[0].rows.length).toBeGreaterThan(0);
    expect(report.written).toEqual([]);
    expect(imports).toHaveLength(0);
  });

  it("skips an active manual table unless overwriteManual is set", async () => {
    const { deps, imports } = fakeDeps({}, {
      getActiveTable: async () => ({ id: 7, metadata: { source: "admin-import" } }),
    });
    const report = await runCalibration({ dryRun: false, destinations: SINGLE_DESTS }, deps);

    expect(imports).toHaveLength(0);
    expect(report.written).toEqual([]);
    expect(report.skippedManualTables).toEqual([
      { carrier: "USPS", serviceCode: "usps_ground_advantage", source: "admin-import" },
    ]);
  });

  it("treats an active table WITHOUT metadata.source as manual", async () => {
    const { deps, imports } = fakeDeps({}, {
      getActiveTable: async () => ({ id: 7, metadata: null }),
    });
    const report = await runCalibration({ dryRun: false, destinations: SINGLE_DESTS }, deps);

    expect(imports).toHaveLength(0);
    expect(report.skippedManualTables).toEqual([
      { carrier: "USPS", serviceCode: "usps_ground_advantage", source: "unknown" },
    ]);
  });

  it("overwriteManual:true supersedes a manual table through the import service", async () => {
    const { deps, imports } = fakeDeps({}, {
      getActiveTable: async () => ({ id: 7, metadata: { source: "admin-import" } }),
    });
    const report = await runCalibration(
      { dryRun: false, overwriteManual: true, destinations: SINGLE_DESTS },
      deps,
    );

    expect(imports).toHaveLength(1);
    expect(report.skippedManualTables).toEqual([]);
    expect(report.written).toEqual([
      { carrier: "USPS", serviceCode: "usps_ground_advantage", rateTableId: 100 },
    ]);
  });

  it("replaces a prior calibration table and stamps calibration provenance", async () => {
    const { deps, imports } = fakeDeps({}, {
      getActiveTable: async () => ({ id: 7, metadata: { source: "calibration" } }),
    });
    const report = await runCalibration({ dryRun: false, destinations: SINGLE_DESTS }, deps);

    expect(report.written).toHaveLength(1);
    expect(imports).toHaveLength(1);
    expect(imports[0].replaceExisting).toBe(true);
    expect(imports[0].metadata).toMatchObject({
      source: "calibration",
      sampledAt: "2026-07-05T12:00:00.000Z",
      bands: [...CALIBRATION_BAND_CEILINGS_GRAMS],
      adapterVersion: expect.stringContaining("shipstation-v2-calibration"),
    });
  });

  it("writes fresh tables when no active table exists", async () => {
    const { deps, imports } = fakeDeps();
    const report = await runCalibration({ dryRun: false, destinations: SINGLE_DESTS }, deps);

    expect(imports).toHaveLength(1);
    expect(report.written).toHaveLength(1);
    expect(report.skippedManualTables).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Consecutive-error abort
// ---------------------------------------------------------------------------

describe("runCalibration — error handling", () => {
  it("aborts the whole run (no writes) after 3 consecutive adapter errors", async () => {
    const { deps, calls, imports } = fakeDeps({ failOnCalls: new Set([0, 1, 2]) });
    const report = await runCalibration({ dryRun: false, destinations: SINGLE_DESTS }, deps);

    expect(report.aborted).toBe(true);
    expect(calls).toHaveLength(3); // stopped immediately at the third failure
    expect(report.carriers).toEqual([]);
    expect(report.written).toEqual([]);
    expect(imports).toHaveLength(0);
    expect(report.errors.some((e) => e.includes("3 consecutive adapter errors"))).toBe(true);
  });

  it("a success in between resets the consecutive-error counter", async () => {
    // Fail calls 0 and 1, succeed 2, fail 3 — never 3 in a row.
    const { deps, calls } = fakeDeps({ failOnCalls: new Set([0, 1, 3]) });
    const report = await runCalibration({ destinations: SINGLE_DESTS }, deps);

    expect(report.aborted).toBe(false);
    expect(calls).toHaveLength(CALIBRATION_SAMPLE_WEIGHTS_GRAMS.length * SINGLE_DESTS.length);
    expect(report.errors.filter((e) => e.startsWith("quote failed"))).toHaveLength(3);
    // The surviving samples still produced a table.
    expect(report.carriers).toHaveLength(1);
  });

  it("reports an error when the origin warehouse is missing or has no ZIP", async () => {
    const missing = fakeDeps({}, { loadOriginWarehouse: async () => null });
    const noZip = fakeDeps({}, {
      loadOriginWarehouse: async (id) => ({ warehouseId: id, postalCode: null, state: null, country: "US" }),
    });

    const missingReport = await runCalibration({}, missing.deps);
    expect(missingReport.errors.some((e) => e.includes("not found"))).toBe(true);
    expect(missing.calls).toHaveLength(0);

    const noZipReport = await runCalibration({}, noZip.deps);
    expect(noZipReport.errors.some((e) => e.includes("no postal code"))).toBe(true);
    expect(noZip.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Default destination sample
// ---------------------------------------------------------------------------

describe("defaultDestinations", () => {
  it("samples mid-country + origin ZIP for US-48 and HI/AK/PR for US-HIPRAK", () => {
    expect(defaultDestinations("17701")).toEqual([
      { zone: "US-48", postalCode: "66044", state: "KS" },
      { zone: "US-48", postalCode: "17701" },
      { zone: "US-HIPRAK", postalCode: "96813", state: "HI" },
      { zone: "US-HIPRAK", postalCode: "99501", state: "AK" },
      { zone: "US-HIPRAK", postalCode: "00907", state: "PR" },
    ]);
  });

  it("does not duplicate the mid-country ZIP when the origin IS 66044", () => {
    const dests = defaultDestinations("66044");
    expect(dests.filter((d) => d.postalCode === "66044")).toHaveLength(1);
  });
});
