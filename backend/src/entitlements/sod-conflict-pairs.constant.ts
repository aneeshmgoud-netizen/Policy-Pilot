export interface SodConflictSide {
  systemName: string;
  entitlementKey: string;
}

// Two independent (system, entitlement) sides rather than one shared
// systemName + a key pair, so a conflict rule can span two different
// systems (see SoD-SEC-02) as well as the more common same-system case.
export interface SodConflictPair {
  a: SodConflictSide;
  b: SodConflictSide;
  ruleId: string;
  description: string;
}

// Mirrors the explicit "Conflict Rule" clauses in the policy documents.
// Kept as structured config, not inferred by the LLM, because identity
// conflicts like these are exactly the kind of hard compliance rule that
// should never depend on retrieval accuracy — see EntitlementLookupService.
export const SOD_CONFLICT_PAIRS: SodConflictPair[] = [
  {
    a: { systemName: 'DATA_WAREHOUSE', entitlementKey: 'FIN_DATASET_EDIT' },
    b: { systemName: 'DATA_WAREHOUSE', entitlementKey: 'BILLING_EXPORT' },
    ruleId: 'SoD-DATA-01',
    description:
      'POL-DATA-001 §5.1 — dataset edit and billing export must not be held simultaneously.',
  },
  {
    a: { systemName: 'VENDOR_PAYMENTS', entitlementKey: 'PAYMENT_CREATE' },
    b: { systemName: 'VENDOR_PAYMENTS', entitlementKey: 'PAYMENT_APPROVE' },
    ruleId: 'SoD-FIN-01',
    description:
      'POL-FIN-003 §2.4 — payment creation and payment approval must not be held simultaneously.',
  },
  {
    a: { systemName: 'HR_PAYROLL', entitlementKey: 'PAYROLL_EDIT' },
    b: { systemName: 'HR_PAYROLL', entitlementKey: 'PAYROLL_APPROVE' },
    ruleId: 'SoD-FIN-02',
    description:
      'POL-FIN-003 §3.4 — payroll edit and payroll approval must not be held simultaneously.',
  },
  {
    a: { systemName: 'DEPLOY_PIPELINE', entitlementKey: 'PROD_DEPLOYER' },
    b: { systemName: 'DEPLOY_PIPELINE', entitlementKey: 'PROD_CHANGE_APPROVER' },
    ruleId: 'SoD-SEC-01',
    description:
      'POL-SEC-002 §4.1 — production deployer and production change approver must not be held simultaneously.',
  },
  {
    // Cross-system by design: a developer who can both deploy to production
    // (DEPLOY_PIPELINE) and read production secrets (CLOUD_CONSOLE) can ship
    // a deployment that exfiltrates the very credentials they administer —
    // the pairing that matters here isn't within one system's role model.
    a: { systemName: 'DEPLOY_PIPELINE', entitlementKey: 'PROD_DEPLOYER' },
    b: { systemName: 'CLOUD_CONSOLE', entitlementKey: 'PROD_SECRETS_ADMIN' },
    ruleId: 'SoD-SEC-02',
    description:
      'POL-SEC-002 §4.2 — production deployment execution and production secrets administration must not be held simultaneously.',
  },
  {
    a: { systemName: 'VENDOR_PAYMENTS', entitlementKey: 'VENDOR_MASTER_EDIT' },
    b: { systemName: 'VENDOR_PAYMENTS', entitlementKey: 'PAYMENT_APPROVE' },
    ruleId: 'SoD-FIN-03',
    description:
      'POL-FIN-003 §2.5 — vendor master data modification and payment approval must not be held simultaneously.',
  },
];
