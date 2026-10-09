import { z } from "zod";
import {
  ORDER_EDIT_CATALOG_CATEGORY_PAGE_SIZE,
  ORDER_EDIT_CATALOG_PRODUCT_PAGE_SIZE,
  ORDER_EDIT_CATALOG_VARIANT_PAGE_SIZE,
  orderEditCatalogCategoriesInputSchema,
  orderEditCatalogCategoriesSchema,
  orderEditCatalogProductsInputSchema,
  orderEditCatalogProductsSchema,
  orderEditCatalogVariantsInputSchema,
  orderEditCatalogVariantsSchema,
  orderEditCatalogPageSchema,
  orderEditCatalogProductIdSchema,
  type OrderEditCatalogCategoriesInput,
  type OrderEditCatalogProductsInput,
  type OrderEditCatalogVariantsInput,
} from "@shared/order-edits/order-edit-catalog";
import type { OrderEditCatalog } from "../application/order-edit-catalog";
import {
  OrderEditProviderError,
  type OrderEditVariant,
} from "../application/order-edit-provider";
import {
  stockAvailable,
  supportedVariant,
  supportedCatalogProduct,
} from "../domain/order-edit-variant";
import { shopifyOrderEditVariantSchema } from "./shopify-order-edit-variant";
import { cents } from "./shopify-order-edit-money";
import * as gql from "./shopify-order-edit.queries";

const shop = z.object({ currencyCode: z.literal("USD") });
const product = z.object({
  id: orderEditCatalogProductIdSchema,
  title: z.string().min(1).max(500),
  productType: z.string().max(255),
  status: z.string(),
  isGiftCard: z.boolean(),
  requiresSellingPlan: z.boolean(),
  onlineStoreUrl: z.string().url().nullable(),
  featuredImage: z.object({ url: z.string() }).nullable(),
});
const variant = shopifyOrderEditVariantSchema.extend({
  id: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/),
  product: shopifyOrderEditVariantSchema.shape.product.extend({
    id: orderEditCatalogProductIdSchema,
    title: z.string().min(1),
  }),
});

type CatalogRequest = (
  connectionId: number,
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>;

/** Uses the provider's scoped transport. These GraphQL queries cannot stage an edit or touch money. */
export class ShopifyOrderEditCatalog implements OrderEditCatalog {
  constructor(private readonly request: CatalogRequest) {}

  async categories(connectionId: number, raw: OrderEditCatalogCategoriesInput) {
    const input = orderEditCatalogCategoriesInputSchema.parse(raw);
    const data = read(
      z.object({
        shop,
        productTypes: z.object({
          edges: z
            .array(z.object({ node: z.string().max(255) }))
            .max(ORDER_EDIT_CATALOG_CATEGORY_PAGE_SIZE),
          pageInfo: orderEditCatalogPageSchema,
        }),
      }),
      await this.request(connectionId, gql.CATALOG_CATEGORIES_QUERY, {
        first: ORDER_EDIT_CATALOG_CATEGORY_PAGE_SIZE,
        after: input.after,
      }),
    );
    assertCursorProgress(data.productTypes.pageInfo, input.after);
    return read(orderEditCatalogCategoriesSchema, {
      connectionId,
      input,
      categories: [
        ...new Set(
          data.productTypes.edges
            .map((edge) => edge.node.trim())
            .filter(Boolean),
        ),
      ],
      pageInfo: data.productTypes.pageInfo,
    });
  }

  async products(connectionId: number, raw: OrderEditCatalogProductsInput) {
    const input = orderEditCatalogProductsInputSchema.parse(raw);
    const data = read(
      z.object({
        shop,
        products: z.object({
          nodes: z.array(product).max(ORDER_EDIT_CATALOG_PRODUCT_PAGE_SIZE),
          pageInfo: orderEditCatalogPageSchema,
        }),
      }),
      await this.request(connectionId, gql.CATALOG_PRODUCTS_QUERY, {
        first: ORDER_EDIT_CATALOG_PRODUCT_PAGE_SIZE,
        after: input.after,
        query: catalogSearch(input.search, input.category),
      }),
    );
    assertCursorProgress(data.products.pageInfo, input.after);
    assertUnique(data.products.nodes.map((entry) => entry.id));
    return read(orderEditCatalogProductsSchema, {
      connectionId,
      input,
      products: data.products.nodes
        .filter(
          (entry) =>
            supportedCatalogProduct(entry) &&
            (input.category === null ||
              entry.productType.trim() === input.category),
        )
        .map(summary),
      pageInfo: data.products.pageInfo,
    });
  }

  async productVariants(
    connectionId: number,
    raw: OrderEditCatalogVariantsInput,
  ) {
    const input = orderEditCatalogVariantsInputSchema.parse(raw);
    const data = read(
      z.object({
        shop,
        product: product
          .extend({
            variants: z.object({
              nodes: z.array(variant).max(ORDER_EDIT_CATALOG_VARIANT_PAGE_SIZE),
              pageInfo: orderEditCatalogPageSchema,
            }),
          })
          .nullable(),
      }),
      await this.request(connectionId, gql.CATALOG_VARIANTS_QUERY, {
        id: input.productId,
        first: ORDER_EDIT_CATALOG_VARIANT_PAGE_SIZE,
        after: input.after,
      }),
    );
    if (!data.product || !supportedCatalogProduct(data.product))
      throw new OrderEditProviderError(
        "CATALOG_PRODUCT_UNAVAILABLE",
        "This product is no longer available on this store.",
        "rejected",
      );
    if (data.product.id !== input.productId)
      invalid("Shopify returned a different product.");
    assertCursorProgress(data.product.variants.pageInfo, input.after);
    assertUnique(data.product.variants.nodes.map((entry) => entry.id));
    for (const entry of data.product.variants.nodes)
      if (entry.product.id !== input.productId)
        invalid("A SKU does not belong to the selected product.");
    const selectedProduct = data.product;
    return read(orderEditCatalogVariantsSchema, {
      connectionId,
      input,
      product: summary(data.product),
      variants: data.product.variants.nodes
        .filter(supportedVariant)
        .map((entry) => ({
          variantId: entry.id,
          title: selectedProduct.title,
          variantTitle: entry.title === "Default Title" ? null : entry.title,
          sku: entry.sku,
          priceCents: cents(entry.price),
          available: stockAvailable(entry, 1),
        })),
      pageInfo: data.product.variants.pageInfo,
    });
  }

  async searchVariants(
    connectionId: number,
    search: string,
  ): Promise<OrderEditVariant[]> {
    const input = orderEditCatalogProductsInputSchema.parse({ search });
    const data = read(
      z.object({
        shop,
        productVariants: z.object({
          nodes: z
            .array(
              variant.extend({
                product: variant.shape.product.extend({
                  onlineStoreUrl: z.string().url().nullable(),
                }),
              }),
            )
            .max(gql.LEGACY_SKU_RESULTS),
        }),
        products: z.object({
          nodes: z
            .array(
              product.extend({
                variants: z.object({
                  nodes: z.array(variant).max(gql.LEGACY_OPTIONS_PER_PRODUCT),
                }),
              }),
            )
            .max(gql.LEGACY_PRODUCT_RESULTS),
        }),
      }),
      await this.request(connectionId, gql.SEARCH_QUERY, {
        query: catalogSearch(input.search, null),
        skuQuery: `product_status:active AND published_status:published${input.search ? ` AND (${searchClause("sku", input.search)})` : ""}`,
      }),
    );
    assertUnique(data.products.nodes.map((entry) => entry.id));
    assertUnique(data.productVariants.nodes.map((entry) => entry.id));
    const options = data.productVariants.nodes.filter((entry) =>
      supportedCatalogProduct(entry.product),
    );
    for (const entry of data.products.nodes.filter(supportedCatalogProduct)) {
      assertUnique(entry.variants.nodes.map((option) => option.id));
      for (const option of entry.variants.nodes) {
        if (option.product.id !== entry.id)
          invalid("A SKU does not belong to its product.");
        // The parent publication has already been verified above.
        options.push({
          ...option,
          product: { ...option.product, onlineStoreUrl: entry.onlineStoreUrl },
        });
      }
    }
    return [
      ...new Map(
        options.filter(supportedVariant).map((option) => [
          option.id,
          {
            id: option.id,
            title: option.displayName,
            sku: option.sku,
            priceCents: cents(option.price),
            available: stockAvailable(option, 1),
            availableQuantity: Math.max(0, option.sellableOnlineQuantity),
          },
        ]),
      ).values(),
    ];
  }
}

/** Product title is on products, not productVariants. Only generated field clauses enter the query. */
function catalogSearch(search: string, category: string | null): string {
  const filters = ["status:active", "published_status:published"];
  if (category)
    filters.push(`product_type:"${category.replace(/[\\"():*]/g, "\\$&")}"`);
  if (search) {
    // Punctuation is a separator except inside SKUs. User text cannot inject field names, negation or wildcards.
    filters.push(
      `((${searchClause("title", search)}) OR (${searchClause("sku", search)}))`,
    );
  }
  return filters.join(" AND ");
}

function searchClause(field: "title" | "sku", search: string): string {
  const terms =
    search.match(new RegExp("[\\p{L}\\p{N}][\\p{L}\\p{N}._/-]*", "gu")) ?? [];
  return terms.map((term) => `${field}:${term}*`).join(" AND ");
}
function summary(entry: z.infer<typeof product>) {
  return {
    productId: entry.id,
    title: entry.title,
    category: entry.productType.trim() || null,
    imageUrl: entry.featuredImage?.url ?? null,
  };
}
function assertUnique(ids: string[]): void {
  if (new Set(ids).size !== ids.length)
    invalid("Shopify returned duplicate catalog identities.");
}
function assertCursorProgress(
  page: z.infer<typeof orderEditCatalogPageSchema>,
  after: string | null,
): void {
  if (page.hasNextPage && page.endCursor === after)
    invalid("Shopify returned a non-advancing catalog cursor.");
}
function invalid(message: string): never {
  throw new OrderEditProviderError(
    "SHOPIFY_RESPONSE_INVALID",
    message,
    "rejected",
  );
}
function read<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid("Shopify returned an invalid catalog response.");
  return result.data;
}
