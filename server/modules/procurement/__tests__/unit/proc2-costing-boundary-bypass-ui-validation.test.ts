import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readLatestLandedCostRevisions,
  readLatestSupplierCostRevisions,
  readReceivingLineCostProvenance,
} from "../../index";
import { readLatestCostApplicationStatuses } from "../../../inventory";
import {
  DEFAULT_STALE_PO_THRESHOLDS,
  RECOMMENDATION_QUEUE_QUERY_KEYS,
  invalidateRecommendationDecisionQueries,
  invalidateRecommendationOrderMutationQueries,
  validateCandidateScoreThresholds,
  validateStalePoThresholds,
} from "@/features/purchasing/autoDraftSettingsValidation";

const repoRoot = path.resolve(__dirname, "../../../../..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("PROC-2: costing boundary decoupling, legacy bypass retirement, and shared UI validation", () => {
  describe("PROC-02 (PROC-B2): procurement and inventory costing public contracts", () => {
    it("reads receiving line cost provenance via procurement public contract", async () => {
      const tx = {
        execute: vi.fn().mockResolvedValue({
          rows: [
            {
              receiving_line_id: 14,
              cost_source_kind: "purchase_order_line",
              cost_source_evidence: { historicalCostLinks: { verifiedSalesOnly: true } },
              has_reversal: false,
            },
          ],
        }),
      };

      const provenance = await readReceivingLineCostProvenance(tx as any, [14]);
      expect(tx.execute).toHaveBeenCalledTimes(1);
      expect(provenance.get(14)).toEqual({
        receivingLineId: 14,
        cost_source_kind: "purchase_order_line",
        cost_source_evidence: { historicalCostLinks: { verifiedSalesOnly: true } },
        has_reversal: false,
      });
    });

    it("reads latest landed and supplier cost revisions via procurement public contract", async () => {
      const tx = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            rows: [
              {
                source_revision_id: 501,
                inbound_shipment_line_id: 14,
                contract: { component: "landed", totalMills: 2725 },
              },
            ],
          })
          .mockResolvedValueOnce({
            rows: [
              {
                source_revision_id: 601,
                component: "product",
                fingerprint: "fp-product-601",
              },
            ],
          }),
      };

      const landed = await readLatestLandedCostRevisions(tx as any, [14]);
      expect(landed).toEqual([
        {
          sourceRevisionId: 501,
          inbound_shipment_line_id: 14,
          contract: { component: "landed", totalMills: 2725 },
        },
      ]);

      const supplier = await readLatestSupplierCostRevisions(tx as any, 14);
      expect(supplier).toEqual([
        {
          sourceRevisionId: 601,
          component: "product",
          fingerprint: "fp-product-601",
        },
      ]);
    });

    it("reads latest inventory cost application statuses via inventory public contract", async () => {
      const tx = {
        execute: vi.fn().mockResolvedValue({
          rows: [
            {
              source_revision_id: 601,
              status: "applied",
            },
          ],
        }),
      };

      const statuses = await readLatestCostApplicationStatuses(tx as any, [601]);
      expect(statuses.get(601)).toBe("applied");
    });

    it("enforces module boundary contracts between procurement and inventory costing", () => {
      const applyCostRevisionSource = readRepoFile(
        "server/modules/inventory/application/apply-cost-revision.ts",
      );
      const refreshReceiptProvisionalSource = readRepoFile(
        "server/modules/inventory/application/refresh-receipt-provisional.ts",
      );
      const purchaseCostApplicationSource = readRepoFile(
        "server/modules/procurement/purchase-cost-application.service.ts",
      );

      expect(applyCostRevisionSource).not.toContain("procurement.receiving_lines");
      expect(applyCostRevisionSource).not.toContain("procurement.receipt_reversals");
      expect(applyCostRevisionSource).toContain('from "../../procurement"');

      expect(refreshReceiptProvisionalSource).not.toContain("procurement.cost_source_revisions");
      expect(refreshReceiptProvisionalSource).toContain('from "../../procurement"');

      expect(purchaseCostApplicationSource).not.toContain("inventory.cost_applications");
      expect(purchaseCostApplicationSource).not.toContain("../inventory/application/");
      expect(purchaseCostApplicationSource).toContain('from "../inventory"');
    });
  });

  describe("PROC-08 (PROC-B6): legacy allocator and AP payment bypass retirement", () => {
    it("retires getAllocatedLineCostsForPo from purchasing and receiving services", () => {
      const purchasingSource = readRepoFile("server/modules/procurement/purchasing.service.ts");
      const receivingSource = readRepoFile("server/modules/procurement/receiving.service.ts");

      expect(purchasingSource).not.toContain("getAllocatedLineCostsForPo");
      expect(receivingSource).not.toContain("getAllocatedLineCostsForPo");
    });

    it("ensures all production server routes/services use createApPaymentCommands().recordPayment rather than legacy ApLedgerService.recordPayment", () => {
      const apLedgerRoutesSource = readRepoFile(
        "server/modules/procurement/ap-ledger.routes.ts",
      );
      const apLedgerSource = readRepoFile("server/modules/procurement/ap-ledger.service.ts");

      expect(apLedgerRoutesSource).toContain("apPaymentCommands.recordPayment(");
      expect(apLedgerRoutesSource).not.toContain("apLedger.recordPayment(");
      expect(apLedgerSource).toContain(
        "@deprecated Legacy direct payment helper retained for test fixtures only.",
      );
    });
  });

  describe("PROC-11 & PROC-07 (PROC-B5): shared auto-draft threshold validation and recommendation invalidation", () => {
    it("validates candidate score thresholds consistently across modal and page surfaces", () => {
      expect(validateCandidateScoreThresholds("80", "60")).toEqual({
        ok: true,
        value: {
          candidateScoreStrongThreshold: 80,
          candidateScoreReviewThreshold: 60,
        },
      });

      expect(validateCandidateScoreThresholds("105", "60")).toEqual({
        ok: false,
        error: {
          title: "Invalid strong threshold",
          description: "Use a whole number from 0 to 100.",
        },
      });

      expect(validateCandidateScoreThresholds("70", "85")).toEqual({
        ok: false,
        error: {
          title: "Invalid thresholds",
          description: "Review threshold must be less than or equal to the strong threshold.",
        },
      });
    });

    it("validates stale PO thresholds consistently across modal and page surfaces", () => {
      const validInputs = Object.fromEntries(
        Object.entries(DEFAULT_STALE_PO_THRESHOLDS).map(([k, v]) => [k, String(v)]),
      ) as Record<keyof typeof DEFAULT_STALE_PO_THRESHOLDS, string>;

      expect(validateStalePoThresholds(validInputs)).toEqual({
        ok: true,
        value: DEFAULT_STALE_PO_THRESHOLDS,
      });

      const invertedInputs = {
        ...validInputs,
        receivingWarningDays: "12",
        receivingCriticalDays: "5",
      };
      expect(validateStalePoThresholds(invertedInputs)).toEqual({
        ok: false,
        error: {
          title: "Invalid stale PO thresholds",
          description: "Receiving warning days must be less than or equal to critical days.",
        },
      });
    });

    it("invalidates shared recommendation decision and order mutation query keys", () => {
      const invalidated: unknown[] = [];
      const fakeQueryClient = {
        invalidateQueries: ({ queryKey }: { queryKey?: readonly unknown[] }) => {
          invalidated.push(queryKey?.[0]);
        },
      };

      invalidateRecommendationDecisionQueries(fakeQueryClient as any);
      expect(invalidated).toEqual([...RECOMMENDATION_QUEUE_QUERY_KEYS]);

      invalidated.length = 0;
      invalidateRecommendationOrderMutationQueries(fakeQueryClient as any, {
        includeDashboard: true,
        includeEngineKpis: true,
      });
      expect(invalidated).toEqual([
        "/api/purchasing/dashboard",
        "/api/purchasing/reorder-analysis",
        "/api/purchasing/kpis",
        "/api/purchasing/rfq-queue",
        ...RECOMMENDATION_QUEUE_QUERY_KEYS,
      ]);
    });

    it("wires shared validation and invalidation helpers into ExclusionRulesModal, ProcurementAutomation, PurchasingView, and ReorderEngine", () => {
      const modalSource = readRepoFile("client/src/components/purchasing/ExclusionRulesModal.tsx");
      const automationSource = readRepoFile("client/src/pages/ProcurementAutomation.tsx");
      const purchasingViewSource = readRepoFile("client/src/pages/PurchasingView.tsx");
      const reorderEngineSource = readRepoFile("client/src/pages/ReorderEngine.tsx");

      expect(modalSource).toContain("validateCandidateScoreThresholds");
      expect(modalSource).toContain("validateStalePoThresholds");
      expect(automationSource).toContain("validateCandidateScoreThresholds");
      expect(automationSource).toContain("validateStalePoThresholds");
      expect(automationSource).toContain("invalidateRecommendationDecisionQueries");
      expect(purchasingViewSource).toContain("invalidateRecommendationDecisionQueries");
      expect(purchasingViewSource).toContain("invalidateRecommendationOrderMutationQueries");
      expect(reorderEngineSource).toContain("invalidateRecommendationOrderMutationQueries");
    });
  });
});
