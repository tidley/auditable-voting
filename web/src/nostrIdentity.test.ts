import { describe, expect, it } from "vitest";
import { nip19 } from "nostr-tools";
import { getNostrEventVerificationUrl } from "./nostrIdentity";

describe("getNostrEventVerificationUrl", () => {
  const FAKE_EVENT_ID = "a".repeat(64);

  it("returns a njump.me URL containing a nevent code", () => {
    const url = getNostrEventVerificationUrl({ eventId: FAKE_EVENT_ID });
    expect(url).toMatch(/^https:\/\/njump\.me\/nevent1/);
  });

  it("encodes only the event id when no optional fields provided", () => {
    const url = getNostrEventVerificationUrl({ eventId: FAKE_EVENT_ID });
    const neventPart = url.replace("https://njump.me/", "");
    const decoded = nip19.decode(neventPart);
    expect(decoded.type).toBe("nevent");
    expect((decoded.data as nip19.neventData).id).toBe(FAKE_EVENT_ID);
    expect((decoded.data as nip19.neventData).relays).toEqual([]);
    expect((decoded.data as nip19.neventData).author).toBeUndefined();
    expect((decoded.data as nip19.neventData).kind).toBeUndefined();
  });

  it("encodes relays when provided", () => {
    const relays = ["wss://relay1.example.com", "wss://relay2.example.com"];
    const url = getNostrEventVerificationUrl({ eventId: FAKE_EVENT_ID, relays });
    const neventPart = url.replace("https://njump.me/", "");
    const decoded = nip19.decode(neventPart);
    expect(decoded.type).toBe("nevent");
    expect((decoded.data as nip19.neventData).relays).toEqual(relays);
  });

  it("encodes author when provided", () => {
    const author = "b".repeat(64);
    const url = getNostrEventVerificationUrl({ eventId: FAKE_EVENT_ID, author });
    const neventPart = url.replace("https://njump.me/", "");
    const decoded = nip19.decode(neventPart);
    expect(decoded.type).toBe("nevent");
    expect((decoded.data as nip19.neventData).author).toBe(author);
  });

  it("encodes kind when provided", () => {
    const url = getNostrEventVerificationUrl({ eventId: FAKE_EVENT_ID, kind: 38000 });
    const neventPart = url.replace("https://njump.me/", "");
    const decoded = nip19.decode(neventPart);
    expect(decoded.type).toBe("nevent");
    expect((decoded.data as nip19.neventData).kind).toBe(38000);
  });

  it("encodes all fields together", () => {
    const relays = ["wss://relay.example.com"];
    const author = "c".repeat(64);
    const url = getNostrEventVerificationUrl({
      eventId: FAKE_EVENT_ID,
      relays,
      author,
      kind: 38010
    });
    const neventPart = url.replace("https://njump.me/", "");
    const decoded = nip19.decode(neventPart);
    expect(decoded.type).toBe("nevent");
    const data = decoded.data as nip19.neventData;
    expect(data.id).toBe(FAKE_EVENT_ID);
    expect(data.relays).toEqual(relays);
    expect(data.author).toBe(author);
    expect(data.kind).toBe(38010);
  });

  it("handles empty relays array gracefully", () => {
    const url = getNostrEventVerificationUrl({ eventId: FAKE_EVENT_ID, relays: [] });
    const neventPart = url.replace("https://njump.me/", "");
    const decoded = nip19.decode(neventPart);
    expect(decoded.type).toBe("nevent");
  });
});
