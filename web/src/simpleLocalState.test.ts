// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildSimpleActorBackupBundle,
  buildSimpleFullStateBackupBundle,
  buildSimpleNamespacedLocalStorageKey,
  downloadSimpleActorBackup,
  downloadSimpleFullStateBackup,
  loadSimpleActorState,
  parseEncryptedSimpleActorBackupBundle,
  parseEncryptedSimpleFullStateBackupBundle,
  parseSimpleActorBackupBundle,
  parseSimpleFullStateBackupBundle,
  resetSimpleActorStateForTests,
  restoreSimpleFullStateBackupBundle,
  saveSimpleActorState,
} from "./simpleLocalState";

describe("simpleLocalState", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await resetSimpleActorStateForTests();
  });

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
    expect(bundle.identityWords?.split(" ")).toHaveLength(3);

    const parsed = parseSimpleActorBackupBundle(JSON.stringify(bundle));
    expect(parsed).toEqual(bundle);
    expect(parsed?.identityWords).toBe(bundle.identityWords);
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
      expect(downloadedText).toContain("\"identityWords\"");
      const restored = await parseEncryptedSimpleActorBackupBundle(downloadedText, "secret-passphrase");
      expect(restored?.role).toBe("coordinator");
      expect(restored?.identityWords?.split(" ")).toHaveLength(3);
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

  it("builds and parses a full-state backup bundle", async () => {
    await saveSimpleActorState({
      role: "coordinator",
      keypair: {
        npub: "npub1coord",
        nsec: "nsec1coord",
      },
      updatedAt: "2026-06-12T12:00:00.000Z",
      cache: {
        selectedVotingId: "q_123",
      },
    });
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey("questionnaire:definitions:v1"),
      JSON.stringify({ q_123: { title: "Questionnaire" } }),
    );
    window.localStorage.setItem("app:auditable-voting:other:outside", "keep");

    const bundle = await buildSimpleFullStateBackupBundle();

    expect(bundle.version).toBe(2);
    expect(bundle.type).toBe("auditable-voting.full-state-backup");
    expect(bundle.schema.restoreMode).toBe("replace-current-namespace");
    expect(bundle.localStorage["questionnaire:definitions:v1"]).toContain("Questionnaire");
    expect(bundle.localStorage.outside).toBeUndefined();
    expect(bundle.actorStates.coordinator).toMatchObject({
      role: "coordinator",
      keypair: {
        npub: "npub1coord",
      },
    });
    expect(parseSimpleFullStateBackupBundle(JSON.stringify(bundle))).toEqual(bundle);
  });

  it("restores a full-state backup by replacing the current namespace", async () => {
    await saveSimpleActorState({
      role: "coordinator",
      keypair: {
        npub: "npub1old",
        nsec: "nsec1old",
      },
      updatedAt: "2026-06-12T12:00:00.000Z",
    });
    window.localStorage.setItem(buildSimpleNamespacedLocalStorageKey("old"), "remove-me");
    window.localStorage.setItem("app:auditable-voting:other:old", "keep-me");

    await restoreSimpleFullStateBackupBundle({
      version: 2,
      type: "auditable-voting.full-state-backup",
      exportedAt: "2026-06-12T13:00:00.000Z",
      namespace: "source",
      schema: {
        localStorageKeyMode: "namespaced-suffix-v1",
        indexedDbName: "auditable-voting-simple",
        indexedDbStore: "actor-state",
        restoreMode: "replace-current-namespace",
      },
      localStorage: {
        "questionnaire:definitions:v1": JSON.stringify({ q_456: { title: "Restored" } }),
      },
      actorStates: {
        voter: {
          role: "voter",
          keypair: {
            npub: "npub1restored",
            nsec: "nsec1restored",
          },
          updatedAt: "2026-06-12T13:00:00.000Z",
          cache: {
            selectedVotingId: "q_456",
          },
        },
      },
    });

    expect(window.localStorage.getItem(buildSimpleNamespacedLocalStorageKey("old"))).toBeNull();
    expect(window.localStorage.getItem("app:auditable-voting:other:old")).toBe("keep-me");
    expect(window.localStorage.getItem(
      buildSimpleNamespacedLocalStorageKey("questionnaire:definitions:v1"),
    )).toContain("Restored");
    await expect(loadSimpleActorState("coordinator")).resolves.toBeNull();
    await expect(loadSimpleActorState("voter")).resolves.toMatchObject({
      keypair: {
        npub: "npub1restored",
      },
      cache: {
        selectedVotingId: "q_456",
      },
    });
  });

  it("encrypts and restores a full-state backup bundle with a passphrase", async () => {
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
      window.localStorage.setItem(buildSimpleNamespacedLocalStorageKey("optiona:elections:registry"), "[\"q_1\"]");

      await downloadSimpleFullStateBackup({
        passphrase: "secret-passphrase",
      });

      expect(downloadedText).toContain("\"auditable-voting.full-state-backup.encrypted\"");
      const restored = await parseEncryptedSimpleFullStateBackupBundle(downloadedText, "secret-passphrase");
      expect(restored?.localStorage["optiona:elections:registry"]).toBe("[\"q_1\"]");
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
