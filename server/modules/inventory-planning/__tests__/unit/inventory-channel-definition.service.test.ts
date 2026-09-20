import { describe, expect, it, vi } from "vitest";
import { ChannelDefinitionService, type ChannelDefinitionStore } from "../../application/inventory-channel-definition.service";
import { saveChannelExposurePolicyDraftRequestSchema, channelExposurePolicyValueSchema } from "@shared/types/inventory-channel-exposure";

const inherited = { allocationSemantics:null,eligible:null,shareBps:null,holdbackSellableUnits:null,maxPublish:null,minPublishSellableUnits:null };
describe("channel definition boundary", () => {
  function fixture() {
    const store = { review:vi.fn<ChannelDefinitionStore["review"]>(),apply:vi.fn<ChannelDefinitionStore["apply"]>(),progress:vi.fn(async () => null) } satisfies ChannelDefinitionStore;
    const service = new ChannelDefinitionService(store,{ now:() => new Date("2026-09-20T12:00:00.000Z") });
    return { store,service };
  }
  it("rejects extra input fields and invalid identities before calling the store", async () => {
    const { store,service }=fixture();
    await expect(service.review({ channelId:0 })).rejects.toThrow();
    await expect(service.review({ channelId:1,activate:true })).rejects.toThrow();
    expect(store.review).not.toHaveBeenCalled();
  });
  it("pins actor, hash and time, retaining the same logical retry", async () => {
    const { store,service }=fixture();
    store.apply.mockResolvedValue({ channelId:1,appliedAt:"2026-09-20T12:00:00.000Z",appliedBy:"operator",reviewHash:"a".repeat(64),publicationIds:[],changedDefinitions:1,alreadyApplied:false });
    const command={ channelId:1,expectedReviewHash:"a".repeat(64),idempotencyKey:"same-command" };
    await service.apply(command,"operator"); await service.apply(command,"operator");
    expect(store.apply.mock.calls[1]).toEqual(store.apply.mock.calls[0]);
    await service.apply(command,"other-operator");
    expect(store.apply.mock.calls[2][2]).not.toBe(store.apply.mock.calls[0][2]);
  });
  it("never accepts an invalid or absent authenticated actor", async () => {
    const { store,service }=fixture();
    await expect(service.apply({ channelId:1,expectedReviewHash:"a".repeat(64),idempotencyKey:"one" }," ")).rejects.toThrow();
    expect(store.apply).not.toHaveBeenCalled();
  });
  it("validates read results instead of turning a malformed review into success", async () => {
    const { store,service }=fixture(); store.review.mockResolvedValue({ ready:true } as never);
    await expect(service.review({ channelId:1 })).rejects.toMatchObject({ code:"CHANNEL_DEFINITION_RESULT_INVALID",status:500 });
  });
  it("classifies an invalid committed receipt as uncertain rather than a rejected request", async () => {
    const { store,service }=fixture(); store.apply.mockResolvedValue({ alreadyApplied:false } as never);
    await expect(service.apply({ channelId:1,expectedReviewHash:"a".repeat(64),idempotencyKey:"one" },"operator"))
      .rejects.toMatchObject({ code:"CHANNEL_DEFINITION_RESULT_INVALID",status:500 });
  });
  it("permits only explicit complete inheritance tombstones", () => {
    expect(channelExposurePolicyValueSchema.safeParse(inherited).success).toBe(false);
    expect(channelExposurePolicyValueSchema.safeParse({ ...inherited,inheritAll:true }).success).toBe(true);
    expect(channelExposurePolicyValueSchema.safeParse({ ...inherited,inheritAll:true,shareBps:0 }).success).toBe(false);
    expect(channelExposurePolicyValueSchema.safeParse({ ...inherited,sourceFulfillmentNodeIds:[1] }).success).toBe(true);
    for (const ids of [[],[1,1],[0],[-1]]) expect(channelExposurePolicyValueSchema.safeParse({ ...inherited,sourceFulfillmentNodeIds:ids }).success).toBe(false);
  });
  it("cannot remove required channel defaults or create a second channel-level supply authority", () => {
    const request={ scope:{ scopeType:"channel",channelId:1 },expectedHeadRevision:"0",expectedDraftPolicyId:null,
      expectedDraftDefinitionHash:null,idempotencyKey:"test" };
    for (const value of [{ ...inherited,inheritAll:true },{ ...inherited,sourceFulfillmentNodeIds:[1] }]) {
      expect(saveChannelExposurePolicyDraftRequestSchema.safeParse({ ...request,value }).success).toBe(false);
    }
  });
});
