# POL-SEC-002: Infrastructure and Deployment Least Privilege Security Policy

**Document Reference:** POL-SEC-002  
**Version:** 4.4.0  
**Classification:** Confidential - Internal IT & Engineering Standard  
**Effective Date:** February 1, 2026  
**Review Cycle:** Annual  
**Document Owner:** Global Infrastructure Security Committee & VP of Platform Engineering  
**Applies To:** All Software Engineers, Systems Administrators, Site Reliability Engineers, DevOps Personnel, Cloud Operations Staff, Security Engineering Personnel, and Technical Contractors across all deployment zones.

---

## 1. Purpose, Vision, and Regulatory Scope

As an enterprise hosting critical digital services and financial transaction pipelines, maintaining the operational integrity, confidentiality, and availability of production cloud environments is a foundational requirement. Unauthorized modifications to production infrastructure, unreviewed code deployments, or administrative privilege escalation expose the organization to severe service outages, data breaches, regulatory penalties under SOC 2 Type II (Common Criteria 6.1, 6.3, and 8.1), and breach of contract obligations.

This policy establishes technical and administrative least-privilege standards governing access to enterprise Cloud Infrastructure Consoles (`CLOUD_CONSOLE`) and Automated Production Deployment Pipelines (`DEPLOY_PIPELINE`). It defines the boundaries between software development, release authorization, and production execution, mandating strict separation of duties and cost-center-aligned role permissions.

---

## 2. Infrastructure Governance and Account Architecture

### 2.1 Cloud Environment Partitioning
The enterprise cloud architecture is strictly partitioned into distinct logical environments: Sandbox, Development, Staging, and Production. Access controls increase in stringency as workloads move toward Production. Standing administrative credentials in Production cloud management planes are prohibited under standard operating conditions.

### 2.2 Operational Roles and Responsibilities
Security oversight of infrastructure and deployment execution is divided among the following technical bodies:

1. **Global Infrastructure Security Committee:** Responsible for establishing baseline cloud security configurations, reviewing high-risk role definitions, and authorizing emergency break-glass protocols.
2. **Platform Engineering Leadership:** Engineering managers and directors within the Engineering department (Cost Center `CC-ENG-03`) responsible for overseeing release pipeline integrity and validating technical personnel capabilities.
3. **Change Advisory Board (CAB):** Multi-disciplinary panel responsible for evaluating production release risk, verifying change ticket documentation, and issuing release authorization keys.
4. **Site Reliability Engineering (SRE) Operations Group:** Specialist engineering personnel within `CC-ENG-03` charged with maintaining cloud console stability, infrastructure-as-code automation, and emergency incident mitigation.

---

## 3. Production Deployment Pipeline Access Protocols (`DEPLOY_PIPELINE`)

Automated deployment tools and continuous integration/continuous deployment (CI/CD) pipelines represent the primary vector through which software updates transition into live customer-facing systems. Access to deployment execution environments must be tightly regulated to prevent unverified code insertions.

### 3.1 Production Deployer Entitlement (`PROD_DEPLOYER`)
The `PROD_DEPLOYER` entitlement authorizes technical personnel to initiate, execute, or trigger automated release deployment jobs targeting production clusters within `DEPLOY_PIPELINE`. Self-service requests for `PROD_DEPLOYER` are restricted to verified software engineering, DevOps, and site reliability engineering personnel assigned to the primary Engineering cost center, specifically Engineering (`CC-ENG-03`).

Self-service requests for `PROD_DEPLOYER` submitted by eligible engineering staff require direct managerial approval from an Engineering manager (`CC-ENG-03`), accompanied by technical peer-review verification confirming that the applicant has completed mandatory secure code deployment training. Upon approval, `PROD_DEPLOYER` is provisioned on a standard annual basis subject to quarterly access certification campaigns. Requests for `PROD_DEPLOYER` submitted by non-technical or non-engineering personnel must be denied during initial administrative review.

### 3.2 Production Change Approver Entitlement (`PROD_CHANGE_APPROVER`)
The `PROD_CHANGE_APPROVER` entitlement grants release authorization privileges within `DEPLOY_PIPELINE`, enabling an individual to evaluate change requests, sign off on deployment readiness, and approve release execution tickets. Because change approval represents a critical supervisory control point, `PROD_CHANGE_APPROVER` is classified as a senior governance privilege requiring authorization from Platform Engineering leadership or the Change Advisory Board.

### 3.3 Staging Deployer Entitlement (`STAGING_DEPLOYER`)
The `STAGING_DEPLOYER` entitlement authorizes technical personnel to trigger deployment jobs targeting pre-production staging clusters within `DEPLOY_PIPELINE`, distinct from and lower-risk than `PROD_DEPLOYER`. Because staging environments do not serve live customer traffic, `STAGING_DEPLOYER` is classified as a standard operational entitlement rather than an elevated one.

Self-service requests for `STAGING_DEPLOYER` are restricted to verified software engineering and DevOps personnel assigned to Engineering (`CC-ENG-03`), and require only standard single-level manager approval. Upon approval, `STAGING_DEPLOYER` is provisioned on an ongoing standing basis subject to mandatory annual access recertification — unlike `PROD_DEPLOYER`, `STAGING_DEPLOYER` is not subject to the SoD-SEC-01 or SoD-SEC-02 conflict rules in Section 4, since staging deployment carries no production impact.

### 3.4 Pipeline Administration Entitlement (`PIPELINE_ADMIN`)
The `PIPELINE_ADMIN` entitlement authorizes modification of the CI/CD pipeline configuration itself — build definitions, deployment gates, approval-routing rules, and the automation that `PROD_DEPLOYER` and `PROD_CHANGE_APPROVER` operate within. Because a compromised or misconfigured pipeline definition can silently bypass the SoD-SEC-01 control it is meant to enforce, `PIPELINE_ADMIN` is classified as a maximum-risk tier 1 entitlement, more severe than either `PROD_DEPLOYER` or `PROD_CHANGE_APPROVER` individually.

Self-service requests for `PIPELINE_ADMIN` require direct managerial sign-off from Platform Engineering leadership, technical peer-review validation, and formal secondary authorization from the Global Infrastructure Security Committee — mirroring the dual sign-off required for `INFRA_ADMIN` under Section 5.1. Upon dual sign-off, `PIPELINE_ADMIN` is provisioned subject to mandatory monthly recertification per Section 6.2.

---

## 4. Separation of Duties Rules in Release Management

### 4.1 Separation of Duties Conflict: Production Deployer vs. Change Approver (SoD-SEC-01)
To satisfy SOC 2 Type II change management criteria and prevent unreviewed code modifications from reaching production, the enterprise enforces strict segregation of duties between software deployment execution and release authorization. Allowing a single individual to both approve a production change ticket and execute the corresponding deployment introduces unacceptable operational risk and violates fundamental internal control standards.

Specifically, **no individual employee may simultaneously hold both the production deployment execution entitlement (`PROD_DEPLOYER`) and the production change approval entitlement (`PROD_CHANGE_APPROVER`) within `DEPLOY_PIPELINE`**. Any self-service access request that would result in a requester holding both `PROD_DEPLOYER` and `PROD_CHANGE_APPROVER` concurrently must be denied immediately by the IT administrator or automated access engine as a critical Separation of Duties (SoD) conflict.

If an engineer currently holds `PROD_DEPLOYER` and submits a self-service request for `PROD_CHANGE_APPROVER` (or vice versa), the request cannot be approved unless the pre-existing entitlement is formally relinquished and revoked prior to or concurrently with the provisioning of the new role. Attempting to bypass this control via manual administrative override is strictly prohibited and constitutes a direct policy violation subject to disciplinary review.

### 4.2 Separation of Duties Conflict: Production Deployer vs. Production Secrets Administrator (SoD-SEC-02)

Production deployment execution and production secrets administration are governed by separate sections of this policy (`DEPLOY_PIPELINE` under Section 3, `CLOUD_CONSOLE` under Section 5), but the risk they jointly create does not respect that boundary. An individual who can both trigger a production deployment and read or export live production secrets — database credentials, third-party API keys, signing keys — can embed credential exfiltration inside an otherwise ordinary deployment, with no separate approval step to catch it before the code reaches production.

Specifically, **no individual employee may simultaneously hold both the production deployment execution entitlement (`PROD_DEPLOYER`) within `DEPLOY_PIPELINE` and the production secrets administration entitlement (`PROD_SECRETS_ADMIN`) within `CLOUD_CONSOLE`**, regardless of the fact that the two entitlements belong to different systems. Any self-service access request that would result in a requester holding both concurrently must be denied immediately as a critical Separation of Duties (SoD) conflict, evaluated against the requester's complete cross-system entitlement history, not just prior holdings within the target system of the current request.

If an engineer currently holds an active `PROD_DEPLOYER` grant and submits a self-service request for `PROD_SECRETS_ADMIN` (or vice versa), the request cannot be approved unless the pre-existing entitlement is formally relinquished and revoked prior to or concurrently with the provisioning of the new role. As with SoD-SEC-01, bypassing this control via manual administrative override is strictly prohibited.

---

## 5. Cloud Infrastructure Console Access Controls (`CLOUD_CONSOLE`)

### 5.1 Infrastructure Administrator Entitlement (`INFRA_ADMIN`)
The `INFRA_ADMIN` entitlement provides administrative management plane access to the Enterprise Cloud Console (`CLOUD_CONSOLE`), including full privileges to modify network security groups, alter IAM role policies, spin up or terminate compute clusters, and reconfigure storage buckets. Due to the destructive potential of administrative infrastructure privileges, `INFRA_ADMIN` is designated as a maximum-risk tier 1 administrative credential.

Self-service requests for `INFRA_ADMIN` submitted by eligible site reliability engineers or systems architecture personnel within Engineering (`CC-ENG-03`) are subject to multi-stage technical verification. **Any self-service request for `INFRA_ADMIN` requires direct managerial sign-off from Platform Engineering leadership (`CC-ENG-03`), technical peer-review validation confirming advanced cloud architecture certification, and formal secondary authorization from the Global Infrastructure Security Committee.** Upon dual sign-off, access is provisioned subject to mandatory monthly recertification per Section 6.2.

### 5.2 Mandatory Engineering Department Restriction
To prevent unauthorized privilege propagation across organizational boundaries, **the `INFRA_ADMIN` entitlement is strictly restricted to verified Site Reliability Engineering (SRE) and Systems Architecture staff assigned to the primary Engineering cost center, Engineering (`CC-ENG-03`)**. 

Self-service requests for `INFRA_ADMIN` originating from employees assigned to non-engineering departments or cost centers—specifically including Marketing (`CC-MKT-02`), Finance Analytics (`CC-FIN-07`), Finance Operations (`CC-FIN-12`), or general business administration—are explicitly prohibited and must be denied immediately during initial payload validation. Non-engineering personnel have no operational necessity for cloud infrastructure administration; any business requirement for specialized data export or reporting must be fulfilled through approved analytical tools governed under `POL-DATA-001`.

Furthermore, pre-existing or legacy holdings of `INFRA_ADMIN` assigned to non-engineering accounts (such as anomalous marketing or administrative profiles) are recognized as severe security risks. Such holdings must be flagged for emergency revocation during monthly access certification scans and cannot be used as precedent to justify new non-engineering access requests.

### 5.3 Infrastructure Read-Only Entitlement (`INFRA_READONLY`)
The `INFRA_READONLY` entitlement provides view-only access to `CLOUD_CONSOLE` dashboards, resource inventories, and configuration state, without modification privileges of any kind. Because `INFRA_READONLY` carries no capability to alter production infrastructure, it is classified as a standard, low-risk entitlement rather than an administrative one.

Self-service requests for `INFRA_READONLY` are available to verified technical personnel assigned to Engineering (`CC-ENG-03`) or Security Engineering (`CC-SEC-01`), and require only standard single-level manager approval. Upon approval, `INFRA_READONLY` is provisioned on an ongoing standing basis subject to mandatory annual access recertification — unlike `INFRA_ADMIN` and `PROD_SECRETS_ADMIN`, `INFRA_READONLY` is not subject to monthly recertification under Section 6.2, given its absence of modification capability.

### 5.4 Production Secrets Administration Entitlement (`PROD_SECRETS_ADMIN`)

The `PROD_SECRETS_ADMIN` entitlement grants read, write, and rotation privileges over the enterprise secrets management vault within `CLOUD_CONSOLE` — including database connection credentials, third-party API keys, TLS signing certificates, and service account tokens used by production systems. Because compromise or misuse of this entitlement exposes every downstream credential it protects, `PROD_SECRETS_ADMIN` is designated a maximum-risk tier 1 administrative credential, equivalent in severity to `INFRA_ADMIN`.

Self-service requests for `PROD_SECRETS_ADMIN` are restricted to verified Site Reliability Engineering personnel assigned to Engineering (`CC-ENG-03`) and Security Engineering personnel assigned to Security Engineering (`CC-SEC-01`) — Security Engineering is the preferred home for this entitlement going forward, given its direct ownership of credential and secrets governance. Any self-service request for `PROD_SECRETS_ADMIN` requires direct managerial sign-off from Platform Engineering or Security Engineering leadership as applicable, technical peer-review validation, and formal secondary authorization from the Global Infrastructure Security Committee — mirroring the dual sign-off required for `INFRA_ADMIN` under Section 5.1. Upon dual sign-off, access is provisioned subject to mandatory monthly recertification per Section 6.2. **Before granting `PROD_SECRETS_ADMIN`, the IT administrator or automated access engine must additionally verify the applicant's complete active entitlement history across `DEPLOY_PIPELINE` for an existing `PROD_DEPLOYER` grant** — see the SoD-SEC-02 conflict rule in Section 4.2.

---

## 6. Emergency Break-Glass Procedures and Recertification

### 6.1 Break-Glass Administrative Protocol
During major production outages (Severity 1 incidents) where standard role boundaries impede immediate resolution, an engineer may request temporary emergency elevation through the automated Break-Glass Portal. Emergency elevation generates real-time notifications to the CISO, logs all command-line executions to an immutable audit ledger, and automatically revokes elevated privileges after four (4) hours.

### 6.2 Access Recertification and Telemetry Monitoring
The Infrastructure Security Committee conducts mandatory monthly recertification of all `INFRA_ADMIN`, `PROD_SECRETS_ADMIN`, `PIPELINE_ADMIN`, and `PROD_CHANGE_APPROVER` holdings. Audit telemetry logs capturing deployment triggers, console logins, secrets vault access, and configuration changes are ingested into the central SIEM platform and retained for seven (7) years in compliance with statutory audit standards.

---

## 7. Revision History

| Version | Date | Author / Title | Summary of Changes |
| :--- | :--- | :--- | :--- |
| 1.0.0 | 2021-11-05 | Cloud Infrastructure Team | Initial deployment policy for legacy cloud environments. |
| 2.3.0 | 2023-04-12 | Security Architecture Group | Defined `PROD_DEPLOYER` role requirements and CI/CD pipeline integration. |
| 3.1.0 | 2024-02-18 | VP of Engineering | Implemented mandatory SoD-SEC-01 conflict rules between deployers and approvers. |
| 4.2.0 | 2025-01-01 | Global Infra Sec Committee | Restricted `INFRA_ADMIN` strictly to Engineering (`CC-ENG-03`) and prohibited non-eng grants. |
| 4.3.0 | 2026-02-01 | Global Infra Sec Committee | Added `PROD_SECRETS_ADMIN` entitlement and cross-system SoD-SEC-02 conflict rule against `PROD_DEPLOYER`. |
| 4.4.0 | 2026-02-01 | Global Infra Sec Committee | Added `STAGING_DEPLOYER`, `PIPELINE_ADMIN`, and `INFRA_READONLY` entitlements; extended `PROD_SECRETS_ADMIN` eligibility to the new Security Engineering cost center (`CC-SEC-01`). |
