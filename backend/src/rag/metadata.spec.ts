import {
  documentCodeFromFilename,
  extractChunkMetadata,
  extractCostCenter,
  extractDepartment,
  extractEntitlementType,
  extractSectionNumber,
  extractTargetSystem,
  parseDocumentHeader,
  policyDomainFromCode,
} from './metadata';

describe('extractCostCenter', () => {
  it('extracts a cost-center code from backticked policy text', () => {
    expect(
      extractCostCenter('members of `CC-FIN-07` or `CC-FIN-12` may request'),
    ).toBe('CC-FIN-07');
  });

  it('returns null when no cost center is present', () => {
    expect(extractCostCenter('no codes here')).toBeNull();
  });
});

describe('extractTargetSystem', () => {
  it('returns the earliest-mentioned known system', () => {
    expect(
      extractTargetSystem('Access to REPORTING_ENV and DATA_WAREHOUSE'),
    ).toBe('REPORTING_ENV');
  });

  it('returns null when no known system is mentioned', () => {
    expect(extractTargetSystem('generic prose about access')).toBeNull();
  });

  it('does not match systems outside the known list', () => {
    expect(extractTargetSystem('SOME_UNKNOWN_SYSTEM access')).toBeNull();
  });
});

describe('policyDomainFromCode', () => {
  it('derives the domain segment from a policy code', () => {
    expect(policyDomainFromCode('POL-DATA-001')).toBe('DATA');
    expect(policyDomainFromCode('POL-SEC-002')).toBe('SEC');
  });
});

describe('documentCodeFromFilename', () => {
  it('extracts the POL code prefix from a filename', () => {
    expect(
      documentCodeFromFilename(
        'POL-DATA-001_Data_Governance_and_Analytics_Access_Policy.md',
      ),
    ).toBe('POL-DATA-001');
  });
});

describe('parseDocumentHeader', () => {
  const markdown = `# POL-DATA-001: Enterprise Data Governance and Analytics Access Policy

**Document Reference:** POL-DATA-001
**Version:** 3.4.1
**Effective Date:** January 15, 2025

## 1. Overview
`;

  it('parses the title, version, and effective date', () => {
    const header = parseDocumentHeader(markdown);
    expect(header.documentName).toBe(
      'POL-DATA-001: Enterprise Data Governance and Analytics Access Policy',
    );
    expect(header.version).toBe('3.4.1');
    expect(header.effectiveDate?.getUTCFullYear()).toBe(2025);
    expect(header.effectiveDate?.getUTCMonth()).toBe(0); // January
  });

  it('returns nulls for missing version/date without throwing', () => {
    const header = parseDocumentHeader('# Bare Title\n\nBody with no metadata.');
    expect(header.documentName).toBe('Bare Title');
    expect(header.version).toBeNull();
    expect(header.effectiveDate).toBeNull();
  });

  it('parses the pipe-delimited header format extracted from PDFs', () => {
    const pdfMarkdown = [
      '# POL-FIN-003: Financial Systems and Payroll Separation of Duties Policy',
      'Document Reference: POL-FIN-003 | Version: 2.1.0 | Effective Date: January 1, 2025 | Classification: Confidential',
    ].join('\n');
    const header = parseDocumentHeader(pdfMarkdown);
    expect(header.documentName).toContain('POL-FIN-003');
    expect(header.version).toBe('2.1.0');
    expect(header.effectiveDate?.getUTCFullYear()).toBe(2025);
  });
});

describe('extractEntitlementType', () => {
  it('returns the earliest-mentioned known entitlement', () => {
    expect(
      extractEntitlementType('Requests for FIN_DATASET_EDIT and BILLING_EXPORT'),
    ).toBe('FIN_DATASET_EDIT');
  });

  it('returns null when no known entitlement is present', () => {
    expect(extractEntitlementType('generic access prose')).toBeNull();
  });
});

describe('extractDepartment', () => {
  it('derives department from the cost center prefix', () => {
    expect(extractDepartment('members of `CC-ENG-03`')).toBe('Engineering');
    expect(extractDepartment('governance owner in `CC-GOV-01`')).toBe(
      'Data Governance',
    );
  });

  it('returns null when no cost center is present', () => {
    expect(extractDepartment('no cost center here')).toBeNull();
  });
});

describe('extractSectionNumber', () => {
  it('extracts the leading number from a section label', () => {
    expect(extractSectionNumber('3.2 Elevated Write Protocol')).toBe('3.2');
    expect(extractSectionNumber('5. Separation of Duties')).toBe('5');
  });

  it('returns null for a non-numbered label', () => {
    expect(extractSectionNumber('Document Header')).toBeNull();
  });
});

describe('extractChunkMetadata', () => {
  it('assembles every per-chunk metadata field in one pass', () => {
    const meta = extractChunkMetadata(
      '3.2 Elevated Write and Dataset Modification Protocol (FIN_DATASET_EDIT)',
      'Write access to DATA_WAREHOUSE for Finance Analytics (`CC-FIN-07`) via FIN_DATASET_EDIT.',
      'DATA',
    );
    expect(meta).toEqual({
      sectionNumber: '3.2',
      policyDomain: 'DATA',
      department: 'Finance',
      costCenter: 'CC-FIN-07',
      targetSystem: 'DATA_WAREHOUSE',
      entitlementType: 'FIN_DATASET_EDIT',
    });
  });
});
