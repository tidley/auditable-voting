import { useEffect, useMemo, useState } from "react";
import SimpleCoordinatorApp from "./SimpleCoordinatorApp";
import SimpleUiApp from "./SimpleUiApp";

type SimpleRole = "voter" | "coordinator";

type SimpleAppShellProps = {
  initialRole?: SimpleRole;
};

function readRoleFromUrl(): SimpleRole | null {
  if (typeof window === "undefined") {
    return null;
  }

  const role = new URLSearchParams(window.location.search).get("role");
  if (role === "voter" || role === "coordinator") {
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

  useEffect(() => {
    writeRoleToUrl(role);
  }, [role]);

  const roleTitle = useMemo(
    () => (role === "voter" ? "Voter view" : "Coordinator view"),
    [role],
  );

  return (
    <div className="simple-app-shell">
      <div className="simple-role-switch-wrap">
        <div className="simple-role-switch-header">
          <p className="simple-role-switch-kicker">Simple UI</p>
          <h1 className="simple-role-switch-title">{roleTitle}</h1>
        </div>
        <div className="simple-role-switch" role="tablist" aria-label="Simple role switch">
          <button
            type="button"
            role="tab"
            aria-selected={role === "voter"}
            className={`simple-role-switch-button${role === "voter" ? " is-active" : ""}`}
            onClick={() => setRole("voter")}
          >
            Voter
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={role === "coordinator"}
            className={`simple-role-switch-button${role === "coordinator" ? " is-active" : ""}`}
            onClick={() => setRole("coordinator")}
          >
            Coordinator
          </button>
        </div>
      </div>

      {role === "voter" ? <SimpleUiApp /> : <SimpleCoordinatorApp />}
    </div>
  );
}
