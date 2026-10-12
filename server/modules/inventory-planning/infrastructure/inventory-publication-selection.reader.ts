import {
  stockPublicationSelectionSchema,
  type StockPublicationSelection,
  type StockSelectionQueryClient,
} from "@shared/types/stock-publication-selection";
import { readChannelStockSelection, ChannelStockSelectionError } from "../../channels/channel-stock-selection";
import { readDropshipListingStockSelection, DropshipError } from "../../dropship/stock-publication-selection";

export interface StockSelectionDestination {
  destinationKind: "channel_connection" | "dropship_store_connection";
  channelId: number;
  channelConnectionId: number | null;
  dropshipStoreConnectionId: number | null;
}

export class InventoryPublicationSelectionError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InventoryPublicationSelectionError";
  }
}

const CHANNEL_SELECTION_ERRORS = new Set([
  "CHANNEL_SELECTION_CONNECTION_UNRESOLVED", "CHANNEL_SELECTION_JOB_SCOPE_CHANGED", "CHANNEL_SELECTION_AMBIGUOUS",
]);
const DROPSHIP_SELECTION_ERRORS = new Set([
  "DROPSHIP_STOCK_SELECTION_AMBIGUOUS", "DROPSHIP_STOCK_STORE_NOT_FOUND", "DROPSHIP_CATALOG_VARIANT_UOM_TYPE_INVALID",
]);

/** The listing owner decides selection. Inventory only validates the exact
 * destination/response contract; it does not read or reproduce listing rules. */
export async function readPublicationStockSelection(
  client: StockSelectionQueryClient,
  target: StockSelectionDestination,
  input: { productId: number; productVariantIds: readonly number[]; now?: Date },
): Promise<StockPublicationSelection> {
  let selection: StockPublicationSelection;
  try {
    if (target.destinationKind === "channel_connection"
      && target.channelConnectionId !== null && target.dropshipStoreConnectionId === null) {
      selection = await readChannelStockSelection(client, {
        channelId: target.channelId,
        channelConnectionId: target.channelConnectionId,
        productId: input.productId,
        productVariantIds: input.productVariantIds,
      });
    } else if (target.destinationKind === "dropship_store_connection"
      && target.dropshipStoreConnectionId !== null && target.channelConnectionId === null) {
      const now = input.now ?? (await client.query<{ now: Date }>(
        "SELECT transaction_timestamp() AS now",
      )).rows[0]?.now;
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new InventoryPublicationSelectionError("PUBLICATION_SELECTION_CLOCK_INVALID",
          "Stock selection requires the caller's valid transaction time.");
      }
      selection = await readDropshipListingStockSelection(client, {
        storeConnectionId: target.dropshipStoreConnectionId,
        ...input,
        now,
      });
    } else {
      throw new InventoryPublicationSelectionError("PUBLICATION_SELECTION_DESTINATION_INVALID",
        "Stock selection destination has inconsistent connection ownership.");
    }
  } catch (error) {
    // These owner errors contain deliberate business diagnostics. A code-like
    // property on a SQL/validation/unknown error does not make its prose public.
    if ((error instanceof ChannelStockSelectionError && CHANNEL_SELECTION_ERRORS.has(error.code))
      || (error instanceof DropshipError && DROPSHIP_SELECTION_ERRORS.has(error.code)))
      throw new InventoryPublicationSelectionError(error.code, error.message, { cause: error });
    throw error;
  }
  const result = stockPublicationSelectionSchema.parse(selection);
  const requested = new Set(input.productVariantIds);
  if (result.productId !== input.productId || result.variants.length !== requested.size
    || result.variants.some(variant => !requested.has(variant.productVariantId))) {
    throw new InventoryPublicationSelectionError("PUBLICATION_SELECTION_IDENTITY_INCOMPLETE",
      "Listing selection did not return every exact requested product variant.");
  }
  return result;
}

export function selectionRequiresPublication(action: StockPublicationSelection["variants"][number]["action"]): boolean {
  return action === "publish" || action === "zero";
}
