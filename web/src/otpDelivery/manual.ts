import type { DeliveryChannel, DeliveryResult, Recipient } from "./types";

/**
 * Manual channel — the display-only fallback.
 *
 * Codes are shown to the coordinator once and handed to residents out of
 * band. `available()` is always ok and `send()` returns ok because this
 * channel never leaves the browser; it is the default when no automated
 * channel is usable.
 */
export const manualChannel: DeliveryChannel = {
  id: "manual",
  label: "Manual (show codes in the app)",
  async available() {
    return { ok: true };
  },
  async send(recipient: Recipient, otp: string): Promise<DeliveryResult> {
    return {
      ok: true,
      channel: "manual",
      mastersListNumber: String(recipient.mastersListNumber),
      detail: `Code ${otp} shown to coordinator for resident ${recipient.mastersListNumber}.`,
    };
  },
};
