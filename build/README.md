<!-- GENERATED FILE — do not edit. Source: data/credentials.yaml. Run `make trust`. -->

# Trust and compliance — INA GPT GmbH

This repository is the single source of truth for every compliance claim
INA GPT GmbH makes in public. One data file, generated output,
CI-enforced.

**Why it exists.** A compliance page can be wrong in a way that still renders
beautifully. Every credential below therefore carries an identifier and a link
to the issuer's own record, and anything that does not carry both is in the
"not yet held" section instead — there is no middle state.

## Held

| Credential | Identifier | Issuer | Valid | Verify |
|---|---|---|---|---|
| **ISO/IEC 27001:2022 — Information Security Management System** | `12 310 71178 TMS` | TÜV SÜD Management Service GmbH | 2026-08-10 → 2029-08-09 | [verify](https://www.tuvsud.com/ms-cert) |
| Gaia-X European Association for Data and Cloud AISBL — European Member (Start-up) | `0469` | — | since 2026-07-23 | [verify](https://gaia-x.eu/who-we-are/members/) |
| Adra — AI, Data and Robotics Association — Industry — Start-up | — | — | since 2026-09-10 | [verify](https://adr-association.eu/members/) |
| IHK Berlin | `10702437784` | — | — | [verify](https://www.ihk.de/berlin) |
| Bundesverband Deutsche Startups e.V. | `14346` | — | — | [verify](https://startupverband.de/) |
| Commercial register (Handelsregister) | `HRB 288452 B` | Amtsgericht Berlin (Charlottenburg) | — | [verify](https://www.handelsregister.de/rp_web/welcome.xhtml) |
| VAT identification number (USt-IdNr.) | `DE464255291` | Bundeszentralamt für Steuern | — | [verify](https://ec.europa.eu/taxation_customs/vies/) |
| D-U-N-S® Number | `317228889` | Dun & Bradstreet | — | [verify](https://www.upik.de/) |

## In progress — not yet held

- **ISO/IEC 42001:2023 — AI Management System** — In progress (since 2026-07-13) — Certification audit contracted (Stage 1 + Stage 2). No certificate has been issued. No certification mark is displayed.
- KI Bundesverband e.V. — Verification pending. Member directory entry / membership number not yet linked.
- appliedAI Institute for Europe — Use Case Library — Verification pending. Listed as "Sovereign AI Assistant for German Citizens".
- Bitkom e.V. — Applied (since 2026-07-23).
- Apply AI Alliance (European Commission) — Stakeholders' Catalogue — Applied (since 2026-07-23).

The TÜV SÜD Management Service GmbH certificate and test mark are verifiable at the issuer's certificate database: <https://www.tuvsud.com/ms-cert> (Fundstelle, § 5a UWG).

## How to verify this register yourself

```
git clone https://github.com/ina-gpt/trust && cd trust
npm ci --ignore-scripts
make check      # schema, rules R1/R3/R4/R5/R8, disclosure guard, drift
make links      # every evidence URL must answer 2xx/3xx
make negative   # the gates must be able to fail
```

Machine-readable: [`build/trust.json`](build/trust.json) ·
published at <https://inagpt.com/trust.json>

## Practices

**GDPR.** Personal data is processed in Germany. Data subject rights, retention limits and deletion are implemented in product, not only in policy.

**Information security management.** ISMS certified to ISO/IEC 27001:2022, Statement of Applicability v1.7, with internal audit, risk assessment, corrective-action tracking and management review.

**Security testing.** Automated dependency scanning, static analysis and code review run in the delivery pipeline. Independent external penetration testing is commissioned as part of the 2026 security programme.

**Notice and action.** Illegal-content and copyright notices receive a statement of reasons and an appeal path.

**Engineering operating model.** Automation-first: CI/CD with mandatory gates, a nightly gated verification battery, automated testing and monitoring, self-healing runbooks, and machine-verified governance traceability.

## Contact

**INA GPT GmbH**  
Selerweg 40 A, 12169 Berlin, Deutschland  
info@inagpt.com · +49 30 4243 2400  
<https://inagpt.com>

Security disclosure: [SECURITY.md](build/SECURITY.md)
