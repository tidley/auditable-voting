import { useEffect, useMemo, useState } from "react";
import { nip19 } from "nostr-tools";
import SimpleAuditorApp from "./SimpleAuditorApp";
import SimpleCoordinatorApp from "./SimpleCoordinatorApp";
import SimpleRelayPanel from "./SimpleRelayPanel";
import SimpleUiApp from "./SimpleUiApp";
import { SIMPLE_APP_VERSION } from "./simpleAppVersion";
import { createAmberConnectBundle, createSignerService, SignerServiceError } from "./services/signerService";
import { deriveNpubFromNsec } from "./nostrIdentity";
import { saveSimpleActorState } from "./simpleLocalState";
import { tryWriteClipboard } from "./clipboard";
import SimpleQrPanel from "./SimpleQrPanel";

type SimpleRole = "voter" | "coordinator" | "auditor";
const GATEWAY_SIGNER_NPUB_STORAGE_KEY = "app:auditable-voting:gateway:signer_npub";
const AMBER_FULLY_TRUST_HINT = "Change from `Approve basic actions` to `I fully trust this application` when Amber opens. This allows the application to fully coordinate.";
const BUTTON_PRESS_FEEDBACK_MS = 1000;
const ROLE_OPTIONS: Array<{ role: SimpleRole; label: string }> = [
  { role: "auditor", label: "Observer" },
  { role: "coordinator", label: "Coordinator" },
  { role: "voter", label: "Voter" },
];

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

function roleLabel(role: SimpleRole) {
  return ROLE_OPTIONS.find((entry) => entry.role === role)?.label ?? "Observer";
}

function isMobileBrowser() {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || "");
}

export default function SimpleAppShell({ initialRole = "auditor" }: SimpleAppShellProps) {
  const [role, setRole] = useState<SimpleRole>(() => readRoleFromUrl() ?? initialRole);
  const [roleSwitchMinimized, setRoleSwitchMinimized] = useState(true);
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
  const preferredSignerLabel = useMemo(() => (isMobileBrowser() ? "Amber" : "NOS2X-FOX"), []);
  const preferredSignerIsAmber = preferredSignerLabel === "Amber";

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const cooldowns = new WeakMap<HTMLButtonElement, number>();
    const timers = new WeakMap<HTMLButtonElement, number>();

    const findButton = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return null;
      }
      return target.closest("button") as HTMLButtonElement | null;
    };

    const preventDuringCooldown = (event: MouseEvent) => {
      const button = findButton(event);
      if (!button || button.disabled || button.dataset.pressCooldownDisabled === "true") {
        return;
      }
      const cooldownUntil = cooldowns.get(button) ?? 0;
      if (cooldownUntil > Date.now()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    const applyCooldown = (event: MouseEvent) => {
      const button = findButton(event);
      if (!button || button.disabled || button.dataset.pressCooldownDisabled === "true") {
        return;
      }
      cooldowns.set(button, Date.now() + BUTTON_PRESS_FEEDBACK_MS);
      button.dataset.pressCooldownActive = "true";
      button.setAttribute("aria-disabled", "true");
      const existingTimer = timers.get(button);
      if (existingTimer) {
        window.clearTimeout(existingTimer);
      }
      const timer = window.setTimeout(() => {
        cooldowns.delete(button);
        timers.delete(button);
        delete button.dataset.pressCooldownActive;
        button.removeAttribute("aria-disabled");
      }, BUTTON_PRESS_FEEDBACK_MS);
      timers.set(button, timer);
    };

    document.addEventListener("click", preventDuringCooldown, true);
    document.addEventListener("click", applyCooldown);
    return () => {
      document.removeEventListener("click", preventDuringCooldown, true);
      document.removeEventListener("click", applyCooldown);
      // Timers are short-lived; removed listeners prevent new cooldowns after unmount.
    };
  }, []);

  const handleRoleSelect = (nextRole: SimpleRole) => {
    setRole(nextRole);
    setRoleSwitchMinimized(true);
  };

  useEffect(() => {
    if (showGateway) {
      return;
    }
    writeRoleToUrl(role);
  }, [role, showGateway]);

  const roleTitle = useMemo(() => roleLabel(role), [role]);
  const gatewayRoleTitle = useMemo(() => roleLabel(gatewayRole), [gatewayRole]);
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
        setRoleSwitchMinimized(true);
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
          <h1 className='simple-login-title'>Auditable Voting</h1>

          <label className='simple-voter-label'>Select role</label>
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
          <span>{SIMPLE_APP_VERSION}</span>
          <a href='project-explainer.html'>Description</a>
        </footer>
      </div>
    );
  }

  return (
    <div className='simple-app-shell'>
      <div className='simple-role-switch-wrap'>
        <div className='simple-role-switch-topbar'>
          <button
            type='button'
            className='simple-role-switch-toggle'
            onClick={() => setRoleSwitchMinimized((current) => !current)}
            aria-expanded={!roleSwitchMinimized}
            aria-controls='simple-role-switch-panel'
          >
            {roleTitle}
          </button>
          {role === "voter" || role === "coordinator" ? (
            <div className='simple-role-switch-actions'>
              <button
                type='button'
                className='simple-voter-secondary'
                onClick={() => {
                  if (typeof window !== "undefined") {
                    window.dispatchEvent(new Event(`auditable-voting:${role}-login`));
                  }
                }}
              >
                Login
              </button>
              <button
                type='button'
                className='simple-voter-secondary'
                onClick={() => {
                  if (typeof window !== "undefined") {
                    window.dispatchEvent(new Event(`auditable-voting:${role}-signout`));
                  }
                }}
              >
                Sign out
              </button>
              <button
                type='button'
                className='simple-voter-primary'
                onClick={() => {
                  if (typeof window !== "undefined") {
                    window.dispatchEvent(new Event(`auditable-voting:${role}-new`));
                  }
                }}
              >
                New ID
              </button>
            </div>
          ) : null}
        </div>
        {!roleSwitchMinimized ? (
          <div
            id='simple-role-switch-panel'
            className='simple-role-switch'
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
                onClick={() => handleRoleSelect(option.role)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
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
        <span>{SIMPLE_APP_VERSION}</span>
        <a href='project-explainer.html'>Description</a>
      </footer>
    </div>
  );
}
