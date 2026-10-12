import { z } from "zod";
import { ebayPublicationStockResultSchema, type EbayPublicationStockResult } from "@shared/types/ebay-publication-stock";
/** Historical command receipts remain readable. Normal Publish now owns
 * automatic stock mapping preparation; there is no separate Apply command. */
export class EbayPublicationStockService {
    constructor(private readonly receipts: {
        findApplied(input: {
            productId: number;
            commandKey: string;
        }): Promise<EbayPublicationStockResult | null>;
    }) { }
    async getReceipt(productId: number, commandKey: string): Promise<EbayPublicationStockResult | null> {
        const receipt = await this.receipts.findApplied({ productId: z.number().int().positive().max(2147483647).parse(productId), commandKey: z.string().uuid().parse(commandKey) });
        return receipt === null ? null : ebayPublicationStockResultSchema.parse(receipt);
    }
}
