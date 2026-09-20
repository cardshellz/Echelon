import { z } from "zod";
import { applyChannelDefinitionSchema, channelDefinitionSelectionSchema, channelDefinitionReviewSchema,
  channelDefinitionReceiptSchema, channelDefinitionProgressSchema,
  type ApplyChannelDefinition, type ChannelDefinitionReview, type ChannelDefinitionReceipt, type ChannelDefinitionProgress,
} from "@shared/types/inventory-channel-definition";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";

export class ChannelDefinitionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "ChannelDefinitionError";
  }
}
export interface ChannelDefinitionStore {
  review(channelId: number): Promise<ChannelDefinitionReview>;
  apply(command: ApplyChannelDefinition, actor: string, requestHash: string, now: Date): Promise<ChannelDefinitionReceipt>;
  progress(channelId: number): Promise<ChannelDefinitionProgress | null>;
}
export class ChannelDefinitionService {
  constructor(private readonly store: ChannelDefinitionStore, private readonly clock = { now: () => new Date() }) {}
  async review(input: unknown): Promise<ChannelDefinitionReview> {
    const { channelId } = channelDefinitionSelectionSchema.parse(input);
    return validatedResponse(channelDefinitionReviewSchema, await this.store.review(channelId));
  }
  async apply(input: unknown, actor: unknown): Promise<ChannelDefinitionReceipt> {
    const command = applyChannelDefinitionSchema.parse(input);
    const authenticatedActor = z.string().trim().min(1).max(100).parse(actor);
    const now = z.date().parse(this.clock.now());
    return validatedResponse(channelDefinitionReceiptSchema, await this.store.apply(command, authenticatedActor,
      inventoryCutoverEvidenceHash({ command, actor: authenticatedActor }), now));
  }
  async progress(input: unknown): Promise<ChannelDefinitionProgress | null> {
    const { channelId } = channelDefinitionSelectionSchema.parse(input);
    return validatedResponse(channelDefinitionProgressSchema.nullable(), await this.store.progress(channelId));
  }
}

function validatedResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    // An invalid response after a committed Apply is not a rejected request.
    // Preserve retry identity by returning a server error, never a 4xx.
    throw new ChannelDefinitionError("CHANNEL_DEFINITION_RESULT_INVALID", "The result could not be verified. Retry with the same command key.", 500);
  }
  return result.data;
}
