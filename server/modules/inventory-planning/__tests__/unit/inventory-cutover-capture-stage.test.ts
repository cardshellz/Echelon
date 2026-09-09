import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { reconstructionEvidence } from "../fixtures/inventory-cutover-reconstruction.fixture";
import { captureInventoryCutoverStage, InventoryCutoverCaptureError,
  type InventoryCutoverCaptureStage } from "../../infrastructure/inventory-cutover-capture-stage";
import { PostgresInventoryCutoverReconstructionRepository } from "../../infrastructure/inventory-cutover-reconstruction.repository";
import { readInventoryCutoverReconstruction } from "../../../inventory/infrastructure/inventory-cutover-reconstruction.reader";
import { readWmsCutoverReconstruction, readWmsCutoverShipmentReviews } from "../../../wms/inventory-cutover-reconstruction.reader";
import { readCutoverOriginalCosts } from "../../../orders/inventory-cutover-reconstruction-cost.reader";
import { readOmsCutoverReconstruction } from "../../../oms/inventory-cutover-reconstruction.reader";
import { assertInventoryCutoverFenceHeldInsideTransaction } from "../../infrastructure/inventory-cutover-admission-fence.repository";

vi.mock("../../../../db", () => ({ pool: {} }));
vi.mock("../../../inventory/infrastructure/inventory-cutover-reconstruction.reader", () => ({ readInventoryCutoverReconstruction: vi.fn() }));
vi.mock("../../../wms/inventory-cutover-reconstruction.reader", () => ({ readWmsCutoverReconstruction: vi.fn(), readWmsCutoverShipmentReviews: vi.fn() }));
vi.mock("../../../orders/inventory-cutover-reconstruction-cost.reader", () => ({ readCutoverOriginalCosts: vi.fn() }));
vi.mock("../../../oms/inventory-cutover-reconstruction.reader", () => ({ readOmsCutoverReconstruction: vi.fn() }));
vi.mock("../../infrastructure/inventory-cutover-admission-fence.repository", () => ({ assertInventoryCutoverFenceHeldInsideTransaction: vi.fn() }));

const SECRET = "postgresql://private:credential@internal.example/db SELECT private_customer_data";

describe("named inventory cutover capture errors", () => {
  it("returns the complete result without wrapping or mutating it", async () => {
    const result = Object.freeze({ complete: true, count: "9007199254740993" });
    const work = vi.fn(async () => result);
    expect(await captureInventoryCutoverStage("inventory_custody", work)).toBe(result);
    expect(work).toHaveBeenCalledOnce();
  });

  it.each([
    ["57014", "TIMEOUT", 503], ["40001", "CONFLICT", 409],
    ["40P01", "CONFLICT", 409], ["55P03", "CONFLICT", 409],
    ["42P01", "FAILED", 500],
  ])("classifies PostgreSQL %s without retrying or exposing raw details", async (postgresCode, kind, status) => {
    const cause = Object.assign(new Error(SECRET), { code: postgresCode, detail: SECRET });
    const work = vi.fn(async () => { throw cause; });
    const failure = await captureInventoryCutoverStage("oms_demand_and_receipts", work).catch(error => error);
    expect(failure).toBeInstanceOf(InventoryCutoverCaptureError);
    expect(failure).toMatchObject({ stage: "oms_demand_and_receipts", code: `CUTOVER_EVIDENCE_CAPTURE_${kind}`, status, postgresCode });
    expect(failure.cause).toBe(cause);
    expect(failure.message).toContain("sales-channel demand and shipment acknowledgments");
    expect(failure.message).not.toContain(SECRET);
    expect(JSON.stringify(failure)).not.toContain(SECRET);
    expect(work).toHaveBeenCalledOnce();
  });

  it.each([
    "INVENTORY_CUTOVER_CAPTURE_LIMIT_EXCEEDED", "INVENTORY_CUTOVER_RECONSTRUCTION_CENSUS_LIMIT_EXCEEDED",
    "CUTOVER_JOURNAL_ROW_LIMIT_EXCEEDED", "CUTOVER_JOURNAL_GROUP_LIMIT_EXCEEDED", "WMS_CUTOVER_RECONSTRUCTION_CENSUS_LIMIT_EXCEEDED",
    "WMS_CUTOVER_REVIEW_CENSUS_LIMIT_EXCEEDED", "CUTOVER_ORIGINAL_COST_CENSUS_LIMIT_EXCEEDED",
    "CUTOVER_VARIANT_CENSUS_LIMIT_EXCEEDED", "OMS_CUTOVER_CENSUS_LIMIT_EXCEEDED",
  ])("recognizes only the exact known complete-census bound: %s", async (code) => {
    for (const cause of [new Error(code), Object.assign(new Error(SECRET), { code })]) {
      const work = vi.fn(async () => { throw cause; });
      const failure = await captureInventoryCutoverStage("inventory_custody", work).catch(error => error);
      expect(failure).toMatchObject({ stage: "inventory_custody", code: "CUTOVER_EVIDENCE_CAPTURE_LIMIT_EXCEEDED", status: 422, postgresCode: null });
      expect(failure.cause).toBe(cause);
      expect(failure.message).not.toContain(SECRET);
      expect(work).toHaveBeenCalledOnce();
    }
  });

  it("classifies invalid evidence while retaining private validation issues only in the cause", async () => {
    const parsed = z.literal("expected").safeParse(SECRET);
    if (parsed.success) throw new Error("Invalid evidence test unexpectedly parsed");
    const failure = await captureInventoryCutoverStage("evidence_validation", async () => { throw parsed.error; }).catch(error => error);
    expect(failure).toMatchObject({ stage: "evidence_validation", code: "CUTOVER_EVIDENCE_CAPTURE_INVALID", status: 500 });
    expect(failure.cause).toBe(parsed.error);
    expect(failure.message).not.toContain(SECRET);
    expect(JSON.stringify(failure)).not.toContain(SECRET);
  });

  it.each([
    undefined, null, SECRET, new Error(SECRET), { code: SECRET, message: SECRET },
    new Error("OMS_CUTOVER_CENSUS_LIMIT_EXCEEDED " + SECRET),
    { code: "OMS_CUTOVER_CENSUS_LIMIT_EXCEEDED_EXTRA", detail: SECRET },
  ])("fails closed on unrecognized thrown data without trusting prefixes: %#", async (cause) => {
    const failure = await captureInventoryCutoverStage("original_costs", async () => { throw cause; }).catch(error => error);
    expect(failure).toMatchObject({ stage: "original_costs", code: "CUTOVER_EVIDENCE_CAPTURE_FAILED", status: 500, postgresCode: null });
    expect(failure.cause).toBe(cause);
    expect(failure.message).not.toMatch(/private|credential|internal\.example/);
    expect(JSON.stringify(failure)).not.toMatch(/private|credential|internal\.example/);
  });

  it("preserves an already-classified inner stage and original cause", async () => {
    const cause = Object.assign(new Error(SECRET), { code: "57014" });
    const inner = new InventoryCutoverCaptureError("inventory_custody", cause);
    const work = vi.fn(async () => { throw inner; });
    expect(await captureInventoryCutoverStage("evidence_validation", work).catch(error => error)).toBe(inner);
    expect(inner.cause).toBe(cause);
    expect(work).toHaveBeenCalledOnce();
  });

  it("rejects an invalid stage before running the supplied operation", async () => {
    const work = vi.fn(async () => "not reached");
    await expect(captureInventoryCutoverStage(SECRET as InventoryCutoverCaptureStage, work)).rejects.toBeInstanceOf(ZodError);
    expect(work).not.toHaveBeenCalled();
  });
});

describe("actual reconstruction repository capture stages", () => {
  const sequence: InventoryCutoverCaptureStage[] = ["transaction_guard", "inventory_custody", "wms_demand_and_packages",
    "variant_identity", "original_costs", "oms_demand_and_receipts", "shipment_reviews"];
  let evidence: CutoverReconstructionEvidence;
  let visited: InventoryCutoverCaptureStage[];
  let failingStage: InventoryCutoverCaptureStage | undefined;
  let failureCause: Error;
  let readOnly: boolean;
  let variantRows: unknown[];
  let query: ReturnType<typeof vi.fn>;
  let client: PoolClient;
  const repository = new PostgresInventoryCutoverReconstructionRepository();

  function enter(stage: InventoryCutoverCaptureStage): void {
    visited.push(stage);
    if (failingStage === stage) throw failureCause;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    evidence = reconstructionEvidence();
    visited = [];
    failingStage = undefined;
    failureCause = Object.assign(new Error(SECRET), { code: "57014" });
    readOnly = true;
    variantRows = evidence.variants;
    query = vi.fn(async (sql: string) => {
      if (sql.includes("current_setting('transaction_isolation')")) {
        enter("transaction_guard");
        return { rows: [{ isolation: readOnly ? "repeatable read" : "read committed", readonly: readOnly ? "on" : "off" }] };
      }
      if (sql.includes("FROM catalog.product_variants")) {
        enter("variant_identity");
        return { rows: variantRows };
      }
      throw new Error("Unexpected query in read-only capture test");
    });
    client = { query } as unknown as PoolClient;
    vi.mocked(assertInventoryCutoverFenceHeldInsideTransaction).mockResolvedValue("1");
    vi.mocked(readInventoryCutoverReconstruction).mockImplementation(async () => {
      enter("inventory_custody");
      const { levels, lots, journals, buildReservations, canonicalResources, canonicalClaimCount, canonicalClaimHash } = evidence;
      return { levels, lots, journals, buildReservations, canonicalResources, canonicalClaimCount, canonicalClaimHash };
    });
    vi.mocked(readWmsCutoverReconstruction).mockImplementation(async () => {
      enter("wms_demand_and_packages");
      const { orders, items, sourceItems, physicalItems, buildDemands } = evidence;
      return { orders, items, sourceItems, physicalItems, buildDemands };
    });
    vi.mocked(readCutoverOriginalCosts).mockImplementation(async () => { enter("original_costs"); return evidence.costs; });
    vi.mocked(readOmsCutoverReconstruction).mockImplementation(async () => {
      enter("oms_demand_and_receipts");
      return { acceptedOmsDemand: evidence.acceptedOmsDemand, shipmentReviewEvidence: evidence.shipmentReviewEvidence };
    });
    vi.mocked(readWmsCutoverShipmentReviews).mockImplementation(async () => { enter("shipment_reviews"); return []; });
  });

  it("captures each owner exactly once, in order, before returning validated complete evidence", async () => {
    expect(await repository.capture(client)).toEqual(evidence);
    expect(visited).toEqual(sequence);
    expect(assertInventoryCutoverFenceHeldInsideTransaction).not.toHaveBeenCalled();
    expect(readWmsCutoverReconstruction).toHaveBeenCalledExactlyOnceWith(client, [1], [11]);
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT\b/.test(sql))).toBe(true);
  });

  it.each(sequence)("reports the exact %s timeout and never calls later owners or returns partial evidence", async (stage) => {
    failingStage = stage;
    const failure = await repository.capture(client).catch(error => error);
    expect(failure).toMatchObject({ stage, code: "CUTOVER_EVIDENCE_CAPTURE_TIMEOUT", status: 503, postgresCode: "57014" });
    expect(failure.cause).toBe(failureCause);
    expect(visited).toEqual(sequence.slice(0, sequence.indexOf(stage) + 1));
    expect(new Set(visited).size).toBe(visited.length);
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT\b/.test(sql))).toBe(true);
    expect(failure).not.toHaveProperty("levels");
    expect(failure).not.toHaveProperty("ready");
  });

  it("names a failed admission assertion as the transaction guard and stops before reading owners", async () => {
    readOnly = false;
    vi.mocked(assertInventoryCutoverFenceHeldInsideTransaction).mockRejectedValue(failureCause);
    const failure = await repository.capture(client).catch(error => error);
    expect(failure).toMatchObject({ stage: "transaction_guard", code: "CUTOVER_EVIDENCE_CAPTURE_TIMEOUT" });
    expect(failure.cause).toBe(failureCause);
    expect(visited).toEqual(["transaction_guard"]);
    expect(assertInventoryCutoverFenceHeldInsideTransaction).toHaveBeenCalledExactlyOnceWith(client);
    expect(readInventoryCutoverReconstruction).not.toHaveBeenCalled();
  });

  it("keeps exact residual identities without duplicating owners before WMS capture", async () => {
    evidence.journals.push({ ...evidence.journals[0], warehouseLocationId: 200 },
      { ...evidence.journals[0], orderId: 2, orderItemId: 22, reservedQty: "0", pickedQty: "0" });
    await repository.capture(client);
    expect(readWmsCutoverReconstruction).toHaveBeenCalledExactlyOnceWith(client, [1], [11]);
  });

  it("rejects invalid complete evidence with the evidence-validation stage rather than returning partial readiness", async () => {
    evidence.costs[0].unitCostMills = SECRET;
    const failure = await repository.capture(client).catch(error => error);
    expect(failure).toMatchObject({ stage: "evidence_validation", code: "CUTOVER_EVIDENCE_CAPTURE_INVALID", status: 500 });
    expect(failure.cause).toBeInstanceOf(ZodError);
    expect(visited).toEqual(sequence);
    expect(failure.message).not.toContain(SECRET);
    expect(failure).not.toHaveProperty("ready");
  });

  it.each(["reservedQty", "pickedQty"] as const)("validates %s before deriving residual ownership", async (quantity) => {
    evidence.journals[0][quantity] = SECRET;
    const failure = await repository.capture(client).catch(error => error);
    expect(failure).toMatchObject({ stage: "inventory_custody", code: "CUTOVER_EVIDENCE_CAPTURE_INVALID", status: 500 });
    expect(failure.cause).toBeInstanceOf(ZodError);
    expect(visited).toEqual(["transaction_guard", "inventory_custody"]);
    expect(readWmsCutoverReconstruction).not.toHaveBeenCalled();
  });

  it("classifies the variant overflow sentinel inside its stage before reading costs", async () => {
    variantRows = Array.from({ length: 100_001 }, () => evidence.variants[0]);
    const failure = await repository.capture(client).catch(error => error);
    expect(failure).toMatchObject({ stage: "variant_identity", code: "CUTOVER_EVIDENCE_CAPTURE_LIMIT_EXCEEDED", status: 422 });
    expect(visited).toEqual(sequence.slice(0, 4));
    expect(readCutoverOriginalCosts).not.toHaveBeenCalled();
  });

  it("returns a stage-bearing422 for an owner census bound and never continues", async () => {
    failingStage = "oms_demand_and_receipts";
    failureCause = Object.assign(new Error(SECRET), { code: "OMS_CUTOVER_CENSUS_LIMIT_EXCEEDED" });
    const failure = await repository.capture(client).catch(error => error);
    expect(failure).toMatchObject({ stage: failingStage, code: "CUTOVER_EVIDENCE_CAPTURE_LIMIT_EXCEEDED", status: 422 });
    expect(visited).toEqual(sequence.slice(0, 6));
    expect(readWmsCutoverShipmentReviews).not.toHaveBeenCalled();
  });

  it("does not expose unknown owner exceptions or retry a failed original-cost read", async () => {
    failingStage = "original_costs";
    failureCause = new Error(SECRET);
    const failure = await repository.capture(client).catch(error => error);
    expect(failure).toMatchObject({ stage: failingStage, code: "CUTOVER_EVIDENCE_CAPTURE_FAILED", status: 500 });
    expect(failure.cause).toBe(failureCause);
    expect(JSON.stringify(failure)).not.toContain(SECRET);
    expect(readCutoverOriginalCosts).toHaveBeenCalledOnce();
    expect(readOmsCutoverReconstruction).not.toHaveBeenCalled();
  });
});
