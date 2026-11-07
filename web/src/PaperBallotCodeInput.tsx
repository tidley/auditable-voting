import { useId, useRef, useState } from 'react';
import { normalisePaperBallotCode } from './paperBallotAdmission';

export default function PaperBallotCodeInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const [error, setError] = useState('');
  const cells = Array.from({ length: 10 }, (_, index) => value[index] === ' ' ? '' : value[index] ?? '');
  const focus = (index: number) => inputs.current[index]?.focus();
  function update(next: string[]) {
    // Spaces preserve empty positions while correcting a partly entered code.
    onChange(next.map(character => character || ' ').join('').trimEnd());
    setError('');
  }
  function write(index: number, raw: string) {
    const text = normalisePaperBallotCode(raw);
    if (!text) {
      if (!raw) { const next = [...cells]; next[index] = ''; update(next); }
      return;
    }
    const start = text.length === 10 ? 0 : index;
    if (!/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]+$/.test(text) || start + text.length > 10) {
      setError('Use the 10 letters and numbers printed on your paper ballot.');
      return;
    }
    const next = [...cells];
    [...text].forEach((character, offset) => { next[start + offset] = character; });
    update(next);
    focus(Math.min(9, start + text.length));
  }
  function renderGroup(start: number) {
    return <div className='simple-paper-code-group'>{cells.slice(start, start + 5).map((character, offset) => {
      const index = start + offset;
      return <input
        key={index}
        ref={node => { inputs.current[index] = node; }}
        type='text'
        className='simple-voter-input simple-paper-code-character'
        aria-label={`Paper code character ${index + 1} of 10`}
        aria-describedby={`${id}-help ${id}-error`}
        aria-invalid={error ? true : undefined}
        value={character}
        maxLength={10}
        autoComplete={index === 0 ? 'one-time-code' : 'off'}
        autoCapitalize='characters'
        spellCheck={false}
        onFocus={event => event.currentTarget.select()}
        onChange={event => write(index, event.target.value)}
        onPaste={event => { event.preventDefault(); write(index, event.clipboardData.getData('text')); }}
        onKeyDown={event => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault(); focus(Math.max(0, Math.min(9, index + (event.key === 'ArrowLeft' ? -1 : 1))));
          } else if (event.key === 'Backspace' || event.key === 'Delete') {
            event.preventDefault();
            const position = event.key === 'Backspace' && !cells[index] ? Math.max(0, index - 1) : index;
            const next = [...cells]; next[position] = ''; update(next); focus(position);
          }
        }}
      />;
    })}</div>;
  }
  return <fieldset className='simple-paper-code-field'>
    <legend>Paper code</legend>
    <div className='simple-paper-code-digits'>
      {renderGroup(0)}<span className='simple-paper-code-separator' aria-hidden='true'>-</span>{renderGroup(5)}
    </div>
    <p id={`${id}-help`} className='simple-voter-note'>10 characters in two groups of five. You can paste the whole code into any box.</p>
    <p id={`${id}-error`} className='simple-voter-note' role='status'>{error}</p>
  </fieldset>;
}
