// Compatibility exports; publication recovery has one provider-neutral contract.
export {
  publicationRecoveryPreviewSchema as ebayPublicationRecoveryPreviewSchema,
  publicationRecoveryConfirmationSchema as ebayPublicationRecoveryConfirmationSchema,
  publicationRecoveryResultSchema as ebayPublicationRecoveryResultSchema,
  type PublicationRecoveryPreview as EbayPublicationRecoveryPreview,
  type PublicationRecoveryResult as EbayPublicationRecoveryResult,
} from "./publication-recovery";
