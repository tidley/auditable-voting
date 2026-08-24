import { manualChannel } from "./manual";
import { emailNomailChannel } from "./emailNomail";
import { smsChannel } from "./sms";
import type { DeliveryChannel } from "./types";

/**
 * All delivery channels in a stable order. The manual channel is first and
 * is the default fallback.
 */
export const DELIVERY_CHANNELS: DeliveryChannel[] = [
  manualChannel,
  emailNomailChannel,
  smsChannel,
];
