import { PICKING_HISTORY_PAGE_SIZE, pickingHistoryPageSchema, type PickingHistoryPage } from "@shared/picking-history";

// A read must resolve or offer Retry; a stalled connection is not an empty archive.
export const PICKING_HISTORY_REQUEST_TIMEOUT_MS = 10_000;

export class PickingHistoryTimeoutError extends Error {
  readonly code = "PICKING_HISTORY_REQUEST_TIMEOUT";

  constructor() {
    super("The picking history search took too long. Please try again.");
    this.name = "PickingHistoryTimeoutError";
  }
}

export async function readPickingHistory(
  input: { search: string; provider: string; offset: number },
  signal: AbortSignal,
): Promise<PickingHistoryPage> {
  signal.throwIfAborted();
  const params = new URLSearchParams({ limit: String(PICKING_HISTORY_PAGE_SIZE), offset: String(input.offset) });
  if (input.search) params.set("search", input.search);
  if (input.provider !== "all") params.set("provider", input.provider);
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new PickingHistoryTimeoutError()), PICKING_HISTORY_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/picking/history?${params}`, { signal: controller.signal, credentials: "include" });
    if (!response.ok) throw new Error("Failed to load picking history");
    return pickingHistoryPageSchema.parse(await response.json());
  } catch (error) {
    if (controller.signal.reason instanceof PickingHistoryTimeoutError) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
}
