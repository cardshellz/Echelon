import { describe, expect, it } from "vitest";
import {
  STOCK_LINK_ACTOR,
  STOCK_LINK_KEY_PREFIX,
  planStockLinkBatch,
  stockLinkBackgroundOriginKey,
  stockLinkCommandIdentity,
  stockLinkCommandKey,
  stockLinkDraftKey,
  stockLinkLookupHash,
  stockLinkPreparationKey,
  stockLinkRequestHash,
  type StockLinkKeyMember,
} from "../../domain/stock-link";
import { DROPSHIP_EBAY_STOCK_KEY_PREFIX, dropshipEbayStockPreparationKey } from "../../domain/dropship-ebay-stock-readiness";

// Channels PR2 (PLAN-CH2 v4.1 §4.2 keys, §11.1, SAF-2): literal goldens of the generic command keys. A replayed
// command finds its receipt, its drafts and its mapping preparation by these strings, so a change re-links or
// conflicts live links: never edit a literal to make this pass. Values computed once from the domain
// (ch2/build/p2/tools/compute-keys.ts) and pinned.

const shopify = { destinationKind: "channel_connection", providerKey: "shopify" } as const;

const member = (overrides: Partial<StockLinkKeyMember> & Pick<StockLinkKeyMember, "productVariantId">): StockLinkKeyMember => ({
  cardShellzSku: "P5", itemId: "44001", storeSku: "P5", mappingAction: "create", draftMappingId: null,
  replacesMappingId: null, expectedHeadRevision: "0", ...overrides,
});

const goldens = [
  {
    label: "a first link",
    publicationTargetId: 41, productId: 20, purpose: "publish" as const,
    members: [member({ productVariantId: 101 })],
    lookupHash: "41ef0b651149aa34d6d64cb5c7c6e93590c0b43fd5cbe2bd0530a929201cfc58",
    originKey: "101@0:41ef0b651149aa34d6d64cb5c7c6e93590c0b43fd5cbe2bd0530a929201cfc58",
    commandKey: "fe3a0aed-d2dc-50a8-b8f5-93b5a31c15d0",
    requestHash: "e32a45ffb364089384d1128601a4652cf4c1388280214b1574ff97f110db73fd",
  },
  {
    label: "a relink and a retire in one product, members given out of order",
    publicationTargetId: 41, productId: 20, purpose: "sync" as const,
    members: [
      member({ productVariantId: 102, cardShellzSku: "P6", itemId: null, storeSku: null, mappingAction: "none",
        replacesMappingId: 9, expectedHeadRevision: "4" }),
      member({ productVariantId: 101, itemId: "44002", storeSku: "p5", mappingAction: "replace_draft", draftMappingId: 12,
        replacesMappingId: 8, expectedHeadRevision: "7" }),
    ],
    lookupHash: "af3c65d5e760c032c124366877eb6abec591092dd0675b14bc26c17500ab8ec6",
    originKey: "101@7,102@4:af3c65d5e760c032c124366877eb6abec591092dd0675b14bc26c17500ab8ec6",
    commandKey: "93b1c0eb-77ef-563e-a578-137bb949904f",
    requestHash: "1963870f8d70df261c815c9b7f387c1a485652d47a0f184f26ce542ee0aa2540",
  },
  {
    label: "the id, SKU and revision bounds",
    publicationTargetId: 2_147_483_647, productId: 2_147_483_647, purpose: "publish" as const,
    members: [member({ productVariantId: 2_147_483_647, cardShellzSku: "Z".repeat(100), itemId: "99999999999999999999",
      storeSku: "z".repeat(100), mappingAction: "promote_draft", draftMappingId: 2_147_483_647,
      expectedHeadRevision: "9223372036854775807" })],
    lookupHash: "6214895fdb2d69c5187b267eb4bc60ec388c1d50fa817e9833660f54d5f76da5",
    originKey: "2147483647@9223372036854775807:6214895fdb2d69c5187b267eb4bc60ec388c1d50fa817e9833660f54d5f76da5",
    commandKey: "171e199e-5146-5091-b53f-6d76c56ded63",
    requestHash: "916a0b31b8294e125f5475221710c4f597d6f9ec867777084a2795f7a1c3fad4",
  },
];

const keysOf = (input: { publicationTargetId: number; productId: number; purpose: "publish" | "sync"; members: StockLinkKeyMember[] },
  actor = STOCK_LINK_ACTOR) => {
  const originKey = stockLinkBackgroundOriginKey(input.members);
  return {
    lookupHash: stockLinkLookupHash(input.members), originKey,
    commandKey: stockLinkCommandKey({ ...shopify, publicationTargetId: input.publicationTargetId, originKind: "background", originKey }),
    requestHash: stockLinkRequestHash({ ...input, actor }),
  };
};

describe("generic stock-link keys (literal goldens)", () => {
  it("keeps the prefix and the actor", () => {
    expect(STOCK_LINK_KEY_PREFIX).toBe("stock-link");
    expect(STOCK_LINK_ACTOR).toBe("system:stock-link");
  });

  for (const golden of goldens) {
    it(`pins ${golden.label}`, () => {
      expect(keysOf(golden)).toEqual({ lookupHash: golden.lookupHash, originKey: golden.originKey,
        commandKey: golden.commandKey, requestHash: golden.requestHash });
    });
  }

  it("command keys are RFC 4122 version-5 UUIDs", () => {
    for (const golden of goldens) expect(golden.commandKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("SAF-2: the head revision is part of the command identity", () => {
  // Link L → A, then a retire (A's SKU blanked), then the SKU restored and L → A again. The re-link must be a new
  // command: the first command's receipt (same key) would otherwise give COMMAND_CONFLICT or LINK_CHANGED_AFTER_APPLY.
  const link = { publicationTargetId: 41, productId: 20, purpose: "publish" as const,
    members: [member({ productVariantId: 101, expectedHeadRevision: "0" })] };
  const retire = { ...link, members: [member({ productVariantId: 101, itemId: null, storeSku: null, mappingAction: "none",
    replacesMappingId: 1, expectedHeadRevision: "3" })] };
  const relink = { ...link, members: [member({ productVariantId: 101, expectedHeadRevision: "4" })] };

  it("B19: link → retire → re-link of the same item gives a new origin key, command key and request hash", () => {
    const [first, retired, again] = [keysOf(link), keysOf(retire), keysOf(relink)];
    expect(again.lookupHash).toBe(first.lookupHash);
    expect(again.originKey).not.toBe(first.originKey);
    expect(again.commandKey).not.toBe(first.commandKey);
    expect(again.requestHash).not.toBe(first.requestHash);
    expect(new Set([first.commandKey, retired.commandKey, again.commandKey]).size).toBe(3);
  });

  it("the same head state replays to the same keys, whatever the member order", () => {
    const pair = [member({ productVariantId: 102, expectedHeadRevision: "2" }), member({ productVariantId: 101, itemId: "44009" })];
    const forward = keysOf({ ...link, members: pair });
    expect(keysOf({ ...link, members: [...pair].reverse() })).toEqual(forward);
    expect(keysOf({ ...link, members: pair.map(row => ({ ...row })) })).toEqual(forward);
  });

  it("new evidence is a new command: another item, another SKU or another replaced version", () => {
    const base = keysOf(link).commandKey;
    for (const changed of [{ itemId: "44002" }, { storeSku: "P5-X" }, { cardShellzSku: "P5-X" }, { replacesMappingId: 7 }]) {
      expect(keysOf({ ...link, members: [member({ productVariantId: 101, ...changed })] }).commandKey).not.toBe(base);
    }
  });

  it("the request hash binds the actor, the purpose and the product; the key binds the target and the policy", () => {
    const base = keysOf(link);
    expect(keysOf(link, "system:other").requestHash).not.toBe(base.requestHash);
    expect(keysOf({ ...link, purpose: "sync" }).requestHash).not.toBe(base.requestHash);
    expect(keysOf({ ...link, productId: 21 }).requestHash).not.toBe(base.requestHash);
    expect(keysOf({ ...link, publicationTargetId: 42 }).commandKey).not.toBe(base.commandKey);
    expect(stockLinkCommandKey({ destinationKind: "channel_connection", providerKey: "walmart", publicationTargetId: 41,
      originKind: "background", originKey: base.originKey })).not.toBe(base.commandKey);
  });
});

describe("key strings fit their columns and match the Dropship template (§5)", () => {
  it("every key fits varchar(120), including the draft writer's receipt prefix", () => {
    const commandKey = goldens[2]!.commandKey;
    const preparation = stockLinkPreparationKey(STOCK_LINK_KEY_PREFIX, commandKey);
    const draft = stockLinkDraftKey(STOCK_LINK_KEY_PREFIX, commandKey, 2_147_483_647);
    expect(preparation).toBe(`stock-link:${commandKey}`);
    expect(draft).toBe(`stock-link:${commandKey}:2147483647`);
    for (const key of [preparation, draft, `inventory-publication-variant-mapping:${draft}`, `mapping-preparation:${preparation}`]) {
      expect(key.length).toBeLessThanOrEqual(120);
    }
  });

  it("the generic builders give the Dropship preparation and draft keys byte for byte (P0 goldens)", () => {
    const dropshipCommandKey = "1a1a8c2c-5459-5e1d-8908-fa2952c12e80";
    expect(stockLinkPreparationKey(DROPSHIP_EBAY_STOCK_KEY_PREFIX, dropshipCommandKey))
      .toBe(dropshipEbayStockPreparationKey(dropshipCommandKey));
    expect(stockLinkPreparationKey(DROPSHIP_EBAY_STOCK_KEY_PREFIX, dropshipCommandKey))
      .toBe("dropship-ebay-stock:1a1a8c2c-5459-5e1d-8908-fa2952c12e80");
    expect(stockLinkDraftKey(DROPSHIP_EBAY_STOCK_KEY_PREFIX, "9e98a9ee-4ac4-52f7-8172-81e430609253", 5))
      .toBe("dropship-ebay-stock:9e98a9ee-4ac4-52f7-8172-81e430609253:5");
  });

  it("a planned command's identity is built from its members", () => {
    const plan = planStockLinkBatch({
      sizes: [{ productVariantId: 101, productId: 20, cardShellzSku: " P5 ", selection: { action: "publish", blockerCodes: [] },
        head: null, observedSku: null, feedHintItemId: null }],
      destinationHeads: [], carriedSkus: [],
      reads: { lookedUpSkus: ["P5"], lookupItems: [{ itemId: "44001", sku: "P5", productId: "77", productStatus: "ACTIVE" }],
        observations: [], controlReadDone: false },
      recentRetireCount: 0,
    });
    const identity = stockLinkCommandIdentity({ destination: { ...shopify, publicationTargetId: 41 }, command: plan.commands[0]!,
      actor: STOCK_LINK_ACTOR });
    expect(identity).toEqual({ originKind: "background", originKey: goldens[0]!.originKey, lookupHash: goldens[0]!.lookupHash,
      commandKey: goldens[0]!.commandKey, requestHash: goldens[0]!.requestHash,
      preparationKey: `stock-link:${goldens[0]!.commandKey}` });
  });
});
