import { describe, expect, it } from "vitest";
import { buildAssignmentFeedback } from "../assignmentFeedback";

describe("buildAssignmentFeedback", () => {
  it("reports new target assignments after a move", () => {
    const feedback = buildAssignmentFeedback({
      mode: "move",
      requestedFallback: 2,
      targetName: "Trading Cards",
      sourceName: "Trading Card Supplies",
      result: {
        requested: 2,
        removedFromSource: 2,
        addedToTarget: 2,
      },
    });

    expect(feedback).toEqual({
      title: "2 products move completed",
      description:
        "2 removed from Trading Card Supplies. 2 newly assigned to Trading Cards.",
    });
  });

  it("reports when moved products were already assigned to the target line", () => {
    const feedback = buildAssignmentFeedback({
      mode: "move",
      requestedFallback: 2,
      targetName: "Trading Cards",
      sourceName: "Trading Card Supplies",
      result: {
        requested: 2,
        removedFromSource: 2,
        addedToTarget: 0,
      },
    });

    expect(feedback).toEqual({
      title: "2 products move completed",
      description:
        "2 removed from Trading Card Supplies. 2 already assigned to Trading Cards.",
    });
  });

  it("reports duplicate assignments that were already present", () => {
    const feedback = buildAssignmentFeedback({
      mode: "duplicate",
      requestedFallback: 3,
      targetName: "Trading Cards",
      result: {
        requested: 3,
        added: 1,
        alreadyAssigned: 2,
      },
    });

    expect(feedback).toEqual({
      title: "3 products assignment updated",
      description:
        "1 newly assigned to Trading Cards. 2 already assigned to Trading Cards.",
    });
  });
});
