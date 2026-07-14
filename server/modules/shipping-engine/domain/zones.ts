/**
 * Pricing-area resolution: pure domain function, no I/O.
 *
 * Maps a destination (country + region + postal code) to an internal rate area using
 * shipping.zone_rules rows. Design: docs/SHIPPING-ENGINE-DESIGN.md.
 *
 * Matching semantics (generalized from the dropship zone lookup in
 * dropship-cached-rate-table.provider.ts):
 *   1. Rule must be active and match the destination country (case-insensitive).
 *   2. A region-scoped rule must match the normalized destination region.
 *   3. A NULL/blank postal prefix is a region/country default; a non-blank
 *      prefix matches when the normalized postal code starts with it.
 *   4. LONGEST matching prefix wins, then a region-scoped rule wins over a
 *      country default, then higher priority and lowest id break ties.
 *      NOTE: the dropship SQL orders priority BEFORE prefix length; this module
 *      deliberately inverts that so a high-priority country-wide default can
 *      never shadow a more specific prefix rule. Priority stays the tiebreak
 *      knob between equally specific rules.
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
  regionSpecificity: number;
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
  destRegion?: string | null,
): string | null {
  const country = normalizeToken(destCountry);
  const postal = normalizeToken(destPostal);
  const region = normalizeToken(destRegion);
  if (!country) return null;

  let best: ZoneRuleMatch | null = null;

  for (const rule of rules) {
    if (!rule.isActive) continue;
    // No region input in v1 — a region-scoped rule cannot be verified, so it
    // never matches (mirrors the dropship SQL with a NULL region parameter).
    if (normalizeToken(rule.destinationCountry) !== country) continue;

    const ruleRegion = normalizeToken(rule.destinationRegion);
    if (ruleRegion !== "" && ruleRegion !== region) continue;

    const prefix = normalizeToken(rule.postalPrefix);
    if (prefix !== "" && !postal.startsWith(prefix)) continue;

    const candidate: ZoneRuleMatch = {
      rule,
      prefixLength: prefix.length,
      regionSpecificity: ruleRegion === "" ? 0 : 1,
    };
    if (best === null || compareMatches(candidate, best) < 0) {
      best = candidate;
    }
  }

  return best ? best.rule.zone : null;
}

/** Negative when `a` should win over `b`. */
function compareMatches(a: ZoneRuleMatch, b: ZoneRuleMatch): number {
  if (a.prefixLength !== b.prefixLength) return b.prefixLength - a.prefixLength;
  if (a.regionSpecificity !== b.regionSpecificity) {
    return b.regionSpecificity - a.regionSpecificity;
  }
  if (a.rule.priority !== b.rule.priority) return b.rule.priority - a.rule.priority;
  return a.rule.id - b.rule.id;
}
