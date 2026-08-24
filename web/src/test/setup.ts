/**
 * Global vitest setup.
 *
 * Enforces a zero-network test suite: any code path that reaches the global
 * `fetch` throws immediately instead of attempting a real network request.
 * Tests that legitimately exercise network code must inject their own fetch
 * stub (see the otpDelivery channel tests, which pass a fetch-injected
 * dependency) or stub `globalThis.fetch` explicitly.
 */
export function setup(): void {
  const throwingFetch = (): Promise<never> =>
    Promise.reject(
      new Error(
        "Network access is disabled in tests. Inject a fetch stub or stub globalThis.fetch explicitly.",
      ),
    );

  Object.defineProperty(globalThis, "fetch", {
    value: throwingFetch,
    configurable: true,
    writable: true,
  });
}
