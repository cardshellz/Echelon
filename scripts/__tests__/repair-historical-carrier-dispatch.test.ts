import { describe, expect, it, vi } from "vitest";

import {
  parseFlags,
  runHistoricalCarrierDispatchRepair,
} from "../repair-historical-carrier-dispatch";

const preview = {
  candidateCount: 2,
  selectedCount: 2,
  byCohort: {
    aggregate_package_identity_conflict: 1,
    immutable_command_request_conflict: 1,
  },
  sample: [],
};

describe("historical carrier-dispatch repair", () => {
  it("defaults to a bounded dry-run", () => {
    expect(parseFlags([])).toEqual({
      help: false,
      mode: "dry-run",
      limit: 100,
      confirmCount: null,
      operator: null,
      reason: null,
      idempotencyKey: null,
      json: false,
    });
    expect(() => parseFlags(["--limit=501"])).toThrow(/1 through 500/);
  });

  it("requires exact confirmation and audit fields in execute mode", () => {
    expect(() => parseFlags(["--execute"])).toThrow(/--confirm-count/);
    expect(() => parseFlags([
      "--execute",
      "--confirm-count=2",
    ])).toThrow(/--operator/);
  });

  it("does not mutate during dry-run", async () => {
    const previewReviewedCarrierDispatchCommands = vi.fn().mockResolvedValue(preview);
    const requeueReviewedCarrierDispatchCommands = vi.fn();
    await expect(runHistoricalCarrierDispatchRepair(parseFlags([]), {
      repository: {
        previewReviewedCarrierDispatchCommands,
        requeueReviewedCarrierDispatchCommands,
      },
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    })).resolves.toEqual({
      mode: "dry-run",
      preview,
      result: null,
    });
    expect(previewReviewedCarrierDispatchCommands).toHaveBeenCalledWith(100);
    expect(requeueReviewedCarrierDispatchCommands).not.toHaveBeenCalled();
  });

  it("rejects execute when the live selection differs from confirmation", async () => {
    const requeueReviewedCarrierDispatchCommands = vi.fn();
    const flags = parseFlags([
      "--execute",
      "--confirm-count=1",
      "--operator=owner@cardshellz.com",
      "--reason=post-authority-repair",
      "--idempotency-key=carrier-dispatch-repair-batch-1",
    ]);
    await expect(runHistoricalCarrierDispatchRepair(flags, {
      repository: {
        previewReviewedCarrierDispatchCommands: vi.fn().mockResolvedValue(preview),
        requeueReviewedCarrierDispatchCommands,
      },
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    })).rejects.toThrow(/does not match/);
    expect(requeueReviewedCarrierDispatchCommands).not.toHaveBeenCalled();
  });

  it("passes the confirmed selection and immutable audit identity to the repository", async () => {
    const requeueReviewedCarrierDispatchCommands = vi.fn().mockResolvedValue({
      selected: 2,
      requeued: 2,
      byCohort: preview.byCohort,
    });
    const flags = parseFlags([
      "--execute",
      "--limit=25",
      "--confirm-count=2",
      "--operator=owner@cardshellz.com",
      "--reason=post-authority-repair",
      "--idempotency-key=carrier-dispatch-repair-batch-1",
    ]);
    const now = new Date("2026-07-24T12:00:00.000Z");
    await runHistoricalCarrierDispatchRepair(flags, {
      repository: {
        previewReviewedCarrierDispatchCommands: vi.fn().mockResolvedValue(preview),
        requeueReviewedCarrierDispatchCommands,
      },
      now: () => now,
    });
    expect(requeueReviewedCarrierDispatchCommands).toHaveBeenCalledWith({
      limit: 25,
      expectedCount: 2,
      operator: "owner@cardshellz.com",
      reason: "post-authority-repair",
      idempotencyKey: "carrier-dispatch-repair-batch-1",
      requeuedAt: now,
    });
  });
});
