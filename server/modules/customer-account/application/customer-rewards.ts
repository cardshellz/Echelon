import type {
  RewardWidgetScope,
  RewardWidgetState,
  RewardWidgetManagementState,
  RewardWidgetCancelResult,
} from "@shared/customer-account/reward-widget";
export interface CustomerRewards {
  state(input: RewardWidgetScope): Promise<RewardWidgetState>;
  manage(input: RewardWidgetScope): Promise<RewardWidgetManagementState>;
  cancel(input: RewardWidgetScope & { rewardId: string }): Promise<RewardWidgetCancelResult>;
  issue(
    input: RewardWidgetScope & { points: number; requestKey: string },
  ): Promise<{
    code: string;
    value: string;
    expiresAt: string;
    balance: string;
  }>;
}
