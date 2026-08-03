# POL-STD-004: Enterprise Data Classification and Handling Standard

**Document Reference:** POL-STD-004  
**Version:** 2.3.0  
**Classification:** Internal Corporate Standard  
**Effective Date:** February 1, 2026  
**Review Cycle:** Annual  
**Document Owner:** Global Information Security Office & Data Protection Officer  
**Applies To:** All employees, contractors, system owners, and data custodians handling corporate information assets across all global business units and operational regions.

---

## 1. Purpose, Governance Context, and Regulatory Alignment

This standard establishes the enterprise-wide data classification taxonomy and defines baseline technical handling requirements governing corporate information assets throughout their lifecycle. Proper data classification ensures that sensitive information—including customer financial records, strategic corporate plans, employee personally identifiable information (PII), proprietary source code, and transactional ledgers—is safeguarded by technical controls commensurate with its sensitivity level during creation, processing, storage, transmission, and disposal.

In accordance with international security standards (including ISO/IEC 27001:2022 Control A.8.12, NIST SP 800-53 Revision 5 Media Protection family MP-1 through MP-8, and SOC 2 Type II Confidentiality criteria), this document provides mandatory technical protection criteria (such as cryptographic standards, key management policies, data retention schedules, and media sanitization protocols) referenced by primary access control policies.

**Contextual Application Note:** This standard establishes technical data handling obligations, storage security controls, and sensitivity tier classifications. IT administrators and governance systems should reference this document to establish baseline handling specifications for corporate data assets across all operational environments.

---

## 2. Data Classification Taxonomy and Sensitivity Tiers

Corporate information assets are categorized into four distinct classification tiers based on the potential financial, legal, operational, and reputational impact to the enterprise resulting from unauthorized disclosure, unauthorized modification, or loss of availability.

### 2.1 Tier 1: Public Information
* **Definition:** Information created for public dissemination or previously approved for external publication by Corporate Communications.
* **Examples:** Marketing brochures, public investor relations releases, published product documentation, open job postings, public website content.
* **Handling Controls:** No encryption required during transmission; public web hosting permitted following standard marketing review; integrity verification recommended.

### 2.2 Tier 2: Internal Information
* **Definition:** Routine operational data intended exclusively for internal enterprise use. Unauthorized disclosure would cause minor operational inconvenience but low financial or legal impact.
* **Examples:** Internal employee directories, general corporate announcements, internal wiki pages, non-sensitive operational procedures, department meeting notes.
* **Handling Controls:** Standard logical network boundary protection required; internal single sign-on (SSO) authentication mandatory; unencrypted external emailing prohibited.

### 2.3 Tier 3: Confidential Information
* **Definition:** Sensitive business data created during routine commercial operations. Unauthorized disclosure could cause moderate financial loss, competitive disadvantage, or legal friction.
* **Examples:** Draft financial performance summaries, de-identified/aggregate customer transaction statistics (`CUSTOMER_METADATA_READ`), department budget plans, vendor contracts, internal audit reports, engineering architectural blueprints.
* **Handling Controls:** Mandatory AES-256 bit encryption at rest; TLS 1.3 encryption in transit; access restricted strictly to authenticated internal staff with documented business necessity; watermark enforcement on exported PDF views.

### 2.4 Tier 4: Restricted Information
* **Definition:** Highly sensitive information subject to strict legal, statutory, or contractual protection. Unauthorized disclosure would cause severe financial loss, regulatory fines, executive liability, or catastrophic reputational damage.
* **Examples:** Payment card cardholder data (PCI-DSS), directly identifying customer records including names, account numbers, and government identifiers (`CUSTOMER_PII_READ`), unannounced financial earnings figures, bulk billing transaction exports, employee payroll master ledgers, sensitive analytics datasets, production secrets and infrastructure master encryption keys (`PROD_SECRETS_ADMIN`).
* **Handling Controls:** Mandatory column-level database encryption; mandatory multi-factor authentication for data access; continuous real-time audit logging; mandatory approval by designated Data Custodians prior to any bulk data movement or analytical schema transfer.

**Note on `CUSTOMER_PII_READ` vs. `CUSTOMER_METADATA_READ`:** these two entitlements govern the same underlying `DATA_WAREHOUSE` customer dataset at two different classification tiers, not two different systems. The determining factor is whether the data can be traced back to an individual customer (Tier 4, `CUSTOMER_PII_READ`) or has been aggregated/de-identified (Tier 3, `CUSTOMER_METADATA_READ`) — see `POL-DATA-001` Section 3.5 for the corresponding entitlement eligibility and approval rules.

---

## 3. Technical Protection and Data Lifecycle Controls

### 3.1 Cryptographic Baseline Standards
* **Data at Rest:** All databases, file servers, cloud object storage buckets, and relational instances storing Confidential (Tier 3) or Restricted (Tier 4) information must enforce AES-256 bit encryption using enterprise-managed keys managed within hardware security modules (HSM) and rotated annually.
* **Data in Transit:** All network communications transferring internal or restricted datasets across public or private networks must enforce TLS 1.3 protocols with approved strong cipher suites. Legacy SSL protocols and TLS versions prior to 1.2 are strictly decommissioned.

### 3.2 Storage, Retention, and Local Transfer Prohibitions
* **Analytical Repositories:** Data stored within central data warehouses, data lakes, or reporting environments must adhere strictly to corporate data retention schedules. Restricted financial records must be retained for seven (7) years to satisfy statutory tax and accounting mandates before secure cryptographic erasure.
* **Local Storage Prohibition:** Exporting or saving Restricted (Tier 4) data—specifically including financial transaction ledgers, billing exports, or payroll master records—to unencrypted local workstation drives, personal mobile devices, removable USB drives, or unauthorized third-party cloud storage services is strictly prohibited and constitutes a major security incident.

### 3.3 Media Sanitization and Disposal Protocols
Physical hard drives, server storage arrays, and decommissioned storage media containing corporate data must undergo degaussing or physical destruction in compliance with NIST SP 800-88 Revision 1 guidelines prior to equipment disposal or vendor return.

---

## 4. Relationship to Logical Access Provisioning Policies

This standard operates alongside enterprise logical access control policies by providing the foundational data classification labels applied to corporate repositories and analytical datasets.

While this document governs technical handling safeguards (including encryption baselines, retention schedules, and Data Custodian sign-offs for bulk Tier 4 transfers), specific identity entitlement eligibility, role provisioning workflows, and separation-of-duties rules for application access keys (such as `FIN_DATASET_EDIT`, `PROD_DEPLOYER`, `PAYMENT_CREATE`, `INFRA_ADMIN`, `PROD_SECRETS_ADMIN`, `PAYROLL_EDIT`, `RESTRICTED_REPORTING_TEMP`, `CUSTOMER_PII_READ`, or `CUSTOMER_METADATA_READ`) are detailed within primary domain policies:
- `POL-DATA-001`: Governs Data Warehouse and Reporting Environment access rules.
- `POL-SEC-002`: Governs Cloud Console and Deployment Pipeline security controls.
- `POL-FIN-003`: Governs Vendor Payments and HR Payroll Separation of Duties.
- `POL-GOV-000`: Defines overall enterprise IAM governance principles and lifecycle frameworks.

---

## 5. Standard Revision History

| Version | Date | Author / Title | Summary of Changes |
| :--- | :--- | :--- | :--- |
| 1.0.0 | 2021-06-15 | Information Security Office | Initial release of enterprise data classification standard. |
| 2.0.0 | 2023-01-20 | Data Protection Officer | Updated encryption baselines to AES-256 and TLS 1.3 protocols. |
| 2.2.0 | 2024-10-01 | Global Security Council | Added Tier 4 Restricted handling rules for financial analytics datasets. |
| 2.3.0 | 2026-02-01 | Global Security Council | Classified `CUSTOMER_PII_READ` (Tier 4) vs. `CUSTOMER_METADATA_READ` (Tier 3) and `PROD_SECRETS_ADMIN` (Tier 4); updated domain-policy cross-reference list. |
