import { describe, expect, it } from "vitest";
import { selectQuestionnaireVoterIdentity } from "./SimpleUiApp";

describe("SimpleUiApp private invite identity selection", () => {
  it("uses the browser-local voter keypair for private code links", () => {
    const identity = selectQuestionnaireVoterIdentity({
      privateInviteCode: "private-code",
      signerNpub: "npub1rememberedsigner",
      voterKeypair: {
        npub: "npub1localvoter",
        nsec: "nsec1localvoter",
      },
    });

    expect(identity).toEqual({
      activeVoterNpub: "npub1localvoter",
      localVoterNsec: "nsec1localvoter",
      autoSignerLogin: false,
    });
  });

  it("does not claim a private code with a remembered signer before local identity is ready", () => {
    const identity = selectQuestionnaireVoterIdentity({
      privateInviteCode: "private-code",
      signerNpub: "npub1rememberedsigner",
      voterKeypair: null,
    });

    expect(identity).toEqual({
      activeVoterNpub: "",
      localVoterNsec: "",
      autoSignerLogin: false,
    });
  });

  it("keeps normal signer login behaviour outside private code links", () => {
    const identity = selectQuestionnaireVoterIdentity({
      signerNpub: "npub1rememberedsigner",
      voterKeypair: {
        npub: "npub1localvoter",
        nsec: "nsec1localvoter",
      },
    });

    expect(identity).toEqual({
      activeVoterNpub: "npub1rememberedsigner",
      localVoterNsec: "",
      autoSignerLogin: true,
    });
  });
});
