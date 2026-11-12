import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = new URL('../../vendor/blind-rsa-signatures/', import.meta.url);
const hashes = JSON.parse(await readFile(new URL('UPSTREAM-SHA256.json', root), 'utf8'));
for (const [path, expected] of Object.entries(hashes)) {
  let bytes = await readFile(new URL(path, root));
  if (path === 'Cargo.toml') bytes = Buffer.from(bytes.toString().replace('rsa = { version = "=0.10.0", features = ["hazmat"] }', 'rsa = { version = "0.10.0-rc.18", features = ["hazmat"] }'));
  if (path === 'src/lib.rs') bytes = Buffer.from(bytes.toString().replace('// Local compatibility patch: the unused PBRSA implementation targets removed\n// prerelease PrivateKeyParts methods. RFC 9474 BRSA below is unchanged.\n// Do not re-enable PBRSA without a separate stable-RSA compatibility review.', 'pub mod pbrsa;'));
  if (path === 'tests/vectors.rs') bytes = Buffer.from(bytes.toString().replace('let s: String = Deserialize::deserialize(d)?;\n    if s.is_empty() {\n        // RFC vectors encode a zero-length salt/prefix as empty bytes, not a\n        // zero-valued bigint (which exports a full zero machine word).\n        return Ok(Vec::new());', "let mut s: String = Deserialize::deserialize(d)?;\n    if s.is_empty() {\n        s.push('0');"));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `Unexpected upstream source change: ${path}`);
}
console.log('Vendored BRSA provenance verified: only the documented dependency pin, unused-module exclusion and test-only empty-byte parser fix differ.');
