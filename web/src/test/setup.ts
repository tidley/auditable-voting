/**
 * Global vitest setup.
 *
 * Enforces a zero-network test suite: any code path that reaches the global
 * `fetch` throws immediately instead of attempting a real network request.
 * Tests that legitimately exercise network code must inject their own fetch
 * stub (see the otpDelivery channel tests, which pass a fetch-injected
 * dependency) or stub `globalThis.fetch` explicitly.
 *
 * Also raises Testing Library's async-utility timeout. `waitFor` has its own
 * budget (`asyncUtilTimeout`, 1000ms by default) which is independent of
 * vitest's `testTimeout`; on a loaded box the default is too tight for any
 * assertion that waits on a real PBKDF2 hash. See the note below.
 */
import { configure } from "@testing-library/dom";

/**
 * OTP records are written with PBKDF2-HMAC-SHA256 at 600,000 iterations
 * (`otpService.OTP_KDF_ITERATIONS`, the C2 work-factor hardening). That is the
 * point of the construction: a single hash costs hundreds of milliseconds on
 * real hardware, and was measured at 642-907ms on our build box under load.
 *
 * `waitFor`'s 1000ms default was sized for a bare SHA-256 (~1ms) and is now
 * below the cost of *one* hash on a contended runner, let alone the loop in
 * `issueAllCodes`, which hashes once per resident. The tests are not waiting on
 * a hang; they are waiting on deliberate cryptographic work, so the budget has
 * to reflect the work factor rather than the old hash speed.
 *
 * 10s leaves a genuine hang detectable while comfortably covering a small
 * roster on a slow runner. If the work factor is raised again, check this
 * number against the measured per-hash cost.
 */
configure({ asyncUtilTimeout: 10_000 });

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

setup();
