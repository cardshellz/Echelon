import { describe, expect, it } from "vitest";
import { valueInventory, type ValuationLot } from "../../domain/inventory-valuation";

function lot(id: number,quantity: number,mills: string,variant = id): ValuationLot {
  return { id,productVariantId: variant,quantity,inboundShipmentId: null,cost_precision_version: 1,
    cost_provisional: 0,qty_received: quantity,unit_cost_mills: mills,total_unit_cost_mills: mills,
    po_unit_cost_mills: mills,packaging_cost_mills: 0,landed_cost_mills: 0 };
}
const identities = [1,2,3].map(id=>({ variantId: id,productId: id,sku: `SKU-${id}`,productName: `Product ${id}`,baseSku: `BASE-${id}` }));

describe("single exact inventory valuation", () => {
  it("values three 149-mill units as 447 mills and rounds once to four cents", () => {
    const result = valueInventory([lot(1,3,"149")],identities);
    expect(result.total).toMatchObject({ qty: 3,valueCents: 4 });
    expect(result.totalValueMills).toBe("447");
    expect(result.byVariant[0].valueCents).toBe(4);
    expect(result.byProduct[0].totalValueCents).toBe(4);
  });
  it("allocates fractional display cents deterministically across SKU and product groups", () => {
    const a = valueInventory([lot(3,1,"149"),lot(1,1,"149"),lot(2,1,"149")],identities);
    const b = valueInventory([lot(2,1,"149"),lot(3,1,"149"),lot(1,1,"149")],identities);
    expect(a).toEqual(b);
    expect(a.byVariant.map(v=>v.valueCents)).toEqual([2,1,1]);
    expect(a.byProduct.reduce((sum,p)=>sum+p.totalValueCents,0)).toBe(a.total.valueCents);
  });
  it("preserves integer money above Number multiplication precision", () => {
    const result = valueInventory([lot(1,16,String(Number.MAX_SAFE_INTEGER))],identities);
    expect(result.totalValueMills).toBe("144115188075855856");
    expect(result.total.valueCents).toBe(1441151880758559);
  });
  it("does not label an unpopulated legacy price as a confirmed zero", () => {
    const result = valueInventory([{ ...lot(1,2,"0"),cost_precision_version: 0,cost_source: "unresolved" }],identities);
    expect(result.unknownCostQty).toBe(2);
    expect(result.total.provisionalQty).toBe(2);
    expect(result.quantityUnit).toBe("variant");
  });
  it("fails when exact stock has no Catalog identity instead of dropping its value", () => {
    expect(()=>valueInventory([lot(4,1,"100")],identities)).toThrow(/Catalog identity missing/);
  });
});
