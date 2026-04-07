let coordinatorCoreModulePromise: Promise<typeof import("../wasm/auditable_voting_coordinator_core/pkg/auditable_voting_core")> | null = null;

export async function loadCoordinatorCoreModule() {
  if (!coordinatorCoreModulePromise) {
    coordinatorCoreModulePromise = import("../wasm/auditable_voting_coordinator_core/pkg/auditable_voting_core");
  }

  return coordinatorCoreModulePromise;
}

export async function loadProtocolCoreModule() {
  return loadCoordinatorCoreModule();
}
