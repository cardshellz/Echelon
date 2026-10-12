import { afterEach, describe, expect, it, vi } from "vitest";
import { publicationSelectionBusyIssue } from "../../publication-selection-work";
import { runInventoryPublicationWorkerTick } from "../../application/inventory-publication-outbox.worker";

describe("selection replan worker boundary", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("plans saved selection changes before draining provider outbox work", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const calls: string[] = [];
    const outbox = { processDue: vi.fn(async () => { calls.push("outbox"); return { claimed: 0, verified: 0, failed: 0, superseded: 0 }; }) };
    const selection = { processDue: vi.fn(async () => { calls.push("selection"); return { planned: 1, blocked: 0, skipped: 0 }; }) };
    await runInventoryPublicationWorkerTick(outbox, selection);
    expect(calls).toEqual(["selection", "outbox"]);
  });
  it("does not claim a successful drain when replan persistence failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const processDue = vi.fn();
    expect(await runInventoryPublicationWorkerTick({ processDue }, { processDue: async () => { throw new Error("unavailable"); } })).toBeNull();
    expect(processDue).not.toHaveBeenCalled();
  });
  it("unwraps the exact busy error and does not expose arbitrary database failures", () => {
    expect(publicationSelectionBusyIssue({ cause: { code: "55P03", message: "PUBLICATION_SELECTION_BUSY" } }))
      .toMatchObject({ code: "PUBLICATION_SELECTION_BUSY", retryable: true });
    expect(publicationSelectionBusyIssue({ code: "55P03", message: "secret SQL" })).toBeNull();
    const circular = { cause: null as unknown };
    circular.cause = circular;
    expect(publicationSelectionBusyIssue(circular)).toBeNull();
  });
});
