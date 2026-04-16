import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import SimpleCollapsibleSection from './SimpleCollapsibleSection';

export default function SimpleIdentityPanel({
  npub,
  nsec,
  title = 'Identity',
  onRestoreNsec,
  restoreMessage,
  onDownloadBackup,
  onRestoreBackupFile,
  backupMessage,
  onProtectLocalState,
  onDisableLocalStateProtection,
  localStateProtected = false,
  localStateMessage,
}: {
  npub: string;
  nsec?: string;
  title?: string;
  onRestoreNsec?: (nsec: string) => void;
  restoreMessage?: string | null;
  onDownloadBackup?: (passphrase?: string) => void | Promise<void>;
  onRestoreBackupFile?: (
    file: File,
    passphrase?: string,
  ) => void | Promise<void>;
  backupMessage?: string | null;
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
    <SimpleCollapsibleSection title={title}>
      <div className='simple-identity-grid'>
        <div className='simple-identity-qr-wrap'>
          {qrSrc ? (
            <button
              type='button'
              className='simple-identity-qr-button'
              onClick={() => setQrExpanded(true)}
              aria-label='Expand npub QR code'
            >
              <img
                className='simple-identity-qr'
                src={qrSrc}
                alt='QR code for npub'
              />
            </button>
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
            <button
              type='button'
              className='simple-voter-secondary'
              onClick={copyNpub}
            >
              {copied ? 'Copied' : 'Copy npub'}
            </button>
          </div>
          <div className='simple-identity-field'>
            <div className='simple-identity-label'>Private key</div>
            {hasLocalSecret ? (
              <div className='simple-identity-secret-row'>
                <code className='simple-identity-code'>
                  {showPrivateKey ? nsec : 'Hidden'}
                </code>
                <button
                  type='button'
                  className='simple-voter-secondary'
                  onClick={() => setShowPrivateKey((value) => !value)}
                >
                  {showPrivateKey ? 'Hide' : 'Click to reveal'}
                </button>
              </div>
            ) : (
              <p className='simple-voter-note'>Managed by external signer.</p>
            )}
          </div>
          {onRestoreNsec && hasLocalSecret ? (
            <div className='simple-identity-restore'>
              <div className='simple-identity-label'>Restore from nsec</div>
              <div className='simple-voter-inline-field'>
                <input
                  className='simple-voter-input simple-voter-input-inline'
                  value={restoreNsec}
                  onChange={(event) => setRestoreNsec(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onRestoreNsec(restoreNsec);
                    }
                  }}
                  placeholder='nsec1...'
                  spellCheck={false}
                  autoCapitalize='off'
                  autoCorrect='off'
                />
                <button
                  type='button'
                  className='simple-voter-secondary'
                  onClick={() => onRestoreNsec(restoreNsec)}
                  disabled={!restoreNsec.trim()}
                >
                  Restore identity only
                </button>
              </div>
              {restoreMessage ? (
                <p className='simple-voter-note'>{restoreMessage}</p>
              ) : null}
            </div>
          ) : null}
          {onDownloadBackup || onRestoreBackupFile ? (
            <div className='simple-identity-restore'>
              <div className='simple-identity-label'>Backup</div>
              <input
                className='simple-voter-input'
                value={backupPassphrase}
                onChange={(event) => setBackupPassphrase(event.target.value)}
                placeholder='Optional backup passphrase'
                type='password'
                spellCheck={false}
                autoCapitalize='off'
                autoCorrect='off'
              />
              <div className='simple-voter-inline-field'>
                {onDownloadBackup ? (
                  <button
                    type='button'
                    className='simple-voter-secondary'
                    onClick={() => void onDownloadBackup(backupPassphrase)}
                  >
                    Download backup
                  </button>
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
              <input
                className='simple-voter-input'
                value={backupPassphrase}
                onChange={(event) => setBackupPassphrase(event.target.value)}
                placeholder='Passphrase to lock/unlock local state'
                type='password'
                spellCheck={false}
                autoCapitalize='off'
                autoCorrect='off'
              />
              <div className='simple-voter-inline-field'>
                {onProtectLocalState ? (
                  <button
                    type='button'
                    className='simple-voter-secondary'
                    onClick={() => void onProtectLocalState(backupPassphrase)}
                    disabled={!backupPassphrase.trim()}
                  >
                    {localStateProtected
                      ? 'Update passphrase'
                      : 'Protect local state'}
                  </button>
                ) : null}
                {onDisableLocalStateProtection ? (
                  <button
                    type='button'
                    className='simple-voter-secondary'
                    onClick={() =>
                      void onDisableLocalStateProtection(backupPassphrase)
                    }
                  >
                    Remove protection
                  </button>
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
          <button
            type='button'
            className='simple-identity-qr-overlay-close'
            onClick={() => setQrExpanded(false)}
            aria-label='Close QR preview'
          >
            Close
          </button>
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
