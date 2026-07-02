import { useState } from "react";
import { UiButton, UiTextField } from "./ui/DesignLayer";

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
        <UiTextField
          inputClassName="simple-voter-input"
          inputProps={{
            type: "password",
            value: passphrase,
            onChange: (event) => setPassphrase(event.target.value),
            placeholder: "Passphrase",
            autoCapitalize: "off",
            autoCorrect: "off",
            spellCheck: false,
          }}
        />
        <div className="simple-voter-inline-field">
          <UiButton
            icon="key"
            className="simple-voter-primary"
            onPress={() => void onUnlock(passphrase)}
            isDisabled={!passphrase.trim()}
          >
            Unlock
          </UiButton>
          {onReset ? (
            <UiButton
              icon="reset"
              className="simple-voter-secondary"
              onPress={() => void onReset()}
            >
              Reset local state
            </UiButton>
          ) : null}
        </div>
        {status ? <p className="simple-voter-note">{status}</p> : null}
      </section>
    </main>
  );
}
