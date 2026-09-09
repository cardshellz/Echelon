import { describe, expect, it, vi } from "vitest";
import { cartonizeDropshipItems, type DropshipPackageProfile, type DropshipBoxCatalogEntry } from "../../domain/shipping-quote";
import { calculateDropshipShippingQuote, type DropshipShippingCalculationDependencies } from "../../application/dropship-shipping-quote-service";
import { CutoverDropshipShippingPricingProvider } from "../../application/dropship-shipping-pricing-service";

// Read-only production evidence, 2026-09-08: ARM-ENV-SGL-P50 is a 590g
// sellable pack, the active 8X6X4 box has a 45g tare, and the only legacy
// US-DEFAULT band is 0-1000g at 800 cents. These are regression fixtures,
// not a new rate source, product default, or authorization to edit live rates.
const profiles: DropshipPackageProfile[] = [{ productVariantId: 66, sku: "ARM-ENV-SGL-P50", weightGrams: 590,
  lengthMm: 152, widthMm: 127, heightMm: 51, shippingGroupCode: null, shipsInOwnContainer: false,
  maxUnitsPerPackage: null, defaultCarrier: null, defaultService: null, defaultBoxId: null }];
const boxes: DropshipBoxCatalogEntry[] = [{ id: 1, code: "8X6X4", name: "8X6X4", lengthMm: 203, widthMm: 152,
  heightMm: 102, tareWeightGrams: 45, maxWeightGrams: null, isActive: true }];
const at = new Date("2026-09-08T12:00:00.000Z");

function scenario(quantity: number) {
  return { vendorId: 10, storeConnectionId: 22, warehouseId: 1, destination: { country: "US", region: null, postalCode: "16046" },
    items: [{ productVariantId: 66, quantity }], quotedAt: at };
}
function makeCalculation() {
  const sharedQuote = vi.fn(async () => { throw new Error("No implicit change of pricing authority is allowed"); });
  const deps: DropshipShippingCalculationDependencies = {
    cartonization: { async cartonize(input) {
      const result = cartonizeDropshipItems({ items: input.items, packageProfiles: profiles, boxes });
      return { packages: result.packages, warnings: result.warnings.map((warning) => warning.message),
        packagingWarnings: result.warnings, engine: { name: "cartonizer-regression", version: "1" } };
    } },
    pricingProvider: new CutoverDropshipShippingPricingProvider({
      cutoverPolicy: { mode: "legacy", storeConnectionIds: new Set() },
      legacyRateProvider: { async quoteRates(input) {
        return { zone: { zone: "US-DEFAULT", zoneRuleId: 1 }, provider: { name: "legacy-band-fixture", version: "1" },
          rates: input.packages.filter((carton) => carton.weightGrams <= 1000).map((carton) => ({ packageSequence: carton.packageSequence,
            rateTableId: 1, carrier: "USPS", service: "Ground Advantage", currency: "USD", rateCents: 800 })) };
      } },
      sharedQuoteProvider: { quote: sharedQuote }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }),
    repository: {
      async getActiveShippingMarkupPolicy() { return { id: 1, source: "config", markupBps: 100, fixedMarkupCents: 0, minMarkupCents: null, maxMarkupCents: null }; },
      async getActiveInsurancePoolPolicy() { return { id: 1, source: "config", feeBps: 200, minFeeCents: null, maxFeeCents: null }; },
    },
  };
  return { deps, sharedQuote };
}

describe("reported one-pack / two-pack legacy coverage gap", () => {
  it("reproduces the one-pack 824-cent total without converting the 50-piece pack to eaches", async () => {
    const { deps } = makeCalculation();
    const quote = await calculateDropshipShippingQuote(deps, scenario(1));
    expect(quote.cartonization.packages.map((carton) => carton.weightGrams)).toEqual([635]);
    expect(quote.totalShippingCents).toBe(824);
  });
  it("identifies the two-pack weight that falls outside the configured legacy band", async () => {
    const { deps, sharedQuote } = makeCalculation();
    const cartons = await deps.cartonization.cartonize(scenario(2));
    expect(cartons.packages.map((carton) => carton.weightGrams)).toEqual([1225]);
    expect(cartons.packages[0].quantity).toBe(2);
    await expect(calculateDropshipShippingQuote(deps, scenario(2))).rejects.toMatchObject({
      code: "DROPSHIP_SHIPPING_RATE_REQUIRED", context: { packageSequence: 1, weightGrams: 1225 },
    });
    expect(sharedQuote).not.toHaveBeenCalled();
  });
});
