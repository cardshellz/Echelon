export {
  ReturnLabelProviderError,
  returnLabelAddressSchema,
  returnLabelDownloadUrlSchema,
  returnLabelInputSchema,
  returnLabelOrderNumberSchema,
  returnLabelProviderIdSchema,
  returnLabelRecordSchema,
  type ReturnLabelAddress,
  type ReturnLabelInput,
  type ReturnLabelProvider,
  type ReturnLabelRecord,
} from "./application/return-label-provider.port";

export { isReturnRateCatalogServiceEligible } from "./application/return-rate-catalog";

export {
  ReturnRateProviderError,
  returnRateCandidateSchema,
  returnRateInputSchema,
  returnRateResultSchema,
  returnRateShipmentSchema,
  type ReturnRateCandidate,
  type ReturnRateInput,
  type ReturnRateProvider,
  type ReturnRateResult,
} from "./application/return-rate-provider.port";

export { createShipStationReturnLabelAdapter } from "./infrastructure/shipstation-return-label.adapter";

export { createShipStationReturnRateAdapter } from "./infrastructure/shipstation-return-rate.adapter";

export { createShipStationV2RatingAdapter } from "./infrastructure/shipstation-v2-rating.adapter";
