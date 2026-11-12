// Generate fictional test material only. Never use fixture keys for real voting.
import { webcrypto } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { RSABSSA } from '@cloudflare/blindrsa-ts';

const suite = RSABSSA.SHA384.PSS.Deterministic();
const pair = await suite.generateKey({ modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) });
const message = 'auditable-voting/simple-blind/v2|compatibility-fixture:café 🗳️';
const prepared = suite.prepare(new TextEncoder().encode(message));
const request = await suite.blind(pair.publicKey, prepared);
const signed = await suite.blindSign(pair.privateKey, request.blindedMsg);
const signature = await suite.finalize(pair.publicKey, prepared, signed, request.inv);
if (!await suite.verify(pair.publicKey, signature, prepared)) throw new Error('Fixture verification failed.');
const hex = bytes => Buffer.from(bytes).toString('hex');
const output = new URL('../../blind-credential-core/tests/fixtures/js-legacy.json', import.meta.url);
await mkdir(new URL('.', output), { recursive: true });
await writeFile(output, JSON.stringify({
  warning: 'PUBLIC FICTIONAL TEST KEY. Never use for production.',
  scheme: 'rsabssa-sha384-pss-deterministic-v1', message,
  publicJwk: await webcrypto.subtle.exportKey('jwk', pair.publicKey),
  privateJwk: await webcrypto.subtle.exportKey('jwk', pair.privateKey),
  blindedMessage: hex(request.blindedMsg), blindingFactor: hex(request.inv),
  blindSignature: hex(signed), signature: hex(signature),
}, null, 2) + '\n', { flag: 'wx' });
console.log('Generated and verified fictional legacy compatibility fixture.');
