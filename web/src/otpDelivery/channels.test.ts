import { describe, expect, it } from "vitest";
import { manualChannel } from "./manual";
import { emailNomailChannel } from "./emailNomail";
import { smsChannel } from "./sms";
import { DELIVERY_CHANNELS } from "./channels";
import type { Recipient } from "./types";

const recipient: Recipient = {
  mastersListNumber: 101,
  email: "alice@example.org",
  name: "Alice Smith",
};

describe("manual channel", () => {
  it("is always available", async () => {
    await expect(manualChannel.available()).resolves.toEqual({ ok: true });
  });

  it("returns an ok display-only result carrying the masters list number", async () => {
    const result = await manualChannel.send(recipient, "123456");
    expect(result.ok).toBe(true);
    expect(result.channel).toBe("manual");
    expect(result.mastersListNumber).toBe("101");
    expect(result.detail).toContain("123456");
  });
});

describe("email-nomail browser descriptor", () => {
  it("is never available in the browser with the documented reason and hint", async () => {
    const availability = await emailNomailChannel.available();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("SameSite=Strict");
    expect(availability.hint).toContain("scripts/otp-send-email.mjs");
  });

  it("throws if send is ever reached (no auth/send code in the browser bundle)", async () => {
    await expect(emailNomailChannel.send(recipient, "123456")).rejects.toThrow();
  });
});

describe("sms stub", () => {
  it("is unavailable with a development reason", async () => {
    const availability = await smsChannel.available();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("SMS service in development");
  });

  it("throws if send is reached", async () => {
    await expect(smsChannel.send(recipient, "123456")).rejects.toThrow();
  });
});

describe("channel registry", () => {
  it("exposes manual, email-nomail and sms in a stable order", () => {
    expect(DELIVERY_CHANNELS.map((c) => c.id)).toEqual([
      "manual",
      "email-nomail",
      "sms",
    ]);
  });

  it("gives every channel a non-empty label", () => {
    for (const channel of DELIVERY_CHANNELS) {
      expect(channel.label.length).toBeGreaterThan(0);
    }
  });
});
