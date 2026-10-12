import { describe,expect,it,vi } from "vitest";
import { EbayPublicationStockService } from "../../ebay-publication-stock.service";
describe("historical eBay stock receipt service",()=>{
  it("validates the exact command scope before reading",async()=>{
    const findApplied=vi.fn(async()=>null),service=new EbayPublicationStockService({findApplied});
    await expect(service.getReceipt(0,"bad")).rejects.toThrow();expect(findApplied).not.toHaveBeenCalled();
    const commandKey="655ca747-20b9-4940-9c61-019baf1c11c1";
    expect(await service.getReceipt(232,commandKey)).toBeNull();expect(findApplied).toHaveBeenCalledExactlyOnceWith({productId:232,commandKey});
  });
});
