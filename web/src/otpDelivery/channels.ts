import { manualChannel } from "./manual";
import { emailSmtp2goChannel } from "./emailSmtp2go";
import type { DeliveryChannel } from "./types";

/**
 * All delivery channels in a stable order. The manual channel is first and
 * is the default fallback.
 */
export const DELIVERY_CHANNELS: DeliveryChannel[] = [
  manualChannel,
  emailSmtp2goChannel,
];
