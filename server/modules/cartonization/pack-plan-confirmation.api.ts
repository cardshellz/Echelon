/**
 * Cartonization — Pack Plan Parcel Confirmation Internal API (`CI-03`)
 *
 * Keeps `modules/cartonization` as the sole writer of `shipping.pack_plans` and
 * `shipping.pack_plan_parcels` without importing the DB singleton at load time.
 */
export {
  confirmPackPlanParcelInTx,
  markPackPlanPackedInTx,
} from "./infrastructure/pack-plan-confirmation.repository";
