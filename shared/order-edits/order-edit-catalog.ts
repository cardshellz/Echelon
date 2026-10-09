import { z } from "zod";
import { orderEditVariantSchema } from "./order-edit.contract";

// Bound a single catalog read; larger catalogs use cursors rather than truncation.
export const ORDER_EDIT_CATALOG_PRODUCT_PAGE_SIZE = 20;
export const ORDER_EDIT_CATALOG_VARIANT_PAGE_SIZE = 50;
export const ORDER_EDIT_CATALOG_CATEGORY_PAGE_SIZE = 250;
export const orderEditCatalogProductIdSchema = z
  .string()
  .regex(/^gid:\/\/shopify\/Product\/[1-9]\d*$/);
const connectionId = z.number().int().positive().safe();
const cursor = z.string().min(1).max(1024).nullable().default(null);
const category = z.string().trim().min(1).max(255).nullable().default(null);
export const orderEditCatalogSearchSchema = z
  .string()
  .trim()
  .max(100)
  .refine(
    (value) => !value || new RegExp("[\\p{L}\\p{N}]", "u").test(value),
    "Enter a product name or SKU.",
  )
  .default("");
export const orderEditCatalogCategoriesInputSchema = z
  .object({ after: cursor })
  .strict();
export const orderEditCatalogProductsInputSchema = z
  .object({ search: orderEditCatalogSearchSchema, category, after: cursor })
  .strict();
export const orderEditCatalogVariantsInputSchema = z
  .object({ productId: orderEditCatalogProductIdSchema, after: cursor })
  .strict();
export const orderEditCatalogPageSchema = z
  .object({ hasNextPage: z.boolean(), endCursor: cursor })
  .strict()
  .refine(
    (page) => !page.hasNextPage || page.endCursor !== null,
    "A next page requires a cursor.",
  );
export const orderEditCatalogProductSchema = z
  .object({
    productId: orderEditCatalogProductIdSchema,
    title: z.string().min(1).max(500),
    category,
    imageUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }, "A safe HTTPS image URL is required.")
      .nullable(),
  })
  .strict();
export const orderEditCatalogCategoriesSchema = z
  .object({
    connectionId,
    input: orderEditCatalogCategoriesInputSchema,
    categories: z
      .array(z.string().trim().min(1).max(255))
      .max(ORDER_EDIT_CATALOG_CATEGORY_PAGE_SIZE),
    pageInfo: orderEditCatalogPageSchema,
  })
  .strict();
export const orderEditCatalogProductsSchema = z
  .object({
    connectionId,
    input: orderEditCatalogProductsInputSchema,
    products: z
      .array(orderEditCatalogProductSchema)
      .max(ORDER_EDIT_CATALOG_PRODUCT_PAGE_SIZE),
    pageInfo: orderEditCatalogPageSchema,
  })
  .strict();
export const orderEditCatalogVariantsSchema = z
  .object({
    connectionId,
    input: orderEditCatalogVariantsInputSchema,
    product: orderEditCatalogProductSchema,
    variants: z
      .array(orderEditVariantSchema)
      .max(ORDER_EDIT_CATALOG_VARIANT_PAGE_SIZE),
    pageInfo: orderEditCatalogPageSchema,
  })
  .strict()
  .refine(
    (result) => result.product.productId === result.input.productId,
    "The product does not match the requested parent.",
  );
export type OrderEditCatalogCategoriesInput = z.infer<
  typeof orderEditCatalogCategoriesInputSchema
>;
export type OrderEditCatalogProductsInput = z.infer<
  typeof orderEditCatalogProductsInputSchema
>;
export type OrderEditCatalogVariantsInput = z.infer<
  typeof orderEditCatalogVariantsInputSchema
>;
export type OrderEditCatalogProduct = z.infer<
  typeof orderEditCatalogProductSchema
>;
export type OrderEditCatalogCategories = z.infer<
  typeof orderEditCatalogCategoriesSchema
>;
export type OrderEditCatalogProducts = z.infer<
  typeof orderEditCatalogProductsSchema
>;
export type OrderEditCatalogVariants = z.infer<
  typeof orderEditCatalogVariantsSchema
>;
