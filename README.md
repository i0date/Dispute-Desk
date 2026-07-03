# The Dispute Desk

**[→ Live demo](https://dispute-desk-tau.vercel.app)**

An AI-powered tool for translating customer complaints into compliant Visa dispute summaries — with a built-in evidence package for every case.

Built from five years of fraud and risk operations experience at Canadian fintechs and banks.

---

## What it does

Paste in a raw customer complaint and the tool returns:

**Step 01 — Case Intake**
Enter the complaint, merchant, amount, transaction date, and expected delivery date. The filing window calculates automatically and flags if you're approaching the 120-day standard window or the 540-day absolute cap.

**Step 02 — Analysis**
- Recommended Visa reason code (10.1 through 13.9) with confidence level
- Rationale explaining the code selection
- Polished dispute summary in operational voice — flowing prose, no first-person pronouns, ready to paste into a Visa submission
- Goodwill outreach flag — surfaces when the cardholder is required to contact the merchant before filing
- Missing information list — what's needed before the case can proceed
- Alternative codes to consider

**Step 03 — Evidence Package**
A reason-code-aware checklist generated automatically after each analysis. Three tiers:
- **Pull from your systems** — 3DS authentication result, AVS log, device fingerprint, terminal capability data, velocity check
- **Collect from cardholder** — proof of purchase, goodwill outreach record, signed non-authorization statement, photos, cancellation confirmations, contracts
- **Watch for from merchant** — delivery confirmation, signed receipt, cancellation policy (anything the merchant may submit at representment that could affect your position)

Each item is checkable so analysts can track collection in real time. Required items are highlighted separately from items that strengthen or weaken the case.

---

## Why this exists

Most dispute work happens in spreadsheets and email threads. An analyst reads a raw customer complaint, decides on a reason code, drafts a summary in the right operational voice, checks the filing window, flags any goodwill outreach the cardholder still needs to do, and assembles the evidence. It takes 15–20 minutes per case when done well. Done poorly, it produces sloppy submissions that lose representment cases that should have been won.

This tool encodes the parts of that work that don't require human judgment — and adds the evidence layer that most dispute tools skip entirely.

---

## Scoring model — reason code base win rates

| Code | Description | Issuer base win rate |
|------|-------------|---------------------|
| 10.1 | EMV liability shift | 85% |
| 10.4 | CNP fraud — other | 76% |
| 10.5 | Visa fraud monitoring program | 93% |
| 13.1 | Merchandise not received | 41% |
| 13.3 | Not as described | 30% |
| 13.5 | Misrepresentation | 57% |
| 13.6 | Credit not processed | 68% |

Win rates are adjusted for evidence quality. See [Dispute Funding Assessor](https://github.com/i0date/dispute-funding-assessor) for the full scoring model.

---

## Tech

- React 18 + Vite
- Tailwind CSS
- Fraunces (display) + JetBrains Mono (monospace) typography
- lucide-react icons
- Anthropic API (Claude Sonnet) — proxied through a Vercel serverless function so the API key is never exposed in the browser

## Running locally

```bash
npm install
npm run dev
```

Create a `.env` file in the project root:
```
ANTHROPIC_API_KEY=your_key_here
```

## Deploying to Vercel

Connect the repo to Vercel — zero config needed for Vite. Then go to **Settings → Environment Variables** and add `ANTHROPIC_API_KEY`. Redeploy once the key is saved.

---

## Relationship to Dispute Funding Assessor

[Dispute Funding Assessor](https://github.com/i0date/dispute-funding-assessor) operates downstream — after claims have been filed, it scores a portfolio of open disputes for fundability and expected recovery value. The two tools cover distinct layers of the dispute lifecycle: operational intake and evidence gathering (Dispute Desk) → portfolio financing (Dispute Funding Assessor).

---

## About

Adeoti Fashokun. Fraud, risk, and compliance professional based in Toronto. Five years across Canadian fintechs and banks.

[LinkedIn](https://www.linkedin.com/in/adeoti-fashokun-284b66164/) · [Substack](https://adeoti.substack.com)

---

*v2 — July 2026. Evidence package added.*
