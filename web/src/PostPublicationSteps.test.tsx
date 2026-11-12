// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import PostPublicationSteps from './PostPublicationSteps';
afterEach(cleanup);
it('explains the online requirement and offers Guardian and invitation next steps', async () => {
  const guardian = vi.fn(), voters = vi.fn();
  render(<PostPublicationSteps onGuardian={guardian} onVoters={voters} />);
  expect(screen.getByText(/keep this organiser browser open and connected/)).toBeTruthy();
  expect(screen.getByText(/Generating invitations does not send email/)).toBeTruthy();
  expect(screen.getByText(/Email acceptance is not redemption or proof of voting/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Configure / check Guardian' }));
  await userEvent.click(screen.getByRole('button', { name: 'Invite voters and monitor requests' }));
  expect(guardian).toHaveBeenCalledOnce(); expect(voters).toHaveBeenCalledOnce();
});
