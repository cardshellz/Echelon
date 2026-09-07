import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentCandidate, noContentProfile } from "../fixtures/listing-content.fixture";
import { resolveListingContent, listingCatalogHash, sanitizeListingDescription, textDescriptionHtml, prepareContentProfile } from "../../application/dropship-listing-content-resolver";
import { DropshipListingContentService, type ContentTransaction } from "../../application/dropship-listing-content-service";
import { contentProfileSchema, descriptionTextSchema, saveListingContentInputSchema, MAX_DESCRIPTION_HTML_LENGTH,
  type ContentProfileState, type SavedListingContent } from "../../../../../shared/dropship/listing-content";
const now = new Date("2026-09-07T12:00:00Z");
const target = { storeConnectionId: 22, productVariantId: 101 };
describe("description compilation", () => {
  it("resolves 1,000 listings using one prepared named-group profile without mutating it", () => {
    const profile: ContentProfileState = { revisionId: 1, updatedAt: now.toISOString(), profile: {
      defaultTemplate: { introduction: "", footer: "" }, groups: [{ id: "batch", name: "Shared branding", priority: 1,
        scope: { type: "listings", productVariantIds: Array.from({ length: 1000 }, (_, index) => index + 1) },
        template: { introduction: "Reusable introduction", footer: "Reusable footer" } }] } };
    const before = structuredClone(profile);
    const preparedProfile = prepareContentProfile(profile);
    const hashes = new Set<string>();
    for (let id = 1; id <= 1000; id += 1) {
      const row = resolveListingContent({ candidate: { ...contentCandidate(), productVariantId: id },
        profile, preparedProfile, saved: null });
      expect(row.templateName).toBe("Shared branding"); expect(row.issues).toEqual([]); hashes.add(row.evidenceHash);
    }
    expect(hashes.size).toBe(1000); expect(profile).toEqual(before);
  });
  it("inherits formatted catalog, appends escaped catalog facts, and does not mutate input", () => {
    const candidate = contentCandidate(); const before = structuredClone(candidate);
    const resolved = resolveListingContent({ candidate, profile: noContentProfile, saved: null });
    expect(resolved.source).toBe("catalog");
    expect(resolved.descriptionHtml).toContain("<ul><li>Durable mailer</li></ul>");
    expect(resolved.descriptionText).toContain("Units per sellable pack: 50");
    expect(resolved.issues).toEqual([]); expect(candidate).toEqual(before);
    expect(resolveListingContent({ candidate, profile: noContentProfile, saved: null })).toEqual(resolved);
  });
  it.each([
    '<script>alert(1)</script><p onclick="bad()">Safe</p>',
    '<svg><a onload="bad()">bad</a></svg><p>Safe</p>',
    '<textarea><img src=x onerror=bad()></textarea><p>Safe</p>',
    '<iframe src="https://evil.test">bad</iframe><p>Safe</p>',
    '<style>body{background:url(https://evil.test)}</style><p>Safe</p>',
    '<p style="color:red"><a href="javascript:bad()">Safe</a><img src=x onerror=bad()></p>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=bad()>"></math><p>Safe</p>',
  ])("removes active content and attributes: %s", (html) => {
    const result = sanitizeListingDescription(html);
    expect(result).not.toMatch(/<\/?(?:script|style|svg|iframe|img|textarea|math)\b|\s(?:on\w+|href|src|style)=/i);
    expect(result).toContain("Safe");
    expect(sanitizeListingDescription(result)).toBe(result);
  });
  it("treats vendor markup as literal text with paragraphs, never executable markup", () => {
    const html = textDescriptionHtml('<script>alert("x")</script>\nNext\n\nParagraph & more');
    expect(html).toContain("&lt;script&gt;"); expect(html).toContain("<br />"); expect(html).toContain("&amp;");
    expect(html).not.toContain("<script>");
  });
  it("applies one group wrapper to custom body; reset restores catalog body, not another group's template", () => {
    const candidate = contentCandidate();
    const profile: ContentProfileState = { revisionId: 1, updatedAt: now.toISOString(), profile: {
      defaultTemplate: { introduction: "Store intro", footer: "Store footer" },
      groups: [{ id: "mailers", name: "Mailers template", priority: 10, scope: { type: "category", category: "Mailers" },
        template: { introduction: "Group intro", footer: "Group footer" } }] } };
    const saved: SavedListingContent = { revisionId: 1, customText: "My copy", catalogHash: listingCatalogHash(candidate), updatedAt: now.toISOString() };
    const result = resolveListingContent({ candidate, profile, saved });
    expect(result.descriptionText).toContain("Group intro"); expect(result.descriptionText).toContain("My copy");
    expect(result.descriptionText).not.toContain("Store intro"); expect(result.descriptionText).not.toContain("Protect your cards");
    const reset = resolveListingContent({ candidate, profile, saved: { ...saved, customText: null } });
    expect(reset.descriptionText).toContain("Protect your cards"); expect(reset.descriptionText).toContain("Group intro");
    expect(reset.evidenceHash).not.toBe(result.evidenceHash);
  });
  it("blocks priority ties and changes evidence when template revision changes", () => {
    const profile: ContentProfileState = { revisionId: 1, updatedAt: now.toISOString(), profile: { defaultTemplate: { introduction: "", footer: "" },
      groups: ["a", "b"].map((id) => ({ id, name: id, priority: 10, scope: { type: "product", productId: 7 }, template: { introduction: id, footer: "" } })) } };
    const result = resolveListingContent({ candidate: contentCandidate(), profile, saved: null });
    expect(result.issues).toContain("listing_content_template_conflict");
    expect(resolveListingContent({ candidate: contentCandidate(), profile: { ...profile, revisionId: 2 }, saved: null }).evidenceHash).not.toBe(result.evidenceHash);
  });
  it.each(["description", "sku", "condition", "catalogUnitsPerVariant", "itemSpecifics"] as const)("preserves custom copy but requires review after %s changes", (field) => {
    const candidate = contentCandidate();
    const saved = { revisionId: 1, customText: "My copy", catalogHash: listingCatalogHash(candidate), updatedAt: now.toISOString() };
    const changed = { ...candidate, [field]: field === "catalogUnitsPerVariant" ? 100 : field === "itemSpecifics" ? { Color: ["Blue"] } : "Changed" };
    const result = resolveListingContent({ candidate: changed, profile: noContentProfile, saved });
    expect(result.needsCatalogReview).toBe(true); expect(result.descriptionText).toContain("My copy");
    expect(resolveListingContent({ candidate: changed, profile: noContentProfile, saved: { ...saved, customText: null } }).needsCatalogReview).toBe(false);
  });
  it("blocks empty or oversized source without truncating silently", () => {
    expect(resolveListingContent({ candidate: { ...contentCandidate(), description: "<script>hidden</script>" }, profile: noContentProfile, saved: null }).issues).toContain("listing_content_description_required");
    expect(resolveListingContent({ candidate: { ...contentCandidate(), description: "x".repeat(MAX_DESCRIPTION_HTML_LENGTH + 1) }, profile: noContentProfile, saved: null }).issues).toContain("listing_content_catalog_too_large");
  });
  it("rejects invalid text and authorities at the boundary", () => {
    for (const value of ["", " ", "\u0000", "x".repeat(20001)]) expect(descriptionTextSchema.safeParse(value).success).toBe(false);
    expect(descriptionTextSchema.parse("  a\r\nb  ")).toBe("a\nb");
    expect(descriptionTextSchema.safeParse("x".repeat(20000)).success).toBe(true);
    expect(saveListingContentInputSchema.safeParse({ ...target, sku: "changed" }).success).toBe(false);
    expect(contentProfileSchema.safeParse({ defaultTemplate: { introduction: "", footer: "" }, groups: [], vendorId: 99 }).success).toBe(false);
  });
  it("bounds total named-listing memberships across all template groups", () => {
    const group = (id: string, count: number) => ({ id, name: id, priority: 1, scope: { type: "listings",
      productVariantIds: Array.from({ length: count }, (_, index) => index + 1) }, template: { introduction: "", footer: "" } });
    const profile = { defaultTemplate: { introduction: "", footer: "" }, groups: [group("a", 5000), group("b", 5000)] };
    expect(contentProfileSchema.safeParse(profile).success).toBe(true);
    expect(contentProfileSchema.safeParse({ ...profile, groups: [...profile.groups, group("c", 1)] }).success).toBe(false);
  });
});
describe("local description authority", () => {
  let tx: ContentTransaction; let service: DropshipListingContentService;
  let saved: SavedListingContent | null; let profile: ContentProfileState;
  beforeEach(() => {
    saved = null; profile = noContentProfile;
    tx = { vendorId: 10, catalog: {
      loadStoreContext: vi.fn(async () => ({ vendorId: 10, storeConnectionId: 22, platform: "ebay", vendorStatus: "onboarding",
        entitlementStatus: "active", storeStatus: "needs_reauth", setupStatus: "incomplete", storeLaunchReady: false })),
      listCatalogCandidates: vi.fn(async () => [contentCandidate()]), listCatalogExposureRules: vi.fn(async () => [{ scopeType: "catalog", action: "include" }]),
      listSelectionRules: vi.fn(async () => [{ id: 1, scopeType: "catalog", action: "include" }]), listVariantOverrides: vi.fn(async () => []), listExistingListings: vi.fn(async () => []),
    }, listVariantIds: vi.fn(async () => []), listProductLines: vi.fn(async () => []),
      loadProfile: vi.fn(async () => profile), loadSaved: vi.fn(async () => saved), findReplay: vi.fn(async () => false),
      saveProfile: vi.fn(async (input) => { profile = { profile: input.profile, revisionId: 1, updatedAt: now.toISOString() }; }),
      saveListing: vi.fn(async (_variant, input) => { saved = { customText: input.customText, catalogHash: input.expectedCatalogHash, revisionId: (saved?.revisionId ?? 0) + 1, updatedAt: now.toISOString() }; }) };
    service = new DropshipListingContentService({ repository: { execute: async (_input, op) => op(tx) },
      clock: { now: () => now }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  });
  function request() { return { customText: "My description", expectedRevisionId: null, expectedProfileRevisionId: null,
    expectedCatalogHash: listingCatalogHash(contentCandidate()), idempotencyKey: "save" }; }
  it("loads inheritance without writing and permits draft save without marketplace reauthorization", async () => {
    expect((await service.getForMember("member", target)).customText).toBeNull(); expect(tx.saveListing).not.toHaveBeenCalled();
    const result = await service.saveForMember("member", target, request());
    expect(result.content.customText).toBe("My description"); expect(result.content.resolved.descriptionText).toContain("ARM-50");
  });
  it("previews transient text without writing or inventing a persisted revision", async () => {
    const { idempotencyKey: _, ...input } = request();
    const result = await service.previewForMember("member", target, input);
    expect(result.customText).toBe("My description"); expect(result.revisionId).toBeNull(); expect(tx.saveListing).not.toHaveBeenCalled();
  });
  it.each(["expectedRevisionId", "expectedProfileRevisionId", "expectedCatalogHash"])("rejects stale %s before writes", async (field) => {
    await expect(service.saveForMember("member", target, { ...request(), [field]: field === "expectedCatalogHash" ? "a".repeat(64) : 5 }))
      .rejects.toMatchObject({ code: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
    expect(tx.saveListing).not.toHaveBeenCalled();
  });
  it("replays before version checks and returns current state without reverting it", async () => {
    saved = { revisionId: 5, customText: "Later edit", catalogHash: listingCatalogHash(contentCandidate()), updatedAt: now.toISOString() };
    vi.mocked(tx.findReplay).mockResolvedValue(true);
    expect((await service.saveForMember("member", target, request())).content.customText).toBe("Later edit");
    expect(tx.saveListing).not.toHaveBeenCalled();
  });
  it.each(["missing", "unexposed", "unselected"])("rejects %s catalog item", async (mode) => {
    if (mode === "missing") vi.mocked(tx.catalog.listCatalogCandidates).mockResolvedValue([]);
    if (mode === "unexposed") vi.mocked(tx.catalog.listCatalogExposureRules).mockResolvedValue([]);
    if (mode === "unselected") vi.mocked(tx.catalog.listSelectionRules).mockResolvedValue([]);
    await expect(service.saveForMember("member", target, request())).rejects.toMatchObject({ code: "DROPSHIP_CONTENT_NOT_AVAILABLE" });
    expect(tx.saveListing).not.toHaveBeenCalled();
  });
  it("rejects another owner's store before reading content", async () => {
    vi.mocked(tx.catalog.loadStoreContext).mockResolvedValue(null);
    await expect(service.getForMember("member", target)).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(tx.loadSaved).not.toHaveBeenCalled();
  });
  it("reports a bounded catalog-picker limit without partially saving settings", async () => {
    vi.mocked(tx.listVariantIds).mockImplementation(async (after, limit) => Array.from({ length: Math.min(limit, 10001 - after) }, (_, index) => after + index + 1));
    vi.mocked(tx.catalog.listCatalogCandidates).mockImplementation(async (ids) => ids.map((id) => ({ ...contentCandidate(), productVariantId: id })));
    await expect(service.targetsForMember("member", 22, { type: "listings" })).rejects.toMatchObject({ code: "DROPSHIP_CATALOG_TARGETS_TOO_LARGE" });
    expect(tx.saveListing).not.toHaveBeenCalled(); expect(tx.saveProfile).not.toHaveBeenCalled();
  });
  it("saves reusable templates with optimistic version and never writes individual descriptions", async () => {
    const input = { expectedRevisionId: null, idempotencyKey: "template", profile: { defaultTemplate: { introduction: "Welcome", footer: "" }, groups: [] } };
    expect((await service.saveProfile("member", 22, input)).state.revisionId).toBe(1);
    await expect(service.saveProfile("member", 22, input)).rejects.toMatchObject({ code: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
    expect(tx.saveListing).not.toHaveBeenCalled();
  });
});
