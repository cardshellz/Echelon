import { describe, expect, it } from "vitest";
import { channelVerificationMismatchRetry, CHANNEL_VERIFICATION_MISMATCH_RETRY_LIMIT, findChannelPublishedContentMismatch,
  type ChannelPublishedContent, type ChannelPublicationContentExpectation } from "../../domain/channel-publication-content";
const expected: ChannelPublicationContentExpectation = { listingId: "listing", skus: ["PACK","CASE"], policies: { shipping: "flat-rate", payment: "payment", return: "return" },
  photoCount: 2, firstPhotoSource: "https://catalog.example.com/original.png", minimumPhotoLongestSide: 500 };
const observed: ChannelPublishedContent = { listingId: "listing", skus: ["PACK","CASE","RETIRED"], policies: expected.policies, firstPhotoSource: expected.firstPhotoSource,
  photos: [{ url: "https://provider.example.com/one.jpg", width: 640, height: 640 },{ url: "https://provider.example.com/two.jpg", width: 500, height: 500 }] };
describe("shared published-content verification",()=>{
  it("accepts published content and leaves retained-member clearing to its lifecycle owner",()=>{
    expect(findChannelPublishedContentMismatch(observed,expected)).toBeNull();
  });
  it.each(["shipping","payment","return"])("rejects an old published %s policy even if an offer echoes the requested policy",kind=>{
    expect(findChannelPublishedContentMismatch({...observed,policies:{...observed.policies,[kind]:"old-copy"}},expected)).toBe(`published.policies.${kind}`);
  });
  it("rejects missing or undersized published photos and the wrong source",()=>{
    expect(findChannelPublishedContentMismatch({...observed,photos:observed.photos.slice(0,1)},expected)).toBe("published.photos.count");
    expect(findChannelPublishedContentMismatch({...observed,photos:observed.photos.map(photo=>({...photo,width:400,height:400}))},expected)).toBe("published.photos.resolution");
    expect(findChannelPublishedContentMismatch({...observed,firstPhotoSource:"https://catalog.example.com/old.png"},expected)).toBe("published.photos.firstSource");
  });
  it("allows propagation checks and pauses after repeated mismatches", () => {
    expect(channelVerificationMismatchRetry(0)).toEqual({ failures: 1, paused: false });
    expect(channelVerificationMismatchRetry(CHANNEL_VERIFICATION_MISMATCH_RETRY_LIMIT - 1))
      .toEqual({ failures: CHANNEL_VERIFICATION_MISMATCH_RETRY_LIMIT, paused: true });
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])("rejects invalid prior check count %s", count => {
    expect(() => channelVerificationMismatchRetry(count)).toThrow("Invalid channel verification check count.");
  });
});
