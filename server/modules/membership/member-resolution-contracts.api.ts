/**
 * Pure domain & application member resolution and presentation contracts for `membership` (CI-03).
 * Free of PostgreSQL infrastructure imports.
 */
export {
  MemberResolver,
  MembershipResolverError,
  type MembershipResolverErrorCode,
} from "./application/member-resolver";
export {
  memberKeyForChannelOrder,
  MEMBERSHIP_CHANNEL_PROVIDERS,
  type MemberKey,
  type MemberKeyAbsenceReason,
} from "./domain/member-key";
export type {
  MemberMatchSource,
  MemberPlan,
  MemberResolution,
} from "./domain/member-resolution";
export {
  MemberPlanPresentationError,
  type MemberPlanPresentationReader,
} from "./application/member-plan-presentation";
