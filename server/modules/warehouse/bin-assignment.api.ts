/**
 * Internal module API facade: Warehouse Bin Assignment contracts & service (`CI-03`).
 *
 * Cross-module consumers (e.g., `catalog`) must import bin-assignment filter,
 * validation contracts, and service factories through this boundary rather than
 * reaching into internal `bin-assignment-*` implementation files.
 */

export {
  createBinAssignmentService,
  type BinAssignmentService,
  type BinAssignmentRow,
  type AssignmentFilters,
  type ImportResult,
} from "./bin-assignment.service";

export {
  BinAssignmentFilterError,
  MAX_BIN_ASSIGNMENT_VARIANT_IDS,
  normalizeBinAssignmentVariantIds,
  parseBinAssignmentVariantIdsQuery,
} from "./bin-assignment-filter";

export {
  BinAssignmentValidationError,
  PRIMARY_SLOT_FLAG,
  parseBinAssignmentWriteRequest,
  parseSlotPrimaryFlag,
  type BinAssignmentWriteRequest,
} from "./bin-assignment-contracts";
