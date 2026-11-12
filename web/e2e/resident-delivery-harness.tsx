import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import DeliveryPanel, { type ResidentInvitation } from '../src/otpDelivery/DeliveryPanel';
import { generateQuestionnaireInviteCode, hashQuestionnaireInviteCode } from '../src/questionnaireInviteCode';

function Harness() {
  const [rows, setRows] = useState<ResidentInvitation[]>([]);
  return <main className='simple-voter-shell'><section className='simple-voter-page'>
    <DeliveryPanel electionId='delivery-ui-test' rows={rows} onRowsChange={setRows} lifecycle={{}}
      isRegistered={id => sessionStorage.getItem(`test-invite:${id}`) === 'registered'}
      createInvitation={async () => {
        const code = generateQuestionnaireInviteCode(), id = await hashQuestionnaireInviteCode(code);
        sessionStorage.setItem(`test-invite:${id}`, 'registered');
        return { id, inviteUrl: `https://example.org/vote.html?q=delivery-ui-test#invite_code=${code}` };
      }} />
  </section></main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
