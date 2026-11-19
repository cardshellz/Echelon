import { shipmentWorkListQuerySchema } from "@shared/procurement/shipment-work-list";

/** Only list filters are retained; no arbitrary return URL is accepted. */
export function shipmentListState(search: string) {
  const params = new URLSearchParams(search);
  const read = (key: string) => params.getAll(key).length === 1 ? params.get(key) ?? undefined : undefined;
  const shape = shipmentWorkListQuerySchema.shape;
  const status = shape.status.safeParse(read("status")).data;
  return {
    status: typeof status === "string" ? status : "active",
    mode: shape.mode.safeParse(read("mode")).data ?? "all",
    costFilter: shape.costFilter.safeParse(read("costFilter")).data ?? "all",
    search: shape.search.safeParse(read("search")).data ?? "",
    offset: shape.offset.safeParse(read("offset")).data ?? 0,
  };
}
export function shipmentListSearch(search: string): string {
  const state = shipmentListState(search);
  const params = new URLSearchParams({ status: state.status, costFilter: state.costFilter, offset: String(state.offset) });
  if (state.mode !== "all") params.set("mode", state.mode);
  if (state.search) params.set("search", state.search);
  return params.toString();
}
