import type { DeliveryChannel, DeliveryResult, Recipient } from "./types";

/**
 * Email delivery via the nomail.name / cashu.email service.
 *
 * This is a THIN BROWSER DESCRIPTOR ONLY. The nomail API authenticates with
 * a SameSite=Strict HttpOnly cookie that cannot be set from a cross-origin
 * browser context, so the browser bundle deliberately contains NO auth or
 * send code — that would be dead, security-sensitive code. Actual sending
 * happens on the coordinator machine via `scripts/otp-send-email.mjs`
 * (AV-DELIVERY-1b).
 */
export const emailNomailChannel: DeliveryChannel = {
  id: "email-nomail",
  label: "Email (nomail)",
  async available() {
    return {
      ok: false,
      reason: "SameSite=Strict cookie blocks cross-origin browser auth",
      hint: "use scripts/otp-send-email.mjs on coordinator machine (AV-DELIVERY-1b)",
    };
  },
  async send(_recipient: Recipient, _otp: string): Promise<DeliveryResult> {
    throw new Error(
      "email-nomail cannot send from the browser; use scripts/otp-send-email.mjs on the coordinator machine.",
    );
  },
};
