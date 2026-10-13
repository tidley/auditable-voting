# Voter OTP entry — redeem an issued code (browser-local)

## Overview

The resident OTP flow now has a voter-side entry point. The organiser issues
codes from the Participants tab (`ResidentOtpAdmission`); the resident redeems
theirs from the Voter role (`ResidentOtpEntry`, mounted at the top of the Vote
tab). Everything runs in the browser — no code or hash is sent to any server.

- `web/src/otpAdmissionRoster.ts` — persistent issued-hash roster + redeemed flags
- `web/src/ResidentOtpEntry.tsx` — voter-side entry (masters-list number + 6-digit code)
- `web/src/ResidentOtpAdmission.tsx` — coordinator-side issue (now persists on issue)

## Persistence decision

The issued-hash roster must outlive the coordinator tab because a resident may
redeem their code hours after it is issued. **Decision: persist to
`localStorage`** (option (a) from F4-T7), reusing the `otp-delivery-channel:`
per-election key pattern from `otpDelivery/selectorStorage.ts`.

Two keys per election, both namespace-prefixed and stored under the raw
(un-namespaced) key scheme the delivery selector already uses:

| Key | Value |
|---|---|
| `otp-admission-roster:<electionId>` | `IssuedOtpRecord[]` — `{ mastersListNumber, saltHash, issuedAt, electionId }` |
| `otp-admission-redeemed:<electionId>` | `number[]` — redeemed masters-list numbers (the admission flag) |
| `otp-admission-binding:<electionId>` | `ResidentNpubBinding[]` — `{ mastersListNumber, npub, boundAt, electionId }` |

**Never plaintext, but not unrecoverable either.** Only the derived record
produced by `hashOtp()` is stored — the format
`pbkdf2-sha256$iterations$saltHex$digestHex`, never the code itself. Stated
honestly, that is a **weak** secret: the code space is six decimal digits
(≈ 20 bits), so anyone who takes a copy of `localStorage` can search all 10^6
codes against each stored record. The stored work factor (600,000 PBKDF2
iterations) makes each guess cost ≈ 0.3 s on a single CPU thread, which turns
that exhaustive search into hours-to-days per record on one core and **minutes**
on parallel hardware — a ~10,000× speed bump, not a barrier. A stolen roster
should be treated as a leak of the codes.

The code is still re-derived and compared in constant time via `verifyOtp()`,
and a record left over from the previous single-SHA-256 format is **never
honoured** (it fails closed with a "cannot be verified in this browser" message
that points the resident at the organiser). See
[docs/otp-service-security.md](otp-service-security.md#the-actual-bound-what-this-does-not-buy)
for the measurements and the full statement of what this does not buy.

The session-only alternative (option (b)) was rejected because redemption
routinely lags issue by hours, and the whole point of out-of-band admission
codes is that the coordinator tab is not open when the resident finally
enters their code.

## Voter flow

1. The resident enters their **masters-list number** and the **6-digit code**
   handed to them out of band.
2. The entry looks up the issued record in the persisted roster. When no
   `electionId` is supplied it searches every stored roster, so the resident
   does not need to know the election id up front.
3. It checks expiry (`ADMISSION_TTL_MS`, 24 hours), then verifies with
   `verifyOtp()` (constant-time comparison; per-*page-load* attempt limiting
   only — see [docs/otp-service-security.md](otp-service-security.md#4-per-page-attempt-limiting-defence-in-depth-not-a-rate-limit)).
   A record in the pre-fix SHA-256 format is rejected here with the
   "cannot be verified in this browser" message rather than reported as a
   wrong code.
4. On success it **marks the code redeemed**, records a **resident → voter-npub
   binding** (when the voter's npub is known), and reports the **admission
   flag** via `onAdmitted`. The redeemed flag persists, so the code cannot be
   reused.

The admission flag is the persisted redeemed state. `SimpleUiApp` consumes it
through `onAdmitted`: until a resident redeems a valid code the ballot and
private-invite panel stays hidden, and once admitted it unlocks for that
browser session.

## Cross-device and reload behaviour

**This is a same-device / kiosk flow.** The issued-code roster the organiser
publishes is stored in the *issuing browser's* `localStorage`, so a code can
only be redeemed in that same browser profile. Redeeming a code on a different
browser, device, or profile will not grant admission there; the coordinator's
npub-keyed whitelist is only reachable from the coordinating browser.

- **Same-device, cross-tab:** works. Because the roster is in `localStorage`
  (shared within one origin), re-entering the same code in another tab on the
  same browser profile verifies against the same stored record.
- **Cross-device/cross-profile:** **not** supported. This is the accepted
  Option-B re-scope from PR #25. Cross-device redemption needs a
  coordinator-signed admission token the voter can verify offline, carried over
  the existing gift-wrapped DM plumbing — a follow-on ticket, not built here.
- **Reload persistence:** a verified redemption records a **resident → voter-npub
  binding**. On a reload, `SimpleUiApp` restores the already-admitted state for
  the active voter npub when such a binding exists
  (`hasPersistedResidentOtpAdmission`), so a reload does not silently revoke
  ballot access that this browser already granted. The binding is written only
  by a *verified* redemption, so this cannot admit an un-verified identity.
- **Admission is usability, not security.** The OTP step confirms the resident
  has possession of an issued code; it is not a substitute for per-voter
  authentication, and it cannot defend against someone who copies the roster
  from one browser to another. See
  [docs/otp-service-security.md](otp-service-security.md) for the honest bound.

## Coordinator wiring

`SimpleCoordinatorApp` passes `electionId` and `onAdmitted` to
`ResidentOtpAdmission`. Issuing a code persists its salted hash; verifying a
code (the coordinator's "test the code" form) marks it redeemed and surfaces
the admission in the coordinator status.

**Admission gates voting on both sides.** When a resident redeems their code
the voter side persists a resident → voter-npub binding
(`recordResidentNpubBinding`). The coordinator reads the bindings for the
current election, filters them to those whose code is actually redeemed, and
pushes the resulting npubs into the npub-keyed whitelist via
`admitVotersToRoster(…, "otp")`. That sync runs when the coordinator tab loads
or the election/identity changes, on every `storage` event that changes the
binding or redeemed key (so a redemption in a neighbouring voter tab is picked
up live), and when the coordinator verifies a code themselves.

## Out of scope

CSV upload, admission and sending (`ResidentOtpAdmission` +
`otpDelivery/DeliveryPanel`) are unchanged, and `scripts/otp-send-email.mjs`
is not touched.

## Testing

```bash
cd web && npx vitest run src/otpAdmissionRoster.test.ts src/ResidentOtpEntry.test.tsx src/ResidentOtpAdmission.test.tsx
```

Coverage: roster persistence/redemption round-trips, resident→npub binding
round-trips, and malformed-entry handling; voter entry rendering, incomplete
entry, no-issued-code, success + redemption + `onAdmitted` + npub binding,
incorrect code, rate-limit lockout, expiry, and cross-election lookup;
coordinator-side persist-on-issue (never plaintext) and verify-marks-redeemed
+ `onAdmitted`.
