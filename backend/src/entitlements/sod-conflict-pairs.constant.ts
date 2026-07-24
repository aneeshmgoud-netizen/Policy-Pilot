export interface SodConflictPair {
  systemName: string;
  entitlementKeys: [string, string];
  ruleId: string;
  description: string;
}

// Mirrors the explicit "Conflict Rule" clauses in the policy documents.
// Kept as structured config, not inferred by the LLM, because identity
// conflicts like these are exactly the kind of hard compliance rule that
// should never depend on retrieval accuracy — see EntitlementLookupService.
export const SOD_CONFLICT_PAIRS: SodConflictPair[] = [
  {
    systemName: 'DATA_WAREHOUSE',
    entitlementKeys: ['FIN_DATASET_EDIT', 'BILLING_EXPORT'],
    ruleId: 'SoD-DATA-01',
    description:
      'POL-DATA-001 §5.1 — dataset edit and billing export must not be held simultaneously.',
  },
  {
    systemName: 'VENDOR_PAYMENTS',
    entitlementKeys: ['PAYMENT_CREATE', 'PAYMENT_APPROVE'],
    ruleId: 'SoD-FIN-01',
    description:
      'POL-FIN-003 §2.3 — payment creation and payment approval must not be held simultaneously.',
  },
  {
    systemName: 'HR_PAYROLL',
    entitlementKeys: ['PAYROLL_EDIT', 'PAYROLL_APPROVE'],
    ruleId: 'SoD-FIN-02',
    description:
      'POL-FIN-003 §3.3 — payroll edit and payroll approval must not be held simultaneously.',
  },
  {
    systemName: 'DEPLOY_PIPELINE',
    entitlementKeys: ['PROD_DEPLOYER', 'PROD_CHANGE_APPROVER'],
    ruleId: 'SoD-SEC-01',
    description:
      'POL-SEC-002 §4.1 — production deployer and production change approver must not be held simultaneously.',
  },
];
