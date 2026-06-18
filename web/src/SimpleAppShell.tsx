import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nip19 } from "nostr-tools";
import QRCode from "qrcode";
import SimpleAuditorApp from "./SimpleAuditorApp";
import SimpleCoordinatorApp from "./SimpleCoordinatorApp";
import SimpleRelayPanel from "./SimpleRelayPanel";
import SimpleUiApp, { type VoterTab } from "./SimpleUiApp";
import { SIMPLE_APP_VERSION } from "./simpleAppVersion";
import { createAmberConnectBundle, createSignerService, SignerServiceError } from "./services/signerService";
import { deriveNpubFromNsec } from "./nostrIdentity";
import { loadSimpleActorState, saveSimpleActorState, type SimpleActorRole } from "./simpleLocalState";
import { tryWriteClipboard } from "./clipboard";
import SimpleQrPanel from "./SimpleQrPanel";
import TokenFingerprint from "./TokenFingerprint";
import { deriveActorDisplayId } from "./actorDisplay";

type SimpleRole = "voter" | "coordinator" | "auditor";
const GATEWAY_SIGNER_NPUB_STORAGE_KEY = "app:auditable-voting:gateway:signer_npub";
const AMBER_FULLY_TRUST_HINT = "Change from `Approve basic actions` to `I fully trust this application` when Amber opens. This allows the application to fully coordinate.";
const ROLE_OPTIONS: Array<{ role: SimpleRole; label: string }> = [
  { role: "auditor", label: "Observer" },
  { role: "coordinator", label: "Organiser" },
  { role: "voter", label: "Voter" },
];
const VOTER_SECTION_OPTIONS: Array<{ tab: VoterTab; label: string; icon: string }> = [
  { tab: "configure", label: "Join", icon: "join" },
  { tab: "vote", label: "Vote", icon: "vote" },
  { tab: "messages", label: "Messages", icon: "messages" },
  { tab: "settings", label: "Settings", icon: "settings" },
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
  const [voterTab, setVoterTab] = useState<VoterTab>(() => (readLinkedQuestionnaireIdFromUrl() ? "vote" : "configure"));
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [voterMessagesUnread, setVoterMessagesUnread] = useState(false);
  const [accountIdentityNpub, setAccountIdentityNpub] = useState("");
  const [accountIdentityDialogOpen, setAccountIdentityDialogOpen] = useState(false);
  const [accountIdentityQrSrc, setAccountIdentityQrSrc] = useState<string | null>(null);
  const [newIdentityConfirmRole, setNewIdentityConfirmRole] = useState<SimpleActorRole | null>(null);
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
  const accountMenuButtonLabel = role === "coordinator"
    ? accountIdentityNpub
      ? `Open organiser profile menu for ${accountIdentityLabel}`
      : "Open organiser profile menu"
    : role === "voter"
      ? accountIdentityNpub
        ? `Open voter profile menu for Voter ${accountIdentityLabel}${voterMessagesUnread ? ", new message" : ""}`
        : `Open voter profile menu${voterMessagesUnread ? ", new message" : ""}`
      : "Menu";

  useEffect(() => {
    if (role !== "voter") {
      setVoterMessagesUnread(false);
    }
  }, [role]);

  useEffect(() => {
    if (role !== "voter" && role !== "coordinator") {
      setAccountIdentityNpub("");
      setAccountIdentityDialogOpen(false);
      setNewIdentityConfirmRole(null);
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
        const loadedNpub = state?.keypair?.npub?.trim() || persistedSignerNpub;
        setAccountIdentityNpub((current) => loadedNpub || current);
      })
      .catch(() => {
        if (!cancelled) {
          setAccountIdentityNpub((current) => persistedSignerNpub || current);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [role]);

  useEffect(() => {
    if (!accountIdentityDialogOpen || !accountIdentityNpub.trim()) {
      setAccountIdentityQrSrc(null);
      return;
    }

    let cancelled = false;
    void QRCode.toDataURL(accountIdentityNpub, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 432,
      color: {
        dark: "#0b0c0c",
        light: "#ffffff",
      },
    }).then((value: string) => {
      if (!cancelled) {
        setAccountIdentityQrSrc(value);
      }
    }).catch(() => {
      if (!cancelled) {
        setAccountIdentityQrSrc(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [accountIdentityDialogOpen, accountIdentityNpub]);

  useEffect(() => {
    if (!accountIdentityDialogOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAccountIdentityDialogOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [accountIdentityDialogOpen]);

  useEffect(() => {
    if (!newIdentityConfirmRole) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNewIdentityConfirmRole(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [newIdentityConfirmRole]);

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

  const handleVoterIdentityChange = useCallback((npub: string) => {
    setAccountIdentityNpub(npub.trim());
  }, []);

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
  const newIdentityConfirmLabel = newIdentityConfirmRole ? roleLabel(newIdentityConfirmRole) : "";
  const newIdentityConfirmShortId = newIdentityConfirmRole === role && accountIdentityNpub
    ? deriveActorDisplayId(accountIdentityNpub)
    : "";
  const gatewayContinueLabel = useMemo(() => {
    const hasSignerIdentity = gatewaySignerNpub.trim().length > 0;
    return `${hasSignerIdentity ? "Login" : "Continue"} as ${gatewayRoleTitle}`;
  }, [gatewayRoleTitle, gatewaySignerNpub]);

  function confirmNewIdentity() {
    if (!newIdentityConfirmRole || typeof window === "undefined") {
      return;
    }
    const targetRole = newIdentityConfirmRole;
    setNewIdentityConfirmRole(null);
    setAccountMenuOpen(false);
    window.dispatchEvent(new Event(`auditable-voting:${targetRole}-new`));
  }

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
          <a href='project-explainer.html' target='_blank' rel='noopener noreferrer'>How it works</a>
        </footer>
      </div>
    );
  }

  const accountMenuControl = (
    <div className='simple-account-menu-wrap' ref={roleSwitchWrapRef}>
      <button
        type='button'
        className={`simple-role-switch-toggle simple-account-menu-toggle${role === "coordinator" ? " simple-account-profile-toggle" : ""}${role === "voter" && voterMessagesUnread ? " has-unread-message is-breathing" : ""}`}
        onClick={() => {
          setAccountMenuOpen((current) => !current);
        }}
        aria-haspopup='menu'
        aria-expanded={accountMenuOpen}
        aria-controls='simple-app-menu'
        aria-label={accountMenuButtonLabel}
      >
        {role === "coordinator" ? (
          <>
            <span className='simple-account-profile-copy'>
              <span className='simple-account-menu-kicker'>Organiser</span>
              <span className='simple-account-profile-title'>{accountIdentityLabel}</span>
              <span className='simple-account-profile-npub' title={accountIdentityNpub || undefined}>
                {accountIdentityNpub || "Identity loading"}
              </span>
            </span>
            <span className='simple-account-profile-caret' aria-hidden='true' />
          </>
        ) : role === "voter" ? (
          `Voter ${accountIdentityLabel}`
        ) : (
          "Menu"
        )}
      </button>
      {accountMenuOpen ? (
        <div
          id='simple-app-menu'
          className='simple-account-menu simple-main-menu'
          role='menu'
          aria-label='App menu'
        >
          <div className='simple-account-menu-section' role='none'>
            <p className='simple-account-menu-kicker'>Switch</p>
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
                  onClick={() => {
                    void handleRoleSelect(option.role);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          {role === "voter" ? (
            <div className='simple-account-menu-section simple-account-menu-section-nav' role='none'>
              <p className='simple-account-menu-kicker'>Voter</p>
              <div
                className='simple-role-switch simple-role-switch-menu-inline simple-voter-menu-switch'
                role='tablist'
                aria-label='Voter sections'
              >
                {VOTER_SECTION_OPTIONS.map((option) => (
                  <button
                    key={option.tab}
                    type='button'
                    role='tab'
                    aria-selected={voterTab === option.tab}
                    className={`simple-role-switch-button${voterTab === option.tab ? ' is-active' : ''}${option.tab === "messages" && voterMessagesUnread ? ' has-unread-message' : ''}`}
                    onClick={() => {
                      setVoterTab(option.tab);
                      if (option.tab === "messages") {
                        setVoterMessagesUnread(false);
                      }
                      setAccountMenuOpen(false);
                    }}
                  >
                    <span className={`simple-menu-tab-icon simple-menu-tab-icon-${option.icon}`} aria-hidden='true'>
                      {option.tab === "messages" && voterMessagesUnread ? <span className='simple-message-unread-dot' /> : null}
                    </span>
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {isSimpleActorRole(role) ? (
            <>
              <div className='simple-account-menu-identity' role='none'>
                <div className='simple-account-menu-identity-actions'>
                  <p className='simple-account-menu-kicker'>Identity</p>
                  {role === "voter" ? (
                    <button
                      type='button'
                      className='simple-account-menu-button simple-account-menu-action'
                      role='menuitem'
                      onClick={() => {
                        setAccountMenuOpen(false);
                        if (typeof window !== "undefined") {
                          window.dispatchEvent(new Event("auditable-voting:voter-login"));
                        }
                      }}
                    >
                      <span>Login</span>
                    </button>
                  ) : null}
                  <button
                    type='button'
                    className='simple-account-menu-button simple-account-menu-action'
                    role='menuitem'
                    disabled={!accountIdentityNpub}
                    onClick={() => {
                      setAccountMenuOpen(false);
                      void tryWriteClipboard(accountIdentityNpub);
                    }}
                  >
                    <span>Copy identity</span>
                  </button>
                  <button
                    type='button'
                    className='simple-account-menu-button simple-account-menu-action'
                    role='menuitem'
                    onClick={() => {
                      setAccountMenuOpen(false);
                      setNewIdentityConfirmRole(role);
                    }}
                  >
                    <span>New identity</span>
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
                  className='simple-account-menu-button simple-account-menu-action simple-account-menu-signout-button'
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
                  <span>Sign out</span>
                </button>
              </div>
            </>
          ) : null}
          <div className='simple-account-menu-section simple-account-menu-about-section' role='none'>
            <p className='simple-account-menu-kicker'>About</p>
            <div className='simple-account-menu-about-row' role='none'>
              <a
                className='simple-account-menu-button simple-account-menu-link'
                role='menuitem'
                href='project-explainer.html'
                target='_blank'
                rel='noopener noreferrer'
                onClick={() => setAccountMenuOpen(false)}
              >
                How it works
              </a>
              <a
                className='simple-account-menu-button simple-account-menu-link'
                role='menuitem'
                href='demo-guide.html'
                target='_blank'
                rel='noopener noreferrer'
                onClick={() => setAccountMenuOpen(false)}
              >
                Demo guide
              </a>
              <p className='simple-account-menu-version'>v{SIMPLE_APP_VERSION}</p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className={`simple-app-shell${role === "coordinator" ? " simple-app-shell-coordinator" : ""}`}>
      {role === "coordinator" ? null : (
        <div className='simple-role-switch-wrap'>
          <div className='simple-role-switch-topbar'>
            {accountMenuControl}
            {role === "voter" ? null : isSimpleActorRole(role) && accountIdentityNpub ? (
              <button
                type='button'
                className='simple-role-switch-toggle simple-current-role-summary simple-current-role-button'
                onClick={() => setAccountIdentityDialogOpen(true)}
                aria-haspopup='dialog'
                aria-label={`Show full ${roleLabel(role).toLowerCase()} npub QR`}
              >
                {currentRoleSummary}
              </button>
            ) : (
              <p className='simple-current-role-summary'>{currentRoleSummary}</p>
            )}
          </div>
        </div>
      )}

      {role === 'voter' ? (
        <SimpleUiApp
          activeTab={voterTab}
          onActiveTabChange={setVoterTab}
          onIdentityChange={handleVoterIdentityChange}
          onUnreadMessagesChange={setVoterMessagesUnread}
          showSectionTabs={false}
        />
      ) : role === 'coordinator' ? (
        <SimpleCoordinatorApp accountMenu={accountMenuControl} />
      ) : (
        <SimpleAuditorApp />
      )}
      {role === 'auditor' ? <SimpleRelayPanel /> : null}
      {accountIdentityDialogOpen && accountIdentityNpub ? (
        <div
          className='simple-identity-qr-overlay simple-account-identity-overlay'
          role='dialog'
          aria-modal='true'
          aria-label={`${roleLabel(role)} npub QR code`}
          onClick={() => setAccountIdentityDialogOpen(false)}
        >
          <button
            type='button'
            className='simple-identity-qr-overlay-close'
            onClick={() => setAccountIdentityDialogOpen(false)}
            aria-label='Close npub QR preview'
          >
            Close
          </button>
          <div
            className='simple-identity-qr-overlay-card simple-account-identity-overlay-card'
            onClick={(event) => event.stopPropagation()}
          >
            <div className='simple-account-identity-overlay-copy'>
              <p className='simple-account-menu-kicker'>{roleLabel(role)} identity</p>
              <h2 className='simple-voter-section-title'>{currentRoleSummary}</h2>
              <code className='simple-account-identity-full-npub'>{accountIdentityNpub}</code>
            </div>
            {accountIdentityQrSrc ? (
              <img
                className='simple-identity-qr-overlay-image simple-account-identity-overlay-image'
                src={accountIdentityQrSrc}
                alt={`QR code for ${roleLabel(role)} npub`}
              />
            ) : (
              <div
                className='simple-identity-qr-overlay-image simple-account-identity-overlay-image simple-identity-qr-fallback'
                aria-hidden='true'
              />
            )}
          </div>
        </div>
      ) : null}
      {newIdentityConfirmRole ? (
        <div
          className='simple-identity-qr-overlay simple-new-identity-confirm-overlay'
          role='dialog'
          aria-modal='true'
          aria-labelledby='new-identity-confirm-title'
          aria-describedby='new-identity-confirm-description'
          onClick={() => setNewIdentityConfirmRole(null)}
        >
          <button
            type='button'
            className='simple-identity-qr-overlay-close simple-new-identity-confirm-close'
            onClick={() => setNewIdentityConfirmRole(null)}
            aria-label='Cancel new identity'
          >
            <span aria-hidden='true'>×</span>
          </button>
          <div
            className='simple-identity-qr-overlay-card simple-new-identity-confirm-card'
            onClick={(event) => event.stopPropagation()}
          >
            <div className='simple-new-identity-confirm-mark' aria-hidden='true'>
              <span />
            </div>
            <div className='simple-new-identity-confirm-copy'>
              <p className='simple-account-menu-kicker'>New {newIdentityConfirmLabel} identity</p>
              <h2 id='new-identity-confirm-title' className='simple-voter-section-title'>Are you sure?</h2>
              <p id='new-identity-confirm-description' className='simple-voter-note'>
                Make sure you have backed up this profile if you intend to use it again.
              </p>
              {newIdentityConfirmShortId ? (
                <p className='simple-new-identity-confirm-current'>
                  Current profile <strong>{newIdentityConfirmShortId}</strong>
                </p>
              ) : null}
              <div className='simple-new-identity-confirm-warning'>
                <span className='simple-new-identity-confirm-warning-icon' aria-hidden='true'>i</span>
                <div>
                  <p>This action cannot be undone.</p>
                  <span>Creating a new identity replaces the current local profile for this role.</span>
                </div>
              </div>
            </div>
            <div className='simple-new-identity-confirm-actions'>
              <button
                type='button'
                className='simple-voter-secondary'
                onClick={() => setNewIdentityConfirmRole(null)}
              >
                Cancel
              </button>
              <button
                type='button'
                className='simple-voter-primary simple-new-identity-confirm-primary'
                onClick={confirmNewIdentity}
              >
                Create new identity
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
