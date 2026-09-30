---
doc_id: SOP-AML
title: DemoLend Transaction Monitoring and AML Alert Handling SOP (synthetic internal SOP)
doc_type: SOP
issuer: DemoLend NBFC Pvt Ltd (fictional) - Compliance / Fraud Control Unit
version: v2.1 (synthetic)
source_ref: internal://sop/aml/v2.1
disclaimer: Fictional SOP written for the Kavach demo. It does not describe any real lender's procedures.
---

## 1. Monitoring rules

### 1.1 STRUCTURING rule
An alert is raised when an account receives three or more credits through cash deposit or wallet top-up channels, each between Rs 40,000 and Rs 49,999, within any rolling seven-day window. These amounts sit just below the Rs 50,000 level at which PAN documentation is required for cash deposits, which is a common structuring (smurfing) pattern.

### 1.2 VELOCITY rule
An alert is raised when the number of credits into an account in 24 hours exceeds five times the account's trailing 30-day daily average, or when funds received are moved out within 24 hours (pass-through behaviour).

### 1.3 GEO_ANOMALY rule
An alert is raised when cash deposits for a single account are made in three or more different cities within seven days, or in a city far from the borrower's registered business location.

### 1.4 INCOME_MISMATCH rule
An alert is raised post-disbursal when the corroboration ratio of bank statement credits to declared income is below 0.40, in line with the Credit Policy income variance thresholds.

## 2. Alert handling workflow

### 2.1 Level 1 review
Every alert must be reviewed by a Level 1 analyst within two working days of generation. The analyst records the facts examined, the customer profile, and a disposition of close as false positive, or escalate.

### 2.2 Escalation to the Principal Officer
STRUCTURING alerts with an aggregate amount above Rs 1,50,000 in the window, and any alert on a PEP or high-risk customer, must be escalated to the Principal Officer (MLRO) within five working days of alert generation. A STRUCTURING alert must never be closed at Level 1 without Principal Officer review.

### 2.3 Decision and STR filing
The Principal Officer must record a reasoned decision. Where suspicion is concluded, a Suspicious Transaction Report must be filed with FIU-IND within seven working days of that conclusion, and the customer's KYC risk category must be upgraded to HIGH.

### 2.4 Tipping-off and account handling
Staff must not inform the customer that an alert is under review or that an STR has been filed. Operations in the account must not be restricted solely because an STR has been filed; any restriction requires a separate documented basis.

### 2.5 Case documentation
Every escalated alert must have a case note containing: the alert and rule triggered, the transactions examined, the KYC and profile review, the applicable regulatory and policy references, the decision and its rationale, and the reviewer sign-off. Case notes must be retained for at least five years.
