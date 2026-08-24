import type { DeliveryChannel, DeliveryResult, Recipient } from "./types";

/**
 * SMS delivery — stub.
 *
 * The SMS service is still in development. When it becomes available it will
 * expose an endpoint that authenticates with an `Authorization` header
 * carrying a signed Nostr event (Felix's service; the API is not yet public,
 * so we do NOT build against guesses). Until then this channel reports
 * unavailable and never attempts a send.
 */
export const smsChannel: DeliveryChannel = {
  id: "sms",
  label: "SMS",
  async available() {
    return { ok: false, reason: "SMS service in development" };
  },
  async send(_recipient: Recipient, _otp: string): Promise<DeliveryResult> {
    throw new Error("SMS delivery is not yet available.");
  },
};
