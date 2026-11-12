import { UiButton } from './ui/DesignLayer';

export default function PostPublicationSteps({ onGuardian, onVoters }: { onGuardian: () => void; onVoters: () => void }) {
  return <section className='simple-voter-section' aria-label='After Go live'>
    <h2 className='simple-voter-question'>Your questionnaire is live. Next: arrange issuance and invite voters.</h2>
    <ol className='simple-voter-note'>
      <li>Configure and check the Guardian if it will issue credentials while you are away. Without a delegated Guardian, keep this organiser browser open and connected while requests are processed.</li>
      <li>Open Voters to share private invitations or import a resident CSV. Generating invitations does not send email.</li>
      <li>Monitor access requests and blind-credential issuance in Participants. Email acceptance is not redemption or proof of voting.</li>
    </ol>
    <div className='simple-voter-action-row simple-voter-action-row-inline'>
      <UiButton className='simple-voter-secondary' onPress={onGuardian}>Configure / check Guardian</UiButton>
      <UiButton className='simple-voter-secondary' onPress={onVoters}>Invite voters and monitor requests</UiButton>
    </div>
  </section>;
}
