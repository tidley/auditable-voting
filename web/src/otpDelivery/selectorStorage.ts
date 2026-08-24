import type { DeliveryChannel } from "./types";

/**
 * Storage prefix for the per-election channel selector. The election id is
 * appended so each election remembers its own channel choice.
 */
export const CHANNEL_STORAGE_PREFIX = "otp-delivery-channel:";

const VALID_CHANNEL_IDS: DeliveryChannel["id"][] = ["manual", "email-nomail", "sms"];

/**
 * Load the selected channel id for an election, defaulting to `manual`.
 * Unknown or malformed stored values fall back to `manual`.
 */
export function loadSelectedChannel(electionId: string): DeliveryChannel["id"] {
  const stored = window.localStorage.getItem(`${CHANNEL_STORAGE_PREFIX}${electionId}`);
  if (stored && (VALID_CHANNEL_IDS as string[]).includes(stored)) {
    return stored as DeliveryChannel["id"];
  }
  return "manual";
}

/**
 * Persist the selected channel id for an election.
 */
export function saveSelectedChannel(
  electionId: string,
  channelId: DeliveryChannel["id"],
): void {
  window.localStorage.setItem(`${CHANNEL_STORAGE_PREFIX}${electionId}`, channelId);
}
