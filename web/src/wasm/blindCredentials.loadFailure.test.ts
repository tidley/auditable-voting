import { expect, it, vi } from 'vitest';
vi.mock('./blind_credential_core/pkg/auditable_voting_blind_credentials', () => { throw new Error('Wasm unavailable'); });
import { blindCredential, signBlindCredential, finalizeBlindCredential, verifyBlindCredential } from './blindCredentials';

it('fails closed without falling back to legacy JavaScript when Wasm cannot load', async () => {
  await expect(blindCredential({}, new Uint8Array())).rejects.toThrow();
  await expect(signBlindCredential({}, '00')).rejects.toThrow();
  await expect(finalizeBlindCredential({}, new Uint8Array(), '00', '00')).rejects.toThrow();
  expect(await verifyBlindCredential({}, new Uint8Array(), '00')).toBe(false);
});
