import { describe, expect, it, vi } from "vitest";
import { customerReturnPackingLimits, defaultCustomerReturnShippingGuardrails } from "@shared/returns/customer-return-shipping-guardrails";
import { selectCustomerReturnRate } from "../../domain/customer-return-rate-selection";
import { buildCustomerReturnCostReferenceInputs } from "../../domain/customer-return-cost-guard";
import { quoteCustomerReturnShipment } from "../../application/customer-return-shipping-quote";
import { customerReturnOriginAddress } from "../../application/customer-return-shipping-plan";
import { validateCustomerReturnBoxPlan } from "../../application/customer-return-box-plan";
import { labelSettings } from "../support/label-fixtures";
import { labelActivePolicy, labelSources } from "../support/label-fixtures";
import { liveShop, LIVE_NOW } from "../support/live-inspection-fixtures";
import { CustomerReturnLiveService } from "../../application/customer-return-live.service";
import { returnRateShipmentSchema, type ReturnRateCandidate, type ReturnRateResult, type ReturnRateProvider } from "../../../shipping-engine/application/return-rate-provider.port";

const rate = (carrierId: string, serviceCode: string, amountCents: number): ReturnRateCandidate => ({ carrierId, serviceCode,
  carrierCode: serviceCode.startsWith("usps_") ? "usps" : "ups", amountCents, currency: "USD", rateId: null, rateType: "quick",
  packageType: "package", trackable: true, validationStatus: "valid", warningCount: 0,
  amounts: { shippingCents: amountCents, insuranceCents: 0, confirmationCents: 0, otherCents: 0 } });
const result = (...rates: ReturnRateCandidate[]): ReturnRateResult => ({ status: "completed", rates, exclusions: [] });
const settings = () => ({ ...labelSettings, carrierId: "se-ups", parcelGuardrails: defaultCustomerReturnShippingGuardrails() });
const shipment = () => returnRateShipmentSchema.parse({ externalShipmentId: "ecr-1-1", rmaNumber: "RMA-1",
  shipFrom: { ...labelSettings.destinationAddress, name: "Customer", postalCode: "99501", state: "AK" },
  shipTo: labelSettings.destinationAddress, parcel: { weightGrams: 1000, dimensionsInches: { length: 8, width: 6, height: 4 } } });
describe("return quote cost protection", () => {
  it("compares against the same real route, account and maximum box weight", () => {
    const source = shipment();
    const configured = settings();
    const reference = buildCustomerReturnCostReferenceInputs(configured, source);
    expect(reference).toHaveLength(1);
    expect(reference[0]).toMatchObject({ carrierIds: ["se-ups"], shipment: { shipFrom: source.shipFrom, shipTo: source.shipTo,
      parcel: { weightGrams: 22680, dimensionsInches: { length: 24, width: 18, height: 16 } } } });
    expect(selectCustomerReturnRate({ policy: configured, shipment: source, weightGrams: 1000,
      result: result(rate("se-ups", "ups_ground", 12602)), costReferences: [{ input: reference[0], result: result(rate("se-ups", "ups_ground", 12602)) }] }).selected.amountCents).toBe(12602);
    expect(() => selectCustomerReturnRate({ policy: configured, shipment: source, weightGrams: 1000,
      result: result(rate("se-ups", "ups_ground", 12603)), costReferences: [{ input: reference[0], result: result(rate("se-ups", "ups_ground", 12602)) }] }))
      .toThrowError(expect.objectContaining({ code: "RETURN_RATE_COST_LIMIT" }));
  });
  it("uses the cheapest allowed normal reference, so an expensive carrier cannot raise the ceiling", () => {
    const configured = { ...settings(), selectionMode: "cheapest_eligible" as const, carrierId: null, serviceCode: null,
      carrierRules: [{ carrierId: "se-ups", serviceCodes: ["ups_ground"], maxWeightLb: null },
        { carrierId: "se-postal", serviceCodes: ["usps_ground_advantage"], maxWeightLb: null }] };
    const source = shipment();
    const references = buildCustomerReturnCostReferenceInputs(configured, source).map(input => ({ input,
      result: input.carrierIds.includes("se-postal") ? result(rate("se-postal", "usps_ground_advantage", 4039)) : result(rate("se-ups", "ups_ground", 12602)) }));
    expect(() => selectCustomerReturnRate({ policy: configured, shipment: source, weightGrams: 1000,
      result: result(rate("se-ups", "ups_ground", 6000), rate("se-postal", "usps_ground_advantage", 5000)), costReferences: references }))
      .toThrowError(expect.objectContaining({ code: "RETURN_RATE_COST_LIMIT" }));
  });
  it("rejects missing, wrong-route, duplicated and missing-service reference evidence", () => {
    const configured = settings();
    const source = shipment();
    const reference = { input: buildCustomerReturnCostReferenceInputs(configured, source)[0], result: result(rate("se-ups", "ups_ground", 1000)) };
    const changed = structuredClone(reference);
    changed.input.shipment.shipFrom.postalCode = "90012";
    for (const references of [[], [changed], [reference, reference], [{ ...reference, result: result() }]]) {
      expect(() => selectCustomerReturnRate({ policy: configured, shipment: source, weightGrams: 1000,
        result: result(rate("se-ups", "ups_ground", 500)), costReferences: references }))
        .toThrowError(expect.objectContaining({ code: "RETURN_RATE_COST_UNVERIFIED" }));
    }
  });
  it("retains rejected quote evidence and never calls a purchase API", async () => {
    const quote = vi.fn(async () => result(rate("se-ups", "ups_ground", 500)));
    quote.mockResolvedValueOnce(result(rate("se-ups", "ups_ground", 600)));
    const evidence = await quoteCustomerReturnShipment({ quote }, settings(), shipment());
    expect(evidence.errorCode).toBe("RETURN_RATE_COST_LIMIT");
    expect(evidence.result?.rates[0].amountCents).toBe(600);
    expect(evidence.costReferences[0].result.rates[0].amountCents).toBe(500);
    expect(quote).toHaveBeenCalledTimes(2);
  });
  it("checks girth and 50 lb limits before accepting a fixed-service quote", () => {
    const configured = settings(); configured.parcelGuardrails.costProtection = false;
    const source = shipment(); source.parcel.weightGrams = 22681;
    expect(() => selectCustomerReturnRate({ policy: configured, shipment: source, weightGrams: 22681, result: result(rate("se-ups", "ups_ground", 1)) }))
      .toThrowError(expect.objectContaining({ code: "RETURN_RATE_NONE_ELIGIBLE" }));
  });
  it("classifies weight, size and unallowed-account exclusions separately", () => {
    const configured = { ...settings(), selectionMode: "cheapest_eligible" as const, carrierId: null, serviceCode: null,
      carrierRules: [{ carrierId: "se-ups", serviceCodes: ["ups_ground"], maxWeightLb: null },
        { carrierId: "se-postal", serviceCodes: ["usps_ground_advantage"], maxWeightLb: null }] };
    configured.parcelGuardrails.costProtection = false;
    const source = shipment(); source.parcel.weightGrams = 10000;
    let decision = selectCustomerReturnRate({ policy: configured, shipment: source, weightGrams: 10000,
      result: result(rate("se-ups", "ups_ground", 500), rate("se-postal", "usps_ground_advantage", 100), rate("se-other", "ups_ground", 1)) });
    expect(decision.excludedRates).toEqual([{ carrierId: "se-postal", serviceCode: "usps_ground_advantage", reason: "weight_limit" },
      { carrierId: "se-other", serviceCode: "ups_ground", reason: "not_allowed" }]);
    source.parcel.weightGrams = 100; source.parcel.dimensionsInches = { length: 50, width: 30, height: 12 };
    decision = selectCustomerReturnRate({ policy: configured, shipment: source, weightGrams: 100,
      result: result(rate("se-ups", "ups_ground", 500), rate("se-postal", "usps_ground_advantage", 100)) });
    expect(decision.excludedRates).toEqual([{ carrierId: "se-postal", serviceCode: "usps_ground_advantage", reason: "size_limit" }]);
  });
  it("rejects an international source address and a 60 lb box before intake", () => {
    expect(() => customerReturnOriginAddress({ name: "Customer", phone: null, company: null, address1: "1 Test St", address2: null,
      city: "Toronto", provinceCode: "ON", zip: "M1M1M1", countryCodeV2: "CA" })).toThrow("shipping address");
    const lines = [{ id: "heavy", title: "Heavy product", eligibleQuantity: 2, unitWeightGrams: 13607.7711 }];
    const plan = { selections: [{ lineId: "heavy", quantity: 2, reasonCode: null }],
      parcels: [{ dimensions: { lengthMm: 254, widthMm: 254, heightMm: 254 }, originalBoxId: null, items: [{ lineId: "heavy", quantity: 2 }] }] };
    expect(() => validateCustomerReturnBoxPlan(lines, plan, [], customerReturnPackingLimits(settings()))).toThrow("too heavy");
  });
  async function guardedReview(actualCents: number, referenceCents: number) {
    const source = labelSources();
    const shipping = settings();
    const policy = { ...labelActivePolicy(), shipping };
    const quote = vi.fn<ReturnRateProvider["quote"]>(async input =>
      result(rate("se-ups", "ups_ground", input.shipment.parcel.weightGrams === 22680 ? referenceCents : actualCents)));
    const service = new CustomerReturnLiveService({ policies: { read: async () => [structuredClone(policy)] },
      local: { listShops: async () => [liveShop], read: async () => structuredClone(source.local) },
      shopify: { read: async () => structuredClone(source.shopify) }, dimensions: { read: async () => null },
      rates: { quote }, now: () => new Date(LIVE_NOW) });
    const lookup = { channelId: 36, orderReference: "0012-A" };
    const order = await service.lookup(lookup);
    const input = { ...lookup, sourceRevision: order.sourceRevision,
      selections: [{ lineId: order.lines[0].id, quantity: 1, reasonCode: null }],
      parcels: [{ dimensions: { lengthMm: 203.2, widthMm: 152.4, heightMm: 101.6 }, originalBoxId: null,
        items: [{ lineId: order.lines[0].id, quantity: 1 }] }] };
    return { service, quote, policy, order, input };
  }
  it("publishes only packing constraints and checks real-route costs during read-only review", async () => {
    const s = await guardedReview(400, 500);
    expect(s.order.packingLimits).toEqual(customerReturnPackingLimits(s.policy.shipping));
    expect(s.order).not.toHaveProperty("shippingSettings");
    expect(s.order).not.toHaveProperty("destinationAddress");
    expect(s.quote).not.toHaveBeenCalled();
    await expect(s.service.review(s.input)).resolves.toMatchObject({ effects: "none" });
    expect(s.quote).toHaveBeenCalledTimes(2);
    expect(s.quote.mock.calls[0][0].shipment.shipFrom.name).toBe("Synthetic Customer");
    expect(s.quote.mock.calls[0][0].shipment.shipTo).toEqual({ ...s.policy.shipping.destinationAddress, addressType: "commercial" });
  });
  it("stops a high price at review while keeping the same box plan editable", async () => {
    const s = await guardedReview(501, 500);
    const original = structuredClone(s.input);
    await expect(s.service.review(s.input)).rejects.toMatchObject({ code: "RETURN_RATE_COST_LIMIT", status: 409 });
    expect(s.input).toEqual(original);
  });
  it("invalidates a displayed order when the winning shipping guardrails change", async () => {
    const s = await guardedReview(400, 500);
    s.policy.shipping.parcelGuardrails.ups.maxWeightLb = "40";
    await expect(s.service.review(s.input)).rejects.toMatchObject({ code: "RETURN_LIVE_REVIEW_CHANGED" });
    expect(s.quote).not.toHaveBeenCalled();
  });
});
