import { describe, it, expect, vi } from "vitest";

const mockMintProofs = vi.fn().mockResolvedValue([
  { id: "test_keyset_id", amount: 1, secret: "test_secret", C: "test_signature" },
]);
const mockCreateMintQuote = vi.fn();
const mockCreateBlankOutputs = vi.fn();
const mockGetEncodedToken = vi.fn().mockReturnValue("encoded_token");

const mockWalletInstance = {
  mintProofs: mockMintProofs,
  createMintQuote: mockCreateMintQuote,
  createBlankOutputs: mockCreateBlankOutputs,
};

vi.mock("@cashu/cashu-ts", () => {
  function MockCashuMint(t) {
    return t;
  }
  function MockCashuWallet() {
    return mockWalletInstance;
  }
  return {
    CashuWallet: vi.fn(MockCashuWallet),
    CashuMint: vi.fn(MockCashuMint),
    getEncodedToken: mockGetEncodedToken,
  };
});

vi.mock("./config", () => ({ USE_MOCK: false }));

describe("requestQuoteAndMint", () => {
  it("calls mintProofs with the approved quote ID", async () => {
    const { requestQuoteAndMint } = await import("./cashuBlind");
    const result = await requestQuoteAndMint("http://example.com/mint", "approved-quote-123");

    expect(mockMintProofs).toHaveBeenCalledWith(1, "approved-quote-123");
    expect(result.quote).toBe("approved-quote-123");
    expect(result.proofs).toHaveLength(1);
  });

  it("does not call createMintQuote (no new unpaid quote)", async () => {
    const { requestQuoteAndMint } = await import("./cashuBlind");
    await requestQuoteAndMint("http://example.com/mint", "approved-quote-123");
    expect(mockCreateMintQuote).not.toHaveBeenCalled();
  });

  it("does not call createBlankOutputs (private API)", async () => {
    const { requestQuoteAndMint } = await import("./cashuBlind");
    await requestQuoteAndMint("http://example.com/mint", "approved-quote-123");
    expect(mockCreateBlankOutputs).not.toHaveBeenCalled();
  });

  it("passes CashuMint instance to CashuWallet constructor", async () => {
    const { requestQuoteAndMint } = await import("./cashuBlind");
    const { CashuWallet, CashuMint } = await import("@cashu/cashu-ts");
    await requestQuoteAndMint("http://example.com/mint", "quote-456");
    expect(CashuMint).toHaveBeenCalledWith("http://example.com/mint");
    expect(CashuWallet).toHaveBeenCalledWith(expect.any(Object), { unit: "sat" });
  });
});
