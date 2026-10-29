/** Feature assignments only. Original Playwright configs own full discovery;
 * regression tests require every discovered case exactly once in these groups.
 * Impact decisions belong to test-impact.mjs. */
export const BROWSER_FEATURES = Object.freeze({
  "inventory": {
    "ebay": {
      "label": "eBay listings",
      // The measured 344-case group needs the original four-runner parallelism;
      // two runners reduced total work but concentrated the long recovery spec.
      "shards": 4,
      "tests": [
        "test/browser/ebay-listing-photos.spec.ts",
        "test/browser/ebay-listing-sync-recovery.spec.ts",
        "test/browser/ebay-policy-integrity.spec.ts",
        "test/browser/ebay-pricing-integrity.spec.ts",
        "test/browser/ebay-listing-mapping-repair.spec.ts",
        "test/browser/ebay-listing-intent.spec.ts",
        "test/browser/ebay-publication-stock.spec.ts"
      ],
      "roots": []
    },
    "catalog": {
      "label": "Catalog inventory and images",
      "shards": 1,
      "tests": [
        "test/browser/bulk-inventory-tracking.spec.ts",
        "test/browser/catalog-images.spec.ts",
        "test/browser/shopify-product-connection.spec.ts",
        "test/browser/shopify-inventory-send.spec.ts",
        "test/browser/channel-package-data.spec.ts"
      ],
      "roots": []
    },
    "availability": {
      "label": "Inventory availability",
      "shards": 1,
      "tests": [
        "test/browser/inventory-availability.spec.ts",
        "test/browser/inventory-authority-gates.spec.ts",
        "test/browser/inventory-publication-target-resume.spec.ts"
      ],
      "roots": []
    },
    "picking": {
      "label": "Picking controls",
      "shards": 1,
      "tests": [
        "test/browser/picking-inventory-policy.spec.ts",
        "test/browser/picking-hold-controls.spec.ts",
        "test/browser/pick-corrections.spec.ts"
      ],
      "roots": []
    },
    "movement": {
      "label": "Inventory movement and receiving",
      "shards": 1,
      "tests": [
        "test/browser/inventory-transfer.spec.ts",
        "test/browser/inventory-reserved-transfer.spec.ts",
        "test/browser/return-receiving.spec.ts"
      ],
      "roots": []
    },
    "channels": {
      "label": "Channel inventory workspaces",
      "shards": 1,
      "tests": [
        "test/browser/channel-inventory-workspace.spec.ts",
        "test/browser/walmart-channel-workspace.spec.ts"
      ],
      "roots": []
    }
  },
  "returns": {
    "returns": {
      "label": "Returns preview",
      "shards": 4,
      "tests": [
        "test/browser/returns-portal-preview.spec.ts",
        "test/browser/returns-policy-shipping.spec.ts",
        "test/browser/returns-customer.spec.ts",
        "test/browser/returns-account-layout.spec.ts"
      ],
      "roots": [
        "client/src/customer-account/entry.tsx"
      ],
      "appRoutes": ["/returns", "/return-policies", "/customer-returns"]
    }
  }
});
export const BROWSER_CONFIGS = Object.freeze({
  inventory: { config: "playwright.inventory.config.ts", workflow: ".github/workflows/inventory-availability.yml", shards: 4 },
  returns: { config: "playwright.returns-preview.config.ts", workflow: ".github/workflows/returns-preview.yml", shards: 4 },
});
export function browserFeatureTestMatch(suite, feature) {
  if (feature === undefined || feature === "all") return undefined;
  const group = BROWSER_FEATURES[suite]?.[feature];
  if (!group) throw new Error("Unknown browser feature: " + suite + "/" + feature);
  return group.tests.map(file => new RegExp("(?:^|[/\\\\])" + file.slice("test/browser/".length).replace(/[.*+?^\${}()|[\]\\]/g, "\\$&") + "$"));
}
export function validateBrowserFeatures(suite, files) {
  const features = BROWSER_FEATURES[suite];
  if (!features) throw new Error("Unknown browser suite: " + suite);
  const assigned = new Set();
  for (const [name, group] of Object.entries(features)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !group.tests.length || !Number.isInteger(group.shards) || group.shards < 1 || group.shards > 8)
      throw new Error("Invalid browser feature: " + name);
    for (const file of group.tests) {
      if (!file.startsWith("test/browser/") || !file.endsWith(".spec.ts") || !files.has(file) || assigned.has(file))
        throw new Error("Missing or duplicate browser spec: " + file);
      assigned.add(file);
    }
    for (const root of group.roots) if (!files.has(root)) throw new Error("Missing browser root: " + root);
  }
  return assigned;
}
