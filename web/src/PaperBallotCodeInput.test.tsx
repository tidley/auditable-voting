// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PaperBallotCodeInput from './PaperBallotCodeInput';

afterEach(cleanup);
function Harness() {
  const [value, setValue] = useState('');
  return <><PaperBallotCodeInput value={value} onChange={setValue} /><output aria-label='Entered code'>{value}</output><button onClick={() => setValue('')}>Reset</button></>;
}
const cell = (index: number) => screen.getByLabelText(`Paper code character ${index} of 10`) as HTMLInputElement;

it('advances through ten single-character boxes and preserves positions during correction', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.type(cell(1), '7k3m9t2x4r');
  expect(cell(10)).toBe(document.activeElement);
  expect(screen.getByLabelText('Entered code').textContent).toBe('7K3M9T2X4R');
  await user.click(cell(3));
  await user.keyboard('{Backspace}');
  expect(cell(3).value).toBe('');
  expect(cell(4).value).toBe('M');
  await user.keyboard('8');
  expect(cell(3).value).toBe('8');
  expect(cell(4)).toBe(document.activeElement);
  await user.keyboard('{ArrowLeft}{ArrowLeft}');
  expect(cell(2)).toBe(document.activeElement);
  await user.click(screen.getByRole('button', { name: 'Reset' }));
  expect(cell(1).value).toBe('');
});

it('pastes a full grouped code from any box and rejects invalid or overlong input', () => {
  render(<Harness />);
  fireEvent.paste(cell(4), { clipboardData: { getData: () => '7k3m9-t2x4r' } });
  expect(screen.getByLabelText('Entered code').textContent).toBe('7K3M9T2X4R');
  fireEvent.paste(cell(1), { clipboardData: { getData: () => '7K3M9-T2X4RU' } });
  expect(screen.getByText('Use the 10 letters and numbers printed on your paper ballot.')).toBeTruthy();
  expect(cell(1).getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByLabelText('Entered code').textContent).toBe('7K3M9T2X4R');
});
