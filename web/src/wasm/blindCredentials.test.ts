import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blindCredential, signBlindCredential, finalizeBlindCredential, verifyBlindCredential } from './blindCredentials';

const fixture = JSON.parse(readFileSync(new URL('../../../blind-credential-core/tests/fixtures/js-legacy.json', import.meta.url), 'utf8'));
const message = new TextEncoder().encode(fixture.message);

describe('real Rust/Wasm blind-credential adapter', () => {
  it('preserves a saved JavaScript credential, request inverse and response', async () => {
    expect(await verifyBlindCredential(fixture.publicJwk, message, fixture.signature)).toBe(true);
    expect(await signBlindCredential(fixture.privateJwk, fixture.blindedMessage)).toBe(fixture.blindSignature);
    expect(await finalizeBlindCredential(fixture.publicJwk, message, fixture.blindSignature, fixture.blindingFactor)).toBe(fixture.signature);
  });
  it('roundtrips with fresh independent blinding and rejects malformed/wrong-message inputs', async () => {
    const first = await blindCredential(fixture.publicJwk, message);
    const second = await blindCredential(fixture.publicJwk, message);
    expect(first.blindedMessage).not.toBe(second.blindedMessage);
    expect(first.blindingFactor).toHaveLength(768);
    const response = await signBlindCredential(fixture.privateJwk, first.blindedMessage);
    const signature = await finalizeBlindCredential(fixture.publicJwk, message, response, first.blindingFactor);
    expect(await verifyBlindCredential(fixture.publicJwk, message, signature)).toBe(true);
    expect(await verifyBlindCredential(fixture.publicJwk, new TextEncoder().encode('wrong'), signature)).toBe(false);
    expect(await verifyBlindCredential(fixture.publicJwk, message, 'zz')).toBe(false);
    await expect(signBlindCredential(fixture.privateJwk, '00')).rejects.toThrow();
    await expect(finalizeBlindCredential(fixture.publicJwk, message, response, second.blindingFactor)).rejects.toThrow();
  });
  it('bounds malformed JWKs and messages and rejects incomplete private keys', async () => {
    for (const jwk of [{ ...fixture.publicJwk, kty: 'EC' }, { ...fixture.publicJwk, e: 'AQ' }, { ...fixture.publicJwk, n: 'A'.repeat(1000) }]) {
      await expect(blindCredential(jwk, message)).rejects.toThrow();
      expect(await verifyBlindCredential(jwk, message, fixture.signature)).toBe(false);
    }
    await expect(signBlindCredential({ ...fixture.privateJwk, p: undefined }, fixture.blindedMessage)).rejects.toThrow();
    await expect(blindCredential(fixture.publicJwk, new Uint8Array(1024 * 1024 + 1))).rejects.toThrow();
    expect(await verifyBlindCredential(fixture.publicJwk, new Uint8Array(1024 * 1024 + 1), fixture.signature)).toBe(false);
    await expect(signBlindCredential(fixture.privateJwk, '+a')).rejects.toThrow();
  });
});
