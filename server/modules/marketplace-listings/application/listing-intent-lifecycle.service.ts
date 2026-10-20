import type {
  IntentDelivery,
  IntentHandoff,
} from "../domain/listing-intent-propagation";
import { resolveListingIntentLifecycle } from "../domain/listing-intent-lifecycle";

export interface ListingIntentLifecycleReader {
  inspect(
    delivery: IntentDelivery,
    now: Date,
  ): Promise<Parameters<typeof resolveListingIntentLifecycle>[0] | null>;
}
/** Disposition is part of the shared listing lifecycle. Provider adapters only
 * consult it after checking for their existing durable command receipt. */
export class ListingIntentLifecycleService {
  constructor(
    private readonly reader: ListingIntentLifecycleReader,
    private readonly now: () => Date,
  ) {}
  async assess(delivery: IntentDelivery): Promise<IntentHandoff | null> {
    const evidence = await this.reader.inspect(delivery, this.now());
    return evidence ? resolveListingIntentLifecycle(evidence) : null;
  }
}
