import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  listingRequirementsSchema,
  type ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import { publicationRequest } from "./api";
import { errorMessage } from "./model";
import type { FieldSchema } from "./schema-field-model";

export interface BulkRowRequirements {
  status: "missing" | "loading" | "error" | "ready";
  schema?: FieldSchema;
  error?: string;
}
const contextKey = (item: Pick<ListingDraftItem, "method" | "productType">) =>
  JSON.stringify([item.method, item.productType]);

/** One request per exact provider context. Untyped rows never borrow another row's schema. */
export function useBulkRowRequirements(
  base: string,
  items: readonly ListingDraftItem[],
  active: boolean,
) {
  const contexts = useMemo(
    () => [
      ...new Map(
        items
          .filter(
            (item) =>
              item.method === "match" || item.productType.trim().length > 0,
          )
          .map((item) => [
            contextKey(item),
            {
              key: contextKey(item),
              method: item.method,
              productType: item.productType,
            },
          ]),
      ).values(),
    ],
    [items],
  );
  const results = useQueries({
    queries: contexts.map((context) => ({
      queryKey: [base, "requirements", context.productType, context.method],
      enabled: active,
      queryFn: () =>
        publicationRequest(
          "GET",
          `${base}/requirements?${new URLSearchParams({ productType: context.productType, method: context.method })}`,
          listingRequirementsSchema,
        ),
    })),
  });
  const contextsWithResults = contexts.map((context, index) => ({
    ...context,
    result: results[index],
  }));
  const byContext = new Map(
    contextsWithResults.map(({ key, result }) => [key, result]),
  );
  const byVariant = new Map<number, BulkRowRequirements>(
    items.map((item) => {
      const result = byContext.get(contextKey(item));
      if (!result) return [item.variantId, { status: "missing" }];
      return [
        item.variantId,
        {
          status: result.error
            ? "error"
            : result.isFetching || !result.data
              ? "loading"
              : "ready",
          schema: result.data?.schema,
          ...(result.error ? { error: errorMessage(result.error) } : {}),
        },
      ];
    }),
  );
  return {
    byVariant,
    loadingCount: results.filter((result) => result.isFetching).length,
    errors: contextsWithResults
      .filter(({ result }) => result.error)
      .map(({ key, productType, method, result }) => ({
        key,
        label:
          productType ||
          (method === "match" ? "Catalog match" : "Product type"),
        message: errorMessage(result.error),
        retry: () => void result.refetch(),
      })),
  };
}
