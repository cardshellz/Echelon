export interface ReturnPolicyResolutionInput {
  channelId: number | null;
  vendorId: number | null;
  storeConnectionId: number | null;
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
