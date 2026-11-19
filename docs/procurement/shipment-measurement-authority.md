# Shipment measurement ownership

The saved shipment line owns its physical measurements:

- `weightKg`, `lengthCm`, `widthCm`, and `heightCm` describe the recorded `dimensionBasis`.
- A `carton` basis uses the physical `cartonCount`. A `piece` basis uses `qtyShipped`.
- A historical null basis retains the original rule: use cartons when their count is recorded, otherwise pieces. Selecting a new basis requires an explicit packing edit.

Receiving configuration determines how stock is counted. It does not change the shipment's physical multiplier. Catalog measurements can be copied by existing creation/setup commands, but subsequent catalog edits are not shipment measurement updates. Shipment-level gross/BOL measurements are separate evidence; they do not replace the per-line inputs used to split charges.

## One calculation

`shared/procurement/shipment-physical-values.ts` owns the decimal calculation and validates source precision, range and aggregate limits. `computeShipmentPhysicalTotals` produces net weight, volume and chargeable weight. `shipmentPhysicalAllocationValue` also checks that the inputs required by the chosen allocation method are present and positive. Chargeable weight requires both weight and dimensions to establish the maximum of actual and volumetric weight.

The following paths use this owner:

- Shipment detail, PO-linked shipments and shipment work-list totals.
- Shipment editor and shipment/receipt quantity-correction previews.
- Weight, volume and chargeable-weight allocation, allocation status and downstream cost-source validation.
- Shipment edits and landed-cost finalization.

The stored `totalWeightKg`, `totalVolumeCbm`, `chargeableWeightKg` and shipment summary totals are derived caches. Reads calculate from the saved source. Authorized physical edits and finalization refresh stale caches under the existing graph/shipment locks and transaction. The `procurement.shipment.physical_totals_materialized` audit records actor, time, before/after line totals and shipment summary. A later failure rolls the cache refresh back with the rest of the command.

## Incomplete measurements

Missing measurements do not authorize an equal split. The charge remains saved, its physical allocation is pending, and the landed cost is unavailable until that charge can be allocated. Existing equal-split fallback evidence remains inspectable but is not projected as a completed physical allocation by shipment, PO or document-relationship reads. Deliberate by-line-count allocation remains a separate supported policy.

Closing still requires the physical inputs needed by each nonzero charge's method. This change does not manufacture source measurements, change actual receiving counts, or rewrite posted cost approvals. Current raw measurement validation is kept separate from immutable economic fingerprint rows so adding the validation fields does not invalidate an otherwise unchanged approved posting.

## Verification

Unit tests cover exact decimal calculations, physical basis, receiving-pack independence, incomplete inputs, precision and overflow. PostgreSQL tests cover a multi-PO shipment with a closed receipt and stale caches, exact charge shares, atomic finalization, retry safety and failure rollback. Desktop/mobile browser tests distinguish pending allocation from a zero cost and preserve recorded charge amounts in the edit review.
