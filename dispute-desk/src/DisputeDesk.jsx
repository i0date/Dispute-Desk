import React, { useState } from 'react'
import { FileText, AlertCircle, Loader2, Copy, Check, ArrowRight, CheckSquare, Square } from 'lucide-react'

// ─── Evidence package by reason code ─────────────────────────────────────────

function getEvidencePackage(code, category) {
  const base = {
    systems: [],
    cardholder: [],
    merchant: [],
  }

  if (category === 'fraud') {
    base.systems = [
      { text: '3DS authentication result (V.me / Cardinal / similar)', impact: 'strengthens' },
      { text: 'AVS match/mismatch on billing and shipping address', impact: 'strengthens' },
      { text: 'Device fingerprint and IP address log', impact: 'strengthens' },
      { text: 'Transaction channel and terminal capability data', impact: 'strengthens' },
      { text: 'Velocity check — same-day or same-merchant transactions', impact: 'strengthens' },
    ]
    base.cardholder = [
      { text: 'Signed non-authorization statement', impact: 'required' },
      { text: 'Card possession status at time of transaction', impact: 'required' },
    ]
    if (code === '10.1' || code === '10.2') {
      base.cardholder.push({ text: 'Lost or stolen card report (police report if available)', impact: 'strengthens' })
      base.systems.push({ text: 'Terminal read method — confirm magnetic stripe used at chip-capable terminal', impact: 'required' })
    }
    if (code === '10.4') {
      base.systems.push({ text: 'Confirmation that no 3DS authentication was performed', impact: 'strengthens' })
    }
    if (code === '10.5') {
      base.systems.push({ text: 'VFMP enrollment confirmation for this merchant', impact: 'required' })
    }
  }

  if (category === 'consumer_dispute') {
    // Common to all 13.x
    base.cardholder.push(
      { text: 'Proof of purchase — receipt, order confirmation, or invoice', impact: 'required' },
      { text: 'Record of goodwill outreach to merchant (email, chat log, support ticket, reference number)', impact: 'required' },
      { text: "Merchant's response (or documented non-response) to outreach", impact: 'required' },
    )

    if (code === '13.1') {
      base.cardholder.push(
        { text: 'Declaration of non-receipt signed by cardholder', impact: 'required' },
        { text: 'Expected delivery date — from order confirmation or merchant communication', impact: 'strengthens' },
        { text: 'Any tracking information showing failure or no update', impact: 'strengthens' },
      )
      base.merchant.push(
        { text: 'Proof of delivery / carrier tracking confirmation', impact: 'weakens' },
        { text: 'Signed delivery receipt or signature capture', impact: 'weakens' },
      )
    }

    if (code === '13.2') {
      base.cardholder.push(
        { text: 'Cancellation confirmation — email screenshot or reference number', impact: 'required' },
        { text: 'Timeline: date cancelled vs. date(s) of continued charges', impact: 'required' },
        { text: 'Proof that cancellation was processed (confirmation screen, email)', impact: 'strengthens' },
      )
      base.merchant.push(
        { text: 'Subscription terms and cancellation policy at time of signup', impact: 'context' },
      )
    }

    if (code === '13.3') {
      base.cardholder.push(
        { text: 'Photos of item as received', impact: 'required' },
        { text: 'Screenshots of original merchant listing, product page, or advertisement', impact: 'required' },
        { text: 'Proof of return attempt or written refusal by merchant to accept return', impact: 'strengthens' },
        { text: 'Expert or third-party assessment if defect is technical', impact: 'strengthens' },
      )
    }

    if (code === '13.4') {
      base.cardholder.push(
        { text: 'Photos or documentation showing counterfeit indicators', impact: 'required' },
        { text: 'Screenshots of original listing representing item as authentic', impact: 'required' },
        { text: 'Expert authentication assessment if available', impact: 'strengthens' },
      )
    }

    if (code === '13.5') {
      base.cardholder.push(
        { text: 'Screenshots of merchant representation — listing, ad, website, email', impact: 'required' },
        { text: 'Documentation of what was actually received or experienced vs. what was represented', impact: 'required' },
        { text: 'Contract or service agreement if applicable', impact: 'strengthens' },
        { text: 'Communications with merchant referencing the misrepresentation', impact: 'strengthens' },
      )
    }

    if (code === '13.6') {
      base.cardholder.push(
        { text: 'Return receipt or proof that credit was owed', impact: 'required' },
        { text: 'Credit authorization number if merchant provided one', impact: 'strengthens' },
        { text: 'Timeline: date return/refund was agreed to vs. statement showing no credit', impact: 'required' },
      )
      base.merchant.push(
        { text: 'Merchant acknowledgement of credit or refund in writing', impact: 'strengthens' },
      )
    }

    if (code === '13.7') {
      base.cardholder.push(
        { text: 'Cancellation confirmation — email, chat log, or reference number', impact: 'required' },
        { text: 'Service agreement or refund policy at time of booking', impact: 'strengthens' },
        { text: 'Proof that merchant failed to deliver the cancelled service', impact: 'required' },
      )
    }
  }

  if (category === 'processing_error') {
    base.systems.push(
      { text: 'Transaction record showing the error (duplicate, incorrect amount, etc.)', impact: 'required' },
      { text: 'Correct transaction or authorisation record for comparison', impact: 'required' },
    )
    base.cardholder.push(
      { text: 'Receipt or confirmation showing correct amount or single transaction', impact: 'strengthens' },
    )
  }

  return base
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DisputeDesk() {
  const [complaint, setComplaint]               = useState('')
  const [merchant, setMerchant]                 = useState('')
  const [amount, setAmount]                     = useState('')
  const [transactionDate, setTransactionDate]   = useState('')
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('')
  const [currency, setCurrency]                 = useState('CAD')
  const [loading, setLoading]                   = useState(false)
  const [result, setResult]                     = useState(null)
  const [error, setError]                       = useState(null)
  const [copied, setCopied]                     = useState(false)
  const [checked, setChecked]                   = useState({})

  const toggleCheck = (key) => setChecked(prev => ({ ...prev, [key]: !prev[key] }))

  const computeDaysSince = (dateStr) => {
    if (!dateStr) return null
    const d = new Date(dateStr)
    const today = new Date()
    return Math.floor((today - d) / (1000 * 60 * 60 * 24))
  }

  const filingWindowStatus = (isFraud) => {
    const txnDays      = computeDaysSince(transactionDate)
    const expectedDays = computeDaysSince(expectedDeliveryDate)
    if (txnDays === null && expectedDays === null) return null
    const baseline = (!isFraud && expectedDays !== null) ? expectedDays : txnDays
    const cap      = txnDays
    if (isFraud) {
      if (cap > 120) return { status: 'expired', text: `${cap} days since transaction — past 120-day fraud filing window`, color: 'red' }
      if (cap > 100) return { status: 'warning', text: `${cap} days since transaction — only ${120 - cap} days remaining`, color: 'amber' }
      return { status: 'ok', text: `${cap} days since transaction — within 120-day fraud filing window`, color: 'green' }
    }
    if (cap !== null && cap > 540) return { status: 'expired', text: `Past 540-day absolute cap (${cap} days since transaction)`, color: 'red' }
    if (baseline > 120) return { status: 'late', text: `${baseline} days past baseline date — outside 120-day standard window`, color: 'red' }
    if (baseline > 100) return { status: 'warning', text: `${baseline} days elapsed — only ${120 - baseline} days remaining`, color: 'amber' }
    return { status: 'ok', text: `${baseline} days elapsed — within 120-day filing window`, color: 'green' }
  }

  const analyze = async () => {
    if (!complaint.trim()) { setError('Customer complaint is required.'); return }
    setLoading(true)
    setError(null)
    setResult(null)
    setChecked({})

    const prompt = `You are an experienced Visa dispute analyst. You write dispute summaries in a tight, operational voice: flowing prose, NO first-person pronouns (no "I"), warm but professional, concise. Real Float-style dispute summaries are typically 3-5 sentences, around 80-120 words. Avoid legal-brief language, avoid hedging, avoid repetition.

Analyze this customer complaint and generate a structured dispute analysis.

CUSTOMER COMPLAINT:
"""${complaint}"""

TRANSACTION DETAILS:
- Merchant: ${merchant || 'Not provided'}
- Amount: ${amount ? `${amount} ${currency}` : 'Not provided'}
- Transaction Date: ${transactionDate || 'Not provided'}
- Expected Delivery/Service Date: ${expectedDeliveryDate || 'Not provided'}

Visa reason codes:

FRAUD (Category 10):
- 10.1: EMV Liability Shift Counterfeit Fraud
- 10.2: EMV Liability Shift Non-Counterfeit Fraud
- 10.3: Other Fraud — Card-Present Environment
- 10.4: Other Fraud — Card-Absent Environment
- 10.5: Visa Fraud Monitoring Program

AUTHORIZATION (Category 11):
- 11.1: Card Recovery Bulletin
- 11.2: Declined Authorization
- 11.3: No Authorization

PROCESSING ERRORS (Category 12):
- 12.1: Late Presentment
- 12.2: Incorrect Transaction Code
- 12.3: Incorrect Currency
- 12.4: Incorrect Account Number
- 12.5: Incorrect Amount
- 12.6.1: Duplicate Processing
- 12.6.2: Paid by Other Means
- 12.7: Invalid Data

CONSUMER DISPUTES (Category 13):
- 13.1: Merchandise/Services Not Received
- 13.2: Cancelled Recurring Transaction
- 13.3: Not as Described / Defective Merchandise
- 13.4: Counterfeit Merchandise
- 13.5: Misrepresentation
- 13.6: Credit Not Processed
- 13.7: Cancelled Merchandise/Services
- 13.8: Original Credit Transaction Not Accepted
- 13.9: Non-Receipt of Cash or Load Transaction Value

FORMATTING RULES:
- For FRAUD codes (10.x): 2-3 sentences, ~50-70 words. State who, what, when, and that the cardholder did not authorize.
- For CONSUMER DISPUTE codes (13.x): 3-5 sentences, ~80-120 words. Facts, what the cardholder tried, what the cardholder is requesting.
- For PROCESSING ERROR codes (12.x): 2-4 sentences, ~60-90 words. State the error and the correct treatment.
- NEVER use first-person pronouns.
- Lead with facts. Save the ask for the final sentence.

Return ONLY a valid JSON object:
{
  "recommended_reason_code": "13.5",
  "reason_code_title": "Misrepresentation",
  "category": "fraud" | "authorization" | "processing_error" | "consumer_dispute",
  "confidence": "high" | "medium" | "low",
  "rationale": "1-2 sentences explaining why this reason code fits best.",
  "dispute_summary": "Tight operational dispute summary.",
  "missing_information": ["list", "of", "info", "needed"],
  "goodwill_outreach_required": true | false,
  "goodwill_outreach_note": "Brief note if required, otherwise empty string.",
  "alternative_codes": [{"code": "13.1", "title": "Services Not Received", "when_to_use": "One line"}]
}`

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (!response.ok) throw new Error(`API error: ${response.status}`)
      const data = await response.json()
      const text = data.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('')
        .replace(/```json|```/g, '')
        .trim()
      setResult(JSON.parse(text))
    } catch (e) {
      setError(`Analysis failed: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  const copySummary = () => {
    if (!result?.dispute_summary) return
    const formatted = `DISPUTE REASON CODE: ${result.recommended_reason_code} — ${result.reason_code_title}\n\n${result.dispute_summary}`
    navigator.clipboard.writeText(formatted)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const isFraud = result?.category === 'fraud'
  const window  = filingWindowStatus(isFraud)
  const evidence = result ? getEvidencePackage(result.recommended_reason_code, result.category) : null

  const impactStyle = (impact) => {
    if (impact === 'required')   return 'text-stone-900'
    if (impact === 'strengthens') return 'text-emerald-800'
    if (impact === 'weakens')    return 'text-red-800'
    return 'text-stone-700'
  }

  const impactLabel = (impact) => {
    if (impact === 'required')    return '— required'
    if (impact === 'strengthens') return '— strengthens case'
    if (impact === 'weakens')     return '— weakens case if present'
    if (impact === 'context')     return '— context only'
    return ''
  }

  return (
    <div className="min-h-screen" style={{ background: '#F5F1EA', fontFamily: 'Georgia, "Times New Roman", serif' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=JetBrains+Mono:wght@400;500&display=swap');
        .display-font { font-family: 'Fraunces', Georgia, serif; }
        .mono-font { font-family: 'JetBrains Mono', monospace; }
        .input-field {
          background: #FAF7F1; border: 1px solid #D4CCBC;
          padding: 14px 16px; font-family: 'Fraunces', Georgia, serif;
          font-size: 15px; width: 100%; color: #1A1814;
          transition: border-color 0.2s ease;
        }
        .input-field:focus { outline: none; border-color: #1A1814; }
        .input-label {
          font-family: 'JetBrains Mono', monospace; font-size: 10px;
          letter-spacing: 0.15em; text-transform: uppercase;
          color: #6B5F4D; margin-bottom: 6px; display: block;
        }
        .section-divider { border-top: 1px solid #1A1814; margin: 32px 0 24px 0; }
      `}</style>

      <div className="max-w-6xl mx-auto px-6 py-12">

        {/* ── Masthead ── */}
        <div className="border-b-2 border-black pb-8 mb-12">
          <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
            <div className="mono-font text-xs tracking-widest text-stone-600">ISSUE Nº 002 — DISPUTE OPERATIONS</div>
            <div className="mono-font text-xs tracking-widest text-stone-600">
              {new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}
            </div>
          </div>
          <h1 className="display-font font-bold text-stone-900 leading-none" style={{ fontSize: 'clamp(48px, 7vw, 88px)', letterSpacing: '-0.03em' }}>
            The Dispute<br />
            <span style={{ fontStyle: 'italic', fontWeight: 500 }}>Desk</span>
          </h1>
          <p className="display-font text-stone-700 mt-4 max-w-2xl" style={{ fontSize: '17px', lineHeight: '1.5' }}>
            An operational tool for translating customer complaints into compliant Visa dispute summaries — with a built-in evidence package for every case.
          </p>
        </div>

        {/* ── Steps 01 + 02 ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">

          {/* 01 — Case Intake */}
          <div>
            <div className="flex items-baseline gap-3 mb-6">
              <span className="mono-font text-xs text-stone-500">01</span>
              <h2 className="display-font font-semibold text-2xl text-stone-900" style={{ letterSpacing: '-0.01em' }}>Case Intake</h2>
            </div>

            <div className="space-y-5">
              <div>
                <label className="input-label">Customer Complaint</label>
                <textarea
                  value={complaint}
                  onChange={e => setComplaint(e.target.value)}
                  placeholder="Paste the cardholder's written complaint here..."
                  rows={6}
                  className="input-field"
                  style={{ resize: 'vertical' }}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="input-label">Merchant</label>
                  <input type="text" value={merchant} onChange={e => setMerchant(e.target.value)} placeholder="e.g. Sephora" className="input-field" />
                </div>
                <div>
                  <label className="input-label">Amount</label>
                  <div className="flex gap-2">
                    <input type="text" value={amount} onChange={e => setAmount(e.target.value)} placeholder="345.81" className="input-field" style={{ flex: 2 }} />
                    <select value={currency} onChange={e => setCurrency(e.target.value)} className="input-field mono-font" style={{ flex: 1, fontSize: '13px' }}>
                      <option>CAD</option><option>USD</option><option>EUR</option><option>GBP</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="input-label">Transaction Date</label>
                  <input type="date" value={transactionDate} onChange={e => setTransactionDate(e.target.value)} className="input-field mono-font" style={{ fontSize: '13px' }} />
                </div>
                <div>
                  <label className="input-label">Expected Delivery (Optional)</label>
                  <input type="date" value={expectedDeliveryDate} onChange={e => setExpectedDeliveryDate(e.target.value)} className="input-field mono-font" style={{ fontSize: '13px' }} />
                </div>
              </div>

              {window && (
                <div className={`p-4 border ${window.color === 'red' ? 'border-red-700 bg-red-50' : window.color === 'amber' ? 'border-amber-700 bg-amber-50' : 'border-emerald-700 bg-emerald-50'}`}>
                  <div className="mono-font text-xs tracking-widest mb-1 text-stone-700">FILING WINDOW</div>
                  <div className="display-font text-sm text-stone-900">{window.text}</div>
                </div>
              )}

              <button
                onClick={analyze}
                disabled={loading || !complaint.trim()}
                className="w-full bg-stone-900 text-stone-50 py-4 mono-font text-xs tracking-widest hover:bg-stone-800 disabled:bg-stone-400 transition-all flex items-center justify-center gap-3 group"
              >
                {loading
                  ? <><Loader2 className="w-4 h-4 animate-spin" /><span>ANALYZING CASE</span></>
                  : <><span>GENERATE DISPUTE SUMMARY</span><ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" /></>
                }
              </button>

              {error && (
                <div className="border border-red-700 bg-red-50 p-4 flex gap-3 items-start">
                  <AlertCircle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
                  <div className="display-font text-sm text-red-900">{error}</div>
                </div>
              )}
            </div>
          </div>

          {/* 02 — Analysis */}
          <div>
            <div className="flex items-baseline gap-3 mb-6">
              <span className="mono-font text-xs text-stone-500">02</span>
              <h2 className="display-font font-semibold text-2xl text-stone-900" style={{ letterSpacing: '-0.01em' }}>Analysis</h2>
            </div>

            {!result && !loading && (
              <div className="border border-dashed border-stone-400 p-12 text-center">
                <FileText className="w-8 h-8 text-stone-400 mx-auto mb-3" />
                <p className="display-font text-stone-500 italic">Output will appear here after analysis.</p>
              </div>
            )}

            {loading && (
              <div className="border border-stone-300 p-12 text-center bg-stone-50">
                <Loader2 className="w-8 h-8 text-stone-700 mx-auto mb-3 animate-spin" />
                <p className="display-font text-stone-700 italic">Reviewing complaint and matching to reason codes…</p>
              </div>
            )}

            {result && (
              <div className="space-y-6">

                {/* Reason code card */}
                <div className="border-2 border-stone-900 bg-stone-50 p-6">
                  <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
                    <div className="mono-font text-xs tracking-widest text-stone-600">RECOMMENDED REASON CODE</div>
                    <div className="flex gap-2 flex-wrap">
                      {result.category && (
                        <div className="mono-font text-xs px-2 py-1 bg-stone-200 text-stone-800">
                          {result.category.replace('_', ' ').toUpperCase()}
                        </div>
                      )}
                      <div className={`mono-font text-xs px-2 py-1 ${result.confidence === 'high' ? 'bg-emerald-900 text-emerald-50' : result.confidence === 'medium' ? 'bg-amber-900 text-amber-50' : 'bg-stone-700 text-stone-50'}`}>
                        {result.confidence?.toUpperCase()} CONFIDENCE
                      </div>
                    </div>
                  </div>
                  <div className="flex items-baseline gap-4 mb-3 flex-wrap">
                    <div className="display-font font-bold text-4xl text-stone-900">{result.recommended_reason_code}</div>
                    <div className="display-font italic text-xl text-stone-700">{result.reason_code_title}</div>
                  </div>
                  <p className="display-font text-stone-700 leading-relaxed text-[15px]">{result.rationale}</p>
                </div>

                {/* Dispute summary */}
                <div className="border border-stone-900 bg-white p-6">
                  <div className="flex items-baseline justify-between mb-4">
                    <div className="mono-font text-xs tracking-widest text-stone-600">DISPUTE SUMMARY — READY FOR VISA</div>
                    <button onClick={copySummary} className="mono-font text-xs flex items-center gap-1.5 text-stone-700 hover:text-stone-900 transition-colors">
                      {copied ? <><Check className="w-3 h-3" /> COPIED</> : <><Copy className="w-3 h-3" /> COPY</>}
                    </button>
                  </div>
                  <p className="display-font text-stone-900 leading-relaxed text-[16px]" style={{ lineHeight: '1.7' }}>
                    {result.dispute_summary}
                  </p>
                  {isFraud && (
                    <div className="mt-4 pt-4 border-t border-stone-200">
                      <p className="mono-font text-xs text-stone-500 italic">
                        Note: for fraud disputes, liability shifts automatically. A brief summary is sufficient — Visa does not require extended narrative for category 10.x.
                      </p>
                    </div>
                  )}
                </div>

                {/* Goodwill outreach flag */}
                {result.goodwill_outreach_required && (
                  <div className="border-l-4 border-amber-700 bg-amber-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-amber-900 mb-2">⚠ GOODWILL OUTREACH REQUIRED</div>
                    <p className="display-font text-stone-900 text-[15px] leading-relaxed">{result.goodwill_outreach_note}</p>
                  </div>
                )}

                {/* Missing info */}
                {result.missing_information?.length > 0 && (
                  <div className="border border-stone-400 bg-stone-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-stone-700 mb-3">INFORMATION NEEDED BEFORE FILING</div>
                    <ul className="space-y-2">
                      {result.missing_information.map((item, i) => (
                        <li key={i} className="display-font text-stone-800 text-[15px] flex gap-2">
                          <span className="text-stone-400">→</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Alternative codes */}
                {result.alternative_codes?.length > 0 && (
                  <div>
                    <div className="mono-font text-xs tracking-widest text-stone-600 mb-3">ALTERNATIVE CODES TO CONSIDER</div>
                    <div className="space-y-2">
                      {result.alternative_codes.map((alt, i) => (
                        <div key={i} className="border border-stone-300 bg-white p-4">
                          <div className="flex items-baseline gap-3 mb-1 flex-wrap">
                            <span className="mono-font text-sm font-bold text-stone-900">{alt.code}</span>
                            <span className="display-font italic text-stone-700 text-[15px]">{alt.title}</span>
                          </div>
                          <p className="display-font text-stone-600 text-sm">{alt.when_to_use}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Step 03 — Evidence Package ── */}
        {evidence && (
          <>
            <div className="section-divider" />
            <div>
              <div className="flex items-baseline gap-3 mb-2">
                <span className="mono-font text-xs text-stone-500">03</span>
                <h2 className="display-font font-semibold text-2xl text-stone-900" style={{ letterSpacing: '-0.01em' }}>Evidence Package</h2>
              </div>
              <p className="display-font text-stone-500 text-[15px] mb-8 ml-7" style={{ lineHeight: '1.5' }}>
                Evidence checklist for <span className="font-semibold text-stone-700">{result.recommended_reason_code} — {result.reason_code_title}</span>. Check items off as you collect them.
              </p>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Pull from systems */}
                {evidence.systems.length > 0 && (
                  <div className="border border-stone-300 bg-stone-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-stone-600 mb-4">PULL FROM YOUR SYSTEMS</div>
                    <div className="space-y-3">
                      {evidence.systems.map((item, i) => {
                        const key = `sys-${i}`
                        const done = !!checked[key]
                        return (
                          <button
                            key={key}
                            onClick={() => toggleCheck(key)}
                            className="w-full text-left flex gap-2.5 items-start group"
                          >
                            {done
                              ? <CheckSquare className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                              : <Square className="w-4 h-4 text-stone-400 shrink-0 mt-0.5 group-hover:text-stone-600" />
                            }
                            <div>
                              <span className={`display-font text-[14px] leading-snug ${done ? 'line-through text-stone-400' : impactStyle(item.impact)}`}>
                                {item.text}
                              </span>
                              {!done && (
                                <span className="mono-font text-[10px] text-stone-400 ml-1">{impactLabel(item.impact)}</span>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Collect from cardholder */}
                {evidence.cardholder.length > 0 && (
                  <div className="border border-stone-300 bg-stone-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-stone-600 mb-4">COLLECT FROM CARDHOLDER</div>
                    <div className="space-y-3">
                      {evidence.cardholder.map((item, i) => {
                        const key = `ch-${i}`
                        const done = !!checked[key]
                        return (
                          <button
                            key={key}
                            onClick={() => toggleCheck(key)}
                            className="w-full text-left flex gap-2.5 items-start group"
                          >
                            {done
                              ? <CheckSquare className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                              : <Square className="w-4 h-4 text-stone-400 shrink-0 mt-0.5 group-hover:text-stone-600" />
                            }
                            <div>
                              <span className={`display-font text-[14px] leading-snug ${done ? 'line-through text-stone-400' : impactStyle(item.impact)}`}>
                                {item.text}
                              </span>
                              {!done && (
                                <span className="mono-font text-[10px] text-stone-400 ml-1">{impactLabel(item.impact)}</span>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Watch for from merchant */}
                {evidence.merchant.length > 0 && (
                  <div className="border border-stone-300 bg-stone-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-stone-600 mb-4">WATCH FOR FROM MERCHANT</div>
                    <p className="display-font text-stone-500 text-[13px] italic mb-3">Merchant may submit these at representment. Know what could weaken or support your position.</p>
                    <div className="space-y-3">
                      {evidence.merchant.map((item, i) => {
                        const key = `mer-${i}`
                        const done = !!checked[key]
                        return (
                          <button
                            key={key}
                            onClick={() => toggleCheck(key)}
                            className="w-full text-left flex gap-2.5 items-start group"
                          >
                            {done
                              ? <CheckSquare className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                              : <Square className="w-4 h-4 text-stone-400 shrink-0 mt-0.5 group-hover:text-stone-600" />
                            }
                            <div>
                              <span className={`display-font text-[14px] leading-snug ${done ? 'line-through text-stone-400' : impactStyle(item.impact)}`}>
                                {item.text}
                              </span>
                              {!done && (
                                <span className="mono-font text-[10px] text-stone-400 ml-1">{impactLabel(item.impact)}</span>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* ── Footer ── */}
        <div className="section-divider" />
        <div className="flex items-baseline justify-between text-stone-600 flex-wrap gap-2">
          <div className="mono-font text-xs tracking-widest">BUILT BY ADEOTI FASHOKUN — RISK &amp; TRUST OPERATIONS</div>
          <div className="display-font italic text-sm">"Disputes resolve faster when the framework is written down."</div>
        </div>
      </div>
    </div>
  )
}
