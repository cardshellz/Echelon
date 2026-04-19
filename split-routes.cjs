const fs = require('fs');

const src = fs.readFileSync('server/routes/ebay-channel.routes.ts', 'utf-8');
const lines = src.split('\n');

const imports = `import express, { type Request, type Response } from "express";
import { eq, and, sql, asc, isNotNull, inArray, isNull, desc } from "drizzle-orm";
import { db, pool } from "../../db";
import { requireAuth, requireInternalApiKey, requirePermission } from "../middleware";
import {
  channels,
  channelConnections,
  ebayOauthTokens,
  ebayCategoryMappings,
  products,
  productVariants,
  productTypes,
  inventoryLevels,
} from "@shared/schema";
import { getAuthService, getChannelConnection, escapeXml, getCached, setCache, ebayApiRequest, ebayApiRequestWithRateNotify, EBAY_CHANNEL_ID, atpService } from "./ebay-utils";
import { createInventoryAtpService } from "../../modules/inventory/atp.service";
import { upsertChannelListing, upsertPushError, clearPushError, resolveChannelPrice, applyPricingRule, determineVariationAspectName, syncActiveListings, triggerPricingRuleSync, delay } from "./ebay-sync-helpers";\n`;

function extractSlice(startLine, endLine) {
    return lines.slice(startLine - 1, endLine).join('\n').replace(/app\.(get|post|put|delete|patch)\(/g, 'router.$1(');
}

function writeRouter(filename, items) {
    const content = imports + `\nexport const router = express.Router();\n\n` + items.join('\n\n') + '\n';
    fs.writeFileSync(`server/routes/ebay/${filename}`, content);
}

writeRouter('ebay-config.routes.ts', [
    extractSlice(231, 388),
    extractSlice(389, 464),
    extractSlice(465, 551),
    extractSlice(552, 581),
    extractSlice(582, 612),
    extractSlice(864, 898)
]);

writeRouter('ebay-taxonomy.routes.ts', [
    extractSlice(900, 962),
    extractSlice(963, 1042),
    extractSlice(1043, 1107),
    extractSlice(1108, 1245),
    extractSlice(1246, 1272),
    extractSlice(1273, 1326),
    extractSlice(1327, 1357),
    extractSlice(1358, 1414)
]);

writeRouter('ebay-listings.routes.ts', [
    extractSlice(614, 863),
    extractSlice(1416, 1954),
    extractSlice(1955, 2471),
    extractSlice(2472, 2484),
    extractSlice(2485, 2502),
    extractSlice(2503, 2862),
    extractSlice(3073, 3206)
]);

writeRouter('ebay-pricing.routes.ts', [
    extractSlice(2863, 2892),
    extractSlice(2893, 2987),
    extractSlice(2988, 3009),
    extractSlice(3010, 3042),
    extractSlice(3043, 3072)
]);

writeRouter('ebay-policies.routes.ts', [
    extractSlice(3207, 3233),
    extractSlice(3234, 3268),
    extractSlice(3269, 3303),
    extractSlice(3304, 3339),
    extractSlice(3340, 3375),
    extractSlice(3376, 3476),
    extractSlice(3477, 3559) 
]);

// Extract Helpers
const helperImports = `import { pool, db } from "../../db";\nimport { EBAY_CHANNEL_ID, getAuthService, getChannelConnection, ebayApiRequest, atpService } from "./ebay-utils";\n\n`;

// Clean up duplicate SyncFilter, and properly prepend 'export' to functions
let helpersSrc = lines.slice(3565, 4230).join('\n');
helpersSrc = helpersSrc.replace(/^async function/gm, 'export async function');
helpersSrc = helpersSrc.replace(/^function/gm, 'export function');
helpersSrc = helpersSrc.replace(/^const delay/gm, 'export const delay');
helpersSrc = helpersSrc.replace('interface SyncFilter {\n  productIds?: number[];\n  productTypeSlugs?: string[];\n  variantIds?: number[];\n}', '');

// Ensure we define SyncFilter once at the top of helpers
const fixedHelpers = helperImports + `export interface SyncFilter { productIds?: number[]; productTypeSlugs?: string[]; variantIds?: number[]; }\n\n` + helpersSrc;

fs.writeFileSync('server/routes/ebay/ebay-sync-helpers.ts', fixedHelpers);

console.log('Routes split successfully.');
