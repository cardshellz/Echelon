/**
 * Membership module: Echelon's single member resolver.
 *
 * Owns no tables. Reads the membership app's schema through one adapter, so
 * every Echelon feature finds members and their current plan the same way.
 * Other modules import from here only.
 */

import type { Pool } from "pg";
import { MemberResolver } from "./application/member-resolver";
import {
  connectionPerQuery,
  PgMemberDirectory,
} from "./infrastructure/member-directory.repository";

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

export function createMemberResolver(pool: Pick<Pool, "connect">): MemberResolver {
  return new MemberResolver(new PgMemberDirectory(connectionPerQuery(pool)));
}
