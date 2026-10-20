import { z } from "zod";
import {
  ebayAvailablePolicyValuesSchema,
  type EbayAvailablePolicyValues,
} from "@shared/ebay-business-policies";
import {
  EBAY_POLICY_KINDS,
  EBAY_POLICY_FIELDS,
  EBAY_POLICY_LABELS,
  EMPTY_EBAY_POLICIES,
  EbayBusinessPolicyError,
  assertEbayPolicyScope,
  assertResolvedEbayPolicies,
  ebayPolicyPatchSchema,
  ebayPolicyScopeSchema,
  ebayPolicyValuesSchema,
  getEbayPolicySelectionState,
  resolveEbayPolicies,
  resolvedEbayPolicyValues,
  type EbayPolicyCatalog,
  type EbayPolicyPatch,
  type EbayPolicyScope,
  type EbayPolicyValues,
  type EbayPolicySource,
  type EbayResolvedPolicies,
} from "@shared/ebay-business-policies";

export const ebayPolicyTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("store") }).strict(),
  z
    .object({
      kind: z.literal("category"),
      productTypeSlug: z.string().trim().min(1).max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal("product"),
      productId: z.number().int().positive().max(2147483647),
    })
    .strict(),
  z
    .object({
      kind: z.literal("variant"),
      variantId: z.number().int().positive().max(2147483647),
    })
    .strict(),
]);
export type EbayPolicyTarget = z.infer<typeof ebayPolicyTargetSchema>;
const optionalText = z.string().trim().max(200).nullable().optional();
const categoryPolicyId = ebayPolicyPatchSchema.shape.fulfillmentPolicyId;
export const ebayCategoryMappingPatchSchema = z
  .object({
    productTypeSlug: z.string().trim().min(1).max(50),
    ebayBrowseCategoryId: z.string().trim().max(20).nullable().optional(),
    ebayBrowseCategoryName: optionalText,
    ebayStoreCategoryId: z.string().trim().max(20).nullable().optional(),
    ebayStoreCategoryName: optionalText,
    fulfillmentPolicyOverride: categoryPolicyId,
    returnPolicyOverride: categoryPolicyId,
    paymentPolicyOverride: categoryPolicyId,
    listingEnabled: z.boolean().optional(),
    expectedPolicies: ebayPolicyValuesSchema.optional(),
  })
  .strict();
export type EbayCategoryMappingPatch = z.infer<
  typeof ebayCategoryMappingPatchSchema
>;
export interface EbayPolicyProductSelection {
  productTypeSlug: string | null;
  product: EbayPolicyValues;
  variants: { variantId: number; policies: EbayPolicyValues }[];
}
export interface EbayPolicyTransaction {
  readPolicies(target: EbayPolicyTarget): Promise<EbayPolicyValues>;
  writePolicies(
    target: EbayPolicyTarget,
    before: EbayPolicyValues,
    after: EbayPolicyValues,
    actor: string,
    now: Date,
  ): Promise<void>;
  readProductSelection(
    productId: number,
    variantIds: readonly number[],
  ): Promise<EbayPolicyProductSelection>;
  saveCategoryMapping(
    mapping: EbayCategoryMappingPatch,
    actor: string,
    now: Date,
  ): Promise<void>;
}
export interface EbayBusinessPolicyRepository {
  withScope<T>(
    scope: EbayPolicyScope,
    run: (transaction: EbayPolicyTransaction) => Promise<T>,
  ): Promise<T>;
}
export interface EbayBusinessPolicyCatalogProvider {
  readCatalog(scope: EbayPolicyScope): Promise<EbayPolicyCatalog>;
}
export interface EbayBusinessPolicyDependencies {
  repository: EbayBusinessPolicyRepository;
  provider: EbayBusinessPolicyCatalogProvider;
  scopeReader: () => Promise<EbayPolicyScope>;
  clock?: () => Date;
}

function equalPolicies(
  left: EbayPolicyValues,
  right: EbayPolicyValues,
): boolean {
  return EBAY_POLICY_KINDS.every(
    (kind) =>
      left[EBAY_POLICY_FIELDS[kind]] === right[EBAY_POLICY_FIELDS[kind]],
  );
}
function sourceFor(target: EbayPolicyTarget): EbayPolicySource {
  const { kind, ...identity } = target;
  return { ...identity, scope: kind };
}
function assertPatchAvailable(
  patch: EbayPolicyPatch,
  target: EbayPolicyTarget,
  catalog: EbayPolicyCatalog,
): void {
  for (const kind of EBAY_POLICY_KINDS) {
    const id = patch[EBAY_POLICY_FIELDS[kind]];
    if (
      id !== undefined &&
      id !== null &&
      getEbayPolicySelectionState(kind, id, catalog).status !== "available"
    )
      throw new EbayBusinessPolicyError(
        "EBAY_POLICY_UNAVAILABLE",
        `The ${EBAY_POLICY_LABELS[kind].toLowerCase()} policy (${id}) is unavailable for this eBay account and marketplace. Refresh the policies and choose an available policy or inheritance.`,
        422,
        {
          policyKind: kind,
          policyId: id,
          policySource: sourceFor(target),
          marketplaceId: catalog.scope.marketplaceId,
        },
      );
  }
}

export function createEbayBusinessPolicyService(
  deps: EbayBusinessPolicyDependencies,
) {
  const clock = deps.clock ?? (() => new Date());
  const scopeReader = async () =>
    ebayPolicyScopeSchema.parse(await deps.scopeReader());
  const catalogFor = async (scope: EbayPolicyScope) => {
    const catalog = await deps.provider.readCatalog(scope);
    assertEbayPolicyScope(scope, catalog.scope);
    return catalog;
  };
  return {
    async readCatalog(): Promise<EbayPolicyCatalog> {
      return catalogFor(await scopeReader());
    },
    async readPolicies(
      targetInput: EbayPolicyTarget,
    ): Promise<EbayPolicyValues> {
      const target = ebayPolicyTargetSchema.parse(targetInput);
      const scope = await scopeReader();
      return deps.repository.withScope(scope, (tx) => tx.readPolicies(target));
    },
    async patchPolicies(input: {
      target: EbayPolicyTarget;
      patch: EbayPolicyPatch;
      expectedPolicies?: EbayPolicyValues;
      expectedScope?: EbayPolicyScope;
      actor: string;
    }): Promise<EbayPolicyValues> {
      const target = ebayPolicyTargetSchema.parse(input.target),
        patch = ebayPolicyPatchSchema.parse(input.patch),
        actor = z.string().trim().min(1).parse(input.actor);
      const expected =
        input.expectedPolicies === undefined
          ? undefined
          : ebayPolicyValuesSchema.parse(input.expectedPolicies);
      const scope = await scopeReader();
      if (input.expectedScope)
        assertEbayPolicyScope(
          ebayPolicyScopeSchema.parse(input.expectedScope),
          scope,
        );
      if (
        Object.values(patch).some(
          (value) => value !== null && value !== undefined,
        )
      )
        assertPatchAvailable(patch, target, await catalogFor(scope));
      return deps.repository.withScope(scope, async (tx) => {
        const before = await tx.readPolicies(target);
        if (expected && !equalPolicies(expected, before))
          throw new EbayBusinessPolicyError(
            "EBAY_POLICY_STALE_EDIT",
            "These eBay policies changed while you were editing. Refresh and review the current selections before saving.",
            409,
          );
        const after = {
          ...before,
          ...Object.fromEntries(
            Object.entries(patch).filter(([, value]) => value !== undefined),
          ),
        } as EbayPolicyValues;
        if (!equalPolicies(before, after))
          await tx.writePolicies(target, before, after, actor, clock());
        return after;
      });
    },
    async saveCategoryMappings(input: {
      mappings: EbayCategoryMappingPatch[];
      expectedScope?: EbayPolicyScope;
      actor: string;
    }): Promise<void> {
      const mappings = z
          .array(ebayCategoryMappingPatchSchema)
          .max(500)
          .parse(input.mappings),
        actor = z.string().trim().min(1).parse(input.actor);
      if (
        new Set(mappings.map((mapping) => mapping.productTypeSlug)).size !==
        mappings.length
      )
        throw new EbayBusinessPolicyError(
          "EBAY_POLICY_INVALID_REQUEST",
          "Each product type may appear only once in a category mapping request.",
        );
      const scope = await scopeReader();
      if (input.expectedScope)
        assertEbayPolicyScope(
          ebayPolicyScopeSchema.parse(input.expectedScope),
          scope,
        );
      const patches = mappings.map(
        (mapping) =>
          Object.fromEntries(
            EBAY_POLICY_KINDS.flatMap((kind) => {
              const value = mapping[`${kind}PolicyOverride`];
              return value === undefined
                ? []
                : [[EBAY_POLICY_FIELDS[kind], value]];
            }),
          ) as EbayPolicyPatch,
      );
      const catalog = patches.some((patch) =>
        Object.values(patch).some((value) => value !== null),
      )
        ? await catalogFor(scope)
        : null;
      for (let i = 0; i < mappings.length; i++)
        if (catalog)
          assertPatchAvailable(
            patches[i],
            { kind: "category", productTypeSlug: mappings[i].productTypeSlug },
            catalog,
          );
      await deps.repository.withScope(scope, async (tx) => {
        for (const mapping of mappings) {
          const before = await tx.readPolicies({
            kind: "category",
            productTypeSlug: mapping.productTypeSlug,
          });
          if (
            mapping.expectedPolicies &&
            !equalPolicies(mapping.expectedPolicies, before)
          )
            throw new EbayBusinessPolicyError(
              "EBAY_POLICY_STALE_EDIT",
              "This product type's eBay policies changed while you were editing. Refresh before saving.",
              409,
            );
          await tx.saveCategoryMapping(mapping, actor, clock());
        }
      });
    },
    async resolveProductPolicies(input: {
      productId: number;
      variantIds: readonly number[];
      expectedScope?: EbayPolicyScope;
    }): Promise<{
      scope: EbayPolicyScope;
      product: EbayPolicyValues;
      byVariantId: Map<number, EbayAvailablePolicyValues>;
      provenanceByVariantId: Map<number, EbayResolvedPolicies>;
    }> {
      const productId = z
          .number()
          .int()
          .positive()
          .max(2147483647)
          .parse(input.productId),
        variantIds = z
          .array(z.number().int().positive().max(2147483647))
          .min(1)
          .max(500)
          .parse(input.variantIds);
      if (new Set(variantIds).size !== variantIds.length)
        throw new EbayBusinessPolicyError(
          "EBAY_POLICY_INVALID_REQUEST",
          "Listing policy scope contains duplicate variants.",
        );
      const scope = await scopeReader();
      if (input.expectedScope)
        assertEbayPolicyScope(input.expectedScope, scope);
      const catalog = await catalogFor(scope);
      return deps.repository.withScope(scope, async (tx) => {
        const selection = await tx.readProductSelection(productId, variantIds);
        const layers: {
          source: EbayPolicySource;
          policies: EbayPolicyValues;
        }[] = [
          {
            source: { scope: "store" },
            policies: await tx.readPolicies({ kind: "store" }),
          },
        ];
        if (selection.productTypeSlug)
          layers.push({
            source: {
              scope: "category",
              productTypeSlug: selection.productTypeSlug,
            },
            policies: await tx.readPolicies({
              kind: "category",
              productTypeSlug: selection.productTypeSlug,
            }),
          });
        layers.push({
          source: { scope: "product", productId },
          policies: selection.product,
        });
        const product = resolvedEbayPolicyValues(resolveEbayPolicies(layers)),
          byVariantId = new Map<number, EbayAvailablePolicyValues>(),
          provenanceByVariantId = new Map<number, EbayResolvedPolicies>();
        for (const variant of selection.variants) {
          const resolved = resolveEbayPolicies([
            ...layers,
            {
              source: {
                scope: "variant",
                productId,
                variantId: variant.variantId,
              },
              policies: variant.policies,
            },
          ]);
          assertResolvedEbayPolicies(resolved, catalog);
          provenanceByVariantId.set(variant.variantId, resolved);
          byVariantId.set(
            variant.variantId,
            ebayAvailablePolicyValuesSchema.parse(
              resolvedEbayPolicyValues(resolved),
            ),
          );
        }
        return { scope, product, byVariantId, provenanceByVariantId };
      });
    },
  };
}
