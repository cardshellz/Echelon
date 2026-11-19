/**
 * Pool-backed read-only adapter factories for `membership` (CI-03).
 */
import type { Pool } from "pg";
import type { MemberPlanPresentationReader } from "./application/member-plan-presentation";
import { MemberResolver } from "./application/member-resolver";
import { PgMemberPlanPresentationReader } from "./infrastructure/member-plan-presentation.repository";
import {
  connectionPerQuery,
  PgMemberDirectory,
} from "./infrastructure/member-directory.repository";

export function createMemberPlanPresentationReader(
  pool: Pick<Pool, "connect">,
): MemberPlanPresentationReader {
  return new PgMemberPlanPresentationReader(connectionPerQuery(pool));
}

export function createMemberResolver(pool: Pick<Pool, "connect">): MemberResolver {
  return new MemberResolver(new PgMemberDirectory(connectionPerQuery(pool)));
}
