import { readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The conversion record's migration (PR 11, plan section 12), found by its
 * name, never by its number. Its number is allocated under the PR that adds
 * it and changes when the file is adopted under another PR number
 * (docs/migration-allocation.md, "Adopting an unmerged migration"), so every
 * test names the file through this one constant and none needs an edit when
 * the number changes. Exactly one file may carry the name; anything else is
 * a broken checkout, refused here before any test reads SQL.
 */
export const LISTING_RULE_CONVERSIONS_MIGRATION_SUFFIX = "_dropship_listing_rule_conversions.sql";

export const LISTING_RULE_CONVERSIONS_MIGRATION_FILE: string = (() => {
  const matches = readdirSync(resolve(process.cwd(), "migrations"))
    .filter((file) => file.endsWith(LISTING_RULE_CONVERSIONS_MIGRATION_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one migration ending in ${LISTING_RULE_CONVERSIONS_MIGRATION_SUFFIX}; found ${matches.length}.`);
  }
  return matches[0];
})();
