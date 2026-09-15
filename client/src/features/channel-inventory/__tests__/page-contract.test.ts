import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source-level guards for owner decisions in
 * docs/INVENTORY-CHANNEL-CONTROLS-DESIGNER-HANDOFF.md that a unit test on the
 * view-model cannot see: what the page asks the operator for, and what it
 * never does.
 */
const FEATURE_DIR = join(process.cwd(), "client", "src", "features", "channel-inventory");

function featureSources(): Array<[string, string]> {
  const files: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (entry.name !== "__tests__") walk(join(dir, entry.name)); continue; }
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push([entry.name, readFileSync(join(dir, entry.name), "utf8")]);
    }
  };
  walk(FEATURE_DIR);
  return files;
}

describe("Channel Inventory page contract", () => {
  const sources = featureSources();
  const all = sources.map(([, source]) => source).join("\n");

  it("never asks for a written reason on a routine save, and always asks on a publishing command", () => {
    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/Reason for this draft/);
      expect(source, name).not.toMatch(/reason\.trim\(\)\.length === 0 \|\| save/);
    }
    expect(all).toContain("Add a note (optional)");
    for (const command of ["setReadinessInclusion", "stopDestination", "reviewResume", "resumeDestination", "changeGlobalPublishing"]) {
      expect(all).toContain(command);
    }
    expect(all).toContain("Reason (required for this publishing command)");
  });

  it("shows percentages and units, never basis points or enum names", () => {
    for (const [name, source] of sources.filter(([file]) => file.endsWith(".tsx"))) {
      expect(source, name).not.toMatch(/basis points/i);
      expect(source, name).not.toMatch(/>\s*exposure\s*</);
      expect(source, name).not.toMatch(/allocation dial|compatibility node|destination owner|publication authority/i);
    }
  });

  it("consumes server quantities and never implements a second calculator", () => {
    const model = readFileSync(join(FEATURE_DIR, "model.ts"), "utf8");
    expect(model).not.toMatch(/Math\.floor\([^)]*shareBps/);
    expect(model).not.toMatch(/\* *shareBps/);
    expect(all).not.toMatch(/10_000\s*\)/);
  });

  // Destination identity is derived server-side from the connection, so setup
  // must not ask an operator to pick a location or type an account id at all.
  it("never asks the operator for a destination identity", () => {
    const dialog = readFileSync(join(FEATURE_DIR, "components", "SetUpDestinationsDialog.tsx"), "utf8");
    expect(dialog).toContain("Warehouses that supply them");
    expect(dialog).toContain("Who publishes the quantity");
    expect(dialog).not.toMatch(/Where quantities go/);
    expect(dialog).not.toMatch(/externalScopeId/);
    expect(dialog).not.toMatch(/useShopifyLocations/);
    expect(dialog).not.toMatch(/shopifyLocationId/);
  });

  it("sends only the decisions the server cannot make for itself", () => {
    const api = readFileSync(join(FEATURE_DIR, "api.ts"), "utf8");
    expect(api).toContain("setUpChannelDestinations");
    expect(api).toContain("channel-destinations");
  });

  it("is wired as the only route and nav entry, with the old path redirected", () => {
    const app = readFileSync(join(process.cwd(), "client", "src", "App.tsx"), "utf8");
    const shell = readFileSync(join(process.cwd(), "client", "src", "components", "layout", "AppShell.tsx"), "utf8");
    expect(app).toContain('<Route path="/channels/inventory">');
    expect(app).toContain('<Redirect to="/channels/inventory" replace />');
    expect(app).not.toContain("InventoryExposure");
    expect(shell).toContain('label: "Channel Inventory"');
    expect(shell).toContain('href: "/channels/inventory"');
    expect(shell).not.toContain("Inventory Exposure");
  });
});
