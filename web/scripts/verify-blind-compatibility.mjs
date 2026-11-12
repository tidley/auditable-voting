// Independent legacy-JavaScript / native-Rust / browser-Wasm oracle.
// All key material is fictional, public test data; no relay or SMTP is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import './check-blind-vendor.mjs';

const core = await import('../src/wasm/blind_credential_core/pkg/auditable_voting_blind_credentials.js');
const fixture = JSON.parse(await readFile(new URL('../../blind-credential-core/tests/fixtures/js-legacy.json', import.meta.url), 'utf8'));
const built = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', fileURLToPath(new URL('../../blind-credential-core/Cargo.toml', import.meta.url)), '--example', 'compatibility', '--message-format=json', '--jobs', '2'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
if (built.status !== 0) { process.stderr.write(built.stderr); throw new Error('Native compatibility driver build failed.'); }
const artifacts = built.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
const binary = artifacts.find(entry => entry.reason === 'compiler-artifact' && entry.target.name === 'compatibility' && entry.executable)?.executable;
assert.ok(binary, 'Use the tool-reported executable path.');
function native(operation, jwk, fields = {}) {
  const result = spawnSync(binary, [], { input: JSON.stringify({ operation, jwk, ...fields }), encoding: 'utf8' });
  assert.equal(result.status, 0, 'Native test operation failed (inputs are not logged).');
  return JSON.parse(result.stdout);
}
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const suite = RSABSSA.SHA384.PSS.Deterministic();
const publicKey = await crypto.subtle.importKey('jwk', fixture.publicJwk, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
const privateKey = await crypto.subtle.importKey('jwk', fixture.privateJwk, { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
const pub = JSON.stringify(fixture.publicJwk), priv = JSON.stringify(fixture.privateJwk);
let checks = 0;
for (const message of [fixture.message, '', 'café 🗳️\u0000\nquestionnaire scope: {"allowedScopes":["0","group-2"]}']) {
  const encoded = new TextEncoder().encode(message), prepared = suite.prepare(encoded);
  // Legacy client -> native issuer -> legacy finaliser -> native + Wasm verifier.
  const jsRequest = await suite.blind(publicKey, prepared);
  const nativeSigned = native('sign', fixture.privateJwk, { blindedMessage: hex(jsRequest.blindedMsg) });
  const jsSignature = await suite.finalize(publicKey, prepared, bytes(nativeSigned), jsRequest.inv);
  assert.equal(native('verify', fixture.publicJwk, { message, signature: hex(jsSignature) }), true); checks++;
  assert.equal(core.blind_credential_verify(pub, encoded, hex(jsSignature)), true); checks++;
  // Rust/Wasm client -> legacy issuer -> Rust/Wasm finaliser -> legacy verifier.
  const wasmRequest = JSON.parse(core.blind_credential_blind(pub, encoded));
  const jsSigned = await suite.blindSign(privateKey, bytes(wasmRequest.blindedMessage));
  const wasmSignature = core.blind_credential_finalize(pub, encoded, hex(jsSigned), wasmRequest.blindingFactor);
  assert.equal(await suite.verify(publicKey, bytes(wasmSignature), prepared), true); checks++;
  assert.equal(native('verify', fixture.publicJwk, { message, signature: wasmSignature }), true); checks++;
  // Native client -> Wasm issuer -> native finaliser -> legacy verifier.
  const nativeRequest = native('blind', fixture.publicJwk, { message });
  const wasmSigned = core.blind_credential_sign(priv, nativeRequest.blindedMessage);
  const nativeSignature = native('finalize', fixture.publicJwk, { message, blindSignature: wasmSigned, blindingFactor: nativeRequest.blindingFactor });
  assert.equal(await suite.verify(publicKey, bytes(nativeSignature), prepared), true); checks++;
  assert.equal(core.blind_credential_verify(pub, new TextEncoder().encode(message + 'tampered'), nativeSignature), false); checks++;
}
// Previously saved JWK, inverse, blind response and completed signature.
assert.equal(core.blind_credential_finalize(pub, new TextEncoder().encode(fixture.message), fixture.blindSignature, fixture.blindingFactor), fixture.signature); checks++;
assert.equal(core.blind_credential_sign(priv, fixture.blindedMessage), fixture.blindSignature); checks++;
assert.equal(core.blind_credential_verify(pub, new TextEncoder().encode(fixture.message), fixture.signature), true); checks++;
assert.equal(core.blind_credential_verify(pub, new TextEncoder().encode(fixture.message), 'zz'), false); checks++;
assert.throws(() => core.blind_credential_finalize(pub, new TextEncoder().encode(fixture.message), fixture.blindSignature, '00')); checks++;
// Key sizes accepted by existing browser/Guardian formats, plus a foreign key.
for (const bits of [1024, 2048, 4096]) {
  const pair = await suite.generateKey({ modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]) });
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const message = `existing-key-format-${bits}`, encoded = new TextEncoder().encode(message);
  const request = JSON.parse(core.blind_credential_blind(JSON.stringify(publicJwk), encoded));
  const signed = native('sign', privateJwk, { blindedMessage: request.blindedMessage });
  const signature = core.blind_credential_finalize(JSON.stringify(publicJwk), encoded, signed, request.blindingFactor);
  assert.equal(await suite.verify(pair.publicKey, bytes(signature), suite.prepare(encoded)), true); checks++;
  assert.equal(native('verify', publicJwk, { message, signature }), true); checks++;
  assert.equal(core.blind_credential_verify(pub, encoded, signature), false); checks++;
}
console.log(`Blind-credential compatibility: ${checks} checks passed across legacy JavaScript, native Rust and Wasm.`);
