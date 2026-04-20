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
type GatewayAuthMode = "signer" | "nsec";
type GatewaySignerChoice = "nip07" | "amber";
const GATEWAY_SIGNER_NPUB_STORAGE_KEY = "app:auditable-voting:gateway:signer_npub";

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

export default function SimpleAppShell({ initialRole = "voter" }: SimpleAppShellProps) {
  const [role, setRole] = useState<SimpleRole>(() => readRoleFromUrl() ?? initialRole);
  const [roleSwitchMinimized, setRoleSwitchMinimized] = useState(true);
  const [showGateway, setShowGateway] = useState(() => !hasRoleInUrl() || shouldForceGatewayFromUrl());
  const [gatewayRole, setGatewayRole] = useState<SimpleRole>(initialRole);
  const [gatewayNsec, setGatewayNsec] = useState("");
  const [gatewaySignerNpub, setGatewaySignerNpub] = useState("");
  const [gatewayStatus, setGatewayStatus] = useState<string | null>(null);
  const [gatewayAuthMode, setGatewayAuthMode] = useState<GatewayAuthMode>("signer");
  const [gatewaySignerChoice, setGatewaySignerChoice] = useState<GatewaySignerChoice>("nip07");
  const [gatewayNostrConnectUri, setGatewayNostrConnectUri] = useState("");
  const [gatewayNsecBunkerUri, setGatewayNsecBunkerUri] = useState("");
  const [gatewayShowConnectQr, setGatewayShowConnectQr] = useState(false);

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

  const roleTitle = useMemo(
    () => (
      role === "voter"
        ? "Voter"
        : role === "coordinator"
          ? "Coordinator"
          : "Auditor"
    ),
    [role],
  );

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
    } catch (error) {
      if (error instanceof SignerServiceError) {
        setGatewayStatus(error.message);
        return;
      }
      setGatewayStatus("Signer login failed.");
    }
  }

  async function runSignerLogin() {
    if (gatewaySignerChoice === "amber") {
      await prepareAmberConnectLinks();
      return;
    }
    await loginWithSigner();
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

  async function copyGatewayValue(value: string, label: string) {
    if (!value.trim()) {
      return;
    }
    const copied = await tryWriteClipboard(value);
    setGatewayStatus(copied ? `${label} copied.` : `Could not copy ${label.toLowerCase()}.`);
  }

  if (showGateway) {
    return (
      <div className='simple-app-shell'>
        <section className='simple-login-gateway' aria-label='Login and role selection'>
          <div className='simple-login-mark' aria-hidden='true' />
          <h1 className='simple-login-title'>Auditable Voting</h1>
          <p className='simple-login-subtitle'>Choose a role directly, or login first via signer or nsec.</p>

          <div className='simple-role-switch simple-role-switch-login' role='tablist' aria-label='Authentication method'>
            <button
              type='button'
              role='tab'
              aria-selected={gatewayAuthMode === "signer"}
              className={`simple-role-switch-button${gatewayAuthMode === "signer" ? " is-active" : ""}`}
              onClick={() => setGatewayAuthMode("signer")}
            >
              Signer
            </button>
            <button
              type='button'
              role='tab'
              aria-selected={gatewayAuthMode === "nsec"}
              className={`simple-role-switch-button${gatewayAuthMode === "nsec" ? " is-active" : ""}`}
              onClick={() => setGatewayAuthMode("nsec")}
            >
              nsec
            </button>
          </div>

          {gatewayAuthMode === "signer" ? (
            <section className='simple-voter-section'>
              <label className='simple-voter-label'>Select signer</label>
              <div className='simple-role-switch simple-role-switch-login' role='tablist' aria-label='Signer selection'>
                <button
                  type='button'
                  role='tab'
                  aria-selected={gatewaySignerChoice === "nip07"}
                  className={`simple-role-switch-button${gatewaySignerChoice === "nip07" ? " is-active" : ""}`}
                  onClick={() => setGatewaySignerChoice("nip07")}
                >
                  NIP-07
                </button>
                <button
                  type='button'
                  role='tab'
                  aria-selected={gatewaySignerChoice === "amber"}
                  className={`simple-role-switch-button${gatewaySignerChoice === "amber" ? " is-active" : ""}`}
                  onClick={() => setGatewaySignerChoice("amber")}
                >
                  Amber
                </button>
              </div>
            </section>
          ) : null}

          {gatewayAuthMode === "signer" ? (
            <div className='simple-login-actions'>
              <button type='button' className='simple-voter-secondary' onClick={() => void runSignerLogin()}>
                {gatewaySignerChoice === "amber" ? "Log in with Amber" : "Log in with NIP-07"}
              </button>
            </div>
          ) : null}

          {gatewayAuthMode === "nsec" ? (
            <>
              <label className='simple-voter-label' htmlFor='gateway-nsec'>Login via nsec</label>
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
            </>
          ) : null}

          <div className='simple-login-actions'>
            <button
              type='button'
              className='simple-voter-secondary'
              onClick={() => void copyGatewayValue(gatewayNostrConnectUri, "Nostr Connect URL")}
              disabled={!gatewayNostrConnectUri.trim()}
            >
              Copy Nostr Connect URL
            </button>
            <button
              type='button'
              className='simple-voter-secondary'
              onClick={() => void copyGatewayValue(gatewayNsecBunkerUri, "nsecbunker URL")}
              disabled={!gatewayNsecBunkerUri.trim()}
            >
              Copy nsecbunker URL
            </button>
          </div>
          <div className='simple-login-actions'>
            <button
              type='button'
              className='simple-voter-secondary'
              onClick={() => void prepareAmberConnectLinks()}
            >
              Show Nostr Connect QR
            </button>
          </div>
          {gatewaySignerNpub ? <p className='simple-voter-note'>Signer: {gatewaySignerNpub}</p> : null}
          {gatewayShowConnectQr && gatewayNostrConnectUri.trim() ? (
            <SimpleQrPanel
              value={gatewayNostrConnectUri}
              title='Nostr Connect URL'
              description='Scan in Amber or copy this URL directly.'
              copyLabel='Copy Nostr Connect URL'
              downloadFilename='nostr-connect-qr.png'
            />
          ) : null}
          {gatewayNsecBunkerUri.trim() ? (
            <p className='simple-voter-note'>
              Amber-compatible nsecbunker URL:
              {" "}
              <code>{gatewayNsecBunkerUri}</code>
            </p>
          ) : null}

          <div className='simple-role-switch simple-role-switch-login' role='tablist' aria-label='Role selection'>
            <button
              type='button'
              role='tab'
              aria-selected={gatewayRole === "voter"}
              className={`simple-role-switch-button${gatewayRole === "voter" ? " is-active" : ""}`}
              onClick={() => setGatewayRole("voter")}
            >
              Voter
            </button>
            <button
              type='button'
              role='tab'
              aria-selected={gatewayRole === "coordinator"}
              className={`simple-role-switch-button${gatewayRole === "coordinator" ? " is-active" : ""}`}
              onClick={() => setGatewayRole("coordinator")}
            >
              Coordinator
            </button>
            <button
              type='button'
              role='tab'
              aria-selected={gatewayRole === "auditor"}
              className={`simple-role-switch-button${gatewayRole === "auditor" ? " is-active" : ""}`}
              onClick={() => setGatewayRole("auditor")}
            >
              Auditor
            </button>
          </div>

          <div className='simple-login-actions'>
            <button type='button' className='simple-voter-primary' onClick={() => void continueFromGateway()}>
              Continue as {gatewayRole}
            </button>
          </div>
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
            <button
              type='button'
              role='tab'
              aria-selected={role === 'voter'}
              className={`simple-role-switch-button${role === 'voter' ? ' is-active' : ''}`}
              onClick={() => handleRoleSelect('voter')}
            >
              Voter
            </button>
            <button
              type='button'
              role='tab'
              aria-selected={role === 'coordinator'}
              className={`simple-role-switch-button${role === 'coordinator' ? ' is-active' : ''}`}
              onClick={() => handleRoleSelect('coordinator')}
            >
              Coordinator
            </button>
            <button
              type='button'
              role='tab'
              aria-selected={role === 'auditor'}
              className={`simple-role-switch-button${role === 'auditor' ? ' is-active' : ''}`}
              onClick={() => handleRoleSelect('auditor')}
            >
              Auditor
            </button>
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
