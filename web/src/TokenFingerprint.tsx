import { tokenIdLabel, tokenPatternCells } from "./tokenIdentity";

export default function TokenFingerprint({
  tokenId,
  label,
  size = 5,
  compact = false,
}: {
  tokenId: string;
  label?: string;
  size?: number;
  compact?: boolean;
}) {
  const cells = tokenPatternCells(tokenId, size);

  return (
    <div className={`token-fingerprint${compact ? " token-fingerprint-compact" : ""}`}>
      <div
        className="token-fingerprint-grid"
        role="img"
        aria-label={label ?? `Token fingerprint ${tokenIdLabel(tokenId)}`}
        style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
      >
        {cells.map((filled, index) => (
          <span
            key={`${tokenId}-${index}`}
            className={`token-fingerprint-cell${filled ? " is-filled" : ""}`}
          />
        ))}
      </div>
      {!compact && (
        <code className="token-fingerprint-label">{tokenIdLabel(tokenId)}</code>
      )}
    </div>
  );
}
