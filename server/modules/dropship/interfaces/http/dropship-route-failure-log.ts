import type { Request } from "express";
import { z } from "zod";
import { logger } from "../../../../platform/observability/logger";
import { DropshipError } from "../../domain/errors";
import { DROPSHIP_LISTING_GROUP_RULES_CLOSED, MAX_GROUP_RULE_IDS_IN_REFUSAL } from "../../domain/older-group-rules-edit";

/**
 * One structured log line per failed or refused request on a listing settings
 * route (CLAUDE.md §10), the same entry on every route that uses it: the eBay
 * category rules route's fields since PR 9b, and, since Listing settings
 * PR 12 (plan D11), the pricing rules and description routes', which logged
 * on `console.*` before. Only codes and ids: never a group's name or text, a
 * provider message or a token. The one refusal that also logs part of its
 * context is the older group-rule refusal (`groupRuleRefusalFields`).
 */

export type DropshipRouteErrorClass = "transient" | "permanent" | "fatal";

/**
 * eBay or token outages recover on their own (transient, 502/503); a 500
 * needs a human (fatal); everything else is a refusal the vendor can fix
 * (permanent).
 */
export function dropshipRouteErrorClass(status: number): DropshipRouteErrorClass {
  if (status === 502 || status === 503) return "transient";
  return status >= 500 ? "fatal" : "permanent";
}

/**
 * Logs one failed request under `scope` (e.g. "dropship.pricing_rules"):
 * `<scope>.request_refused` at INFO for a permanent refusal, `<scope>.request_failed`
 * at WARN for a transient failure and at ERROR, with the error's own message,
 * for a fatal one. `storeConnectionId` is the route's parsed store id, or null.
 * `actorId` is for staff routes, whose actor is the signed-in user; a vendor
 * route leaves it out and logs the session's member id.
 */
export function logDropshipRouteFailure(scope: string, req: Request, failure: {
  status: number; code: string; storeConnectionId: number | null; error: unknown; actorId?: string | null;
}): void {
  const errorClass = dropshipRouteErrorClass(failure.status);
  const entry = {
    outcome: "failed",
    error_code: failure.code,
    status: failure.status,
    method: req.method,
    path: req.route?.path ?? req.path,
    // Correlation: one query on a store or a member returns every refused or failed request.
    store_connection_id: failure.storeConnectionId !== null && Number.isSafeInteger(failure.storeConnectionId)
      ? failure.storeConnectionId : null,
    actor_id: failure.actorId !== undefined ? failure.actorId : req.session?.dropship?.memberId ?? null,
    error_class: errorClass,
    error_message: errorClass === "fatal" && failure.error instanceof Error ? failure.error.message : undefined,
    ...groupRuleRefusalFields(failure.error),
  };
  if (errorClass === "fatal") logger.error(`${scope}.request_failed`, entry);
  else if (errorClass === "transient") logger.warn(`${scope}.request_failed`, entry);
  else logger.info(`${scope}.request_refused`, entry);
}

/**
 * A group id as both sides' schemas store and accept it (`pricingProfileSchema`,
 * `contentProfileSchema`, the eBay rule schemas): a generated key, never a name.
 */
const loggedGroupRuleId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const groupRuleRefusalContextSchema = z.object({
  kind: z.enum(["pricing", "description", "ebay_category"]),
  addedIds: z.array(loggedGroupRuleId).max(MAX_GROUP_RULE_IDS_IN_REFUSAL),
  changedIds: z.array(loggedGroupRuleId).max(MAX_GROUP_RULE_IDS_IN_REFUSAL),
  reordered: z.boolean(),
});

/**
 * Which older group a refused request tried to add or change, and whether it
 * reordered the eBay rules (Listing settings PR 12, review MC1): the refusal
 * keeps them out of the response (plan D11), so this line is the only trace of
 * what was refused (CLAUDE.md §10). Ids only, re-checked here so no free text
 * can reach the log; a context that fails the check logs nulls, so the line
 * still shows the refusal and that its ids could not be read. Every other code
 * adds nothing.
 */
function groupRuleRefusalFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof DropshipError) || error.code !== DROPSHIP_LISTING_GROUP_RULES_CLOSED) return {};
  const context = groupRuleRefusalContextSchema.safeParse(error.context ?? {});
  if (!context.success) return { group_rules_kind: null, added_ids: null, changed_ids: null, reordered: null };
  return {
    group_rules_kind: context.data.kind,
    added_ids: context.data.addedIds,
    changed_ids: context.data.changedIds,
    reordered: context.data.reordered,
  };
}
