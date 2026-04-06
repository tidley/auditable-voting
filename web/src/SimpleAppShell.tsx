import { useEffect, useMemo, useState } from "react";
import SimpleAuditorApp from "./SimpleAuditorApp";
import SimpleCoordinatorApp from "./SimpleCoordinatorApp";
import SimpleRelayPanel from "./SimpleRelayPanel";
import SimpleUiApp from "./SimpleUiApp";
import { SIMPLE_APP_VERSION } from "./simpleAppVersion";

type SimpleRole = "voter" | "coordinator" | "auditor";

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

function writeRoleToUrl(role: SimpleRole) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("role", role);
  window.history.replaceState({}, "", url.toString());
}

export default function SimpleAppShell({ initialRole = "voter" }: SimpleAppShellProps) {
  const [role, setRole] = useState<SimpleRole>(() => readRoleFromUrl() ?? initialRole);
  const [roleSwitchMinimized, setRoleSwitchMinimized] = useState(false);

  const handleRoleSelect = (nextRole: SimpleRole) => {
    setRole(nextRole);
    setRoleSwitchMinimized(true);
  };

  useEffect(() => {
    writeRoleToUrl(role);
  }, [role]);

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
