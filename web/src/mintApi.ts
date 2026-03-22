import { MINT_URL, USE_MOCK } from "./config";
import { requestMintInvoice, fetchMintProof, type MintInvoiceResponse, type ProofStatusResponse } from "./cashuMintApi";

export type MintQuoteResponse = {
  quote: string;
  request: string;
  state: "UNPAID" | "PAID" | "ISSUED";
  amount: number;
  unit: string;
  expiry: number;
};

export type MintQuoteStatusResponse = {
  quote: string;
  state: "UNPAID" | "PAID" | "ISSUED";
  amount: number;
  unit: string;
};

export type MintKeysResponse = {
  [keysetId: string]: {
    [amount: number]: string;
  };
};

export type MintKeysetResponse = {
  id: string;
  unit: string;
  active: boolean;
};

export type MintTokensResponse = {
  signatures: string[];
};

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json() as T & { error?: string; detail?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? payload.detail ?? "Request failed");
  }

  return payload;
}

export async function createMintQuote(): Promise<MintQuoteResponse> {
  if (USE_MOCK) {
    const mockInvoice = await requestMintInvoice(MINT_URL);
    return {
      quote: mockInvoice.quoteId,
      request: mockInvoice.invoice,
      state: "UNPAID",
      amount: mockInvoice.amount,
      unit: "sat",
      expiry: 600000
    };
  }

  return fetchJson<MintQuoteResponse>(`${MINT_URL}/v1/mint/quote/bolt11`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount: 1, unit: "sat" })
  });
}

export async function checkQuoteStatus(quoteId: string): Promise<MintQuoteStatusResponse> {
  if (USE_MOCK) {
    const mockStatus = await fetchMintProof(MINT_URL, quoteId);
    if (mockStatus.status === "pending") {
      return { quote: quoteId, state: "UNPAID", amount: 1, unit: "sat" };
    }
    return { quote: quoteId, state: "PAID", amount: 1, unit: "sat" };
  }

  return fetchJson<MintQuoteStatusResponse>(`${MINT_URL}/v1/mint/quote/bolt11/${quoteId}`);
}

export async function getMintKeys(): Promise<MintKeysResponse> {
  if (USE_MOCK) {
    return { "00": { "1": "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } };
  }

  return fetchJson<MintKeysResponse>(`${MINT_URL}/v1/keys`);
}

export async function getMintKeysets(): Promise<MintKeysetResponse[]> {
  if (USE_MOCK) {
    return [{ id: "00" + "a".repeat(64), unit: "sat", active: true }];
  }

  return fetchJson<MintKeysetResponse[]>(`${MINT_URL}/v1/keysets`);
}

export async function mintTokens(quote: string, outputs: string[]): Promise<MintTokensResponse> {
  if (USE_MOCK) {
    return { signatures: outputs.map(() => "mock_signature_" + Math.random().toString(36).slice(2)) };
  }

  return fetchJson<MintTokensResponse>(`${MINT_URL}/v1/mint/bolt11`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quote, outputs })
  });
}
