import type { Pool } from "pg";
import { ebayPublicationStockResultSchema } from "@shared/types/ebay-publication-stock";
import { findEbayPublicationReadinessReceipt } from "../../inventory-planning/quantity-publication";
import { EbayListingSyncError } from "../ebay-listing-sync.domain";
import { PostgresEbayListingSyncRepository } from "./ebay-listing-sync.repository";
/** Read-only compatibility for immutable commands saved by the retired manual
 * stock setup flow. It cannot create mappings, selection or listing requests. */
export class PostgresEbayPublicationStockRepository {
    private readonly jobs: PostgresEbayListingSyncRepository;
    constructor(private readonly pool: Pool, private readonly channelId: number) { this.jobs = new PostgresEbayListingSyncRepository(pool); }
    async findApplied(input: {
        productId: number;
        commandKey: string;
    }) {
        const receipt = await findEbayPublicationReadinessReceipt(this.pool, { channelId: this.channelId, productId: input.productId, commandKey: input.commandKey });
        if (!receipt)
            return null;
        const job = await this.jobs.getByCommand(receipt.commandKey, receipt.channelId);
        if (!job || job.productId !== receipt.productId || job.operation !== "publish")
            throw new EbayListingSyncError("EBAY_PUBLICATION_STOCK_RECEIPT_INCOMPLETE", "The historical stock receipt is missing its saved publication request. Keep this command reference for investigation.");
        return ebayPublicationStockResultSchema.parse({ job, replayed: true, receipt: { commandKey: receipt.commandKey, productId: receipt.productId, reviewHash: receipt.contextHash, appliedAt: receipt.appliedAt } });
    }
}
