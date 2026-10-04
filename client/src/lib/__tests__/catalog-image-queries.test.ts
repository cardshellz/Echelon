import { describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { catalogImageQueryOptions, invalidateCatalogImages } from "../catalog-image-queries";

describe("catalog image references", () => {
  it("refreshes active channel previews while keeping saved draft overrides intact", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const key = ["/api/channels/77/listing-publications", "selected-catalog", "1"];
    let images = ["original.jpg"];
    const observer = new QueryObserver(client, {
      ...catalogImageQueryOptions, queryKey: key, queryFn: async () => ({ images: [...images] }),
    });
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    const draftKey = ["/api/channels/77/listing-publications"];
    const draft = { items: [{ variantId: 1, images: ["custom.jpg"] }] };
    client.setQueryData(draftKey, draft);
    const productKey = ["/api/products/1"];
    client.setQueryData(productKey, { images });
    client.setQueryData(["/api/orders"], []);
    images = ["added.jpg", "original.jpg"];
    await invalidateCatalogImages(client, 1);
    expect(client.getQueryData(key)).toEqual({ images });
    expect(client.getQueryData(draftKey)).toEqual(draft);
    expect(client.getQueryState(draftKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(productKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(["/api/orders"])?.isInvalidated).toBe(false);
    stop(); client.clear();
  });

  it("invalidates cached product thumbnails and inactive catalog pickers for every channel", async () => {
    const client = new QueryClient();
    const imageKeys = [
      ["/api/channels/77/listing-publications", "catalog", "", 0],
      ["/api/channels/88/listing-publications", "selected-catalog", "1,2"],
    ];
    for (const queryKey of imageKeys) {
      client.setQueryDefaults(queryKey, catalogImageQueryOptions);
      client.setQueryData(queryKey, { images: ["old.jpg"] });
    }
    const thumbnailKeys = [["/api/products"], ["/api/product-variants", { active: true }]];
    for (const key of thumbnailKeys) client.setQueryData(key, []);
    await invalidateCatalogImages(client, 1);
    for (const key of [...imageKeys, ...thumbnailKeys]) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    client.clear();
  });
});
