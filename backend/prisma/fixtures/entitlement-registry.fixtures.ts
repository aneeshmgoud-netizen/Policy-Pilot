// Synthetic entitlement_registry seed data.
//
// This is our own design (the assignment gives us the table shape only, not
// sample rows) — see EMP-52190 for the one anchor point that must match the
// assignment's sample access-request payload exactly.
//
// Deliberately shared with the Phase 8 golden-dataset evaluation cases: both
// import from here so the "expected outcome" of an eval case and the
// underlying entitlement facts never drift apart.

export interface EmployeeFixture {
  employeeId: string;
  title: string;
  department: string;
  costCenter: string;
}

export interface EntitlementFixture {
  employeeId: string;
  systemName: string;
  entitlementKey: string;
  grantedDate: string; // ISO date
  isActive: boolean;
  /** Not persisted — documents why this row exists, for readers of this file. */
  note: string;
}

export const EMPLOYEES: EmployeeFixture[] = [
  {
    employeeId: 'EMP-52190',
    title: 'Data Analyst',
    department: 'Finance Analytics',
    costCenter: 'CC-FIN-07',
  },
  {
    employeeId: 'EMP-61304',
    title: 'Senior Financial Analyst',
    department: 'Finance Analytics',
    costCenter: 'CC-FIN-07',
  },
  {
    employeeId: 'EMP-73215',
    title: 'Data Governance Owner',
    department: 'Data Governance',
    costCenter: 'CC-GOV-01',
  },
  {
    employeeId: 'EMP-84402',
    title: 'Billing Operations Analyst',
    department: 'Finance Operations',
    costCenter: 'CC-FIN-12',
  },
  {
    employeeId: 'EMP-90118',
    title: 'Platform Engineer',
    department: 'Engineering',
    costCenter: 'CC-ENG-03',
  },
  {
    employeeId: 'EMP-95527',
    title: 'Site Reliability Engineer',
    department: 'Engineering',
    costCenter: 'CC-ENG-03',
  },
  {
    employeeId: 'EMP-10873',
    title: 'Marketing Coordinator',
    department: 'Marketing',
    costCenter: 'CC-MKT-02',
  },
];

export const ENTITLEMENTS: EntitlementFixture[] = [
  // --- DATA_WAREHOUSE ---
  {
    employeeId: 'EMP-52190',
    systemName: 'DATA_WAREHOUSE',
    entitlementKey: 'FIN_DATASET_READ',
    grantedDate: '2025-11-03',
    isActive: true,
    note: 'PDF sample requester — already has READ, requests EDIT (expected: ESCALATE)',
  },
  {
    employeeId: 'EMP-61304',
    systemName: 'DATA_WAREHOUSE',
    entitlementKey: 'FIN_DATASET_EDIT',
    grantedDate: '2025-04-10',
    isActive: true,
    note: 'Conflict pair 1a — combined with BILLING_EXPORT below, same employee',
  },
  {
    employeeId: 'EMP-61304',
    systemName: 'DATA_WAREHOUSE',
    entitlementKey: 'BILLING_EXPORT',
    grantedDate: '2025-04-10',
    isActive: true,
    note: 'Conflict pair 1b — pre-existing SoD violation with row above (PDF policy example)',
  },
  {
    employeeId: 'EMP-73215',
    systemName: 'DATA_WAREHOUSE',
    entitlementKey: 'FIN_DATASET_EDIT',
    grantedDate: '2025-01-15',
    isActive: true,
    note: 'Governance owner baseline — control case, no conflict',
  },
  {
    employeeId: 'EMP-84402',
    systemName: 'DATA_WAREHOUSE',
    entitlementKey: 'BILLING_EXPORT',
    grantedDate: '2024-08-22',
    isActive: true,
    note: 'Conflict pair 1, request-side test — a future FIN_DATASET_EDIT request from this employee would create the conflict',
  },
  {
    employeeId: 'EMP-10873',
    systemName: 'DATA_WAREHOUSE',
    entitlementKey: 'FIN_DATASET_READ',
    grantedDate: '2025-09-09',
    isActive: true,
    note: 'Cross-department anomaly — Marketing employee holding Finance data access',
  },

  // --- DEPLOY_PIPELINE ---
  {
    employeeId: 'EMP-90118',
    systemName: 'DEPLOY_PIPELINE',
    entitlementKey: 'PROD_DEPLOYER',
    grantedDate: '2025-06-01',
    isActive: true,
    note: 'Conflict pair 2a — combined with PROD_CHANGE_APPROVER below, same employee',
  },
  {
    employeeId: 'EMP-90118',
    systemName: 'DEPLOY_PIPELINE',
    entitlementKey: 'PROD_CHANGE_APPROVER',
    grantedDate: '2025-06-01',
    isActive: true,
    note: 'Conflict pair 2b — pre-existing SoD violation: deployer approving their own deployments',
  },
  {
    employeeId: 'EMP-95527',
    systemName: 'DEPLOY_PIPELINE',
    entitlementKey: 'PROD_DEPLOYER',
    grantedDate: '2024-02-14',
    isActive: false,
    note: 'Revoked — tests that lookups filter on is_active, not just row presence',
  },

  // --- REPORTING_ENV ---
  {
    employeeId: 'EMP-95527',
    systemName: 'REPORTING_ENV',
    entitlementKey: 'RESTRICTED_REPORTING_TEMP',
    grantedDate: '2026-05-01',
    isActive: true,
    note: 'PDF example #3 — temporary/time-boxed restricted reporting access',
  },

  // --- CLOUD_CONSOLE ---
  {
    employeeId: 'EMP-95527',
    systemName: 'CLOUD_CONSOLE',
    entitlementKey: 'INFRA_ADMIN',
    grantedDate: '2025-03-20',
    isActive: true,
    note: 'Plausible baseline — SRE with infra admin access',
  },
  {
    employeeId: 'EMP-10873',
    systemName: 'CLOUD_CONSOLE',
    entitlementKey: 'INFRA_ADMIN',
    grantedDate: '2025-12-01',
    isActive: true,
    note: 'Anomalous — Marketing employee with infra admin access, insufficient-evidence/prohibited case fodder',
  },

  // --- VENDOR_PAYMENTS ---
  {
    employeeId: 'EMP-61304',
    systemName: 'VENDOR_PAYMENTS',
    entitlementKey: 'PAYMENT_CREATE',
    grantedDate: '2025-02-01',
    isActive: true,
    note: 'Conflict pair 3a — combined with PAYMENT_APPROVE below, same employee',
  },
  {
    employeeId: 'EMP-61304',
    systemName: 'VENDOR_PAYMENTS',
    entitlementKey: 'PAYMENT_APPROVE',
    grantedDate: '2025-02-01',
    isActive: true,
    note: 'Conflict pair 3b — pre-existing SoD violation: maker/checker held by the same employee',
  },
  {
    employeeId: 'EMP-84402',
    systemName: 'VENDOR_PAYMENTS',
    entitlementKey: 'PAYMENT_CREATE',
    grantedDate: '2025-05-18',
    isActive: true,
    note: 'Conflict pair 3, split across employees — control case, no conflict',
  },
  {
    employeeId: 'EMP-73215',
    systemName: 'VENDOR_PAYMENTS',
    entitlementKey: 'PAYMENT_APPROVE',
    grantedDate: '2025-05-18',
    isActive: true,
    note: 'Conflict pair 3, other half of the split-employee control case',
  },

  // --- HR_PAYROLL ---
  {
    employeeId: 'EMP-90118',
    systemName: 'HR_PAYROLL',
    entitlementKey: 'PAYROLL_EDIT',
    grantedDate: '2025-07-10',
    isActive: true,
    note: 'Conflict pair 4a — combined with PAYROLL_APPROVE below, same employee',
  },
  {
    employeeId: 'EMP-90118',
    systemName: 'HR_PAYROLL',
    entitlementKey: 'PAYROLL_APPROVE',
    grantedDate: '2025-07-10',
    isActive: true,
    note: 'Conflict pair 4b — pre-existing SoD violation: payroll maker/checker held by the same employee',
  },
  {
    employeeId: 'EMP-84402',
    systemName: 'HR_PAYROLL',
    entitlementKey: 'PAYROLL_EDIT',
    grantedDate: '2025-10-05',
    isActive: true,
    note: 'Conflict pair 4, request-side test — a future PAYROLL_APPROVE request would create the conflict',
  },
];
