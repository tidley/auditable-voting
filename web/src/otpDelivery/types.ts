import type { ResidentEntry } from "../residentRegister";

/**
 * A recipient of an OTP delivery. Extends {@link ResidentEntry} so the
 * email stays required and the name stays optional, but the
 * `mastersListNumber` is the unique join key for the status table, the
 * results CSV and resume — never key by name.
 */
export interface Recipient extends ResidentEntry {
  mastersListNumber: number;
}

/**
 * Result of a single delivery attempt.
 *
 * `mastersListNumber` is carried on every result so a batch can be joined
 * back to the roster and written to the results CSV without re-deriving the
 * key from the recipient's name.
 */
export interface DeliveryResult {
  ok: boolean;
  channel: string;
  mastersListNumber: string;
  detail: string;
  ref?: string;
}

/**
 * Availability probe for a delivery channel.
 */
export interface ChannelAvailability {
  ok: boolean;
  reason?: string;
  hint?: string;
}

/**
 * A delivery channel abstraction. Channels are pure modules: they take no
 * global state and, where they need network access, receive an injected
 * `fetch` dependency rather than reaching for the global.
 */
export interface DeliveryChannel {
  id: "manual" | "email-nomail" | "sms";
  label: string;
  available(): Promise<ChannelAvailability>;
  send(recipient: Recipient, otp: string): Promise<DeliveryResult>;
}
