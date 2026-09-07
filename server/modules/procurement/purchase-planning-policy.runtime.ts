import { pool } from "../../db";
import { PurchasePlanningPolicyRepository } from "./purchase-planning-policy.repository";
import { PurchasePlanningPolicyService } from "./purchase-planning-policy.service";

let service: PurchasePlanningPolicyService | undefined;

/** Construct the application owner when planning is used. Importing unrelated
 * storage/routes must not initialize a second database adapter. */
export function getPurchasePlanningPolicyService(): PurchasePlanningPolicyService {
  service ??= new PurchasePlanningPolicyService(new PurchasePlanningPolicyRepository(pool), () => new Date());
  return service;
}
