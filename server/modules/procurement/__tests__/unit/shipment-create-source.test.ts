import { describe, expect, it } from "vitest";
import { parseShipmentCreateSources, shipmentCreateSourcesSchema, shipmentWarehouseOptionsSchema } from "@shared/procurement/shipment-create-source";
const line = {id:15,purchaseOrderId:17,sku:"PO-REMAINING",productName:"Product",description:null,
  orderQty:1000,alreadyShippedQty:400,directReceivedQty:99,remainingQty:501};
const review = {id:16,purchaseOrderId:17,sku:null,remainingQty:null,code:"SOURCE_REVIEW_REQUIRED",error:"Review receipt history."};

describe("shipment creation source read contracts",()=>{
  it("projects server quantities without recalculating them or retaining unrelated full-record fields",()=>{
    expect(parseShipmentCreateSources({lines:[{...line,receivedQty:100,unitCostMills:42}],reviewRequiredLines:[{...review,orderQty:10}]},17))
      .toEqual({lines:[line],reviewRequiredLines:[review]});
  });
  it("allows an explicit verified empty source result",()=>{
    expect(parseShipmentCreateSources({lines:[],reviewRequiredLines:[]},17)).toEqual({lines:[],reviewRequiredLines:[]});
  });
  it.each([null,[],{lines:null,reviewRequiredLines:[]},{lines:{length:1},reviewRequiredLines:[]},{lines:[]},
    {lines:[],reviewRequiredLines:[{...review,remainingQty:0}]},{lines:[line,line],reviewRequiredLines:[]},
    {lines:[line],reviewRequiredLines:[{...review,id:line.id}]}])("rejects malformed or contradictory source response %j",raw=>{
    expect(shipmentCreateSourcesSchema.safeParse(raw).success).toBe(false);
  });
  it.each([{id:"15"},{id:0},{purchaseOrderId:0},{orderQty:1.5},{remainingQty:0},{remainingQty:-1},
    {remainingQty:"501"},{remainingQty:Number.MAX_SAFE_INTEGER+1},{alreadyShippedQty:-1},{directReceivedQty:null},
    {sku:{}},{productName:[]},{description:7}])("rejects bad source line fields %j",change=>{
    expect(shipmentCreateSourcesSchema.safeParse({lines:[{...line,...change}],reviewRequiredLines:[]}).success).toBe(false);
  });
  it("rejects both selectable and blocked source rows from another purchase",()=>{
    expect(()=>parseShipmentCreateSources({lines:[{...line,purchaseOrderId:18}],reviewRequiredLines:[]},17)).toThrow("selected purchase order");
    expect(()=>parseShipmentCreateSources({lines:[],reviewRequiredLines:[{...review,purchaseOrderId:18}]},17)).toThrow("selected purchase order");
  });
});

describe("shipment warehouse selector contract",()=>{
  it("projects actual warehouse identities while leaving WMS-owned fields outside this consumer",()=>{
    expect(shipmentWarehouseOptionsSchema.parse([{id:1,code:"MAIN",name:"Main",warehouseType:"operations",isActive:1}]))
      .toEqual([{id:1,code:"MAIN",name:"Main"}]);
    expect(shipmentWarehouseOptionsSchema.parse([])).toEqual([]);
  });
  it.each([{},null,{warehouses:[]},[{id:1,code:"MAIN"}],[{id:"1",code:"MAIN",name:"Main"}],
    [{id:1,code:"",name:"Main"}],[{id:1,code:"MAIN",name:null}],
    [{id:1,code:"MAIN",name:"Main"},{id:1,code:"OTHER",name:"Other"}]])("rejects malformed warehouse options %j",raw=>{
    expect(shipmentWarehouseOptionsSchema.safeParse(raw).success).toBe(false);
  });
});
