import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source contract for the vendor Onboarding page. The page is a React
 * component with browser-only dependencies, so its structure is checked from
 * source and its behavior from the browser journey in
 * test/browser/dropship-onboarding.spec.ts.
 */
const source = readFileSync(join(__dirname, "..", "DropshipPortalOnboarding.tsx"), "utf8");

function body(functionName: string): string {
  const start = source.indexOf(`function ${functionName}(`);
  expect(start).toBeGreaterThan(0);
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n") + 3);
}

describe("DropshipPortalOnboarding contract", () => {
  it("renders one checklist whose rows come from the onboarding model, with no second set of gate cards", () => {
    expect(source).toContain("describeOnboardingStep(step, onboarding)");
    expect(source).toContain("<ChecklistRow");
    expect(source).not.toContain("LaunchGate");
    expect(source).not.toContain("Catalog availability");
    // The old two-column grid is gone; the page is one column.
    expect(source).not.toContain("lg:grid-cols-[0.8fr_1.2fr]");
    expect(source).toContain("max-w-4xl");
  });

  it("gives each row its own button, either another page or the store panel on this one", () => {
    const row = body("ChecklistRow");
    expect(row).toContain("action.kind === \"navigate\" ? onNavigate(action.path) : onRevealStorePanel()");
    expect(source).toContain("storePanelRef.current?.scrollIntoView({ behavior: \"smooth\", block: \"start\" })");
    // The store panel is rendered once, below the checklist, at the scroll target.
    const panelUses = source.match(/<StoreConnectPanel onboarding=\{onboarding\} \/>/g) ?? [];
    expect(panelUses).toHaveLength(1);
    expect(source.indexOf("ref={storePanelRef}")).toBeLessThan(source.indexOf("<StoreConnectPanel onboarding={onboarding} />"));
  });

  it("keeps activation inside the checklist card and gates it with the model, not its own rules", () => {
    const checklist = body("LaunchChecklist");
    expect(checklist).toContain("<ActivationFooter");
    expect(checklist.indexOf("<ol")).toBeLessThan(checklist.indexOf("<ActivationFooter"));
    const footer = body("ActivationFooter");
    expect(footer).toContain("const activation = describeActivation(onboarding);");
    expect(footer).toContain("const activateDisabled = !activation.ready");
    expect(footer).toContain("if (!activation.ready) return;");
  });

  it("shows a vendor past onboarding a short account summary instead of the checklist, and keeps the confirmation after activating here", () => {
    expect(source).toContain("isOnboardingVendor(onboarding.vendor.status) || activatedHere");
    expect(source).toContain("<AccountSummaryCard");
    expect(source).toContain("describeAccountSummary(onboarding.vendor.status)");
    expect(source).toContain("setActivatedHere(true);");
  });

  it("only ever calls the existing onboarding and store routes", () => {
    const routes = [...source.matchAll(/"\/api\/dropship\/[^"]+"/g)].map((match) => match[0]);
    expect(new Set(routes)).toEqual(new Set([
      "\"/api/dropship/onboarding/state\"",
      "\"/api/dropship/store-connections\"",
      "\"/api/dropship/store-connections/oauth/start\"",
      "\"/api/dropship/onboarding/activate\"",
    ]));
  });
});
