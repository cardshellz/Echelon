import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUNTIME_SOURCES = [
  "../../lots.service.ts",
  "../../cogs.service.ts",
  "../../atp.service.ts",
  "../../domain/inventory.domain.ts",
  "../../infrastructure/inventory.repository.ts",
  "../../inventory.routes.ts",
  "../../../dropship/infrastructure/dropship-order-acceptance.repository.ts",
];

describe("inventory availability contract", () => {
  it("never deducts picked or packed workflow counters from current on-hand", () => {
    for (const relativePath of RUNTIME_SOURCES) {
      const source = readFileSync(
        fileURLToPath(new URL(relativePath, import.meta.url)),
        "utf8",
      );

      expect(source, relativePath).not.toMatch(
        /(?:\w+\.)?(?:qtyOnHand|qty_on_hand|variantQty|variant_qty|onHand)\s*-\s*(?:\w+\.)?(?:qtyReserved|qty_reserved|reservedQty|reserved_qty|reserved)\s*-\s*(?:\w+\.)?(?:qtyPicked|qty_picked|pickedQty|picked_qty|picked)/,
      );
    }
  });
});
