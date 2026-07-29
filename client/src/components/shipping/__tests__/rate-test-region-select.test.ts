import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { US_POSTAL_REGIONS } from "../rate-table-model";

const RATE_TEST_DIALOG_SOURCE = readFileSync(
  resolve(
    process.cwd(),
    "client/src/components/shipping/pricing-programs/RateTestDialog.tsx",
  ),
  "utf8",
);

describe("rate-test destination region selector", () => {
  it("keeps the long postal-region menu bounded and scrollable", () => {
    expect(RATE_TEST_DIALOG_SOURCE).toContain(
      '<SelectContent className="max-h-72">',
    );
  });

  it("includes Hawaii in the selectable postal-region source", () => {
    expect(US_POSTAL_REGIONS).toContainEqual(["HI", "Hawaii"]);
  });
});
