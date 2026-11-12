import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('../../blind-credential-core/tests/fixtures/js-legacy.json', import.meta.url), 'utf8'));

test('browser Wasm preserves a saved JavaScript credential and generates interoperable fresh credentials', async ({ page }) => {
  await page.goto('/e2e/blind-credentials-harness.html');
  const result = await page.evaluate(async fixture => {
    const modulePath = '/src/wasm/blindCredentials.ts';
    const core = await import(modulePath);
    const message = new TextEncoder().encode(fixture.message);
    const restored = await core.finalizeBlindCredential(fixture.publicJwk, message, fixture.blindSignature, fixture.blindingFactor);
    const request = await core.blindCredential(fixture.publicJwk, message);
    const signed = await core.signBlindCredential(fixture.privateJwk, request.blindedMessage);
    const signature = await core.finalizeBlindCredential(fixture.publicJwk, message, signed, request.blindingFactor);
    const key = await crypto.subtle.importKey('jwk', fixture.publicJwk, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
    const bytes = Uint8Array.from(signature.match(/../g)!.map((pair: string) => Number.parseInt(pair, 16)));
    return {
      restored: restored === fixture.signature,
      verified: await core.verifyBlindCredential(fixture.publicJwk, message, signature),
      independentlyVerified: await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 48 }, key, bytes, message),
      tampered: await core.verifyBlindCredential(fixture.publicJwk, new TextEncoder().encode('tampered'), signature),
      inverseLength: request.blindingFactor.length,
    };
  }, fixture);
  expect(result).toEqual({ restored: true, verified: true, independentlyVerified: true, tampered: false, inverseLength: 768 });
});

test('browser questionnaire wrapper keeps its WebCrypto key format and key-ID derivation', async ({ page }) => {
  await page.goto('/e2e/blind-credentials-harness.html');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/questionnaireBlindSignature.ts';
    const api = await import(modulePath);
    const key = await api.generateQuestionnaireBlindKeyPair();
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ n: key.jwk.n, e: key.jwk.e })));
    const expectedId = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
    const publicKey = api.toQuestionnaireBlindPublicKey(key);
    const message = 'scope-preservation: {"allowedScopes":["0","group-2"]}';
    const request = await api.blindQuestionnaireToken({ publicKey, message });
    const blindSignature = await api.signBlindedQuestionnaireToken({ privateKey: key, blindedMessage: request.blindedMessage });
    const signature = await api.finalizeQuestionnaireBlindSignature({ publicKey, message, blindSignature, blindingFactor: request.blindingFactor });
    return { sameId: key.keyId === expectedId, scheme: key.scheme, alg: key.jwk.alg, e: key.jwk.e,
      privateComponents: ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'].every(field => typeof key.privateJwk[field] === 'string'),
      verified: await api.verifyQuestionnaireBlindSignature({ publicKey, message, signature }) };
  });
  expect(result).toEqual({ sameId: true, scheme: 'rsabssa-sha384-pss-deterministic-v1', alg: 'PS384', e: 'AQAB', privateComponents: true, verified: true });
});
