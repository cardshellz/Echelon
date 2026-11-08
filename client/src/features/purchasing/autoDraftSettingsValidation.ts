import type { QueryClient } from "@tanstack/react-query";

export interface AutoDraftStalePoThresholds {
  reviewPendingWarningDays: number;
  reviewPendingCriticalDays: number;
  supplierSendWarningDays: number;
  supplierSendCriticalDays: number;
  supplierFollowupWarningDays: number;
  supplierFollowupCriticalDays: number;
  receivingWarningDays: number;
  receivingCriticalDays: number;
  apCloseoutWarningDays: number;
  apCloseoutCriticalDays: number;
  exceptionBlockedWarningDays: number;
  exceptionBlockedCriticalDays: number;
  closeoutWarningDays: number;
  closeoutCriticalDays: number;
}

export const DEFAULT_STALE_PO_THRESHOLDS: AutoDraftStalePoThresholds = {
  reviewPendingWarningDays: 2,
  reviewPendingCriticalDays: 5,
  supplierSendWarningDays: 2,
  supplierSendCriticalDays: 5,
  supplierFollowupWarningDays: 7,
  supplierFollowupCriticalDays: 14,
  receivingWarningDays: 3,
  receivingCriticalDays: 10,
  apCloseoutWarningDays: 7,
  apCloseoutCriticalDays: 21,
  exceptionBlockedWarningDays: 1,
  exceptionBlockedCriticalDays: 3,
  closeoutWarningDays: 7,
  closeoutCriticalDays: 14,
};

export const STALE_PO_THRESHOLD_ROWS: ReadonlyArray<{
  label: string;
  warningKey: keyof AutoDraftStalePoThresholds;
  criticalKey: keyof AutoDraftStalePoThresholds;
}> = [
  { label: "Review", warningKey: "reviewPendingWarningDays", criticalKey: "reviewPendingCriticalDays" },
  { label: "Send", warningKey: "supplierSendWarningDays", criticalKey: "supplierSendCriticalDays" },
  { label: "Supplier", warningKey: "supplierFollowupWarningDays", criticalKey: "supplierFollowupCriticalDays" },
  { label: "Receiving", warningKey: "receivingWarningDays", criticalKey: "receivingCriticalDays" },
  { label: "AP", warningKey: "apCloseoutWarningDays", criticalKey: "apCloseoutCriticalDays" },
  { label: "Exceptions", warningKey: "exceptionBlockedWarningDays", criticalKey: "exceptionBlockedCriticalDays" },
  { label: "Closeout", warningKey: "closeoutWarningDays", criticalKey: "closeoutCriticalDays" },
];

export interface ThresholdValidationFailure {
  title: string;
  description: string;
}

export type CandidateThresholdValidationResult =
  | {
      ok: true;
      value: {
        candidateScoreStrongThreshold: number;
        candidateScoreReviewThreshold: number;
      };
    }
  | {
      ok: false;
      error: ThresholdValidationFailure;
    };

export type StalePoThresholdValidationResult =
  | {
      ok: true;
      value: AutoDraftStalePoThresholds;
    }
  | {
      ok: false;
      error: ThresholdValidationFailure;
    };

export function validateCandidateScoreThresholds(
  strongInput: string,
  reviewInput: string,
): CandidateThresholdValidationResult {
  const strongThreshold = Number(strongInput);
  const reviewThreshold = Number(reviewInput);
  if (!Number.isInteger(strongThreshold) || strongThreshold < 0 || strongThreshold > 100) {
    return {
      ok: false,
      error: {
        title: "Invalid strong threshold",
        description: "Use a whole number from 0 to 100.",
      },
    };
  }
  if (!Number.isInteger(reviewThreshold) || reviewThreshold < 0 || reviewThreshold > 100) {
    return {
      ok: false,
      error: {
        title: "Invalid review threshold",
        description: "Use a whole number from 0 to 100.",
      },
    };
  }
  if (reviewThreshold > strongThreshold) {
    return {
      ok: false,
      error: {
        title: "Invalid thresholds",
        description: "Review threshold must be less than or equal to the strong threshold.",
      },
    };
  }
  return {
    ok: true,
    value: {
      candidateScoreStrongThreshold: strongThreshold,
      candidateScoreReviewThreshold: reviewThreshold,
    },
  };
}

export function validateStalePoThresholds(
  inputs: Record<keyof AutoDraftStalePoThresholds, string>,
): StalePoThresholdValidationResult {
  const parsed = {} as AutoDraftStalePoThresholds;
  for (const key of Object.keys(DEFAULT_STALE_PO_THRESHOLDS) as Array<keyof AutoDraftStalePoThresholds>) {
    const raw = inputs[key];
    const value = raw === "" || raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 365) {
      return {
        ok: false,
        error: {
          title: "Invalid stale PO threshold",
          description: "Use whole days from 0 to 365.",
        },
      };
    }
    parsed[key] = value;
  }
  for (const row of STALE_PO_THRESHOLD_ROWS) {
    if (parsed[row.warningKey] > parsed[row.criticalKey]) {
      return {
        ok: false,
        error: {
          title: "Invalid stale PO thresholds",
          description: `${row.label} warning days must be less than or equal to critical days.`,
        },
      };
    }
  }
  return { ok: true, value: parsed };
}

export const RECOMMENDATION_QUEUE_QUERY_KEYS = [
  "/api/purchasing/recommendation-review-queue",
  "/api/purchasing/recommendation-accepted-queue",
  "/api/purchasing/recommendation-decisions",
] as const;

export function invalidateRecommendationDecisionQueries(queryClient: Pick<QueryClient, "invalidateQueries">): void {
  for (const key of RECOMMENDATION_QUEUE_QUERY_KEYS) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}

export function invalidateRecommendationOrderMutationQueries(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  options: { includeDashboard?: boolean; includeEngineKpis?: boolean } = {},
): void {
  if (options.includeDashboard) {
    queryClient.invalidateQueries({ queryKey: ["/api/purchasing/dashboard"] });
  }
  queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
  if (options.includeEngineKpis) {
    queryClient.invalidateQueries({ queryKey: ["/api/purchasing/kpis"] });
    queryClient.invalidateQueries({ queryKey: ["/api/purchasing/rfq-queue"] });
  }
  invalidateRecommendationDecisionQueries(queryClient);
}
