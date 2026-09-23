import { describe, expect, it, vi } from "vitest";
import { validateReplenishmentTrigger } from "../../domain/replenishment-trigger";
import { insertReplenTaskSchema } from "@shared/schema";

vi.mock("../../../notifications/notifications.service", () => ({ notify: vi.fn() }));
vi.mock("../../../warehouse/settings.resolver", () => ({ getSettingsForWarehouse: vi.fn() }));
import { ReplenishmentUseCases } from "../../application/replenishment.use-cases";

describe("replenishment trigger contract", () => {
  it.each(["min_max", "pick_shortage_case_break", "inventory_change:".repeat(1000), "仓库补货原因".repeat(100)])(
    "preserves complete valid provenance (%#)", (reason) => {
      expect(validateReplenishmentTrigger(reason)).toBe(reason);
      expect(insertReplenTaskSchema.parse({
        fromLocationId: 1, toLocationId: 2, qtyTargetUnits: 10, triggeredBy: reason,
      }).triggeredBy).toBe(reason);
    },
  );

  it.each(["", " \t\n", "pick\0shortage", null, undefined, 123, {}, []])(
    "rejects invalid provenance without including it in error context (%#)", (reason) => {
      expect(() => validateReplenishmentTrigger(reason)).toThrow(expect.objectContaining({
        code: "VALIDATION_ERROR", statusCode: 400, context: { field: "triggeredBy" },
      }));
    },
  );

  it("rejects invalid reasons before either automatic entry point starts work", async () => {
    const db = { transaction: vi.fn() };
    const service = new ReplenishmentUseCases(db as any, {} as any);
    await expect(service.createAndExecuteReplen(1, 2, "picker", { triggeredBy: " " }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.checkAndTriggerAfterPick(1, 2, "bad\0reason"))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
