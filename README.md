# The Dispute Desk

An AI-powered tool for translating customer complaints into compliant Visa dispute summaries. Built from five years of fraud and risk operations experience at Canadian fintechs and banks.

## What it does

Paste in a raw customer complaint and the tool returns:

- **Recommended Visa reason code** with confidence level (10.1 through 13.9)
- **Rationale** explaining the reason code selection
- **Polished dispute summary** in operational voice — flowing prose, no first-person pronouns, ready to paste into a Visa submission
- **Filing window check** — calculates days since transaction and flags if approaching the 120-day standard window or the 540-day absolute cap (with fraud-specific logic)
- **Goodwill outreach flag** — surfaces when the cardholder is required to contact the merchant before a dispute can be filed
- **Missing information list** — what's needed before filing
- **Alternative codes** to consider

## Why I built this

Most dispute work happens in spreadsheets and email threads. An analyst reads a raw customer complaint, decides on a reason code, drafts a summary in the right operational voice, checks the filing window, flags any goodwill outreach the cardholder still needs to do, and assembles the evidence. It takes 15-20 minutes per case when done well. Done poorly, it produces sloppy submissions that lose representment cases that should have been won.

This tool encodes the parts of that work that don't require human judgment:

- Reason code selection — including the codes that are genuinely easy to miss (13.5 Misrepresentation is the classic one)
- Visa's filing window math, which is different for fraud (10.x) vs. consumer disputes (13.x)
- Operational communication standards (no first-person, flowing prose, warm but professional, no legal-brief hedging)
- The goodwill outreach requirement that cardholders often skip
- Fraud-specific summary length — Visa doesn't require lengthy narratives for category 10 because liability shifts automatically

It's not a replacement for an analyst. Judgment cases still need human review, and edge cases (PIN-used fraud, family member disputes, business email compromise) require operator discretion. But it gets you from raw complaint to a clean draft in seconds rather than minutes — which matters when the queue is full.

## How it works

The interface is built in React. The reasoning lives in a structured prompt to Claude (claude-sonnet-4) that includes the full Visa reason code reference, formatting conventions, and operational rules.

The model returns structured JSON which the UI renders into a dispute analyst's workflow:

```
Customer complaint  →  Claude (Sonnet 4)  →  Structured analysis  →  Operator UI
```

No data is stored. Each analysis runs fresh.

## Tech

- React (single-file component)
- Tailwind CSS
- Anthropic API (Claude Sonnet 4)
- lucide-react icons
- Fraunces (display) + JetBrains Mono (monospace) typography

## Who this is for

- Fraud and risk analysts working dispute cases
- Compliance professionals learning Visa reason codes
- Anyone building Trust & Safety tooling who wants to see what good operational policy looks like in practice

## What this is *not*

- Not legal advice
- Not a guaranteed dispute win
- Not a replacement for actual Visa rule reference materials
- Not for fraud-flavored shortcuts — every reason code recommendation should be reviewed by a human before filing

## About me

Adeoti Fashokun. Fraud, risk, and compliance professional based in Toronto. Five years across Canadian fintechs and banks. 

I write at [adeoti.substack.com](https://adeoti.substack.com). I think about the intersection of financial crime, policy, and AI safety.

[LinkedIn](https://www.linkedin.com/in/adeoti-fashokun-284b66164/)

---

*Built May 2026. Update in progress.*
