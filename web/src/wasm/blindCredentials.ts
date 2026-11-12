// The same Rust library is linked natively by the Guardian. There is no
// automatic JavaScript crypto fallback if the Wasm module cannot load.
let modulePromise: Promise<typeof import('./blind_credential_core/pkg/auditable_voting_blind_credentials')> | null = null;
function load() {
  return modulePromise ??= import('./blind_credential_core/pkg/auditable_voting_blind_credentials');
}
function invoke<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
}

export async function blindCredential(publicJwk: JsonWebKey, message: Uint8Array): Promise<{ blindedMessage: string; blindingFactor: string }> {
  const core = await load();
  return invoke(() => JSON.parse(core.blind_credential_blind(JSON.stringify(publicJwk), message)));
}
export async function signBlindCredential(privateJwk: JsonWebKey, blindedMessage: string): Promise<string> {
  const core = await load();
  return invoke(() => core.blind_credential_sign(JSON.stringify(privateJwk), blindedMessage));
}
export async function finalizeBlindCredential(publicJwk: JsonWebKey, message: Uint8Array, blindSignature: string, blindingFactor: string): Promise<string> {
  const core = await load();
  return invoke(() => core.blind_credential_finalize(JSON.stringify(publicJwk), message, blindSignature, blindingFactor));
}
export async function verifyBlindCredential(publicJwk: JsonWebKey, message: Uint8Array, signature: string): Promise<boolean> {
  try {
    const core = await load();
    return core.blind_credential_verify(JSON.stringify(publicJwk), message, signature);
  } catch { return false; }
}
