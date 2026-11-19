import { z } from "zod";
import { ebayAutomaticRecoveryCommandSchema, publicationBigint, sortedRecoveryScopes,
  type EbayAutomaticRecoveryInput } from "../domain/ebay-automatic-publication-recovery";

export const ebayAutomaticRecoveryResultSchema = z.object({
  superseded: z.array(publicationBigint).max(100), unresolved: z.array(publicationBigint).max(100),
  busy: z.boolean(), watchId: publicationBigint.nullable(),
  reviewRequired: z.boolean().optional(),
}).strict();
export type EbayAutomaticRecoveryResult = z.infer<typeof ebayAutomaticRecoveryResultSchema>;
export interface EbayAutomaticPublicationRecoveryStore {
  recover(input: EbayAutomaticRecoveryInput & { now: Date }): Promise<EbayAutomaticRecoveryResult>;
}

/** The saved Sync command authorizes replacement with current values. Historical
 * effects remain unknown; an atomic recurring obligation is required to resume. */
export class EbayAutomaticPublicationRecoveryService {
  constructor(private readonly store: EbayAutomaticPublicationRecoveryStore, private readonly clock: () => Date = () => new Date()) {}
  async recover(input: EbayAutomaticRecoveryInput): Promise<EbayAutomaticRecoveryResult> {
    const command = ebayAutomaticRecoveryCommandSchema.parse(input);
    return ebayAutomaticRecoveryResultSchema.parse(await this.store.recover({ ...command,
      scopes: sortedRecoveryScopes(command.scopes), now: z.date().parse(this.clock()) }));
  }
}
