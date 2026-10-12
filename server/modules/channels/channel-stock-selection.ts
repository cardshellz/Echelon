// Channels owns selection and retained listing intent. Inventory consumes this
// read-only interface using its existing transaction and quantity protections.
export { readChannelStockSelection, ChannelStockSelectionError } from "./infrastructure/channel-stock-selection.repository";
export type { StockSelectionQueryClient, StockPublicationSelection } from "@shared/types/stock-publication-selection";
