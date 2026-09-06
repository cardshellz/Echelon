import { createElement } from "react";
import { Router } from "wouter";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { AssemblyJob } from "../../AssemblyWorkPage";
import { AssemblyHandoffCard } from "../../AssemblyHandoffPanel";
import type { AssemblyTaskView, AssemblyOrderInstructions } from "@shared/warehouse-assembly-execution";
import { task, TIME } from "../../../../../../server/modules/warehouse/__tests__/assembly-work.fixture";

function view(overrides: Partial<AssemblyTaskView> = {}): AssemblyTaskView {
  return { task: task(), orderNumber: "ORDER-70", sku: "P5", name: "Five pack", itemQuantity: 2,
    pickedQuantity: 0, itemStatus: "pending", orderStatus: "in_progress", onHold: false,
    inputs: [{ variantId: 101, sku: "EA", name: "Each", quantity: "10" }], outputLocationCode: "FINISHED", outputPickBlocker: null, ...overrides };
}
function renderJob(data: AssemblyTaskView, actorId = "assembler") {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Router, { ssrPath: "/assembly" }, createElement(AssemblyJob, { view: data, actorId }))));
}
describe("assembly operator safeguards", () => {
  it("offers packing continuation to the responsible worker only after the output pick", () => {
    const data = view({ task: task({ state: "completed", assignedTo: "assembler", version: 3 }), pickedQuantity: 2, itemStatus: "completed" });
    expect(renderJob(data)).toContain("Continue to packing");
    expect(renderJob(data, "other")).not.toContain("Continue to packing");
    expect(renderJob({ ...data, pickedQuantity: 0, itemStatus: "pending" })).not.toContain("Continue to packing");
  });
  it("does not fabricate separate-station custody", () => {
    const html = renderJob(view({ task: task({ state: "completed", assignedTo: "assembler", profile: { ...task().profile, assemblyPacking: "separate" } }), pickedQuantity: 2, itemStatus: "completed" }));
    expect(html).toContain("Separate-station packing custody is not connected"); expect(html).not.toContain("Continue to packing");
  });
  it("requires receipt confirmation before start and does not claim a label scan or shipment", () => {
    const html = renderJob(view());
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Receive &amp; start assembly/);
    expect(html).toContain("10 × EA"); expect(html).toContain("not a barcode/provider-label validation or carrier dispatch");
    expect(html).not.toContain("Record finished-goods pick");
  });
  it("requires actual output quantity plus a physical confirmation for completion", () => {
    const html = renderJob(view({ task: task({ state: "in_progress", version: 2, assignedTo: "assembler", receivedAt: TIME, startedAt: TIME }) }));
    expect(html).toContain("Actual finished quantity");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Record finished assembly/);
    expect(html).toContain("Block job — keep materials reserved");
  });
  it("does not show another employee's completion controls", () => {
    const html = renderJob(view({ task: task({ state: "in_progress", assignedTo: "other" }) }));
    expect(html).not.toContain("Record finished assembly"); expect(html).not.toContain("Block job — keep materials reserved");
  });
  it("keeps finished goods unpicked until the separate physical confirmation", () => {
    const html = renderJob(view({ task: task({ state: "completed", assignedTo: "assembler", version: 3 }) }));
    expect(html).toContain("Finished-goods pick is separate");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Record finished-goods pick/);
  });
  it("shows a blocker instead of an enabled output-pick action", () => {
    const html = renderJob(view({ task: task({ state: "completed" }), outputPickBlocker: "Outside your picking scope" }));
    expect(html).toContain("Outside your picking scope"); expect(html).not.toContain("Record finished-goods pick");
  });
  it("does not label picked output packed or dispatched", () => {
    const html = renderJob(view({ task: task({ state: "completed" }), pickedQuantity: 2, itemStatus: "completed" }));
    expect(html).toContain("Packing and active-label verification are not recorded by this screen; dispatch remains separate");
    expect(html).not.toContain("Record finished-goods pick");
  });
  it("keeps unsupported gun work explicit and queued handoffs distinct from completed picks", () => {
    const instruction: AssemblyOrderInstructions["instructions"][number] = { claimId: "9", operationKey: "build:10", orderItemId: 71,
      sku: "P5", name: "Five pack", outputQty: "2", committedOutputQty: "2", inputs: [], task: null, routes: [], blocker: "Mixed-source work is not connected" };
    const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AssemblyHandoffCard, { instruction, onHandedOff: () => undefined })));
    expect(render()).toContain("Mixed-source work is not connected"); expect(render()).not.toContain("Send to assembly");
    instruction.task = task();
    expect(render()).toContain("This is not a completed pick"); expect(render()).not.toContain("Send to assembly");
  });
});
