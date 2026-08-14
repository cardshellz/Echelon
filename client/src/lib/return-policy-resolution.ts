export interface ReturnPolicyResolutionInput {
  channelId: number | null;
  vendorId: number | null;
  storeConnectionId: number | null;
}

export interface ReturnPolicyResolutionSelection {
  channelId: number | null;
  dropshipOmsChannelId: number;
  selectedVendorId: number | null;
  selectedStoreConnectionId: number | null;
}

export function deriveReturnPolicyResolutionInput(
  selection: ReturnPolicyResolutionSelection,
): ReturnPolicyResolutionInput {
  const isDropship = selection.channelId === selection.dropshipOmsChannelId;
  const vendorId = isDropship ? selection.selectedVendorId : null;

  return {
    channelId: selection.channelId,
    vendorId,
    storeConnectionId: vendorId === null ? null : selection.selectedStoreConnectionId,
  };
}

export function isSameReturnPolicyResolutionInput(
  first: ReturnPolicyResolutionInput,
  second: ReturnPolicyResolutionInput,
): boolean {
  return first.channelId === second.channelId
    && first.vendorId === second.vendorId
    && first.storeConnectionId === second.storeConnectionId;
}

export function snapshotReturnPolicyResolutionInput(
  input: ReturnPolicyResolutionInput,
): ReturnPolicyResolutionInput {
  return {
    channelId: input.channelId,
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
  };
}
