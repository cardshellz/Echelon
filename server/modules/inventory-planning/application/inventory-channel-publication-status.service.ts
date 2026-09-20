import {
  channelPublicationStatusRequestSchema,
  channelPublicationStatusSchema,
  type ChannelPublicationStatus,
  type ChannelPublicationStatusRequest,
} from "@shared/types/inventory-channel-publication-status";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";

export interface ChannelPublicationStatusReader {
  read(request: ChannelPublicationStatusRequest): Promise<unknown>;
}

export class ChannelPublicationStatusService {
  constructor(private readonly reader: ChannelPublicationStatusReader) {}

  async read(request: ChannelPublicationStatusRequest): Promise<ChannelPublicationStatus> {
    const parsed = channelPublicationStatusRequestSchema.safeParse(request);
    if (!parsed.success) throw new InventoryAvailabilityMasterDataError(
      400, "PUBLICATION_STATUS_INVALID_REQUEST", "Choose a valid destination and product.",
    );
    // An invalid/missing observation must never become a zero or a successful read.
    return channelPublicationStatusSchema.parse(await this.reader.read(parsed.data));
  }
}
