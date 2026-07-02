import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import SimpleCollapsibleSection from './SimpleCollapsibleSection';
import { UiButton, UiTextField } from './ui/DesignLayer';

export default function SimpleIdentityPanel({
  npub,
  nsec,
  title = 'Identity',
  onRestoreNsec,
  onLogin,
  restoreMessage,
  onDownloadBackup,
  onRestoreBackupFile,
  backupMessage,
  backupPassphraseRequired = false,
  onProtectLocalState,
  onDisableLocalStateProtection,
  localStateProtected = false,
  localStateMessage,
}: {
  npub: string;
  nsec?: string;
  title?: string;
  onRestoreNsec?: (nsec: string) => void;
  onLogin?: () => void;
  restoreMessage?: string | null;
  onDownloadBackup?: (passphrase?: string) => void | Promise<void>;
  onRestoreBackupFile?: (
    file: File,
    passphrase?: string,
  ) => void | Promise<void>;
  backupMessage?: string | null;
  backupPassphraseRequired?: boolean;
  onProtectLocalState?: (passphrase: string) => void | Promise<void>;
  onDisableLocalStateProtection?: (passphrase?: string) => void | Promise<void>;
  localStateProtected?: boolean;
  localStateMessage?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const [qrExpanded, setQrExpanded] = useState(false);
  const [restoreNsec, setRestoreNsec] = useState('');
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [showPrivateKey, setShowPrivateKey] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!npub) {
      setQrSrc(null);
      return;
    }

    void QRCode.toDataURL(npub, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 168,
      color: {
        dark: '#0b0c0c',
        light: '#ffffff',
      },
    })
      .then((value: string) => {
        if (!cancelled) {
          setQrSrc(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrSrc(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [npub]);

  useEffect(() => {
    if (!qrExpanded) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setQrExpanded(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [qrExpanded]);

  async function copyNpub() {
    try {
      await navigator.clipboard.writeText(npub);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  const hasLocalSecret = Boolean(nsec && nsec.trim());

  if (!npub) {
    return null;
  }

  return (
    <SimpleCollapsibleSection title={title} hideToggle>
      <div className='simple-identity-grid'>
        <div className='simple-identity-qr-wrap'>
          {qrSrc ? (
            <UiButton
              icon='qr'
              iconOnly
              className='simple-identity-qr-button'
              onPress={() => setQrExpanded(true)}
              aria-label='Expand npub QR code'
            >
              <img
                className='simple-identity-qr'
                src={qrSrc}
                alt='QR code for npub'
              />
            </UiButton>
          ) : (
            <div
              className='simple-identity-qr simple-identity-qr-fallback'
              aria-hidden='true'
            />
          )}
        </div>
        <div className='simple-identity-fields'>
          <div className='simple-identity-field'>
            <div className='simple-identity-label'>Public key</div>
            <code className='simple-identity-code'>{npub}</code>
            <UiButton
              icon={copied ? 'check' : 'copy'}
              className='simple-voter-secondary'
              onPress={copyNpub}
            >
              {copied ? 'Copied' : 'Copy identity'}
            </UiButton>
          </div>
          <div className='simple-identity-field'>
            <div className='simple-identity-label'>Private key</div>
            {hasLocalSecret ? (
              <div className='simple-identity-secret-row'>
                <code className='simple-identity-code'>
                  {showPrivateKey ? nsec : 'Hidden'}
                </code>
                <UiButton
                  icon={showPrivateKey ? 'view' : 'key'}
                  className='simple-voter-secondary'
                  onPress={() => setShowPrivateKey((value) => !value)}
                >
                  {showPrivateKey ? 'Conceal' : 'Click to reveal'}
                </UiButton>
              </div>
            ) : (
              <p className='simple-voter-note'>Managed by external signer.</p>
            )}
          </div>
          {onRestoreNsec && hasLocalSecret ? (
            <div className='simple-identity-restore'>
              <div className='simple-identity-label'>Restore from nsec</div>
              <div className='simple-voter-inline-field'>
                <UiTextField
                  inputClassName='simple-voter-input simple-voter-input-inline'
                  inputProps={{
                    value: restoreNsec,
                    onChange: (event) => setRestoreNsec(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        onRestoreNsec(restoreNsec);
                      }
                    },
                    placeholder: 'nsec1...',
                    spellCheck: false,
                    autoCapitalize: 'off',
                    autoCorrect: 'off',
                  }}
                />
                <UiButton
                  icon='upload'
                  className='simple-voter-secondary'
                  onPress={() => onRestoreNsec(restoreNsec)}
                  isDisabled={!restoreNsec.trim()}
                >
                  Restore identity
                </UiButton>
              </div>
              {restoreMessage ? (
                <p className='simple-voter-note'>{restoreMessage}</p>
              ) : null}
            </div>
          ) : null}
          {onLogin ? (
            <div className='simple-identity-restore'>
              <div className='simple-identity-label'>Login</div>
              <UiButton
                icon='login'
                className='simple-voter-secondary'
                onPress={onLogin}
              >
                Login
              </UiButton>
            </div>
          ) : null}
          {onDownloadBackup || onRestoreBackupFile ? (
            <div className='simple-identity-restore'>
              <div className='simple-identity-label'>Backup</div>
              <UiTextField
                inputClassName='simple-voter-input'
                inputProps={{
                  value: backupPassphrase,
                  onChange: (event) => setBackupPassphrase(event.target.value),
                  placeholder: backupPassphraseRequired ? 'Backup passphrase' : 'Optional backup passphrase',
                  type: 'password',
                  spellCheck: false,
                  autoCapitalize: 'off',
                  autoCorrect: 'off',
                }}
              />
              <div className='simple-voter-inline-field'>
                {onDownloadBackup ? (
                  <UiButton
                    icon='download'
                    className='simple-voter-secondary'
                    onPress={() => void onDownloadBackup(backupPassphrase)}
                    isDisabled={backupPassphraseRequired && !backupPassphrase.trim()}
                  >
                    {backupPassphraseRequired ? 'Download full backup' : 'Download backup'}
                  </UiButton>
                ) : null}
                {onRestoreBackupFile ? (
                  <label className='simple-voter-secondary simple-voter-file-button'>
                    Restore full local state
                    <input
                      className='simple-voter-file-input'
                      type='file'
                      accept='application/json,.json'
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) {
                          void onRestoreBackupFile(file, backupPassphrase);
                        }
                        event.currentTarget.value = '';
                      }}
                    />
                  </label>
                ) : null}
              </div>
              {backupMessage ? (
                <p className='simple-voter-note'>{backupMessage}</p>
              ) : null}
            </div>
          ) : null}
          {onProtectLocalState || onDisableLocalStateProtection ? (
            <div className='simple-identity-restore'>
              <div className='simple-identity-label'>Local state</div>
              <UiTextField
                inputClassName='simple-voter-input'
                inputProps={{
                  value: backupPassphrase,
                  onChange: (event) => setBackupPassphrase(event.target.value),
                  placeholder: 'Passphrase to lock/unlock local state',
                  type: 'password',
                  spellCheck: false,
                  autoCapitalize: 'off',
                  autoCorrect: 'off',
                }}
              />
              <div className='simple-voter-inline-field'>
                {onProtectLocalState ? (
                  <UiButton
                    icon='shield'
                    className='simple-voter-secondary'
                    onPress={() => void onProtectLocalState(backupPassphrase)}
                    isDisabled={!backupPassphrase.trim()}
                  >
                    {localStateProtected
                      ? 'Update passphrase'
                      : 'Protect local state'}
                  </UiButton>
                ) : null}
                {onDisableLocalStateProtection ? (
                  <UiButton
                    icon='delete'
                    className='simple-voter-secondary'
                    onPress={() =>
                      void onDisableLocalStateProtection(backupPassphrase)
                    }
                  >
                    Remove protection
                  </UiButton>
                ) : null}
              </div>
              {localStateMessage ? (
                <p className='simple-voter-note'>{localStateMessage}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {qrExpanded && qrSrc ? (
        <div
          className='simple-identity-qr-overlay'
          role='dialog'
          aria-modal='true'
          aria-label='Expanded npub QR code'
          onClick={() => setQrExpanded(false)}
        >
          <UiButton
            icon='cancel'
            className='simple-identity-qr-overlay-close'
            onPress={() => setQrExpanded(false)}
            aria-label='Close QR preview'
          >
            Close
          </UiButton>
          <div
            className='simple-identity-qr-overlay-card'
            onClick={(event) => event.stopPropagation()}
          >
            <img
              className='simple-identity-qr-overlay-image'
              src={qrSrc}
              alt='Expanded QR code for npub'
            />
          </div>
        </div>
      ) : null}
    </SimpleCollapsibleSection>
  );
}
