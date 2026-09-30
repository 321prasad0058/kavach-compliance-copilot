"""Generate deterministic synthetic NBFC data and policy chunks for Kavach.

Everything produced here is synthetic. Demo scenarios are planted on purpose so
the rehearsed demo questions always return meaningful evidence:

  * 3 recently-disbursed accounts with STRUCTURING patterns in the last 7 days
    (sub-Rs 50k cash / wallet credits across several cities, then an RTGS out)
  * 14 accounts disbursed 3-6 months ago that are already at DPD > 60
    (early delinquency), concentrated in one sourcing partner
  * 6 first-time borrowers disbursed in the last 30 days whose bank-statement
    credits are < 40% of declared income (only 4 of them have alerts - the
    copilot finds the 2 the rules engine missed)
  * a handful of PEP / high-risk customers with overdue periodic KYC

Usage:
    python data/generate_synthetic.py            # anchor = today
    python data/generate_synthetic.py --anchor 2026-10-04
Outputs CSVs to data/out/.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import pathlib
import random
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "out"
CORPUS = ROOT / "corpus"

CITIES = [
    ("Mumbai", "Maharashtra"), ("Pune", "Maharashtra"), ("Nagpur", "Maharashtra"),
    ("Delhi", "Delhi"), ("Gurugram", "Haryana"), ("Bengaluru", "Karnataka"),
    ("Chennai", "Tamil Nadu"), ("Coimbatore", "Tamil Nadu"), ("Hyderabad", "Telangana"),
    ("Ahmedabad", "Gujarat"), ("Surat", "Gujarat"), ("Jaipur", "Rajasthan"),
    ("Lucknow", "Uttar Pradesh"), ("Kanpur", "Uttar Pradesh"), ("Kolkata", "West Bengal"),
    ("Indore", "Madhya Pradesh"), ("Ludhiana", "Punjab"), ("Kochi", "Kerala"),
]
PREFIX = ["Shree", "Sai", "Om", "New", "Royal", "Balaji", "Laxmi", "Ganesh", "Krishna", "Metro",
          "Star", "Sunrise", "Apex", "Urban", "Classic", "Jai", "Vinayak", "Ashirwad", "Navkar", "Siddhi"]
CORE = ["Traders", "Enterprises", "Textiles", "Electronics", "Kirana Store", "Pharma", "Auto Parts",
        "Foods", "Garments", "Hardware", "Logistics", "Distributors", "Agencies", "Mobile Point",
        "Steel", "Plastics", "Printers", "Caterers"]
SEGMENTS = ["Retail Trader", "Manufacturer", "Service Provider", "E-commerce Seller", "Distributor"]
PRODUCTS = [("Unsecured Business Loan", 0.55), ("Business Line of Credit", 0.20),
            ("Merchant Cash Advance", 0.15), ("Supply Chain Finance", 0.10)]
PARTNERS = [("Direct Digital", 0.40), ("Marketplace Partner A", 0.18), ("Payments Aggregator B", 0.15),
            ("DSA Network North", 0.12), ("DSA Network West", 0.10), ("Supply Chain Anchor C", 0.05)]
ANALYSTS = ["fcu.analyst1", "fcu.analyst2", "fcu.analyst3", "mlro.office"]
RULES = ["STRUCTURING", "VELOCITY", "GEO_ANOMALY", "INCOME_MISMATCH", "EARLY_DELINQUENCY", "PEP_EXPOSURE"]
BG_NOTES = {
    "VELOCITY": ["Credits spiked around festival season; consistent with trade cycle.",
                 "Pass-through of marketplace settlement; seller confirmed via call.", ""],
    "GEO_ANOMALY": ["Deposits made by field agents of distributor; documented.", ""],
    "INCOME_MISMATCH": ["Seasonal business; GST returns support declared turnover.", ""],
    "EARLY_DELINQUENCY": ["Customer cites delayed receivables from anchor.", ""],
    "PEP_EXPOSURE": ["Relative of local elected official; senior management approval on file.", ""],
    "STRUCTURING": ["Deposits linked to daily cash sales; bills sighted.", ""],
}


def wchoice(rng, pairs):
    items, weights = zip(*pairs)
    return rng.choices(items, weights=weights, k=1)[0]


def pan(rng, entity="P"):
    L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    return "".join(rng.choice(L) for _ in range(3)) + entity + rng.choice(L) + \
        f"{rng.randint(0, 9999):04d}" + rng.choice(L)


def ts(d: dt.datetime) -> str:
    return d.strftime("%Y-%m-%d %H:%M:%S")


def classify(dpd: int) -> str:
    if dpd == 0:
        return "STANDARD"
    if dpd <= 30:
        return "SMA-0"
    if dpd <= 60:
        return "SMA-1"
    if dpd <= 90:
        return "SMA-2"
    return "NPA"


def generate(anchor: dt.date, seed: int = 42, n_customers: int = 1000):
    rng = random.Random(seed)
    now = dt.datetime.combine(anchor, dt.time(18, 0))
    customers, accounts, txns, kyc, alerts = [], [], [], [], []
    txn_no = [0]
    alert_no = [0]

    def add_txn(acc, when, amount, direction, channel, counterparty, cp_type, city=None):
        txn_no[0] += 1
        c, s = city or (acc["_city"], acc["_state"])
        txns.append([f"T{txn_no[0]:08d}", acc["account_id"], acc["customer_id"], ts(when), round(amount, 2),
                     direction, channel, counterparty, cp_type, c, s])

    def add_alert(acc, rule, severity, status, when, amount, notes, assigned=None):
        alert_no[0] += 1
        alerts.append([f"AL{alert_no[0]:06d}", acc["account_id"], acc["customer_id"], rule, severity, status,
                       ts(when), assigned or rng.choice(ANALYSTS), round(amount, 2), notes])

    # ---------------- customers + kyc ----------------
    for i in range(1, n_customers + 1):
        city, state = rng.choice(CITIES)
        declared = rng.choice([1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15]) * 100000 / 2
        ratio = rng.uniform(0.75, 1.3)
        ntc = rng.random() < 0.22
        onboard = anchor - dt.timedelta(days=rng.randint(40, 900))
        customers.append({
            "customer_id": f"C{i:06d}", "business_name": f"{rng.choice(PREFIX)} {rng.choice(CORE)}",
            "pan": pan(rng, rng.choice("PF")), "segment": rng.choice(SEGMENTS), "city": city, "state": state,
            "onboarding_date": onboard.isoformat(), "declared_monthly_income": round(declared, 0),
            "bank_stmt_avg_monthly_credit": round(declared * ratio, 0), "first_time_borrower": ntc,
            "bureau_score": "" if ntc else rng.randint(640, 860),
        })
        risk = wchoice(rng, [("LOW", 0.62), ("MEDIUM", 0.31), ("HIGH", 0.07)])
        last_kyc = onboard + dt.timedelta(days=rng.randint(0, 30))
        period = {"LOW": 3650, "MEDIUM": 2920, "HIGH": 730}[risk]
        kyc.append({
            "customer_id": f"C{i:06d}",
            "doc_type": wchoice(rng, [("AADHAAR_OKYC", 0.45), ("CKYC", 0.25), ("VIDEO_KYC", 0.2), ("PASSPORT", 0.05), ("VOTER_ID", 0.05)]),
            "verification_status": wchoice(rng, [("VERIFIED", 0.93), ("PENDING", 0.04), ("FAILED", 0.01), ("EXPIRED", 0.02)]),
            "risk_category": risk, "pep_flag": rng.random() < 0.01,
            "sanctions_screening": "POTENTIAL_MATCH" if rng.random() < 0.005 else "CLEAR",
            "last_kyc_date": last_kyc.isoformat(), "next_kyc_due": (last_kyc + dt.timedelta(days=period)).isoformat(),
        })

    # ---------------- accounts ----------------
    acc_no = 0

    def new_account(cust, disb_date, product=None, partner=None, amount=None, dpd=None):
        nonlocal acc_no
        acc_no += 1
        product = product or wchoice(rng, PRODUCTS)
        partner = partner or wchoice(rng, PARTNERS)
        sanctioned = amount or rng.choice([1, 2, 3, 4, 5, 7.5, 10, 15, 20, 25, 30]) * 100000
        if cust["first_time_borrower"] and not amount:
            sanctioned = min(sanctioned, 500000)
        disbursed = sanctioned * (rng.uniform(0.6, 1.0) if product == "Business Line of Credit" else 1.0)
        tenure = rng.choice([12, 18, 24, 36])
        age_days = (anchor - disb_date).days
        paid_frac = min(age_days / 30 / tenure, 1.0)
        closed = paid_frac >= 1.0
        if dpd is None:
            if age_days < 35 or closed:
                dpd = 0
            else:
                r = rng.random()
                dpd = 0 if r < 0.84 else rng.randint(1, 30) if r < 0.91 else rng.randint(31, 60) if r < 0.95 \
                    else rng.randint(61, 90) if r < 0.975 else rng.randint(91, 400)
                dpd = min(dpd, max(age_days - 30, 0))  # cannot be overdue longer than the first EMI has existed
        outstanding = 0 if closed else disbursed * (1 - paid_frac * (0.35 if dpd > 60 else 0.9))
        city, state = cust["city"], cust["state"]
        acc = {
            "account_id": f"LA{acc_no:07d}", "customer_id": cust["customer_id"], "product": product,
            "sourcing_partner": partner, "sanctioned_amount": round(sanctioned, 0), "disbursed_amount": round(disbursed, 0),
            "disbursal_date": disb_date.isoformat(), "tenure_months": tenure, "interest_rate": round(rng.uniform(16, 28), 2),
            "outstanding_principal": round(outstanding, 0), "dpd": dpd, "asset_classification": classify(dpd),
            "npa_flag": dpd > 90, "account_status": "CLOSED" if closed else "ACTIVE", "_city": city, "_state": state,
        }
        accounts.append(acc)
        return acc

    for cust in customers:
        n = 1 if rng.random() < 0.82 else 2
        for _ in range(n):
            new_account(cust, anchor - dt.timedelta(days=rng.randint(36, 540)))

    # ---------------- background transactions ----------------
    for acc in accounts:
        if acc["account_status"] != "ACTIVE":
            continue
        disb = dt.datetime.fromisoformat(acc["disbursal_date"]) + dt.timedelta(hours=11)
        if (now - disb).days <= 90:
            add_txn(acc, disb, acc["disbursed_amount"], "CREDIT", "DISBURSAL", "DemoLend NBFC", "LENDER")
        start = max(disb + dt.timedelta(days=1), now - dt.timedelta(days=90))
        d = start
        while d < now:
            d += dt.timedelta(days=rng.randint(2, 6), hours=rng.randint(0, 9))
            if d >= now:
                break
            ch = wchoice(rng, [("UPI", 0.5), ("NEFT", 0.2), ("IMPS", 0.15), ("CASH_DEPOSIT", 0.1), ("WALLET_TOPUP", 0.05)])
            amt = rng.uniform(3000, 38000) if ch in ("CASH_DEPOSIT", "WALLET_TOPUP") else rng.uniform(5000, 180000)
            add_txn(acc, d, amt, "CREDIT", ch, f"Customer {rng.randint(100, 999)}", "RETAIL_CUSTOMER")
            if rng.random() < 0.35:
                add_txn(acc, d + dt.timedelta(hours=3), rng.uniform(4000, 90000), "DEBIT",
                        rng.choice(["UPI", "NEFT", "IMPS"]), f"Supplier {rng.randint(10, 99)}", "SUPPLIER")
        for m in range(1, 4):
            emi = now - dt.timedelta(days=30 * m - 5)
            if emi > disb + dt.timedelta(days=28) and acc["dpd"] < 30 * m:
                add_txn(acc, emi, acc["disbursed_amount"] / acc["tenure_months"] * 1.15, "DEBIT", "NACH",
                        "DemoLend NBFC", "LENDER")

    # ---------------- background alerts ----------------
    active = [a for a in accounts if a["account_status"] == "ACTIVE"]
    for _ in range(140):
        acc = rng.choice(active)
        rule = wchoice(rng, [("VELOCITY", 0.35), ("GEO_ANOMALY", 0.2), ("INCOME_MISMATCH", 0.15),
                             ("EARLY_DELINQUENCY", 0.15), ("PEP_EXPOSURE", 0.05), ("STRUCTURING", 0.10)])
        when = now - dt.timedelta(days=rng.randint(3, 170), hours=rng.randint(0, 20))
        age = (now - when).days
        status = "CLOSED_FP" if age > 20 and rng.random() < 0.8 else wchoice(rng, [("OPEN", 0.5), ("IN_REVIEW", 0.35), ("ESCALATED", 0.15)])
        sev = wchoice(rng, [("LOW", 0.35), ("MEDIUM", 0.45), ("HIGH", 0.2)])
        add_alert(acc, rule, sev, status, when, rng.uniform(20000, 400000), rng.choice(BG_NOTES[rule]))

    cust_by_id = {c["customer_id"]: c for c in customers}
    kyc_by_id = {k["customer_id"]: k for k in kyc}
    fresh = iter([c for c in customers if not c["first_time_borrower"]][::7])
    fresh_ntc = iter([c for c in customers if c["first_time_borrower"]][::5])

    # ---------------- PLANT 1: structuring ----------------
    structuring_plan = [(22, 6, ["Mumbai", "Pune", "Surat"]), (15, 5, ["Delhi", "Gurugram", "Jaipur"]),
                        (11, 4, ["Hyderabad", "Bengaluru"])]
    city_state = dict(CITIES)
    for days_ago, n_dep, cities in structuring_plan:
        cust = next(fresh)
        acc = new_account(cust, anchor - dt.timedelta(days=days_ago), product="Unsecured Business Loan",
                          partner="DSA Network West", amount=rng.choice([800000, 1000000, 1200000]), dpd=0)
        kyc_by_id[cust["customer_id"]]["risk_category"] = "MEDIUM"
        disb = dt.datetime.fromisoformat(acc["disbursal_date"]) + dt.timedelta(hours=11)
        add_txn(acc, disb, acc["disbursed_amount"], "CREDIT", "DISBURSAL", "DemoLend NBFC", "LENDER")
        total = 0
        for k in range(n_dep):
            when = now - dt.timedelta(days=6 - k, hours=rng.randint(1, 8))
            amt = rng.choice([49500, 49900, 48000, 49000, 47500, 49990, 45000])
            city = cities[k % len(cities)]
            add_txn(acc, when, amt, "CREDIT", "CASH_DEPOSIT" if k % 3 else "WALLET_TOPUP",
                    "Self / cash", "SELF", (city, city_state[city]))
            total += amt
        add_txn(acc, now - dt.timedelta(hours=20), total * 0.97 + acc["disbursed_amount"] * 0.5, "DEBIT", "RTGS",
                "Zenith Global Trading LLP", "UNRELATED_ENTITY")
        add_alert(acc, "STRUCTURING", "HIGH", "OPEN", now - dt.timedelta(hours=rng.randint(4, 30)), total,
                  f"Auto: {n_dep} sub-50k cash/wallet credits in 7 days across {len(cities)} cities; outward RTGS to unrelated entity.",
                  assigned="fcu.analyst1")
        if days_ago == 22:
            add_alert(acc, "GEO_ANOMALY", "MEDIUM", "OPEN", now - dt.timedelta(hours=10), total,
                      "Auto: cash deposits in 3 cities within 7 days.", assigned="fcu.analyst2")

    # historical structuring case that went to STR (for context)
    cust = next(fresh)
    acc = new_account(cust, anchor - dt.timedelta(days=260), dpd=0)
    add_alert(acc, "STRUCTURING", "HIGH", "STR_FILED", now - dt.timedelta(days=190), 238000,
              "MLRO concluded suspicion; STR filed with FIU-IND within 7 working days. KYC upgraded to HIGH.",
              assigned="mlro.office")
    kyc_by_id[cust["customer_id"]]["risk_category"] = "HIGH"

    # ---------------- PLANT 2: early delinquency ----------------
    for k in range(14):
        cust = next(fresh)
        partner = "DSA Network North" if k < 9 else rng.choice(["Direct Digital", "Marketplace Partner A"])
        acc = new_account(cust, anchor - dt.timedelta(days=rng.randint(95, 175)), partner=partner,
                          amount=rng.choice([300000, 500000, 750000, 1000000, 1500000]), dpd=rng.randint(61, 118))
        if k % 3 == 0:
            add_alert(acc, "EARLY_DELINQUENCY", "HIGH", "OPEN", now - dt.timedelta(days=rng.randint(1, 20)),
                      acc["outstanding_principal"], "Auto: DPD>60 within 6 months of disbursal.")

    # ---------------- PLANT 3: income mismatch on first-time borrowers ----------------
    for k in range(6):
        cust = next(fresh_ntc)
        cust["bank_stmt_avg_monthly_credit"] = round(cust["declared_monthly_income"] * rng.uniform(0.18, 0.36), 0)
        acc = new_account(cust, anchor - dt.timedelta(days=rng.randint(3, 27)),
                          partner="DSA Network North" if k < 4 else "Marketplace Partner A",
                          amount=rng.choice([300000, 400000, 500000]), dpd=0)
        if k < 4:
            add_alert(acc, "INCOME_MISMATCH", "MEDIUM", "OPEN", now - dt.timedelta(days=rng.randint(0, 3)),
                      acc["disbursed_amount"], "Auto: bank statement credits < 40% of declared income.")

    # ---------------- PLANT 4: PEP / overdue KYC ----------------
    for k in range(4):
        c = rng.choice(customers)
        kr = kyc_by_id[c["customer_id"]]
        kr.update(risk_category="HIGH", pep_flag=True,
                  last_kyc_date=(anchor - dt.timedelta(days=900 + 40 * k)).isoformat())
        kr["next_kyc_due"] = (dt.date.fromisoformat(kr["last_kyc_date"]) + dt.timedelta(days=730)).isoformat()
    for k in range(9):
        c = rng.choice(customers)
        kr = kyc_by_id[c["customer_id"]]
        kr.update(risk_category="HIGH", last_kyc_date=(anchor - dt.timedelta(days=760 + 17 * k)).isoformat())
        kr["next_kyc_due"] = (dt.date.fromisoformat(kr["last_kyc_date"]) + dt.timedelta(days=730)).isoformat()

    return customers, accounts, txns, kyc, alerts


FRONT = re.compile(r"^---\n(.*?)\n---\n", re.S)
HEAD = re.compile(r"^(#{2,3})\s+(.*)$")


def chunk_corpus():
    """Split each corpus doc into one chunk per '###' clause (or '##' if no sub-clauses)."""
    rows = []
    for path in sorted(CORPUS.glob("*.md")):
        text = path.read_text()
        m = FRONT.match(text)
        meta = dict(line.split(": ", 1) for line in m.group(1).splitlines())
        body = text[m.end():]
        current, parent, buf = None, "", []

        def flush():
            content = " ".join(" ".join(buf).split())
            if current and content:
                sec = current
                sid = sec.split(" ", 1)[0].rstrip(".")
                rows.append([f"{meta['doc_id']}-{sid}", meta["doc_id"], meta["title"], meta["doc_type"],
                             meta["issuer"], meta["version"], meta["source_ref"], sid,
                             sec.split(" ", 1)[1] if " " in sec else sec,
                             f"{parent} > {sec}" if parent and parent != sec else sec, content, meta.get("disclaimer", "")])

        for line in body.splitlines():
            h = HEAD.match(line)
            if h:
                flush()
                current, buf = h.group(2).strip(), []
                if h.group(1) == "##":
                    parent = current
            else:
                buf.append(line)
        flush()
    return rows


def write(name, header, rows):
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / name, "w", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
        w.writerow(header)
        for r in rows:
            w.writerow(["TRUE" if v is True else "FALSE" if v is False else v for v in r])
    print(f"  {name:22s} {len(rows):>7,d} rows")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--anchor", default=dt.date.today().isoformat(), help="'today' for the synthetic data (YYYY-MM-DD)")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    anchor = dt.date.fromisoformat(args.anchor)
    customers, accounts, txns, kyc, alerts = generate(anchor, args.seed)
    print(f"Writing synthetic data anchored at {anchor} to {OUT}")
    ccols = ["customer_id", "business_name", "pan", "segment", "city", "state", "onboarding_date",
             "declared_monthly_income", "bank_stmt_avg_monthly_credit", "first_time_borrower", "bureau_score"]
    write("customers.csv", ccols, [[c[k] for k in ccols] for c in customers])
    acols = ["account_id", "customer_id", "product", "sourcing_partner", "sanctioned_amount", "disbursed_amount",
             "disbursal_date", "tenure_months", "interest_rate", "outstanding_principal", "dpd",
             "asset_classification", "npa_flag", "account_status"]
    write("accounts.csv", acols, [[a[k] for k in acols] for a in accounts])
    write("transactions.csv", ["txn_id", "account_id", "customer_id", "txn_ts", "amount", "direction", "channel",
                               "counterparty", "counterparty_type", "geo_city", "geo_state"],
          sorted(txns, key=lambda r: r[3]))
    kcols = ["customer_id", "doc_type", "verification_status", "risk_category", "pep_flag",
             "sanctions_screening", "last_kyc_date", "next_kyc_due"]
    write("kyc_records.csv", kcols, [[k[c] for c in kcols] for k in kyc])
    write("fraud_alerts.csv", ["alert_id", "account_id", "customer_id", "rule_triggered", "severity", "status",
                               "created_at", "assigned_to", "alert_amount", "analyst_notes"], alerts)
    write("policy_chunks.csv", ["chunk_id", "doc_id", "doc_title", "doc_type", "issuer", "version", "source_ref",
                                "section_id", "section_title", "section_path", "chunk_text", "disclaimer"], chunk_corpus())
    write("data_meta.csv", ["anchor_date", "seed"], [[anchor.isoformat(), args.seed]])


if __name__ == "__main__":
    main()
