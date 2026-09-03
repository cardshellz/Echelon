import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  FulfillmentRoutingError,
  FulfillmentRoutingResolver,
} from "../../shipping-engine/application/fulfillment-routing.service";
import type {
  FulfillmentRouteResolution,
} from "../../shipping-engine/domain/fulfillment-routing";
import {
  PostgresFulfillmentRoutingStore,
} from "../../shipping-engine/infrastructure/fulfillment-routing.repository";
import {
  DropshipEbayFulfillmentCapabilityService,
  type DropshipCarrierServiceCapability,
  type DropshipCarrierServiceCapabilityProvider,
  type DropshipCarrierServiceCapabilitySnapshot,
  type DropshipEbayInternalFulfillmentEvidence,
  type DropshipEbayInternalFulfillmentEvidenceRepository,
} from "../application/dropship-ebay-fulfillment-capability-service";
import { selectRateBookAssignment } from "../../shipping-engine/domain/rate-book";
import { DropshipError } from "../domain/errors";
import { resolveDropshipOmsChannelIdWithClient } from "./dropship-order-intake.repository";

const DROPSHIP_RATE_CONTEXT = {
  pricingChannel: "dropship",
  purpose: "vendor_fulfillment_charge",
} as const;

interface StoreConfigRow {
  config: Record<string, unknown> | null;
}

interface OmsSlaRow {
  sla_days: number | null;
}

interface RateBookAssignmentRow {
  assignment_id: number;
  rate_book_id: number;
  rate_book_code: string;
  zone_set_id: number;
  origin_warehouse_id: number | null;
}

interface RateTableRow {
  rate_table_id: number;
  service_level_id: number;
}

interface CoverageDestinationRow {
  destination_country: string;
  destination_region: string | null;
}

export class PgDropshipEbayInternalFulfillmentEvidenceRepository
implements DropshipEbayInternalFulfillmentEvidenceRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async loadForStoreConnection(input: {
    storeConnectionId: number;
    evaluatedAt: Date;
  }): Promise<DropshipEbayInternalFulfillmentEvidence> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const evidence = await loadEvidenceWithClient(client, input);
      await client.query("COMMIT");
      return evidence;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

interface FulfillmentRoutingResolverPort {
  resolve(input: {
    serviceLevelId: number;
    scope: "domestic" | "international";
  }): Promise<FulfillmentRouteResolution>;
}

export class FulfillmentRoutingDropshipCarrierServiceCapabilityProvider
implements DropshipCarrierServiceCapabilityProvider {
  constructor(
    private readonly resolver: FulfillmentRoutingResolverPort =
      new FulfillmentRoutingResolver(new PostgresFulfillmentRoutingStore()),
  ) {}

  async listServices(input: {
    serviceLevelId: number;
  }): Promise<DropshipCarrierServiceCapabilitySnapshot> {
    let resolution: FulfillmentRouteResolution;
    try {
      resolution = await this.resolver.resolve({
        serviceLevelId: input.serviceLevelId,
        scope: "domestic",
      });
    } catch (error) {
      if (error instanceof DropshipError) throw error;
      throw new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
        "Card Shellz fulfillment routing could not be verified.",
        {
          serviceLevelId: input.serviceLevelId,
          routingCode: error instanceof FulfillmentRoutingError ? error.code : null,
          retryable: !(error instanceof FulfillmentRoutingError),
        },
      );
    }
    if (!resolution.ok) {
      throw new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED",
        "Standard Shipping needs at least one allowed domestic fulfillment method before eBay policies can be validated.",
        {
          serviceLevelId: input.serviceLevelId,
          routingCode: resolution.code,
          routingRevision: resolution.profileRevision,
          retryable: false,
        },
      );
    }
    return {
      serviceLevelId: resolution.serviceLevelId,
      routingRevision: resolution.profileRevision,
      services: resolution.candidates.map((method): DropshipCarrierServiceCapability => ({
        provider: method.provider,
        carrierCode: method.carrierCode,
        serviceCode: method.serviceCode,
        serviceName: method.serviceName,
        domestic: method.domestic,
      })),
    };
  }
}

export function createDropshipEbayFulfillmentCapabilityProviderFromEnv():
DropshipEbayFulfillmentCapabilityService {
  return new DropshipEbayFulfillmentCapabilityService({
    evidence: new PgDropshipEbayInternalFulfillmentEvidenceRepository(),
    carrierServices: new FulfillmentRoutingDropshipCarrierServiceCapabilityProvider(),
  });
}

async function loadEvidenceWithClient(
  client: PoolClient,
  input: { storeConnectionId: number; evaluatedAt: Date },
): Promise<DropshipEbayInternalFulfillmentEvidence> {
  const storeResult = await client.query<StoreConfigRow>(
    `SELECT config
     FROM dropship.dropship_store_connections
     WHERE id = $1
     LIMIT 1`,
    [input.storeConnectionId],
  );
  const store = storeResult.rows[0];
  if (!store) {
    throw new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_STORE_NOT_FOUND",
      "Dropship store connection was not found while loading fulfillment capabilities.",
      { storeConnectionId: input.storeConnectionId, retryable: false },
    );
  }
  const originWarehouseId = readDefaultWarehouseId(store.config ?? {});
  if (originWarehouseId === null) {
    throw new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_WAREHOUSE_REQUIRED",
      "The dropship store must have a valid default warehouse before fulfillment policies can be verified.",
      { storeConnectionId: input.storeConnectionId, retryable: false },
    );
  }

  const omsChannelId = await resolveDropshipOmsChannelIdWithClient(client);
  const slaResult = await client.query<OmsSlaRow>(
    `SELECT sla_days
     FROM channels.channels
     WHERE id = $1
     LIMIT 1`,
    [omsChannelId],
  );
  const slaDays = slaResult.rows[0]?.sla_days;
  if (!Number.isInteger(slaDays) || (slaDays ?? -1) < 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_SLA_REQUIRED",
      "The canonical Dropship OMS channel must have an explicit non-negative fulfillment SLA.",
      { omsChannelId, slaDays: slaDays ?? null, retryable: false },
    );
  }

  const assignmentResult = await client.query<RateBookAssignmentRow>(
    `SELECT assignment.id AS assignment_id,
            book.id AS rate_book_id,
            book.code AS rate_book_code,
            book.zone_set_id,
            assignment.origin_warehouse_id
     FROM shipping.rate_book_assignments assignment
     JOIN shipping.rate_books book
       ON book.id = assignment.rate_book_id
      AND book.status = 'active'
     JOIN shipping.zone_sets zone_set
       ON zone_set.id = book.zone_set_id
      AND zone_set.status = 'active'
     WHERE assignment.pricing_channel = $1
       AND assignment.rate_purpose = $2
       AND assignment.is_active = TRUE
       AND (
         assignment.origin_warehouse_id IS NULL
         OR assignment.origin_warehouse_id = $3
       )
     ORDER BY assignment.id ASC`,
    [DROPSHIP_RATE_CONTEXT.pricingChannel, DROPSHIP_RATE_CONTEXT.purpose, originWarehouseId],
  );
  const selectedAssignment = selectRateBookAssignment(
    assignmentResult.rows.map((row) => ({
      assignmentId: row.assignment_id,
      rateBookId: row.rate_book_id,
      rateBookCode: row.rate_book_code,
      zoneSetId: row.zone_set_id,
      pricingChannel: DROPSHIP_RATE_CONTEXT.pricingChannel,
      purpose: DROPSHIP_RATE_CONTEXT.purpose,
      originWarehouseId: row.origin_warehouse_id,
    })),
    { ...DROPSHIP_RATE_CONTEXT, originWarehouseId },
  );
  if (!selectedAssignment.ok) {
    throw new DropshipError(
      `DROPSHIP_EBAY_FULFILLMENT_${selectedAssignment.code}`,
      "A unique active dropship fulfillment rate book is required.",
      {
        storeConnectionId: input.storeConnectionId,
        originWarehouseId,
        reason: selectedAssignment.message,
        retryable: false,
      },
    );
  }

  const tableResult = await client.query<RateTableRow>(
    `SELECT rate_table.id AS rate_table_id,
            rate_table.service_level_id
     FROM shipping.rate_tables rate_table
     JOIN shipping.service_levels service_level
       ON service_level.id = rate_table.service_level_id
      AND service_level.code = 'standard'
      AND service_level.is_active = TRUE
     WHERE rate_table.rate_book_id = $1
       AND rate_table.status = 'active'
       AND rate_table.effective_from <= $2
       AND (rate_table.effective_to IS NULL OR rate_table.effective_to > $2)
     ORDER BY rate_table.effective_from DESC, rate_table.id DESC
     LIMIT 2`,
    [selectedAssignment.assignment.rateBookId, input.evaluatedAt],
  );
  if (tableResult.rows.length !== 1) {
    throw new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_RATE_TABLE_REQUIRED",
      "Exactly one active Standard dropship rate table is required.",
      {
        rateBookId: selectedAssignment.assignment.rateBookId,
        activeTableIds: tableResult.rows.map((row) => row.rate_table_id),
        retryable: false,
      },
    );
  }
  const rateTable = tableResult.rows[0];
  const rateTableId = rateTable.rate_table_id;
  const coverageResult = await client.query<CoverageDestinationRow>(
    `SELECT DISTINCT destination.destination_country,
                     destination.destination_region
     FROM shipping.rate_table_coverages coverage
     JOIN shipping.rate_table_coverage_destinations destination
       ON destination.rate_table_coverage_id = coverage.id
     WHERE coverage.rate_table_id = $1
       AND coverage.availability = 'offered'
       AND (
         coverage.origin_warehouse_id IS NULL
         OR coverage.origin_warehouse_id = $2
       )
     ORDER BY destination.destination_country,
              destination.destination_region NULLS FIRST`,
    [rateTableId, originWarehouseId],
  );
  if (coverageResult.rows.length === 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_DESTINATION_COVERAGE_REQUIRED",
      "The active dropship rate table has no offered destination coverage evidence.",
      { rateTableId, originWarehouseId, retryable: false },
    );
  }

  return {
    omsChannelId,
    originWarehouseId,
    requiredHandlingTimeBusinessDays: slaDays as number,
    rateBookId: selectedAssignment.assignment.rateBookId,
    rateBookCode: selectedAssignment.assignment.rateBookCode,
    rateTableId,
    serviceLevelId: rateTable.service_level_id,
    offeredDestinations: coverageResult.rows.map((row) => ({
      country: row.destination_country,
      region: row.destination_region,
    })),
  };
}

function readDefaultWarehouseId(config: Record<string, unknown>): number | null {
  const candidates = [
    config.defaultWarehouseId,
    config.warehouseId,
    nestedConfigValue(config, "orderProcessing", "defaultWarehouseId"),
    nestedConfigValue(config, "dropshipOrderProcessing", "defaultWarehouseId"),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    const parsed = typeof candidate === "number"
      ? candidate
      : typeof candidate === "string" && /^\d+$/.test(candidate.trim())
        ? Number(candidate.trim())
        : Number.NaN;
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return parsed;
  }
  return null;
}

function nestedConfigValue(
  config: Record<string, unknown>,
  parentKey: string,
  childKey: string,
): unknown {
  const parent = config[parentKey];
  return parent && typeof parent === "object" && !Array.isArray(parent)
    ? (parent as Record<string, unknown>)[childKey]
    : undefined;
}
