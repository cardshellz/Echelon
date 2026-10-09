import type { MemberPlanPresentation } from "@shared/membership/member-plan-presentation";

/** Read display settings for an already resolved plan. Never selects a customer's plan or price. */
export interface MemberPlanPresentationReader {
  read(planId: string): Promise<MemberPlanPresentation>;
}

export class MemberPlanPresentationError extends Error {
  readonly code = "MEMBERSHIP_PRESENTATION_UNAVAILABLE";
  constructor(
    readonly reason:
      | "INVALID_PLAN_ID"
      | "READ_FAILED"
      | "MISSING_PLAN"
      | "INVALID_PLAN_CONFIG",
  ) {
    super(
      "The membership plan's storefront display settings could not be verified.",
    );
    this.name = "MemberPlanPresentationError";
  }
}
