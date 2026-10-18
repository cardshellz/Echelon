import type {
  RewardWidgetScope,
  RewardWidgetState,
} from "@shared/customer-account/reward-widget";
export interface CustomerRewards {
  state(input: RewardWidgetScope): Promise<RewardWidgetState>;
  issue(
    input: RewardWidgetScope & { points: number; requestKey: string },
  ): Promise<{
    code: string;
    value: string;
    expiresAt: string;
    balance: string;
  }>;
}
