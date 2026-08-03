import { buildPrecedentCaseFactsText } from './precedent-case-facts';

describe('buildPrecedentCaseFactsText', () => {
  it('produces the same labeled representation for historical and new request facts', () => {
    const facts = {
      requestType: 'GRANT_ENTITLEMENT',
      targetSystem: 'VENDOR_PAYMENTS',
      entitlementKey: 'VENDOR_MASTER_EDIT',
      requesterTitle: 'AP Specialist',
      requesterDepartment: 'Finance Operations',
      requesterCostCenter: 'CC-FIN-12',
      justification: 'Need vendor updates; manager approved.',
    };

    expect(buildPrecedentCaseFactsText(facts)).toBe(
      [
        'Request type: GRANT_ENTITLEMENT',
        'Target system: VENDOR_PAYMENTS',
        'Entitlement: VENDOR_MASTER_EDIT',
        'Requester title: AP Specialist',
        'Requester department: Finance Operations',
        'Requester cost center: CC-FIN-12',
        'Business justification: Need vendor updates; manager approved.',
      ].join('\n'),
    );
    expect(buildPrecedentCaseFactsText({ ...facts })).toBe(
      buildPrecedentCaseFactsText(facts),
    );
  });

  it('normalizes layout whitespace without changing substantive wording', () => {
    expect(
      buildPrecedentCaseFactsText({
        requestType: ' GRANT_ENTITLEMENT ',
        targetSystem: 'VENDOR_PAYMENTS',
        entitlementKey: 'VENDOR_MASTER_EDIT',
        requesterTitle: 'AP   Specialist',
        requesterDepartment: 'Finance\nOperations',
        requesterCostCenter: 'CC-FIN-12',
        justification: 'Need vendor updates.\r\nManager approved.',
      }),
    ).toContain('Requester title: AP Specialist\nRequester department: Finance Operations');
  });
});
