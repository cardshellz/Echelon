/**
 * Zone resolution — pure domain function, no I/O.
 *
 * Maps a destination (country + postal code) to a rate-table zone using
 * shipping.zone_rules rows. Design: docs/SHIPPING-ENGINE-DESIGN.md.
 *
 * Matching semantics (generalized from the dropship zone lookup in
 * dropship-cached-rate-table.provider.ts):
 *   1. Rule must be active and match the destination country (case-insensitive).
 *   2. A NULL/blank postal prefix is a country-wide default; a non-blank prefix
 *      matches when the normalized postal code starts with it.
 *   3. LONGEST matching prefix wins (most specific rule), then higher priority
 *      breaks ties, then lowest id for determinism.
 *      NOTE: the dropship SQL orders priority BEFORE prefix length; this module
 *      deliberately inverts that so a high-priority country-wide default can
 *      never shadow a more specific prefix rule. Priority stays the tiebreak
 *      knob between equally specific rules.
 *   4. Region-scoped rules (destination_region set) are skipped: this resolver
 *      has no region input in v1, and in the dropship SQL a NULL region input
 *      likewise never matches a region-scoped rule.
 *
 * Contract: never throws. Unresolvable destinations return null and the
 * caller decides how to degrade.
 */

export interface ZoneRule {
  id: number;
  destinationCountry: string;
  destinationRegion: string | null;
  /** NULL or blank = country-wide default row. */
  postalPrefix: string | null;
  zone: string;
  priority: number;
  isActive: boolean;
}

interface ZoneRuleMatch {
  rule: ZoneRule;
  prefixLength: number;
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

/**
 * Resolve the zone for a destination. Returns the zone string of the best
 * matching rule, or null when no active rule matches.
 */
export function resolveZone(
  rules: readonly ZoneRule[],
  destCountry: string,
  destPostal: string,
): string | null {
  const country = normalizeToken(destCountry);
  const postal = normalizeToken(destPostal);
  if (!country) return null;

  let best: ZoneRuleMatch | null = null;

  for (const rule of rules) {
    if (!rule.isActive) continue;
    // No region input in v1 — a region-scoped rule cannot be verified, so it
    // never matches (mirrors the dropship SQL with a NULL region parameter).
    if (rule.destinationRegion != null && rule.destinationRegion.trim() !== "") continue;
    if (normalizeToken(rule.destinationCountry) !== country) continue;

    const prefix = normalizeToken(rule.postalPrefix);
    if (prefix !== "" && !postal.startsWith(prefix)) continue;

    const candidate: ZoneRuleMatch = { rule, prefixLength: prefix.length };
    if (best === null || compareMatches(candidate, best) < 0) {
      best = candidate;
    }
  }

  return best ? best.rule.zone : null;
}

/** Negative when `a` should win over `b`. */
function compareMatches(a: ZoneRuleMatch, b: ZoneRuleMatch): number {
  if (a.prefixLength !== b.prefixLength) return b.prefixLength - a.prefixLength;
  if (a.rule.priority !== b.rule.priority) return b.rule.priority - a.rule.priority;
  return a.rule.id - b.rule.id;
}
