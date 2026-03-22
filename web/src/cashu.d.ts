declare module "@cashu/cashu-ts" {
  export class CashuWallet {
    constructor(mint: string | any, options?: {
      unit?: string;
      keys?: any;
      keysets?: any;
      mintInfo?: any;
      bip39seed?: Uint8Array;
    });

    createMintQuote(amount: number, unit: string): Promise<{ quote: string }>;
    checkMintQuote(quote: string): Promise<{ state: string }>;
    createBlankOutputs(amount: number, counter?: number, pubkey?: string, keysetId?: string): any[];
    mintProofs(amount: number, quote: string, options?: any): Promise<any[]>;
    getKeys(keysetId?: string): Promise<any>;
    getKeySets(): Promise<any[]>;
    getActiveKeyset(): Promise<any>;
  }

  export function getEncodedToken(token: { mint: string; proofs: any[] }, options?: any): string;
  export function getDecodedToken(token: string): { mint: string; proofs: any[] };
}
