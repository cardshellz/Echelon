import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { productSyncStartSchema, productSyncLinkScopeSchema, productSyncWorkflowSchema } from "@shared/types/inventory-product-sync-workflow";
import { productSyncLinksPending, type ProductSyncLinkCheck } from "../../domain/product-sync-workflow";
import { ProductSyncWorkflowService, type ProductSyncJob, type ProductSyncWorkflowDeps } from "../../application/product-sync-workflow.service";
import { InventoryProductSyncError } from "../../application/inventory-product-sync.service";

const now = new Date("2026-10-30T12:00:00.000Z");
const key = "12345678-1234-4234-8234-123456789012";
const review = { productId:20,productName:"Binder",sku:"BINDER",reviewHash:"a".repeat(64),ready:false,blockers:[],rows:[],targets:[] };
const check: ProductSyncLinkCheck = { publicationTargetId:1,productVariantId:101,status:"waiting",reasonCode:"STOCK_LINK_NOT_ON_SALE",
  errorClass:null,nextCheckAt:new Date(now.getTime()+60_000),leaseToken:null,available:true,pausedUntil:null };
const job: ProductSyncJob = { idempotencyKey:key,productId:20,requestedBy:"operator",requestedAt:now,updatedAt:now,
  state:"checking_links",message:"Checking links",review,publicationCommand:null,deadlineAt:new Date(now.getTime()+30*60_000),attempts:1,
  leaseToken:"00000000-0000-4000-8000-000000000001" };
function fixture() {
  const deps: ProductSyncWorkflowDeps = { store: { accept:vi.fn(async () => job), read:vi.fn(async () => job),
    claim:vi.fn(async () => job), save:vi.fn(async () => {}), readLinkChecks:vi.fn(async () => []) },
  publication:{ review:vi.fn(async () => review),sync:vi.fn(),progress:vi.fn() }, links:{checkProduct:vi.fn()},
  clock:() => now,newLeaseToken:() => job.leaseToken!,enabled:() => true,logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()} };
  return {deps,service:new ProductSyncWorkflowService(deps)};
}
describe("durable product sync boundaries and recovery decisions", () => {
  it.each([{productId:0},{productId:1.5},{productId:2_147_483_648},{idempotencyKey:"wrong"},
    {quantity:99},{channelId:1},{publicationTargetId:1},{actor:"spoof"},{productVariantIds:[101]}])("rejects invalid or expanded public scope %j", input => {
    expect(productSyncStartSchema.safeParse({productId:20,idempotencyKey:key,...input}).success).toBe(false);
  });
  it("requires unique bounded target/variant scopes", () => {
    expect(productSyncLinkScopeSchema.safeParse({productId:20,targets:[{publicationTargetId:1,productVariantIds:[101,101]}]}).success).toBe(false);
    expect(productSyncLinkScopeSchema.safeParse({productId:20,targets:[{publicationTargetId:1,productVariantIds:[]}]}).success).toBe(false);
  });
  it.each([
    [{},false], [{leaseToken:"claimed"},true], [{status:null,reasonCode:null,nextCheckAt:null},true],
    [{nextCheckAt:now},true], [{status:"flagged"},false], [{status:"error"},false], [{available:false},false],
    [{errorClass:"transient"},true], [{reasonCode:"STOCK_LINK_CALL_BUDGET_USED"},true],
    [{pausedUntil:new Date(now.getTime()+60_000)},true],
  ] as Array<[Partial<ProductSyncLinkCheck>,boolean]>)("waits only for recoverable work %j", (override,expected) => {
    expect(productSyncLinksPending([{...check,...override}],[],now)).toBe(expected);
  });
  it("settles unsupported destinations without suppressing another destination's pending work", () => {
    expect(productSyncLinksPending([{...check,reasonCode:null}],[1],now)).toBe(false);
    expect(productSyncLinksPending([{...check,reasonCode:null},{...check,publicationTargetId:2,errorClass:"transient"}],[1],now)).toBe(true);
  });
  it("binds acceptance to actor and product and performs no provider writes from start or progress", async () => {
    const {deps,service}=fixture();
    await service.start({productId:20,idempotencyKey:key},"operator"); await service.progress(key,"operator");
    expect(deps.links.checkProduct).not.toHaveBeenCalled(); expect(deps.publication.sync).not.toHaveBeenCalled();
    expect(deps.store.accept).toHaveBeenCalledWith({productId:20,idempotencyKey:key},"operator",expect.stringMatching(/^[a-f0-9]{64}$/),now);
  });
  it("refuses disabled workers and invalid actors before acceptance", async () => {
    const {deps}=fixture(); const service=new ProductSyncWorkflowService({...deps,enabled:() => false});
    await expect(service.start({productId:20,idempotencyKey:key},"operator")).rejects.toMatchObject({code:"PRODUCT_SYNC_WORKER_DISABLED"});
    await expect(service.start({productId:20,idempotencyKey:key},"")).rejects.toThrow();
    expect(deps.store.accept).not.toHaveBeenCalled();
  });
  it("keeps corrupt stored evidence uncertain rather than rejecting an already accepted command", async () => {
    const {deps,service}=fixture(); vi.mocked(deps.store.read).mockRejectedValue(new z.ZodError([]));
    await expect(service.progress(key,"operator")).rejects.toMatchObject({code:"PRODUCT_SYNC_EVIDENCE_INVALID",status:503});
  });
  it("never presents queued or mismatched delivery as verified evidence", () => {
    const base={idempotencyKey:key,productId:20,requestedBy:"operator",requestedAt:now.toISOString(),updatedAt:now.toISOString(),
      state:"checking_links",message:"Checking",review,delivery:null};
    expect(productSyncWorkflowSchema.safeParse(base).success).toBe(true);
    expect(productSyncWorkflowSchema.safeParse({...base,state:"queued"}).success).toBe(false);
    expect(productSyncWorkflowSchema.safeParse({...base,productId:21}).success).toBe(false);
  });
  it("bounds repeated stale-review refusals without discarding the request identity", async () => {
    const {deps,service}=fixture();
    const command={productId:20,idempotencyKey:key,expectedReviewHash:review.reviewHash};
    vi.mocked(deps.store.claim).mockResolvedValue({...job,state:"publishing",publicationCommand:command,deadlineAt:now});
    vi.mocked(deps.publication.sync).mockRejectedValue(new InventoryProductSyncError("PRODUCT_SYNC_REVIEW_STALE","Changed"));
    await service.tick();
    expect(deps.store.save).toHaveBeenCalledWith(expect.objectContaining({idempotencyKey:key}),
      expect.objectContaining({state:"failed",publicationCommand:null}),now,true);
  });
  it("recalculates after a proven transactional stale-review refusal, retaining the same request identity", async () => {
    const {deps,service}=fixture(); const command={productId:20,idempotencyKey:key,expectedReviewHash:review.reviewHash};
    vi.mocked(deps.store.claim).mockResolvedValue({...job,state:"publishing",publicationCommand:command});
    vi.mocked(deps.publication.sync).mockRejectedValue(new InventoryProductSyncError("PRODUCT_SYNC_REVIEW_STALE","Changed"));
    await service.tick();
    expect(deps.store.save).toHaveBeenCalledWith(expect.objectContaining({idempotencyKey:key}),
      expect.objectContaining({state:"checking_links",publicationCommand:null}),now,true);
  });
});
