import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  channelCatalogLinkSchema,
  channelCatalogVariantSchema,
  channelCatalogViewSchema,
  type ChannelCatalogMapping,
  type ChannelCatalogRow,
} from "@shared/types/channel-catalog";
import { publicationRequest } from "./api";
import { errorMessage } from "./model";

const mappingResultSchema = z
  .object({ linked: z.number().int().nonnegative().max(100) })
  .strict();

/** Bind each link to the remote identity the operator actually reviewed. */
export function catalogMapping(
  item: ChannelCatalogRow,
  variantId: number,
): ChannelCatalogMapping {
  return {
    sku: item.sku,
    productVariantId: variantId,
    ...(item.externalProductId
      ? { expectedExternalProductId: item.externalProductId }
      : {}),
  };
}

export function useChannelCatalog({
  channelId,
  canEdit,
  busy,
  onMappingsChanged,
}: {
  channelId: number;
  canEdit: boolean;
  busy: boolean;
  onMappingsChanged?: () => Promise<void>;
}) {
  const base = `/api/channels/${channelId}/catalog`;
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [sku, setSku] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [matching, setMatching] = useState<ChannelCatalogRow | null>(null);
  const [variantSearch, setVariantSearch] = useState("");
  const [message, setMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const cursor = cursors[cursors.length - 1];
  const feed = useQuery({
    queryKey: [base, cursor, sku],
    queryFn: () => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (sku) params.set("sku", sku);
      return publicationRequest(
        "GET",
        `${base}?${params}`,
        channelCatalogViewSchema,
      );
    },
  });
  const variants = useQuery({
    queryKey: [base, "variants", variantSearch.trim()],
    enabled: matching !== null && variantSearch.trim().length >= 2,
    queryFn: () =>
      publicationRequest(
        "GET",
        `${base}/variants?q=${encodeURIComponent(variantSearch.trim())}`,
        channelCatalogVariantSchema.array(),
      ),
  });
  const link = useMutation({
    mutationFn: (mappings: ChannelCatalogMapping[]) => {
      if (!canEdit || busy)
        throw new Error(
          "Wait for the current change to finish before linking listings.",
        );
      return publicationRequest(
        "POST",
        `${base}/mappings`,
        mappingResultSchema,
        channelCatalogLinkSchema.parse({ mappings }),
      );
    },
    onSuccess: async (result) => {
      setMessage(
        `${result.linked} listing${result.linked === 1 ? "" : "s"} linked.`,
      );
      setSelected(new Set());
      setMatching(null);
      try {
        await client.invalidateQueries({ queryKey: [base] });
        await onMappingsChanged?.();
      } catch (error) {
        // The mapping write succeeded; a failed read must not imply it needs replay.
        setRefreshError(
          `Listings were linked, but refreshing their status failed: ${errorMessage(error)}`,
        );
      }
    },
  });
  const locked = busy || link.isPending;
  const resetFeedback = () => {
    setMessage("");
    setRefreshError("");
    link.reset();
  };
  const changePage = (next: (string | null)[]) => {
    if (locked) return;
    setCursors(next);
    setSelected(new Set());
    resetFeedback();
  };
  const searchFor = (value: string) => {
    if (locked) return;
    setSearch(value);
    setSku(value.trim());
    changePage([null]);
  };
  const chooseVariant = (item: ChannelCatalogRow) => {
    if (!canEdit || locked) return;
    resetFeedback();
    setMatching(item);
    setVariantSearch(item.variant?.sku ?? item.sku);
  };
  const linkMappings = (mappings: ChannelCatalogMapping[]) => {
    if (!canEdit || locked) return;
    resetFeedback();
    link.mutate(mappings);
  };
  return {
    feed,
    variants,
    link,
    locked,
    search,
    setSearch,
    sku,
    cursors,
    selected,
    setSelected,
    matching,
    variantSearch,
    setVariantSearch,
    message,
    refreshError,
    searchFor,
    changePage,
    chooseVariant,
    linkMappings,
    closeMatching: () => {
      if (!locked) setMatching(null);
    },
    refresh: () => {
      if (!locked) {
        setSelected(new Set());
        resetFeedback();
        void feed.refetch();
      }
    },
  };
}
