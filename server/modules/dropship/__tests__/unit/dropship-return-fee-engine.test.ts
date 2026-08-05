import { describe, expect, it } from "vitest";
import {
  computeDropshipReturnSettlement,
  computeReturnFeeCents,
  type DropshipReturnSettlementInput,
} from "../../domain/return-fee-engine";

const ACCEPTED_LINES = [
  { productVariantId: 20, acceptedQuantity: 2, wholesaleUnitCostCents: 1_000 },
  { productVariantId: 21, acceptedQuantity: 1, wholesaleUnitCostCents: 500 },
];
// productCredit = 2*1000 + 1*500 = 2500

function makeInput(overrides: Partial<DropshipReturnSettlementInput> = {}): DropshipReturnSettlementInput {
  return {
    faultCategory: "customer",
    acceptedLines: ACCEPTED_LINES,
    originalShippingCents: 800,
    returnShippingActualCents: 650,
    fees: {
      restockingFee: { feeType: "restocking_fee", amountType: "flat_cents", amount: 300 },
      processingFee: { feeType: "processing_fee", amountType: "flat_cents", amount: 150 },
      returnShippingFee: { feeType: "return_shipping_fee", amountType: "flat_cents", amount: 0 },
    },
    ...overrides,
  };
}

describe("dropship return fee engine (D2 matrix + D5 netting)", () => {
  it("computeReturnFeeCents: flat_cents passes through, percent floors against the basis", () => {
    expect(computeReturnFeeCents(
      { feeType: "restocking_fee", amountType: "flat_cents", amount: 300 },
      2_500,
    )).toBe(300);
    expect(computeReturnFeeCents(
      { feeType: "restocking_fee", amountType: "percent", amount: 10 },
      2_500,
    )).toBe(250);
    // floor rounding: 15% of 199 = 29.85 -> 29
    expect(computeReturnFeeCents(
      { feeType: "processing_fee", amountType: "percent", amount: 15 },
      199,
    )).toBe(29);
    expect(computeReturnFeeCents(
      { feeType: "processing_fee", amountType: "percent", amount: 100 },
      199,
    )).toBe(199);
  });

  it("card_shellz fault: product + original shipping credited, no fees, label absorbed", () => {
    const settlement = computeDropshipReturnSettlement(makeInput({ faultCategory: "card_shellz" }));
    expect(settlement.productCreditCents).toBe(2_500);
    expect(settlement.originalShippingCreditCents).toBe(800);
    expect(settlement.restockingFeeCents).toBe(0);
    expect(settlement.processingFeeCents).toBe(0);
    expect(settlement.returnShippingFeeCents).toBe(0);
    expect(settlement.grossCreditCents).toBe(3_300);
    expect(settlement.totalFeeCents).toBe(0);
    expect(settlement.netSettlementCents).toBe(3_300);
    expect(settlement.creditLedgerType).toBe("return_credit");
  });

  it.each(["vendor", "customer", "marketplace"] as const)(
    "%s fault: product credited, original shipping NOT credited, fees + label charged",
    (faultCategory) => {
      const settlement = computeDropshipReturnSettlement(makeInput({ faultCategory }));
      expect(settlement.productCreditCents).toBe(2_500);
      expect(settlement.originalShippingCreditCents).toBe(0);
      expect(settlement.restockingFeeCents).toBe(300);
      expect(settlement.processingFeeCents).toBe(150);
      expect(settlement.returnShippingFeeCents).toBe(650);
      expect(settlement.grossCreditCents).toBe(2_500);
      expect(settlement.totalFeeCents).toBe(1_100);
      expect(settlement.netSettlementCents).toBe(1_400);
      expect(settlement.creditLedgerType).toBe("return_credit");
    },
  );

  it("carrier fault: product + allocated shipping credited FROM POOL, no vendor debit", () => {
    const settlement = computeDropshipReturnSettlement(makeInput({ faultCategory: "carrier" }));
    expect(settlement.productCreditCents).toBe(2_500);
    expect(settlement.originalShippingCreditCents).toBe(800);
    expect(settlement.totalFeeCents).toBe(0);
    expect(settlement.netSettlementCents).toBe(3_300);
    expect(settlement.creditLedgerType).toBe("insurance_pool_credit");
  });

  it("percent fees are computed against the wholesale line credit", () => {
    const settlement = computeDropshipReturnSettlement(makeInput({
      faultCategory: "vendor",
      fees: {
        restockingFee: { feeType: "restocking_fee", amountType: "percent", amount: 10 },
        processingFee: { feeType: "processing_fee", amountType: "percent", amount: 5 },
        returnShippingFee: { feeType: "return_shipping_fee", amountType: "flat_cents", amount: 0 },
      },
    }));
    expect(settlement.restockingFeeCents).toBe(250);
    expect(settlement.processingFeeCents).toBe(125);
    expect(settlement.returnShippingFeeCents).toBe(650);
    expect(settlement.totalFeeCents).toBe(1_025);
    expect(settlement.netSettlementCents).toBe(1_475);
  });

  it("absent fee rows charge nothing (schedule is opt-in per fault)", () => {
    const settlement = computeDropshipReturnSettlement(makeInput({
      faultCategory: "vendor",
      fees: { restockingFee: null, processingFee: null, returnShippingFee: null },
    }));
    expect(settlement.totalFeeCents).toBe(0);
    expect(settlement.netSettlementCents).toBe(2_500);
  });

  it("return shipping is charged only when the actual label cost is known", () => {
    const settlement = computeDropshipReturnSettlement(makeInput({
      faultCategory: "customer",
      returnShippingActualCents: null,
    }));
    expect(settlement.returnShippingFeeCents).toBe(0);
    expect(settlement.totalFeeCents).toBe(450);
  });

  it("netting: fees larger than the credit produce a negative remainder (D5)", () => {
    const settlement = computeDropshipReturnSettlement(makeInput({
      faultCategory: "vendor",
      acceptedLines: [{ productVariantId: 20, acceptedQuantity: 1, wholesaleUnitCostCents: 100 }],
      originalShippingCents: 0,
      returnShippingActualCents: 900,
      fees: {
        restockingFee: { feeType: "restocking_fee", amountType: "flat_cents", amount: 500 },
        processingFee: { feeType: "processing_fee", amountType: "flat_cents", amount: 250 },
        returnShippingFee: { feeType: "return_shipping_fee", amountType: "flat_cents", amount: 0 },
      },
    }));
    expect(settlement.grossCreditCents).toBe(100);
    expect(settlement.totalFeeCents).toBe(1_650);
    expect(settlement.netSettlementCents).toBe(-1_550);
  });

  it("zero accepted units yields a zero settlement", () => {
    const settlement = computeDropshipReturnSettlement(makeInput({
      acceptedLines: [],
      originalShippingCents: 0,
    }));
    expect(settlement.productCreditCents).toBe(0);
    expect(settlement.grossCreditCents).toBe(0);
    expect(settlement.restockingFeeCents).toBe(300);
    expect(settlement.netSettlementCents).toBe(-(300 + 150 + 650));
  });

  it("breakdown carries the structured audit detail", () => {
    const settlement = computeDropshipReturnSettlement(makeInput({ faultCategory: "customer" }));
    expect(settlement.breakdown).toMatchObject({
      version: 1,
      faultCategory: "customer",
      productCreditCents: 2_500,
      grossCreditCents: 2_500,
      totalFeeCents: 1_100,
      netSettlementCents: 1_400,
      fees: {
        restocking: { configured: true, amountType: "flat_cents", amount: 300, chargedCents: 300 },
        processing: { configured: true, amountType: "flat_cents", amount: 150, chargedCents: 150 },
        returnShipping: { vendorPays: true, actualLabelCostCents: 650, chargedCents: 650 },
      },
    });
    const lines = settlement.breakdown.acceptedLines as { lineCreditCents: number }[];
    expect(lines.map((line) => line.lineCreditCents)).toEqual([2_000, 500]);
  });
});
