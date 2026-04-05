import { deriveActorDisplayIdRust } from "./wasm/auditableVotingCore";

export function deriveActorDisplayId(value: string) {
  return deriveActorDisplayIdRust(value);
}
