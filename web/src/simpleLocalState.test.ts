import { describe, expect, it } from "vitest";
import {
  buildSimpleActorBackupBundle,
  downloadSimpleActorBackup,
  parseEncryptedSimpleActorBackupBundle,
  parseSimpleActorBackupBundle,
} from "./simpleLocalState";

describe("simpleLocalState", () => {
  it("builds and parses a voter backup bundle", () => {
    const bundle = buildSimpleActorBackupBundle("voter", {
      npub: "npub1example",
      nsec: "nsec1example",
    }, {
      manualCoordinators: ["npub1coord"],
      selectedVotingId: "round-1",
    });

    expect(bundle.role).toBe("voter");
    expect(bundle.type).toBe("auditable-voting.simple-backup");

    const parsed = parseSimpleActorBackupBundle(JSON.stringify(bundle));
    expect(parsed).toEqual(bundle);
    expect(parsed?.cache).toEqual({
      manualCoordinators: ["npub1coord"],
      selectedVotingId: "round-1",
    });
  });

  it("rejects malformed backup bundles", () => {
    expect(parseSimpleActorBackupBundle("{}")).toBeNull();
    expect(parseSimpleActorBackupBundle("{not-json")).toBeNull();
    expect(parseSimpleActorBackupBundle(JSON.stringify({
      version: 1,
      type: "wrong-type",
      role: "voter",
      keypair: {
        npub: "npub1example",
        nsec: "nsec1example",
      },
    }))).toBeNull();
  });

  it("encrypts and restores a backup bundle with a passphrase", async () => {
    let downloadedText = "";
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    const originalDocument = globalThis.document as Document | undefined;
    const documentStub = {
      createElement: (_tagName: string) => ({
        click: () => undefined,
        href: "",
        download: "",
      }),
    } as unknown as Document;

    URL.createObjectURL = (() => "blob:test") as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
    Object.defineProperty(globalThis, "document", {
      value: documentStub,
      configurable: true,
      writable: true,
    });

    const originalBlob = globalThis.Blob;
    globalThis.Blob = class extends Blob {
      constructor(blobParts?: BlobPart[], options?: BlobPropertyBag) {
        super(blobParts, options);
        downloadedText = String(blobParts?.[0] ?? "");
      }
    } as typeof Blob;

    try {
      await downloadSimpleActorBackup("coordinator", {
        npub: "npub1example",
        nsec: "nsec1example",
      }, {
        roundBlindPrivateKeys: { "vote-1": { keyId: "key-1" } },
      }, {
        passphrase: "secret-passphrase",
      });

      expect(downloadedText).toContain("\"auditable-voting.simple-backup.encrypted\"");
      const restored = await parseEncryptedSimpleActorBackupBundle(downloadedText, "secret-passphrase");
      expect(restored?.role).toBe("coordinator");
      expect(restored?.cache).toEqual({
        roundBlindPrivateKeys: { "vote-1": { keyId: "key-1" } },
      });
    } finally {
      globalThis.Blob = originalBlob;
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
      Object.defineProperty(globalThis, "document", {
        value: originalDocument,
        configurable: true,
        writable: true,
      });
    }
  });
});
