import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDemandEventStatusTransition,
  DemandEventError,
  validateDemandEventWriteInput,
  type DemandEventWriteInput,
} from "../../demand-events.service";

function validInput(): DemandEventWriteInput {
  return {
    event: {
      name: "Fall wholesale commitment",
      eventType: "wholesale",
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      status: "planned",
      notes: null,
    },
    lines: [{
      productId: 10,
      productVariantId: 101,
      expectedPieces: 25_000,
      confidence: "high",
      notes: null,
    }],
  };
}

describe("demand event domain contract", () => {
  it("accepts a valid piece-based demand event", () => {
    expect(() => validateDemandEventWriteInput(validInput())).not.toThrow();
  });

  it("rejects an inverted event date window", () => {
    const input = validInput();
    input.event.endDate = "2026-08-31";

    expect(() => validateDemandEventWriteInput(input)).toThrowError(expect.objectContaining({
      code: "DEMAND_EVENT_INVALID_DATE_WINDOW",
      statusCode: 400,
    }));
  });

  it("requires positive whole-piece quantities", () => {
    const input = validInput();
    input.lines[0].expectedPieces = 1.5;

    expect(() => validateDemandEventWriteInput(input)).toThrowError(expect.objectContaining({
      code: "DEMAND_EVENT_INVALID_PIECES",
    }));
  });

  it("rejects duplicate product and SKU configuration lines", () => {
    const input = validInput();
    input.lines.push({ ...input.lines[0] });

    expect(() => validateDemandEventWriteInput(input)).toThrowError(expect.objectContaining({
      code: "DEMAND_EVENT_DUPLICATE_LINE",
      statusCode: 409,
    }));
  });

  it("enforces one-way status transitions", () => {
    expect(() => assertDemandEventStatusTransition("planned", "active")).not.toThrow();
    expect(() => assertDemandEventStatusTransition("active", "completed")).not.toThrow();
    expect(() => assertDemandEventStatusTransition("completed", "active")).toThrowError(expect.objectContaining({
      code: "DEMAND_EVENT_INVALID_STATUS_TRANSITION",
    }));
  });

  it("uses bound Drizzle updates and the same active-date rule as recommendation storage", () => {
    const source = readFileSync(resolve(__dirname, "../../demand-events.service.ts"), "utf8");
    expect(source).not.toContain("sql.raw(");
    expect(source).toContain("tx.update(demandEvents)");
    expect(source).toContain("de.end_date IS NULL OR de.end_date >= CURRENT_DATE");
    expect(source).toContain("weights.medium");
  });

  it("exposes stable structured errors", () => {
    const error = new DemandEventError("TEST", "test error", 409);
    expect(error).toMatchObject({ name: "DemandEventError", code: "TEST", statusCode: 409 });
  });
});
