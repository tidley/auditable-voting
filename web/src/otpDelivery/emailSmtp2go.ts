import type { DeliveryChannel } from './types';

export const emailSmtp2goChannel: DeliveryChannel = {
  id: 'email-smtp2go',
  label: 'Email (SMTP2GO — coordinator sender)',
  async available() {
    return { ok: false, reason: 'Sending requires the trusted coordinator CLI.', hint: 'Download the private batch and run scripts/otp-send-email.mjs. SMTP credentials must never enter this browser.' };
  },
  async send() { throw new Error('Use the coordinator CLI; browser SMTP sending is not supported.'); },
};
