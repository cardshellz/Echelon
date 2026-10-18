import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  costIssueSchema,
  costSourceRevisionSchema,
} from "@shared/procurement/cost-source-contracts";
import {
  purchaseComponentPostingStatus,
  purchaseCostComponentStatusSchema,
} from "@shared/procurement/purchase-cost-status";
import type { CostRevisionInput } from "../../inventory/infrastructure/cost-evidence.repository";

const resultSchema = z.object({
  status: z.enum(["applied", "review_required"]),
  lotsUpdated: z.number().int().nonnegative().safe(),
  issues: z.array(costIssueSchema),
});
export interface CurrentPurchaseComponentEvidence {
  input: CostRevisionInput;
  currentFingerprint: string;
  revision: { id: number; contract: unknown } | null;
  application: {
    id: number;
    status: string;
    evidence: unknown;
    reportingVerified: boolean;
  } | null;
  lotIds: readonly number[];
  unprovenLotIds: readonly number[];
  changedLots: readonly {
    lotId: number;
    component: string;
    amountMatches: boolean;
  }[];
  historicalPosting?: { destination: "historical_cogs" | "inventory_variance"; amountMills: number };
}

/** A successful old attempt is not current authority: compare the live source,
 * current descendants and component balances before calling it posted. */
export function projectPurchaseComponentStatus(
  evidence: CurrentPurchaseComponentEvidence,
) {
  const { input, revision, application } = evidence;
  const issues = input.issue ? [input.issue] : [];
  const parsed = costSourceRevisionSchema.safeParse(revision?.contract);
  const recordedInput = parsed.success
    ? (({ fingerprint, revision: sequence, ...source }) => source)(parsed.data)
    : null;
  const sourceCurrent =
    parsed.success &&
    parsed.data.fingerprint === evidence.currentFingerprint &&
    canonicalJson(recordedInput) === canonicalJson(input);
  const saved = z
    .object({
      result: resultSchema,
      lotIds: z.array(z.number().int().positive().safe()),
    })
    .safeParse(application?.evidence);
  if (
    application &&
    (!saved.success || saved.data.result.status !== application.status)
  ) {
    issues.push({
      code: "COST_APPLICATION_RESULT_INVALID",
      message:
        "The saved cost result cannot be verified. Review the recorded attempt before retrying.",
    });
  }
  if (sourceCurrent && saved.success) issues.push(...saved.data.result.issues.filter(issue =>
    !(evidence.historicalPosting && issue.code === "COST_UNRESOLVED_QUANTITY_RETAINED")));
  if (
    !issues.some((issue) => issue.code === "COST_HISTORICAL_LINEAGE_MISSING")
  ) {
    for (const lotId of evidence.unprovenLotIds) {
      issues.push({
        code: "COST_HISTORICAL_LINEAGE_MISSING",
        message: `Lot #${lotId} has no verified receipt or transformation cost source. Its product and packaging costs need their own history review; a shipment charge approval does not resolve them.`,
      });
    }
  }
  if (sourceCurrent && application && (application.status === "applied" || evidence.historicalPosting) && saved.success) {
    const expected = [...evidence.lotIds].sort((a, b) => a - b);
    const captured = [...saved.data.lotIds].sort((a, b) => a - b);
    if (
      canonicalJson(expected) !== canonicalJson(captured) ||
      saved.data.result.lotsUpdated !== evidence.changedLots.length ||
      canonicalJson(expected) !==
        canonicalJson(
          evidence.changedLots.map((lot) => lot.lotId).sort((a, b) => a - b),
        )
    ) {
      issues.push({
        code: "COST_APPLICATION_SCOPE_CHANGED",
        message:
          "The recorded application does not cover the current receipt and transformed lots. Apply the current supplier costs.",
      });
    }
    if (
      evidence.changedLots.some(
        (lot) => lot.component !== input.component || !lot.amountMatches,
      )
    ) {
      issues.push({
        code: "COST_COMPONENT_CHANGED",
        message:
          "A current lot component differs from its saved application. Review the cost history before applying again.",
      });
    }
    if (!application?.reportingVerified)
      issues.push({
        code: "COST_REPORTING_EVENT_UNVERIFIED",
        message:
          "The saved application has no matching cost reporting evidence.",
      });
  }
  if (input.currency !== "USD")
    issues.push({
      code: "COST_CURRENCY_REVIEW",
      message:
        "The cost owner needs supported USD evidence before applying these supplier costs.",
    });
  const unique = [
    ...new Map(issues.map((issue) => [canonicalJson(issue), issue])).values(),
  ];
  return purchaseCostComponentStatusSchema.parse({
    component: input.component,
    status: purchaseComponentPostingStatus({
      sourceCurrent,
      issues: unique,
      applicationStatus: sourceCurrent ? (evidence.historicalPosting ? "applied" : application?.status ?? null) : null,
    }),
    sourceEvidence: input.evidence,
    sourceCurrent,
    sourceRevisionId: revision?.id ?? null,
    applicationId: application?.id ?? null,
    issues: unique,
    ...(evidence.historicalPosting ? { historicalPosting: evidence.historicalPosting } : {}),
  });
}
