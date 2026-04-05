import { useState } from "react";

export default function SimpleUnlockGate({
  roleLabel,
  status,
  onUnlock,
  onReset,
}: {
  roleLabel: string;
  status?: string | null;
  onUnlock: (passphrase: string) => void | Promise<void>;
  onReset?: () => void | Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState("");

  return (
    <main className="simple-voter-shell">
      <section className="simple-voter-page simple-unlock-panel">
        <h1 className="simple-voter-title">{roleLabel} local state locked</h1>
        <p className="simple-voter-question">
          Enter the passphrase to unlock the encrypted local state on this device.
        </p>
        <input
          className="simple-voter-input"
          type="password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          placeholder="Passphrase"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <div className="simple-voter-inline-field">
          <button
            type="button"
            className="simple-voter-primary"
            onClick={() => void onUnlock(passphrase)}
            disabled={!passphrase.trim()}
          >
            Unlock
          </button>
          {onReset ? (
            <button
              type="button"
              className="simple-voter-secondary"
              onClick={() => void onReset()}
            >
              Reset local state
            </button>
          ) : null}
        </div>
        {status ? <p className="simple-voter-note">{status}</p> : null}
      </section>
    </main>
  );
}
