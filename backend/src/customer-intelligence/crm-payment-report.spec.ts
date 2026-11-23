import { classifyCrmPaymentText, crmReportedAmount, readCrmPaymentReport } from './crm-payment-report';

describe('reading what a CRM says about payment (a report, never proof)', () => {
  it('Not Paid / Unpaid are unpaid, not "paid"', () => {
    expect(classifyCrmPaymentText('Not Paid').state).toBe('unpaid');
    expect(classifyCrmPaymentText('UNPAID').state).toBe('unpaid');
  });
  it('50% Paid is partially paid with the percentage', () => expect(classifyCrmPaymentText('50% Paid')).toMatchObject({ state: 'partially_paid', percentPaid: 50 }));
  it('Paid is paid', () => expect(classifyCrmPaymentText('Paid').state).toBe('paid'));
  it('"Paid In square" is paid, and Square is only a hint — never proof of a transaction', () =>
    expect(classifyCrmPaymentText('Paid In square')).toMatchObject({ state: 'paid', gatewayHints: ['Square'] }));
  it('"Square" alone says nothing about payment status', () => expect(classifyCrmPaymentText('Square')).toMatchObject({ state: 'unknown', gatewayHints: ['Square'] }));
  it('Remittance is a payment METHOD, never a gateway and never a status', () =>
    expect(classifyCrmPaymentText('Remittance')).toMatchObject({ state: 'unknown', methods: ['Remittance'], gatewayHints: [] }));
  it('other CRM steps say nothing about payment', () => {
    expect(classifyCrmPaymentText('FOLLOW UP 2').state).toBe('unknown');
    expect(classifyCrmPaymentText('CREATED').state).toBe('unknown');
    expect(classifyCrmPaymentText(undefined).state).toBe('unknown');
  });
});

describe('combining several CRM words for one quote', () => {
  it('keeps method, gateway hint and state apart', () => {
    const r = readCrmPaymentReport(['Remittance', '50% Paid', 'Square']);
    expect(r).toMatchObject({ state: 'partially_paid', percentPaid: 50, methods: ['Remittance'], gatewayHints: ['Square'] });
  });
  it('states an amount only when the words state one', () => {
    expect(crmReportedAmount(readCrmPaymentReport(['50% Paid']), 200)).toBe(100);
    expect(crmReportedAmount(readCrmPaymentReport(['Paid']), 200)).toBe(200);
    expect(crmReportedAmount(readCrmPaymentReport(['Remittance']), 200)).toBe(0);
    expect(crmReportedAmount(readCrmPaymentReport(['Not Paid']), 200)).toBe(0);
  });
});
