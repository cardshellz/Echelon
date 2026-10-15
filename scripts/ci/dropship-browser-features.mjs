// The unfiltered configuration remains the coverage baseline and local full-suite
// command. Feature groups partition it; they never replace its discovery rules.
export const DROPSHIP_BROWSER_TEST_PATTERN = /^test\/browser\/(?:dropship-(?:pricing|content|policy)-.*\.spec\.ts|dropship-(?:shipping-estimate|wallet|orders|finance|onboarding)\.spec\.ts|shared-shipping-configuration\.spec\.ts|bounded-page-loading\.spec\.ts|catalog-conversions\.spec\.ts)$/;

function feature(label, tests, harnesses, shards = 1) {
  return Object.freeze({
    label,
    tests: Object.freeze(tests.map(name => `test/browser/${name}.spec.ts`)),
    roots: Object.freeze(harnesses.map(name => `test/browser/fixtures/${name}-harness.tsx`)),
    shards,
  });
}

export const DROPSHIP_BROWSER_FEATURES = Object.freeze({
  pricing: feature("Listing prices", ["dropship-pricing-rules"], ["dropship-pricing"]),
  content: feature("Listing content", ["dropship-content-editor"], ["dropship-content"]),
  listings: feature("Catalog and listing settings", [
    "dropship-policy-catalog-steps", "dropship-policy-listing-access",
    "dropship-policy-listing-settings-bulk", "dropship-policy-listing-settings-categories",
    "dropship-policy-listing-settings-drawer", "dropship-policy-listing-settings-step",
    "dropship-policy-listing-settings-updated",
  ], ["dropship-catalog"], 3),
  policies: feature("eBay policies and categories", [
    "dropship-policy-recovery", "dropship-policy-ebay-categories",
  ], ["dropship-policy", "dropship-ebay-categories"]),
  "cost-changes": feature("Cost change notices", [
    "dropship-policy-cost-changes", "dropship-policy-cost-changes-portal",
  ], ["dropship-cost-change-policy", "dropship-cost-changes"]),
  wallet: feature("Wallet and funding", ["dropship-wallet"], ["dropship-wallet"]),
  orders: feature("Dropship orders", ["dropship-orders"], ["dropship-orders"]),
  finance: feature("Dropship finance", ["dropship-finance"], ["dropship-finance"]),
  onboarding: feature("Dropship onboarding", ["dropship-onboarding"], ["dropship-onboarding"]),
  "shipping-estimates": feature("Shipping estimates", ["dropship-shipping-estimate"], ["dropship-shipping-estimate"]),
  "shipping-configuration": feature("Shipping configuration", ["shared-shipping-configuration"], ["shared-shipping-configuration"]),
  "catalog-conversions": feature("Catalog conversions", ["catalog-conversions"], ["catalog-conversion"]),
  "page-loading": feature("Bounded page loading", ["bounded-page-loading"], ["bounded-page-loading"]),
  // This spec injects the shipping harness's inventory-opening mode. Keep its
  // actual imports in the graph even though the user-facing feature is inventory.
  "inventory-opening": feature("Inventory opening", ["dropship-pricing-inventory-cutover-opening"], ["shared-shipping-configuration"]),
});

export function dropshipFeatureTestMatch(name) {
  if (typeof name !== "string" || !Object.hasOwn(DROPSHIP_BROWSER_FEATURES, name)) {
    throw new Error(`Unknown dropship browser feature: ${String(name)}`);
  }
  // Playwright matches absolute file paths; anchor the complete basename, not a
  // substring that could also collect a newly named neighbouring spec.
  return DROPSHIP_BROWSER_FEATURES[name].tests.map(file =>
    new RegExp(`(?:^|[/\\\\])${file.slice("test/browser/".length).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
}

export function validateDropshipFeatureCoverage(files, features = DROPSHIP_BROWSER_FEATURES) {
  const assigned = new Set();
  for (const [name, group] of Object.entries(features)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || name === "all" || !group.label
        || !Array.isArray(group.tests) || !group.tests.length
        || !Array.isArray(group.roots) || !group.roots.length
        || !Number.isSafeInteger(group.shards) || group.shards < 1 || group.shards > group.tests.length) {
      throw new Error(`Invalid dropship browser feature: ${name}`);
    }
    for (const file of group.tests) {
      if (!DROPSHIP_BROWSER_TEST_PATTERN.test(file) || !files.has(file) || assigned.has(file)) {
        throw new Error(`Missing, duplicate, or unrecognized browser spec: ${file}`);
      }
      assigned.add(file);
    }
    for (const root of group.roots) {
      if (!/^test\/browser\/fixtures\/[a-z0-9-]+-harness\.tsx$/.test(root) || !files.has(root)) {
        throw new Error(`Missing or invalid browser harness: ${root}`);
      }
    }
  }
  const unassigned = [...files].filter(file => DROPSHIP_BROWSER_TEST_PATTERN.test(file) && !assigned.has(file));
  if (unassigned.length) throw new Error(`Browser specs need a feature group: ${unassigned.sort().join(", ")}`);
}
