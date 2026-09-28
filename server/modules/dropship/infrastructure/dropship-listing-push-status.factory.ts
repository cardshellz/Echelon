import { pool } from "../../../db";
import { DropshipListingPushStatusService } from "../application/dropship-listing-push-status-service";
import { PgDropshipListingPushStatusRepository } from "./dropship-listing-push-status.repository";

export function createDropshipListingPushStatusServiceFromEnv(): DropshipListingPushStatusService {
  return new DropshipListingPushStatusService({ repository: new PgDropshipListingPushStatusRepository(pool) });
}
