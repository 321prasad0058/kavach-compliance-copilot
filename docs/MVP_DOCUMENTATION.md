# Kavach: MVP / Prototype Documentation

**Challenge:** Snowflake CoCo CLI Hackathon 2026 (GCC Edition). Challenge 1: Risk, Fraud and Regulatory Intelligence Copilot
**One line:** Kavach (कवच, "shield") turns a compliance officer's plain-English question into a cited, audit-ready finding, built on Snowflake Cortex.

---

## 1. Problem

Risk, fraud and compliance teams at Indian NBFCs answer the same three kinds of question every day:

| Question type | Example | Where the answer lives today |
|---|---|---|
| **Data** | "Which accounts disbursed in the last 6 months are already at DPD > 60?" | SQL written by an analyst, pasted into a spreadsheet |
| **Regulation / policy** | "What does Scale Based Regulation require of a Middle Layer NBFC?" | RBI Master Direction PDFs, internal SOPs, past audit findings |
| **Both** | "Which accounts show structuring this week, and what must we do about them?" | Two teams, two tools, then a case note written by hand |

The last step is the expensive one. Turning a signal into a *documented finding* (case note, exception report or STR draft) with a defensible evidence trail is manual and slow. It is also where auditors and the RBI later ask *"how did you decide this?"*

Generic chatbots do not help here. They cannot show their SQL, they paraphrase regulations without citing a clause, and they leave no audit trail.

## 2. Solution

Kavach is a governed copilot with one core loop: **signal → evidence → documented finding → sign-off**. Every step is recorded in an immutable, hash-chained audit log.

1. **Ask.** The user types a question in plain English, or clicks **Investigate** on a live alert.
2. **Route.** A Cortex LLM decides whether the question needs *data*, *policy* or *both*, and splits it into a data question and one to three policy search queries.
3. **Evidence.**
   * **Cortex Analyst** turns the data question into SQL against a governed semantic model. "NPA", "exposure", "structuring" and "income mismatch" always resolve to the same definitions. The SQL is shown, checked to be read-only, and executed under a role that sees masked PAN.
   * **Cortex Search** retrieves the exact clauses (document, section number, text) from RBI directions, internal credit policy, the AML SOP, past audit findings and report templates.
4. **Cited answer.** Cortex COMPLETE (temperature 0) writes an answer in which every sentence carries a citation tag (`[D1]` for data, `[P1]…[Pn]` for clauses). The citations are clickable in the UI and open the evidence behind them.
5. **Confidence badge.** A rule-based check, not an LLM opinion. Confidence is LOW if the data is empty or errored, retrieval is weak, the answer cites evidence that does not exist, or it cites nothing at all. It is HIGH only when a verified (pre-approved) query and relevant clauses back the answer.
6. **Generate Finding.** One click produces a case note, exception report or STR draft. The header (IDs, timestamps, audit reference, confidence) and the evidence appendix (SQL, rows, quoted clauses) are generated deterministically by code. Only the narrative comes from the LLM, and it is constrained to the cited evidence.
7. **Sign-off.** A reviewer approves, requests changes or rejects. Maker-checker is enforced as data: a self-review is recorded as an exception, not silently allowed.
8. **Audit.** Every question, SQL statement, retrieved clause, answer, finding and review is appended to `KAVACH.GOV.AUDIT_LOG`. Each row's SHA-256 covers the previous row's hash, and a view recomputes the whole chain to prove nothing was edited, deleted or reordered.

## 3. Architecture

```
┌──────────────────────── Snowpark Container Services (inside Snowflake) ────────────────────────┐
│  Angular 20 SPA  ──HTTP/SSE──▶  NestJS 11 API (Fastify)                                          │
│  (CJP design system,             • router (COMPLETE)  • orchestrator  • confidence rules          │
│   VANA themes & effects)         • finding generator  • maker-checker                             │
└───────────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                            │ OAuth token from SPCS (or PAT / key-pair locally)
         ┌───────────────────┬──────────────┼──────────────────┬───────────────────────────┐
         ▼                   ▼              ▼                  ▼                           ▼
  Cortex Analyst      Cortex Search    Cortex COMPLETE     SQL API (KAVACH_APP role)   LOG_EVENT proc
  semantic_model/     POLICY_SEARCH    router, answer,     CORE tables & views         (owner's rights)
  kavach.yaml         (clause chunks)  finding narrative   PAN masking policy          → GOV.AUDIT_LOG
```

| Layer | Snowflake feature | Why |
|---|---|---|
| Governed text-to-SQL | **Cortex Analyst** + semantic model with 7 verified queries | The same metric definitions every time; verified queries lift confidence |
| Retrieval | **Cortex Search** over clause-level chunks (`section_path` + text) | Clause-accurate citations; hybrid semantic + keyword search |
| Reasoning | **Cortex COMPLETE** (model fallback list, temperature 0) | Router, synthesis and finding narrative with no external LLM |
| Data | Tables, views, **masking policy**, sequences | PII never reaches the LLM path; "structuring" is defined once, in a view |
| Governance | Owner's-rights **stored procedure**, RBAC, hash-chain view | The app role can only *append*; tampering is detectable |
| Runtime | **Snowpark Container Services** | The app runs inside Snowflake with Snowflake-authenticated users |
| Live feed | **Task** (optional) | Simulated alert stream for the landing screen |

## 4. Data (all synthetic)

* **Structured** (`KAVACH.CORE`): 1,000 MSME customers, about 1,200 loan accounts, about 33,000 transactions, KYC records and about 155 fraud alerts. Planted scenarios make the demo deterministic:
  * 3 recently disbursed accounts with structuring patterns (sub-₹50k cash and wallet credits across cities, then an RTGS out)
  * 14 accounts at DPD > 60 within six months of disbursal, concentrated in one sourcing partner
  * 6 first-time borrowers whose bank credits are below 40% of declared income. Only 4 have rule alerts, so **Kavach surfaces the 2 that the rules engine missed**
  * PEP and high-risk customers with overdue periodic KYC
* **Unstructured** (`KAVACH.KNOWLEDGE`): 7 documents chunked into 60 clauses. These are paraphrased summaries of RBI Scale Based Regulation, KYC/PMLA and Fraud Risk Management directions, plus a fictional lender's credit policy, AML SOP, audit findings register and report templates. The official RBI PDFs can be added with `PARSE_DOCUMENT` (script included).

## 5. How it meets the judging criteria

| Criterion | Evidence in the prototype |
|---|---|
| **Real-World Relevance (30%)** | Built around real NBFC workflows: DPD/SMA/NPA classification, early-delinquency EWS, structuring below the ₹50k PAN threshold, STR within 7 working days, periodic KYC updation, SBR layer-specific governance. Uses the maker-checker and five-year retention concepts auditors expect. |
| **Technical Execution (40%)** | Cortex Analyst, Cortex Search and Cortex COMPLETE orchestrated explicitly with an inspectable trace; semantic model with verified queries; read-only SQL guard; PII masking; owner's-rights append-only audit with SHA-256 chaining; SSE-streamed pipeline; SPCS deployment; offline mock with identical contracts for testing. |
| **Solution Completeness (30%)** | Full loop in one screen: signal (live alert queue) → evidence (SQL, rows, clauses) → documented finding (one click) → reviewer sign-off → audit replay and chain verification. |

## 6. What makes it different

1. **It closes the loop to a document.** Most copilots stop at Q&A. Kavach produces the case note, exception report or STR draft, with the evidence appendix built by code, not by the model.
2. **Governance you can query.** The audit log is a Snowflake table with a verification view (`V_AUDIT_CHAIN_CHECK`), not chat history.
3. **Confidence from rules, not vibes.** It checks for empty results, weak retrieval and hallucinated citations deterministically.
4. **Least privilege by construction.** The copilot's role cannot modify the audit log or see raw PAN.

## 7. Limitations and next steps

* Regulation text is **paraphrased for the demo**. Before any real use, load the official RBI Master Directions and have compliance validate the chunking.
* The hash chain assumes serialized writes. At production volume, add a lock or anchor periodic chain heads to external WORM storage.
* The confidence thresholds are heuristic. They should be calibrated on a labelled set of real questions.
* Next: attach findings to case-management and FIU-IND STR workflows, row-access policies by branch or region, and evaluation harnesses for Analyst accuracy.
