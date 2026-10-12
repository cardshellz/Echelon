import { pool } from "../../../db";
import { EbayPublicationStockService } from "../ebay-publication-stock.service";
import { EBAY_CHANNEL_ID } from "./ebay-api-runtime";
import { PostgresEbayPublicationStockRepository } from "./ebay-publication-stock.repository";
export const ebayPublicationStockService = new EbayPublicationStockService(new PostgresEbayPublicationStockRepository(pool, EBAY_CHANNEL_ID));
