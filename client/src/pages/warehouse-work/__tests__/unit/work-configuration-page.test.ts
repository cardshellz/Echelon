import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { emptyWorkConfiguration, type WorkSetup } from "@shared/warehouse-work";
import { ConfigurationEditor } from "../../WorkConfigurationPage";
import { prepareWorkSaveAttempt } from "../../work-configuration-draft";

function setup(): WorkSetup {
  return { warehouse: { id: 1, code: "HQ", name: "Headquarters" },
    revision: { warehouseId: 1, revision: 0, configuration: emptyWorkConfiguration(), executionStatus: "explicit_handoff_only", savedAt: null, savedBy: null, reason: null },
    locations: [], employees: [], canConfigure: true, canManageAccess: true };
}
function render(data: WorkSetup) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(Router, { ssrPath: "/warehouse/workflows/1" }, createElement(ConfigurationEditor, { setup: data, url: "/test" }))));
}
describe("warehouse work draft UI", () => {
  it("clearly labels inactive execution, combined defaults, and real physical stations", () => {
    const html = render(setup());
    expect(html).toContain("single-order gun and assembly execution connected; packing close is separate");
    expect(html).toContain("Saving does not start jobs or post inventory");
    expect(html).toContain("No stations configured");
    expect(html).toContain("Receive &amp; stow");
    expect(html).toContain("Same operator");
    expect(html).toContain("Combined station / operator");
    expect(html).toContain("Save setup");
    expect(html).not.toContain("Save draft setup");
    expect(html).not.toContain("Activate execution");
  });
  it("disables configuration and distinguishes access-management permission", () => {
    const html = render({ ...setup(), canConfigure: false, canManageAccess: false });
    expect(html).toContain('fieldset disabled=""');
    expect(html).toContain("separate Manage access permission");
    expect(html).toContain("It does not grant role permissions");
  });
  it("shows explicit assembly bindings separately from the station's physical identity", () => {
    const data = setup();
    data.locations = [{ id: 1, code: "BENCH", active: true, zone: "PACK" }, { id: 2, code: "MATERIALS", active: true, zone: "PACK" }];
    data.revision.configuration.stations = [{ id: "00000000-0000-4000-8000-000000000001", code: "ASM", name: "Assembly", locationId: 1,
      capabilities: ["assembly"], enabled: true, assemblyBindings: { materialLocationIds: [2], outputLocationId: 1 } }];
    const html = render(data);
    expect(html).toContain("Materials at this station"); expect(html).toContain("Finished output location");
    expect(html).toContain("Handoff never transfers stock"); expect(html).toContain("MATERIALS");
  });
  it("keeps the same command ID for exact retries without mutating draft state", () => {
    const draft = { expectedRevision: 0, configuration: emptyWorkConfiguration(), reason: "Small team setup" };
    const before = structuredClone(draft);
    const id = vi.fn(() => "00000000-0000-4000-8000-000000000001");
    const first = prepareWorkSaveAttempt(draft, null, id);
    expect(prepareWorkSaveAttempt(draft, first, id)).toBe(first);
    expect(id).toHaveBeenCalledOnce(); expect(draft).toEqual(before);
    const changed = prepareWorkSaveAttempt({ ...draft, reason: "Separate assembly" }, first, () => "00000000-0000-4000-8000-000000000002");
    expect(changed.command.commandId).not.toBe(first.command.commandId);
  });
  it("rejects invalid draft inputs before the HTTP command", () => {
    expect(() => prepareWorkSaveAttempt({ expectedRevision: 0, configuration: emptyWorkConfiguration(), reason: "" }, null, () => "00000000-0000-4000-8000-000000000001")).toThrow();
  });
});
