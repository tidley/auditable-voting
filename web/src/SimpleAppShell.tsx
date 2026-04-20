import { useEffect, useMemo, useState } from "react";
import { nip19 } from "nostr-tools";
import SimpleAuditorApp from "./SimpleAuditorApp";
import SimpleCoordinatorApp from "./SimpleCoordinatorApp";
import SimpleRelayPanel from "./SimpleRelayPanel";
import SimpleUiApp from "./SimpleUiApp";
import { SIMPLE_APP_VERSION } from "./simpleAppVersion";
import { createSignerService, SignerServiceError } from "./services/signerService";
import { deriveNpubFromNsec } from "./nostrIdentity";
import { saveSimpleActorState } from "./simpleLocalState";

type SimpleRole = "voter" | "coordinator" | "auditor";
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

  if (showGateway) {
    return (
      <div className='simple-app-shell'>
        <section className='simple-login-gateway' aria-label='Login and role selection'>
          <div className='simple-login-mark' aria-hidden='true' />
          <h1 className='simple-login-title'>Auditable Voting</h1>
          <p className='simple-login-subtitle'>Choose a role directly, or login first via signer or nsec.</p>

          <div className='simple-login-actions'>
            <button type='button' className='simple-voter-secondary' onClick={() => void loginWithSigner()}>
              Login via signer
            </button>
          </div>
          {gatewaySignerNpub ? <p className='simple-voter-note'>Signer: {gatewaySignerNpub}</p> : null}

          <label className='simple-voter-label' htmlFor='gateway-nsec'>Login via nsec (optional)</label>
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
          {role === "voter" ? (
            <div className='simple-role-switch-actions'>
              <button
                type='button'
                className='simple-voter-secondary'
                onClick={() => {
                  if (typeof window !== "undefined") {
                    window.dispatchEvent(new Event("auditable-voting:voter-login"));
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
                    window.dispatchEvent(new Event("auditable-voting:voter-signout"));
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
                    window.dispatchEvent(new Event("auditable-voting:voter-new"));
                  }
                }}
              >
                New
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
