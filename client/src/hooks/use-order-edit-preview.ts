import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  ORDER_EDIT_PREVIEW_DEBOUNCE_MS,
  ORDER_EDIT_PREVIEW_TTL_MS,
  type OrderEditPreview,
  type OrderEditPreviewInput,
  type OrderEditPreviewScope,
} from "@shared/order-edits/order-edit-preview";
import { useDebounce } from "@/hooks/use-debounce";
import {
  matchingOrderEditPreview,
  OrderEditRequestError,
  ORDER_EDITS_API,
  type OrderEditTransport,
} from "@/lib/order-edits";
import { orderEditPreviewRefreshDelay } from "@/lib/order-edit-preview-cache";

const defaultClock = () => Date.now();
const staleTime = (query: {
  state: { data?: OrderEditPreview; dataUpdatedAt: number };
}) =>
  Math.max(
    0,
    Date.parse(query.state.data?.expiresAt ?? "") - query.state.dataUpdatedAt,
  ) || 0;
const previewKey = (actor: string, inputKey: string) =>
  [ORDER_EDITS_API, actor, "preview", inputKey] as const;

export function useOrderEditPreview(options: {
  api: OrderEditTransport;
  actorId: string;
  scope: OrderEditPreviewScope;
  input: OrderEditPreviewInput | null;
  nextInput: OrderEditPreviewInput | null;
  active: boolean;
  clock?: () => number;
}) {
  const {
    api,
    actorId,
    scope,
    input,
    nextInput,
    active,
    clock = defaultClock,
  } = options;
  const [warmed, setWarmed] = useState(false);
  const inputKey = input ? canonicalJson(input) : "";
  const settledKey = useDebounce(inputKey, ORDER_EDIT_PREVIEW_DEBOUNCE_MS);
  const enabled = active && !!input && inputKey === settledKey;
  const query = useQuery({
    // Select the current cart's cache immediately; debounce only a new request.
    queryKey: previewKey(actorId, inputKey),
    queryFn: ({ signal }) => api.preview(input!, signal),
    enabled,
    retry: false,
    gcTime: ORDER_EDIT_PREVIEW_TTL_MS,
    staleTime,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchInterval: (current) =>
      enabled && current.state.data && current.state.status !== "error"
        ? orderEditPreviewRefreshDelay(current.state.data.expiresAt, clock())
        : false,
  });
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setWarmed(false);
    void api
      .warmPreview(scope, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) setWarmed(true);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          console.warn(
            "order_edit_preview_warm_failed",
            cause instanceof OrderEditRequestError
              ? cause.code
              : "PREVIEW_UNAVAILABLE",
          );
      });
    return () => controller.abort();
  }, [
    active,
    api,
    scope.connectionId,
    scope.omsOrderId,
    scope.expectedRevision,
  ]);
  const currentPreview = input
    ? matchingOrderEditPreview(query.data, input, clock())
    : null;
  // Preserve the same cart's last display while refreshing. It must never be
  // used as an apply/payment authority or silently reused for a different cart.
  const displayPreview =
    input && query.data && canonicalJson(query.data.input) === inputKey
      ? query.data
      : null;
  const nextKey = nextInput ? canonicalJson(nextInput) : "";
  const forecastEnabled =
    active && warmed && !!nextInput && (!input || !!currentPreview);
  const forecast = useQuery({
    // The same key lets a foreground change reuse this result or in-flight
    // request. Observe only one adjacent quantity and refresh it after expiry.
    queryKey: previewKey(actorId, nextKey),
    queryFn: ({ signal }) => api.preview(nextInput!, signal),
    enabled: forecastEnabled,
    staleTime,
    gcTime: ORDER_EDIT_PREVIEW_TTL_MS,
    retry: false,
    refetchOnMount: true,
    refetchInterval: (current) =>
      forecastEnabled && current.state.data && current.state.status !== "error"
        ? orderEditPreviewRefreshDelay(current.state.data.expiresAt, clock())
        : false,
  });
  useEffect(() => {
    if (forecast.error)
      console.warn(
        "order_edit_preview_read_ahead_failed",
        forecast.error instanceof OrderEditRequestError
          ? forecast.error.code
          : "PREVIEW_UNAVAILABLE",
      );
  }, [forecast.error]);
  return { currentPreview, displayPreview, query };
}
