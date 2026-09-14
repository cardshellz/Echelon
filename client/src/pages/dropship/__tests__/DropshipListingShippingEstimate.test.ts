import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/pages/dropship/DropshipListingShippingEstimate.tsx"), "utf8");

describe("listing shipping estimate form contract", () => {
  it("offers US states from the rate-table region list instead of free text", () => {
    expect(source).toContain('import { US_POSTAL_REGIONS } from "@/components/shipping/rate-table-model"');
    expect(source).toContain("US_POSTAL_REGIONS.map(([code, name]) =>");
    expect(source).toContain('<SelectItem key={code} value={code}>{name} ({code})</SelectItem>');
    // The two-letter text input survives only for non-US destinations.
    const regionInputs = source.match(/pattern="\[A-Za-z\]\{2\}"/g) ?? [];
    expect(regionInputs).toHaveLength(1);
    expect(source).toContain("usDestination\n            ? <Select");
  });
  it("renders the staff calculation block only when the server attached one", () => {
    expect(source).toContain("{result.calculation && <ListingShippingEstimateCalculationDetails");
    for (const label of ["Items submitted", "Cartons rated", "Rate selection", "Rate table row", "Pricing program", "Rated weight", "Charges"]) {
      expect(source).toContain(label);
    }
    expect(source).toContain("rate.rateRowId === null ? \"unknown\" : `#${rate.rateRowId}`");
  });
});
