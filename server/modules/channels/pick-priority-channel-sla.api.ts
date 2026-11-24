/**
 * Public channels SLA configuration contract for Pick Priority administration (`channels.channels`).
 */
export {
  readPickPriorityChannels,
  updateChannelPickPrioritySlaDays,
  type PickPriorityChannelSummary,
} from "./infrastructure/pick-priority-channel-sla.repository";
