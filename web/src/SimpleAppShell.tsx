import { useEffect, useMemo, useRef, useState } from "react";
import { nip19 } from "nostr-tools";
import SimpleAuditorApp from "./SimpleAuditorApp";
import SimpleCoordinatorApp from "./SimpleCoordinatorApp";
import SimpleRelayPanel from "./SimpleRelayPanel";
import SimpleUiApp from "./SimpleUiApp";
import { SIMPLE_APP_VERSION } from "./simpleAppVersion";
import { createAmberConnectBundle, createSignerService, SignerServiceError } from "./services/signerService";
import { deriveNpubFromNsec } from "./nostrIdentity";
import { loadSimpleActorState, saveSimpleActorState, type SimpleActorRole } from "./simpleLocalState";
import { tryWriteClipboard } from "./clipboard";
import SimpleQrPanel from "./SimpleQrPanel";
import { PRESS_FEEDBACK_SETTLED_EVENT } from "./pressFeedback";
import TokenFingerprint from "./TokenFingerprint";
import { deriveActorDisplayId } from "./actorDisplay";

type SimpleRole = "voter" | "coordinator" | "auditor";
const GATEWAY_SIGNER_NPUB_STORAGE_KEY = "app:auditable-voting:gateway:signer_npub";
const AMBER_FULLY_TRUST_HINT = "Change from `Approve basic actions` to `I fully trust this application` when Amber opens. This allows the application to fully coordinate.";
const ROLE_OPTIONS: Array<{ role: SimpleRole; label: string }> = [
  { role: "auditor", label: "Observer" },
  { role: "coordinator", label: "Coordinator" },
  { role: "voter", label: "Voter" },
];
const IDENTITY_UPDATED_EVENT = "auditable-voting:identity-updated";

type SimpleAppShellProps = {
  initialRole?: SimpleRole;
};

function readRoleFromUrl(): SimpleRole | null {
  if (typeof window === "undefined") {
    return null;
  }

  const role = new URLSearchParams(window.location.search).get("role");
  if (role === "voter" || role === "coordinator" || role === "auditor") {
    return role;
  }

  return null;
}

function hasRoleInUrl() {
  if (typeof window === "undefined") {
    return false;
  }
  return Boolean(new URLSearchParams(window.location.search).get("role"));
}

function shouldForceGatewayFromUrl() {
  if (typeof window === "undefined") {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  return params.get("login") === "1";
}

function readLinkedQuestionnaireIdFromUrl() {
  if (typeof window === "undefined") {
    return "";
  }
  const params = new URLSearchParams(window.location.search);
  return (params.get("q") ?? params.get("election_id") ?? params.get("questionnaire") ?? "").trim();
}

function writeRoleToUrl(role: SimpleRole) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("role", role);
  url.searchParams.delete("login");
  window.history.replaceState({}, "", url.toString());
}

function getLandingPageUrl() {
  if (typeof window === "undefined") {
    return "/";
  }
  return new URL(import.meta.env.BASE_URL || "/", window.location.origin).toString();
}

function returnToLandingPage() {
  if (typeof window === "undefined") {
    return;
  }
  window.location.assign(getLandingPageUrl());
}

function roleLabel(role: SimpleRole) {
  return ROLE_OPTIONS.find((entry) => entry.role === role)?.label ?? "Observer";
}

function isSimpleActorRole(role: SimpleRole): role is SimpleActorRole {
  return role === "voter" || role === "coordinator";
}

function isMobileBrowser() {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || "");
}

export default function SimpleAppShell({ initialRole = "auditor" }: SimpleAppShellProps) {
  const [role, setRole] = useState<SimpleRole>(() => readRoleFromUrl() ?? initialRole);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [accountIdentityNpub, setAccountIdentityNpub] = useState("");
  const [showGateway, setShowGateway] = useState(() => !hasRoleInUrl() || shouldForceGatewayFromUrl());
  const [gatewayRole, setGatewayRole] = useState<SimpleRole>(() => readRoleFromUrl() ?? initialRole);
  const [gatewayNsec, setGatewayNsec] = useState("");
  const [gatewaySignerNpub, setGatewaySignerNpub] = useState("");
  const [gatewayStatus, setGatewayStatus] = useState<string | null>(null);
  const [gatewayNsecOpen, setGatewayNsecOpen] = useState(false);
  const [gatewayAdvancedOpen, setGatewayAdvancedOpen] = useState(false);
  const [gatewayNostrConnectUri, setGatewayNostrConnectUri] = useState("");
  const [gatewayNsecBunkerUri, setGatewayNsecBunkerUri] = useState("");
  const [gatewayShowConnectQr, setGatewayShowConnectQr] = useState(false);
  const roleSwitchWrapRef = useRef<HTMLDivElement | null>(null);
  const preferredSignerLabel = useMemo(() => (isMobileBrowser() ? "Amber" : "NOS2X-FOX"), []);
  const preferredSignerIsAmber = preferredSignerLabel === "Amber";
  const accountIdentityLabel = accountIdentityNpub ? deriveActorDisplayId(accountIdentityNpub) : "pending";

  useEffect(() => {
    if (role !== "voter" && role !== "coordinator") {
      setAccountIdentityNpub("");
      return;
    }

    let cancelled = false;
    const persistedSignerNpub = typeof window === "undefined"
      ? ""
      : window.localStorage.getItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY)?.trim() ?? "";
    setAccountIdentityNpub(persistedSignerNpub);

    loadSimpleActorState(role)
      .then((state) => {
        if (cancelled) {
          return;
        }
        setAccountIdentityNpub(state?.keypair?.npub?.trim() || persistedSignerNpub);
      })
      .catch(() => {
        if (!cancelled) {
          setAccountIdentityNpub(persistedSignerNpub);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [role]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleIdentityUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ role?: SimpleRole; npub?: string }>).detail;
      if (!detail || detail.role !== role) {
        return;
      }
      setAccountIdentityNpub(detail.npub?.trim() ?? "");
    };

    window.addEventListener(IDENTITY_UPDATED_EVENT, handleIdentityUpdated);
    return () => window.removeEventListener(IDENTITY_UPDATED_EVENT, handleIdentityUpdated);
  }, [role]);

  useEffect(() => {
    if (!accountMenuOpen || typeof document === "undefined") {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const wrapper = roleSwitchWrapRef.current;
      const target = event.target;
      if (!wrapper || !(target instanceof Node) || wrapper.contains(target)) {
        return;
      }
      setAccountMenuOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [accountMenuOpen]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    type ButtonSnapshot = {
      ariaExpanded: string;
      ariaPressed: string;
      ariaSelected: string;
      className: string;
      disabled: boolean;
      text: string;
    };

    const pendingSnapshots = new WeakMap<HTMLButtonElement, ButtonSnapshot>();
    const activeReleases = new WeakMap<HTMLButtonElement, () => void>();
    const releaseHandlers = new Set<() => void>();

    const findButton = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return null;
      }
      return target.closest("button") as HTMLButtonElement | null;
    };

    const shouldIgnoreButton = (button: HTMLButtonElement) => (
      button.disabled || button.dataset.pressFeedbackDisabled === "true"
    );

    const snapshotButton = (button: HTMLButtonElement): ButtonSnapshot => ({
      ariaExpanded: button.getAttribute("aria-expanded") ?? "",
      ariaPressed: button.getAttribute("aria-pressed") ?? "",
      ariaSelected: button.getAttribute("aria-selected") ?? "",
      className: button.className,
      disabled: button.disabled,
      text: button.textContent ?? "",
    });

    const snapshotsEqual = (left: ButtonSnapshot, right: ButtonSnapshot) => (
      left.ariaExpanded === right.ariaExpanded &&
      left.ariaPressed === right.ariaPressed &&
      left.ariaSelected === right.ariaSelected &&
      left.className === right.className &&
      left.disabled === right.disabled &&
      left.text === right.text
    );

    const buttonAlreadyResponded = (button: HTMLButtonElement, before: ButtonSnapshot) => (
      !button.isConnected || button.disabled || !snapshotsEqual(before, snapshotButton(button))
    );

    const preventWhileAwaitingFeedback = (event: MouseEvent) => {
      const button = findButton(event);
      if (!button || shouldIgnoreButton(button)) {
        return;
      }
      if (activeReleases.has(button)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      pendingSnapshots.set(button, snapshotButton(button));
    };

    const releaseAll = () => {
      for (const release of [...releaseHandlers]) {
        release();
      }
    };

    const awaitButtonFeedback = (event: MouseEvent) => {
      const button = findButton(event);
      if (!button || shouldIgnoreButton(button) || event.defaultPrevented) {
        return;
      }
      const before = pendingSnapshots.get(button);
      pendingSnapshots.delete(button);
      if (!before || buttonAlreadyResponded(button, before)) {
        return;
      }
      activeReleases.get(button)?.();

      let observer: MutationObserver | null = null;
      const release = () => {
        observer?.disconnect();
        observer = null;
        releaseHandlers.delete(release);
        activeReleases.delete(button);
        if (!button.isConnected) {
          return;
        }
        delete button.dataset.pressFeedbackActive;
        if (button.dataset.pressFeedbackOwnsAriaDisabled === "true") {
          button.removeAttribute("aria-disabled");
        }
        delete button.dataset.pressFeedbackOwnsAriaDisabled;
      };

      activeReleases.set(button, release);
      releaseHandlers.add(release);
      button.dataset.pressFeedbackActive = "true";
      if (!button.hasAttribute("aria-disabled")) {
        button.dataset.pressFeedbackOwnsAriaDisabled = "true";
        button.setAttribute("aria-disabled", "true");
      }

      if (!document.body) {
        release();
        return;
      }
      observer = new MutationObserver(() => {
        release();
      });
      observer.observe(document.body, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    };

    document.addEventListener("click", preventWhileAwaitingFeedback, true);
    document.addEventListener("click", awaitButtonFeedback);
    window.addEventListener(PRESS_FEEDBACK_SETTLED_EVENT, releaseAll);
    window.addEventListener("pagehide", releaseAll);
    document.addEventListener("visibilitychange", releaseAll);
    return () => {
      document.removeEventListener("click", preventWhileAwaitingFeedback, true);
      document.removeEventListener("click", awaitButtonFeedback);
      window.removeEventListener(PRESS_FEEDBACK_SETTLED_EVENT, releaseAll);
      window.removeEventListener("pagehide", releaseAll);
      document.removeEventListener("visibilitychange", releaseAll);
      releaseAll();
    };
  }, []);

  async function preserveLocalIdentityForRoleSwitch(nextRole: SimpleRole) {
    if (role === nextRole || !isSimpleActorRole(role) || !isSimpleActorRole(nextRole)) {
      return;
    }

    try {
      const currentState = await loadSimpleActorState(role);
      if (!currentState?.keypair?.nsec?.trim() || !currentState.keypair.npub.trim()) {
        return;
      }
      const targetState = await loadSimpleActorState(nextRole);
      await saveSimpleActorState({
        role: nextRole,
        keypair: currentState.keypair,
        updatedAt: new Date().toISOString(),
        cache: targetState?.cache,
      });
      setAccountIdentityNpub(currentState.keypair.npub);
    } catch {
      // Locked or unavailable local state should not block role switching.
    }
  }

  const handleRoleSelect = async (nextRole: SimpleRole) => {
    setAccountMenuOpen(false);
    await preserveLocalIdentityForRoleSwitch(nextRole);
    setRole(nextRole);
  };

  useEffect(() => {
    if (showGateway) {
      return;
    }
    writeRoleToUrl(role);
  }, [role, showGateway]);

  const gatewayRoleTitle = useMemo(() => roleLabel(gatewayRole), [gatewayRole]);
  const currentRoleSummary = useMemo(() => (
    isSimpleActorRole(role) ? `${roleLabel(role)} ${accountIdentityLabel}` : roleLabel(role)
  ), [accountIdentityLabel, role]);
  const gatewayContinueLabel = useMemo(() => {
    const hasSignerIdentity = gatewaySignerNpub.trim().length > 0;
    return `${hasSignerIdentity ? "Login" : "Continue"} as ${gatewayRoleTitle}`;
  }, [gatewayRoleTitle, gatewaySignerNpub]);

  async function loginWithSigner() {
    try {
      const signer = createSignerService();
      const rawPubkey = await signer.getPublicKey();
      const npub = rawPubkey.startsWith("npub1") ? rawPubkey : nip19.npubEncode(rawPubkey);
      setGatewaySignerNpub(npub);
      setGatewayStatus(`Signer connected: ${npub}`);
      if (gatewayRole === "voter" && readLinkedQuestionnaireIdFromUrl()) {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY, npub);
        }
        setRole("voter");
        setShowGateway(false);
      }
      return npub;
    } catch (error) {
      if (error instanceof SignerServiceError) {
        setGatewayStatus(error.message);
        return null;
      }
      setGatewayStatus("Signer login failed.");
      return null;
    }
  }

  async function runSignerLogin(options?: { continueAfterLogin?: boolean }) {
    if (preferredSignerIsAmber) {
      setGatewayStatus(AMBER_FULLY_TRUST_HINT);
      const npub = await loginWithSigner();
      if (!npub) {
        await prepareAmberConnectLinks();
        return;
      }
      if (options?.continueAfterLogin) {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY, npub);
        }
        setRole(gatewayRole);
        setShowGateway(false);
      }
      return;
    }
    const npub = await loginWithSigner();
    if (npub && options?.continueAfterLogin) {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY, npub);
      }
      setRole(gatewayRole);
      setShowGateway(false);
    }
  }

  async function continueFromGateway() {
    const trimmedNsec = gatewayNsec.trim();
    if (trimmedNsec && (gatewayRole === "voter" || gatewayRole === "coordinator")) {
      const npub = deriveNpubFromNsec(trimmedNsec);
      if (!npub) {
        setGatewayStatus("Enter a valid nsec before continuing.");
        return;
      }
      await saveSimpleActorState({
        role: gatewayRole,
        keypair: { nsec: trimmedNsec, npub },
        updatedAt: new Date().toISOString(),
      });
      setGatewayStatus(`Loaded ${gatewayRole} identity ${npub}.`);
    }
    if (typeof window !== "undefined") {
      if (gatewaySignerNpub.trim()) {
        window.localStorage.setItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY, gatewaySignerNpub.trim());
      } else {
        window.localStorage.removeItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY);
      }
    }
    setRole(gatewayRole);
    setShowGateway(false);
  }

  async function prepareAmberConnectLinks() {
    try {
      const bundle = await createAmberConnectBundle();
      setGatewayNostrConnectUri(bundle.nostrConnectUri);
      setGatewayNsecBunkerUri(bundle.nsecBunkerUri);
      setGatewayShowConnectQr(true);
      setGatewayStatus("Nostr Connect links ready. Scan the QR or copy a URL.");
    } catch (error) {
      if (error instanceof Error && error.message.trim()) {
        setGatewayStatus(error.message);
        return;
      }
      setGatewayStatus("Could not prepare Nostr Connect links.");
    }
  }

  async function ensureAmberConnectLinks() {
    if (gatewayNostrConnectUri.trim() && gatewayNsecBunkerUri.trim()) {
      return {
        nostrConnectUri: gatewayNostrConnectUri,
        nsecBunkerUri: gatewayNsecBunkerUri,
      };
    }
    const bundle = await createAmberConnectBundle();
    setGatewayNostrConnectUri(bundle.nostrConnectUri);
    setGatewayNsecBunkerUri(bundle.nsecBunkerUri);
    return bundle;
  }

  async function copyGatewayValue(value: string, label: string) {
    if (!value.trim()) {
      return;
    }
    const copied = await tryWriteClipboard(value);
    setGatewayStatus(copied ? `${label} copied.` : `Could not copy ${label.toLowerCase()}.`);
  }

  async function copyPreparedGatewayValue(kind: "nostr-connect" | "nsec-bunker") {
    try {
      const bundle = await ensureAmberConnectLinks();
      const value = kind === "nostr-connect" ? bundle.nostrConnectUri : bundle.nsecBunkerUri;
      await copyGatewayValue(value, kind === "nostr-connect" ? "Nostr Connect URL" : "nsec-bunker URL");
    } catch (error) {
      setGatewayStatus(error instanceof Error && error.message.trim() ? error.message : "Could not prepare Nostr Connect links.");
    }
  }

  if (showGateway) {
    return (
      <div className='simple-app-shell'>
        <section className='simple-login-gateway' aria-label='Login and role selection'>
          <div className='simple-login-brand'>
            <div className='simple-login-brand-mark' aria-hidden='true'>
              <TokenFingerprint tokenId='auditable-voting' compact showQr={false} hideMetadata />
            </div>
            <div className='simple-login-brand-copy'>
              <h1 className='simple-login-title'>Auditable Voting</h1>
            </div>
          </div>

          <label className='simple-voter-label simple-login-role-label'>Select role</label>
          <div className='simple-role-switch simple-role-switch-login' role='tablist' aria-label='Role selection'>
            {ROLE_OPTIONS.map((option) => (
              <button
                key={option.role}
                type='button'
                role='tab'
                aria-selected={gatewayRole === option.role}
                className={`simple-role-switch-button${gatewayRole === option.role ? " is-active" : ""}`}
                data-press-feedback-disabled='true'
                onClick={() => setGatewayRole(option.role)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className='simple-login-actions'>
            <button type='button' className='simple-voter-primary' onClick={() => void continueFromGateway()}>
              {gatewayContinueLabel}
            </button>
          </div>

          <div className='simple-login-existing'>
            <p className='simple-login-existing-title'>Or login using existing profile:</p>
            <div className='simple-login-actions simple-login-existing-actions'>
              <button
                type='button'
                className='simple-voter-secondary'
                onClick={() => void runSignerLogin({ continueAfterLogin: true })}
              >
                {preferredSignerLabel}
              </button>
              <button
                type='button'
                className='simple-voter-secondary'
                aria-expanded={gatewayNsecOpen}
                aria-controls='gateway-nsec-panel'
                onClick={() => {
                  setGatewayNsecOpen((current) => !current);
                  setGatewayAdvancedOpen(false);
                }}
              >
                Enter nsec
              </button>
              <button
                type='button'
                className='simple-voter-secondary'
                aria-expanded={gatewayAdvancedOpen}
                aria-controls='gateway-advanced-panel'
                onClick={() => {
                  setGatewayAdvancedOpen((current) => !current);
                  setGatewayNsecOpen(false);
                }}
              >
                Advanced
              </button>
            </div>
          </div>

          {gatewayNsecOpen ? (
            <section id='gateway-nsec-panel' className='simple-login-panel' aria-label='nsec login'>
              <label className='simple-voter-label' htmlFor='gateway-nsec'>Enter nsec</label>
              <input
                id='gateway-nsec'
                className='simple-voter-input'
                value={gatewayNsec}
                onChange={(event) => setGatewayNsec(event.target.value)}
                placeholder='nsec1...'
                spellCheck={false}
                autoCapitalize='off'
                autoCorrect='off'
              />
              <div className='simple-login-actions'>
                <button type='button' className='simple-voter-primary' onClick={() => void continueFromGateway()}>
                  Continue with nsec
                </button>
              </div>
            </section>
          ) : null}

          {gatewayAdvancedOpen ? (
            <section id='gateway-advanced-panel' className='simple-login-panel' aria-label='Advanced signer options'>
              <div className='simple-login-actions simple-login-advanced-actions'>
                <button
                  type='button'
                  className='simple-voter-secondary'
                  onClick={() => void copyPreparedGatewayValue("nostr-connect")}
                >
                  Copy nostr-connect URL
                </button>
                <button
                  type='button'
                  className='simple-voter-secondary'
                  onClick={() => void copyPreparedGatewayValue("nsec-bunker")}
                >
                  Copy nsec-bunker URL
                </button>
                <button
                  type='button'
                  className='simple-voter-secondary'
                  onClick={() => void prepareAmberConnectLinks()}
                >
                  Show nostr-connect QR
                </button>
              </div>
              {gatewaySignerNpub ? <p className='simple-voter-note'>Signer: {gatewaySignerNpub}</p> : null}
              {gatewayShowConnectQr && gatewayNostrConnectUri.trim() ? (
                <SimpleQrPanel
                  value={gatewayNostrConnectUri}
                  title='Nostr Connect URL'
                  description='Scan in Amber or copy this URL directly.'
                  copyLabel='Copy nostr-connect URL'
                  downloadFilename='nostr-connect-qr.png'
                />
              ) : null}
            </section>
          ) : null}
          {gatewayStatus ? <p className='simple-voter-note'>{gatewayStatus}</p> : null}
        </section>
        <footer className='simple-app-version' aria-label='App version'>
          <span>v{SIMPLE_APP_VERSION}</span>
          <a href='project-explainer.html'>How it works</a>
        </footer>
      </div>
    );
  }

  return (
    <div className='simple-app-shell'>
      <div className='simple-role-switch-wrap' ref={roleSwitchWrapRef}>
        <div className='simple-role-switch-topbar'>
          <div className='simple-account-menu-wrap'>
            <button
              type='button'
              className='simple-role-switch-toggle simple-account-menu-toggle'
              onClick={() => {
                setAccountMenuOpen((current) => !current);
              }}
              aria-haspopup='menu'
              aria-expanded={accountMenuOpen}
              aria-controls='simple-app-menu'
              data-press-feedback-disabled='true'
            >
              Menu
            </button>
            {accountMenuOpen ? (
              <div
                id='simple-app-menu'
                className='simple-account-menu simple-main-menu'
                role='menu'
                aria-label='App menu'
              >
                <div className='simple-account-menu-section' role='none'>
                  <p className='simple-account-menu-kicker'>Role</p>
                  <div
                    className='simple-role-switch simple-role-switch-menu-inline'
                    role='tablist'
                    aria-label='Simple role switch'
                  >
                    {ROLE_OPTIONS.map((option) => (
                      <button
                        key={option.role}
                        type='button'
                        role='tab'
                        aria-selected={role === option.role}
                        className={`simple-role-switch-button${role === option.role ? ' is-active' : ''}`}
                        data-press-feedback-disabled='true'
                        onClick={() => {
                          void handleRoleSelect(option.role);
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                {isSimpleActorRole(role) ? (
                  <>
                    <div className='simple-account-menu-identity' role='none'>
                      <div className='simple-account-menu-identity-actions'>
                        <p className='simple-account-menu-kicker'>Identity</p>
                        <button
                          type='button'
                          className='simple-account-menu-button'
                          role='menuitem'
                          disabled={!accountIdentityNpub}
                          onClick={() => {
                            setAccountMenuOpen(false);
                            void tryWriteClipboard(accountIdentityNpub);
                          }}
                        >
                          Copy identity
                        </button>
                        <button
                          type='button'
                          className='simple-account-menu-button'
                          role='menuitem'
                          onClick={() => {
                            if (
                              typeof window !== "undefined"
                              && !window.confirm("Create a new identity for this role? Your current identity stays in this browser only if you have backed it up.")
                            ) {
                              return;
                            }
                            setAccountMenuOpen(false);
                            if (typeof window !== "undefined") {
                              window.dispatchEvent(new Event(`auditable-voting:${role}-new`));
                            }
                          }}
                        >
                          New identity
                        </button>
                      </div>
                      <div className='simple-account-menu-identity-detail'>
                        <p
                          className='simple-account-menu-title'
                          data-tooltip={accountIdentityNpub ? `Short identity shown here. Full identity: ${accountIdentityNpub}` : undefined}
                        >
                          {accountIdentityLabel}
                        </p>
                        {accountIdentityNpub ? (
                          <div className='simple-account-identity-visuals'>
                            <TokenFingerprint
                              tokenId={accountIdentityNpub}
                              compact
                              showQr
                              hideMetadata
                              qrValue={accountIdentityNpub}
                              fingerprintTitle='Colour ID: a visual fingerprint for checking this identity at a glance.'
                              qrTitle='QR code: scan this to copy the full identity.'
                            />
                            <div className='simple-account-identity-visual-labels' aria-hidden='true'>
                              <span data-tooltip='Colour ID: a visual fingerprint for checking this identity at a glance.'>Colour ID</span>
                              <span data-tooltip='QR code: scan this to copy the full identity.'>QR code</span>
                            </div>
                          </div>
                        ) : (
                          <p className='simple-voter-note simple-account-menu-note'>Identity is loading.</p>
                        )}
                      </div>
                    </div>
                    <div className='simple-account-menu-signout-section' role='none'>
                      <button
                        type='button'
                        className='simple-account-menu-button'
                        role='menuitem'
                        onClick={() => {
                          if (
                            typeof window !== "undefined"
                            && !window.confirm("Sign out and return to the landing page?")
                          ) {
                            return;
                          }
                          setAccountMenuOpen(false);
                          if (typeof window !== "undefined") {
                            window.dispatchEvent(new Event(`auditable-voting:${role}-signout`));
                            returnToLandingPage();
                          }
                        }}
                      >
                        Sign out
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
          <p className='simple-current-role-summary'>{currentRoleSummary}</p>
        </div>
      </div>

      {role === 'voter' ? (
        <SimpleUiApp />
      ) : role === 'coordinator' ? (
        <SimpleCoordinatorApp />
      ) : (
        <SimpleAuditorApp />
      )}
      {role === 'auditor' ? <SimpleRelayPanel /> : null}
      <footer className='simple-app-version' aria-label='App version'>
        <span>v{SIMPLE_APP_VERSION}</span>
        <a href='project-explainer.html'>How it works</a>
      </footer>
    </div>
  );
}
