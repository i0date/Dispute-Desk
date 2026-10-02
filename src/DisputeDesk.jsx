import React, { useState, useEffect } from 'react'
import { FileText, AlertCircle, Loader2, Copy, Check, ArrowRight, CheckSquare, Square, Shield, MessageSquare, ClipboardList, Download, Pencil } from 'lucide-react'

// ─── Error boundary — catches render crashes and shows the actual error ────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '40px', fontFamily: 'monospace', background: '#FFF1F1', minHeight: '100vh' }}>
          <div style={{ maxWidth: '700px', margin: '0 auto' }}>
            <div style={{ fontSize: '11px', letterSpacing: '0.1em', color: '#991B1B', marginBottom: '8px' }}>RENDER ERROR — PLEASE COPY AND SHARE</div>
            <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#1A1814', marginBottom: '16px' }}>{this.state.error.message}</div>
            <pre style={{ fontSize: '12px', color: '#7C3AED', whiteSpace: 'pre-wrap', background: '#F5F3FF', padding: '16px' }}>{this.state.error.stack}</pre>
            <button onClick={() => this.setState({ error: null })} style={{ marginTop: '16px', padding: '8px 16px', fontFamily: 'monospace', fontSize: '11px', cursor: 'pointer' }}>RETRY</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── Compliance threshold defaults ────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  smallDollarThreshold: 50,      // write-off below this amount
  sarThreshold:         5000,    // SAR flag above this amount
  fraudWindowDays:      120,     // fraud filing window (days from txn)
  consumerWindowDays:   120,     // consumer filing window (days from expected delivery)
  absoluteCapDays:      540,     // absolute filing cap (days from txn)
  pcMilestones:         [10, 45, 90], // provisional credit deadline milestones (business days)
}

// ─── DFA integration helpers ──────────────────────────────────────────────────

// Estimate DFA funding grade from reason code + amount (no behavioral signals in tracker)
const DFA_BASE_WIN = {
  "10.1": 0.85, "10.2": 0.48, "10.4": 0.76, "10.5": 0.93,
  "13.1": 0.41, "13.3": 0.30, "13.5": 0.57, "13.6": 0.68, "13.7": 0.44,
  "4837": 0.78, "4840": 0.72, "4849": 0.65, "4863": 0.73,
  "4870": 0.87, "4871": 0.81,
  "4841": 0.48, "4853": 0.33, "4855": 0.44, "4859": 0.46,
  "4860": 0.70, "4854": 0.38,
}
function estimateFundingGrade(reasonCode, amountStr) {
  if (!reasonCode || !amountStr) return null
  const code   = (reasonCode || '').split(/[\s–—]/)[0].trim()
  const amount = parseFloat(amountStr)
  if (isNaN(amount) || amount <= 0) return null
  const p = DFA_BASE_WIN[code] ?? 0.50
  const amtScore = amount < 50 ? 0.15 : amount < 100 ? 0.40 : amount < 200 ? 0.65 : amount <= 2000 ? 1.00 : amount <= 5000 ? 0.85 : 0.70
  const score = Math.round((p * 0.55 + 0.90 * 0.25 + amtScore * 0.20) * 100)
  if (score >= 75) return { label: 'A', bg: 'bg-emerald-900', text: 'text-emerald-50' }
  if (score >= 60) return { label: 'B', bg: 'bg-stone-700',   text: 'text-stone-50'  }
  if (score >= 45) return { label: 'C', bg: 'bg-amber-800',   text: 'text-amber-50'  }
  return              { label: 'D', bg: 'bg-red-900',     text: 'text-red-50'    }
}

// Export pending tracker cases as DFA-ready CSV
function exportDFACSV(outcomes) {
  const pending = outcomes.filter(o => o.status === 'pending')
  if (!pending.length) { alert('No pending cases to export.'); return }
  const headers = ['id','code','amount','filed_days_ago','window_days','avs_mismatch','no_3ds','delivery_confirmed','merchant_acknowledged','pin_verified','vfmp_enrolled','strong_docs','merchant_cbr','prior_claims','note']
  const rows = pending.map(o => {
    const code   = (o.reasonCode || '').split(/[\s–—]/)[0].trim()
    const amount = parseFloat(o.amount) || 0
    const note   = `"DisputeDesk export — ${o.merchant || ''} — ${o.amount || ''}. ${(o.notes || '').replace(/"/g,"'")}"`
    return [o.id, code, amount, 0, 120, 'no','no','no','no','no','no','no', '0.8', 0, note].join(',')
  })
  const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `disputedesk-to-dfa-${new Date().toISOString().split('T')[0]}.csv`
  a.click()
}

// Calendar days until a date (negative = past)
function daysUntil(date) {
  if (!date) return null
  return Math.round((new Date(date) - new Date()) / (1000 * 60 * 60 * 24))
}

// ─── Evidence package by reason code ─────────────────────────────────────────

function getEvidencePackage(code, category) {
  const base = { systems: [], cardholder: [], merchant: [] }

  // ── Visa Fraud (10.x) ──────────────────────────────────────────────────────
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

  // ── Visa Consumer Dispute (13.x) ──────────────────────────────────────────
  if (category === 'consumer_dispute') {
    base.cardholder.push(
      { text: 'Proof of purchase — receipt, order confirmation, or invoice', impact: 'required' },
      { text: "Proof of cardholder's direct contact with merchant — email, chat transcript, support ticket, or reference number", impact: 'required' },
      { text: "Merchant's response — or documented non-response (e.g. no reply after 15 days)", impact: 'required' },
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
      base.merchant.push({ text: 'Subscription terms and cancellation policy at time of signup', impact: 'context' })
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
        { text: 'Documentation of what was actually received vs. what was represented', impact: 'required' },
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
      base.merchant.push({ text: 'Merchant acknowledgement of credit or refund in writing', impact: 'strengthens' })
    }
    if (code === '13.7') {
      base.cardholder.push(
        { text: 'Cancellation confirmation — email, chat log, or reference number', impact: 'required' },
        { text: 'Service agreement or refund policy at time of booking', impact: 'strengthens' },
        { text: 'Proof that merchant failed to deliver the cancelled service', impact: 'required' },
      )
    }
  }

  // ── Mastercard Fraud (48xx) ───────────────────────────────────────────────
  if (category === 'mc_fraud') {
    base.systems = [
      { text: '3DS / SecureCode authentication result', impact: 'strengthens' },
      { text: 'AVS and CVV2 match/mismatch log', impact: 'strengthens' },
      { text: 'Device fingerprint and IP address at time of transaction', impact: 'strengthens' },
      { text: 'Velocity check — same-day or same-merchant activity', impact: 'strengthens' },
    ]
    base.cardholder = [
      { text: 'Signed non-authorization or fraud affidavit', impact: 'required' },
      { text: 'Card possession status at time of transaction', impact: 'required' },
    ]
    if (code === '4870' || code === '4871') {
      base.systems.push({ text: 'Terminal read method — confirm magnetic stripe used at chip-capable terminal', impact: 'required' })
      base.cardholder.push({ text: 'Lost or stolen card report (police report if available)', impact: 'strengthens' })
    }
    if (code === '4837' || code === '4863') {
      base.systems.push({ text: 'Confirmation that 3DS / SecureCode was not completed', impact: 'strengthens' })
    }
  }

  // ── Mastercard Consumer Dispute (48xx) ────────────────────────────────────
  if (category === 'mc_consumer_dispute') {
    base.cardholder.push(
      { text: 'Proof of purchase — receipt, order confirmation, or invoice', impact: 'required' },
      { text: "Proof of cardholder's direct contact with merchant — email, chat transcript, support ticket, or reference number", impact: 'required' },
      { text: "Merchant's response — or documented non-response (e.g. no reply after 15 days)", impact: 'required' },
    )
    if (code === '4853') {
      base.cardholder.push(
        { text: 'Photos of item as received', impact: 'required' },
        { text: 'Screenshots of original merchant listing or advertisement', impact: 'required' },
        { text: 'Return attempt documentation or merchant refusal to accept return', impact: 'strengthens' },
      )
    }
    if (code === '4855' || code === '4859') {
      base.cardholder.push(
        { text: 'Declaration of non-receipt or non-delivery of service', impact: 'required' },
        { text: 'Expected delivery or service date from merchant communication', impact: 'strengthens' },
        { text: 'Any tracking or booking confirmation showing no fulfilment', impact: 'strengthens' },
      )
      base.merchant.push(
        { text: 'Proof of delivery or service completion', impact: 'weakens' },
        { text: 'Signed receipt or confirmation of service rendered', impact: 'weakens' },
      )
    }
    if (code === '4860') {
      base.cardholder.push(
        { text: 'Return receipt or credit authorization from merchant', impact: 'required' },
        { text: 'Timeline: date return accepted vs. statement showing no credit applied', impact: 'required' },
      )
    }
    if (code === '4841') {
      base.cardholder.push(
        { text: 'Cancellation confirmation — email, reference number, or chat log', impact: 'required' },
        { text: 'Timeline: date cancelled vs. date of continued charges', impact: 'required' },
      )
      base.merchant.push({ text: 'Subscription terms and cancellation policy at signup', impact: 'context' })
    }
  }

  // ── Visa Processing Errors (12.x) ─────────────────────────────────────────
  if (category === 'processing_error') {
    base.systems.push(
      { text: 'Transaction record showing the error (duplicate, incorrect amount, etc.)', impact: 'required' },
      { text: 'Correct transaction or authorisation record for comparison', impact: 'required' },
    )
    base.cardholder.push({ text: 'Receipt or confirmation showing correct amount or single transaction', impact: 'strengthens' })
  }

  // ── Mastercard Processing Errors (48xx) ──────────────────────────────────
  if (category === 'mc_processing_error') {
    base.systems.push(
      { text: 'Transaction record showing the processing error', impact: 'required' },
      { text: 'Correct authorisation or transaction record for comparison', impact: 'required' },
    )
    base.cardholder.push({ text: 'Receipt or confirmation showing intended amount or single charge', impact: 'strengthens' })
  }

  return base
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DisputeDesk() {
  const [network, setNetwork]                               = useState('visa')
  const [complaint, setComplaint]                           = useState('')
  const [merchant, setMerchant]                             = useState('')
  const [amount, setAmount]                                 = useState('')
  const [transactionDate, setTransactionDate]               = useState('')
  const [expectedDeliveryDate, setExpectedDeliveryDate]     = useState('')
  const [currency, setCurrency]                             = useState('CAD')
  const [loading, setLoading]                               = useState(false)
  const [result, setResult]                                 = useState(null)
  const [error, setError]                                   = useState(null)
  const [copied, setCopied]                                 = useState(false)
  const [checked, setChecked]                               = useState({})
  const [rebuttal, setRebuttal]                             = useState(null)
  const [rebuttalLoading, setRebuttalLoading]               = useState(false)
  const [rebuttalError, setRebuttalError]                   = useState(null)
  const [comms, setComms]                                   = useState(null)
  const [commsLoading, setCommsLoading]                     = useState(false)
  const [commsError, setCommsError]                         = useState(null)
  const [commsCopied, setCommsCopied]                       = useState(false)
  const [docRequestCopied, setDocRequestCopied]             = useState(false)
  const [goodwillCopied, setGoodwillCopied]                 = useState(false)
  const [disputedAmount, setDisputedAmount]                 = useState('')     // partial dispute amount (optional)
  const [cardType, setCardType]                             = useState('credit') // 'credit' | 'debit'
  const [sarDiscoveryDate, setSarDiscoveryDate]             = useState('')     // FI: date fraud was detected (for SAR deadline)
  const [editingRow, setEditingRow]                         = useState(null)   // id of row being edited
  const [editDraft, setEditDraft]                           = useState({})     // draft field values

  // ── 3DS / authentication ──────────────────────────────────────────────────
  const [threeDSStatus, setThreeDSStatus]                   = useState('unknown') // 'not_attempted' | 'attempted_failed' | 'attempted_passed' | 'unknown'

  // ── Pre-arb response drafter ──────────────────────────────────────────────
  const [preArbDraft, setPreArbDraft]                       = useState(null)
  const [preArbLoading, setPreArbLoading]                   = useState(false)
  const [preArbError, setPreArbError]                       = useState(null)
  const [preArbCopied, setPreArbCopied]                     = useState(false)
  const [preArbTargetId, setPreArbTargetId]                 = useState(null) // tracker row ID
  const [merchantRepNotes, setMerchantRepNotes]             = useState({}) // {[outcomeId]: string}

  // ── Platform mode ─────────────────────────────────────────────────────────
  const [platformMode, setPlatformMode]                     = useState('fi') // 'fi' | 'merchant'

  // ── Merchant intake state ─────────────────────────────────────────────────
  const [mchReasonCode, setMchReasonCode]                   = useState('')
  const [mchOrderDate, setMchOrderDate]                     = useState('')
  const [mchOrderId, setMchOrderId]                         = useState('')
  const [mchCustomerEmail, setMchCustomerEmail]             = useState('')
  const [mchDeliveryConfirmed, setMchDeliveryConfirmed]     = useState('unknown')
  const [mchThreeDS, setMchThreeDS]                         = useState('unknown')
  const [mchRefundPolicyShown, setMchRefundPolicyShown]     = useState('unknown')
  const [mchPriorOrders, setMchPriorOrders]                 = useState('')
  const [mchIpLogs, setMchIpLogs]                           = useState('')
  const [mchCbDisputes, setMchCbDisputes]                   = useState('')
  const [mchCbTransactions, setMchCbTransactions]           = useState('')
  const [mchCbAmount, setMchCbAmount]                       = useState('')
  const [mchResult, setMchResult]                           = useState(null)
  const [mchLoading, setMchLoading]                         = useState(false)
  const [mchError, setMchError]                             = useState(null)
  const [mchRepLetter, setMchRepLetter]                     = useState(null)
  const [mchRepLetterLoading, setMchRepLetterLoading]       = useState(false)
  const [mchRepLetterError, setMchRepLetterError]           = useState(null)
  const [mchRepLetterCopied, setMchRepLetterCopied]         = useState(false)

  // ── Outcome tracking (60-day dispute log) ─────────────────────────────────
  const [outcomes, setOutcomes] = useState(() => {
    try { return JSON.parse(localStorage.getItem('dispute_desk_outcomes') || '[]') } catch { return [] }
  })
  useEffect(() => {
    localStorage.setItem('dispute_desk_outcomes', JSON.stringify(outcomes))
  }, [outcomes])

  // ── Compliance settings — persisted ───────────────────────────────────────
  const [settings, setSettings] = useState(() => {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('dd_settings') || '{}') } } catch { return { ...DEFAULT_SETTINGS } }
  })
  useEffect(() => {
    try { localStorage.setItem('dd_settings', JSON.stringify(settings)) } catch {}
  }, [settings])
  const [showSettings, setShowSettings] = useState(false)
  const updateSetting = (key, val) => setSettings(prev => ({ ...prev, [key]: val }))
  const resetSettings = () => { setSettings({ ...DEFAULT_SETTINGS }); try { localStorage.removeItem('dd_settings') } catch {} }

  // ── Triage handoff — read from URL query params on mount ─────────────────
  // localStorage cannot be used across Vercel domains (different origins)
  const [triageHandoff, setTriageHandoff] = useState(null)
  const [showHandoffBanner, setShowHandoffBanner] = useState(false)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const caseId = params.get('caseId')
      if (!caseId) return   // not a triage handoff
      const h = {
        caseId:          caseId,
        merchant:        params.get('merchant')        || '',
        amount:          params.get('amount')          || '',
        currency:        params.get('currency')        || 'CAD',
        transactionDate: params.get('transactionDate') || '',
        network:         params.get('network')         || '',
        accountType:     params.get('accountType')     || '',
        classification:  params.get('classification')  || '',
        confidence:      params.get('confidence')      || '',
        headline:        params.get('headline')        || '',
        routing:         params.get('routing')         || '',
        complaint:       params.get('complaint')       || '',
      }
      // Pre-fill intake fields
      if (h.merchant)         setMerchant(h.merchant)
      if (h.amount)           setAmount(h.amount)
      if (h.currency)         setCurrency(h.currency)
      if (h.transactionDate)  setTransactionDate(h.transactionDate)
      if (h.complaint)        setComplaint(h.complaint)
      // Map triage network → DisputeDesk network selector
      if (h.network) {
        const n = h.network.toLowerCase()
        if (n.includes('mastercard') || n.includes('mc')) setNetwork('mastercard')
        else if (n.includes('visa'))                       setNetwork('visa')
      }
      // FI handoff pre-fill
      if (true) {
        if (h.merchant)         setMerchant(h.merchant)
        if (h.amount)           setAmount(h.amount)
        if (h.currency)         setCurrency(h.currency)
        if (h.transactionDate)  setTransactionDate(h.transactionDate)
        if (h.complaint)        setComplaint(h.complaint)
        if (h.network) {
          const n = h.network.toLowerCase()
          if (n.includes('mastercard') || n.includes('mc')) setNetwork('mastercard')
          else if (n.includes('visa'))                       setNetwork('visa')
        }
      }
      setTriageHandoff(h)
      setShowHandoffBanner(true)
      window.history.replaceState({}, '', window.location.pathname)
    } catch {}
  }, [])

  const dismissHandoffBanner = () => setShowHandoffBanner(false)

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
    const fw = isFraud ? settings.fraudWindowDays : settings.consumerWindowDays
    const warnAt = Math.round(fw * 0.83)   // warn at ~83% of window
    if (isFraud) {
      if (cap > fw)     return { status: 'expired', text: `${cap} days since transaction — past ${fw}-day fraud filing window`, color: 'red' }
      if (cap > warnAt) return { status: 'warning', text: `${cap} days since transaction — only ${fw - cap} days remaining`, color: 'amber' }
      return { status: 'ok', text: `${cap} days since transaction — within ${fw}-day fraud filing window`, color: 'green' }
    }
    if (cap !== null && cap > settings.absoluteCapDays) return { status: 'expired', text: `Past ${settings.absoluteCapDays}-day absolute cap (${cap} days since transaction)`, color: 'red' }
    if (baseline > fw)     return { status: 'late',    text: `${baseline} days past baseline date — outside ${fw}-day standard window`, color: 'red' }
    if (baseline > warnAt) return { status: 'warning', text: `${baseline} days elapsed — only ${fw - baseline} days remaining`, color: 'amber' }
    return { status: 'ok', text: `${baseline} days elapsed — within ${fw}-day filing window`, color: 'green' }
  }

  // ─── Visa reason codes prompt section ───────────────────────────────────────
  const visaCodes = `
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
- 13.9: Non-Receipt of Cash or Load Transaction Value`

  const mastercardCodes = `
Mastercard reason codes:

FRAUD:
- 4837: No Cardholder Authorization
- 4840: Fraudulent Processing of Transactions
- 4849: Questionable Merchant Activity
- 4863: Cardholder Does Not Recognize — Potential Fraud
- 4870: Chip Liability Shift
- 4871: Chip/PIN Liability Shift

AUTHORIZATION:
- 4808: Authorization-Related Chargeback
- 4812: Account Number Not On File
- 4847: Required Authorization Not Obtained

PROCESSING ERRORS:
- 4831: Transaction Amount Differs
- 4834: Point-of-Interaction Error
- 4835: Card Not Valid or Expired
- 4842: Late Presentment
- 4846: Correct Transaction Currency Code Not Provided

CONSUMER DISPUTES:
- 4841: Cancelled Recurring or Digital Goods Transaction
- 4850: Installment Billing Dispute
- 4853: Cardholder Dispute — Defective / Not as Described
- 4854: Cardholder Dispute — Not Elsewhere Classified
- 4855: Goods or Services Not Provided
- 4859: Services Not Rendered
- 4860: Credit Not Processed
- 4999: Domestic Chargeback Dispute (Region Use Only)`

  const networkCodes = network === 'visa' ? visaCodes : mastercardCodes

  const categoryMap = network === 'visa'
    ? '"fraud" | "authorization" | "processing_error" | "consumer_dispute"'
    : '"mc_fraud" | "mc_authorization" | "mc_processing_error" | "mc_consumer_dispute"'

  // ─── Analyse ─────────────────────────────────────────────────────────────────
  const analyze = async () => {
    if (!complaint.trim()) { setError('Customer complaint is required.'); return }
    setLoading(true)
    setError(null)
    setResult(null)
    setRebuttal(null)
    setComms(null)
    setChecked({})

    const prompt = `You are an experienced ${network === 'visa' ? 'Visa' : 'Mastercard'} dispute analyst. You write dispute summaries in a tight, operational voice: flowing prose, NO first-person pronouns (no "I"), warm but professional, concise. Real dispute summaries are typically 3-5 sentences, around 80-120 words. Avoid legal-brief language, avoid hedging, avoid repetition.

Analyze this customer complaint and generate a structured dispute analysis.

CUSTOMER COMPLAINT:
"""${complaint}"""

TRANSACTION DETAILS:
- Merchant: ${merchant || 'Not provided'}
- Transaction Amount: ${amount ? `${amount} ${currency}` : 'Not provided'}${disputedAmount && parseFloat(disputedAmount) > 0 && disputedAmount !== amount ? `\n- Disputed Amount: ${disputedAmount} ${currency} (PARTIAL DISPUTE — cardholder is only disputing this portion of the transaction)` : ''}
- Transaction Date: ${transactionDate || 'Not provided'}
- Expected Delivery/Service Date: ${expectedDeliveryDate || 'Not provided'}
- Card Network: ${network === 'visa' ? 'Visa' : 'Mastercard'}
- Card Type: ${cardType === 'debit' ? 'Debit (Reg E / EFTA)' : 'Credit (Reg Z / FCBA)'}
- 3DS Status: ${threeDSStatus === 'not_attempted' ? 'Not attempted — supports fraud claim' : threeDSStatus === 'attempted_passed' ? 'Passed — liability may shift to issuer, review before filing' : threeDSStatus === 'attempted_failed' ? 'Attempted, authentication failed' : 'Unknown'}

${networkCodes}

FORMATTING RULES:
- For FRAUD codes: 2-3 sentences, ~50-70 words. State who, what, when, and that the cardholder did not authorize.
- For CONSUMER DISPUTE codes: 3-5 sentences, ~80-120 words. Facts, what the cardholder tried, what the cardholder is requesting.
- For PROCESSING ERROR codes: 2-4 sentences, ~60-90 words. State the error and the correct treatment.
- NEVER use first-person pronouns.
- Lead with facts. Save the ask for the final sentence.

Return ONLY a valid JSON object:
{
  "recommended_reason_code": "${network === 'visa' ? '13.5' : '4853'}",
  "reason_code_title": "Code title here",
  "category": ${categoryMap},
  "confidence": "high" | "medium" | "low",
  "rationale": "1-2 sentences explaining why this reason code fits best.",
  "dispute_summary": "Tight operational dispute summary.",
  "missing_information": ["list", "of", "info", "needed"],
  "goodwill_outreach_required": true | false,
  "goodwill_outreach_note": "Brief note if required, otherwise empty string.",
  "alternative_codes": [{"code": "4855", "title": "Goods Not Provided", "when_to_use": "One line"}]
}`

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
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
      const parsed = JSON.parse(text)
      setResult(parsed)
      // Save to outcome log
      setOutcomes(prev => [{
        id: `DD-${Date.now().toString(36).toUpperCase().slice(-5)}`,
        date: new Date().toISOString(),
        merchant: merchant || '—',
        amount: amount ? `${amount} ${currency}` : '—',
        network: network === 'visa' ? 'VISA' : 'MC',
        reasonCode: parsed.recommended_reason_code,
        reasonTitle: parsed.reason_code_title,
        status: 'pending',
        resolvedDate: null,
      }, ...prev])
    } catch (e) {
      setError(`Analysis failed: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  // ─── Rebuttal simulator ───────────────────────────────────────────────────
  const fetchRebuttal = async () => {
    if (!result) return
    setRebuttalLoading(true)
    setRebuttalError(null)
    setRebuttal(null)

    const prompt = `You are a chargeback representment expert who has reviewed thousands of merchant rebuttals. Given this dispute, predict exactly what the merchant will argue at representment — and how the issuer should counter it.

DISPUTE DETAILS:
- Network: ${network === 'visa' ? 'Visa' : 'Mastercard'}
- Reason Code: ${result.recommended_reason_code} — ${result.reason_code_title}
- Merchant: ${merchant || 'Unknown'}
- Amount: ${amount ? `${amount} ${currency}` : 'Unknown'}
- Dispute Summary: ${result.dispute_summary}

Be specific and realistic. Merchant arguments should reflect what this type of merchant actually argues for this reason code. Counter-strategy should be actionable for the issuing bank's dispute agent.

Return ONLY valid JSON:
{
  "merchant_arguments": [
    "Specific argument 1 the merchant will make",
    "Specific argument 2",
    "Specific argument 3"
  ],
  "merchant_evidence": [
    "Evidence item 1 merchant will likely submit",
    "Evidence item 2"
  ],
  "counter_strategy": [
    "Actionable counter point 1 for the issuer",
    "Actionable counter point 2"
  ],
  "win_risk": "LOW" | "MEDIUM" | "HIGH",
  "win_risk_note": "One sentence on how strong the merchant defense is likely to be and why."
}`

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
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
      setRebuttal(JSON.parse(text))
    } catch (e) {
      setRebuttalError(`Rebuttal preview failed: ${e.message}`)
    } finally {
      setRebuttalLoading(false)
    }
  }

  // ─── Customer communication ───────────────────────────────────────────────
  const fetchComms = async () => {
    if (!result) return
    setCommsLoading(true)
    setCommsError(null)
    setComms(null)

    const outcomeContext = (result.category === 'fraud' || result.category === 'mc_fraud')
      ? 'This is a confirmed fraud dispute. The cardholder did not authorize the transaction. The bank files through network rules — no merchant contact is involved.'
      : result.goodwill_outreach_required
      ? 'This is a consumer dispute where the cardholder must first attempt direct resolution with the merchant before the bank can file. The cardholder — not the bank or analyst — contacts the merchant directly (by email, phone, or chat). The bank cannot file until that outreach is documented.'
      : 'This is a consumer dispute being filed on behalf of the cardholder through Visa/Mastercard network rules. The bank does not contact the merchant directly — the chargeback is processed through the card network.'

    const prompt = `You are a customer communications specialist at an issuing bank. Write a professional, clear cardholder letter based on this dispute analysis.

DISPUTE DETAILS:
- Network: ${network === 'visa' ? 'Visa' : 'Mastercard'}
- Reason Code: ${result.recommended_reason_code} — ${result.reason_code_title}
- Merchant: ${merchant || 'Unknown'}
- Amount: ${amount ? `${amount} ${currency}` : 'Unknown'}
- Dispute Summary: ${result.dispute_summary}
- Context: ${outcomeContext}
- Goodwill outreach required: ${result.goodwill_outreach_required ? 'Yes — ' + result.goodwill_outreach_note : 'No'}
- Original complaint: "${complaint}"

SELECT THE CORRECT OUTCOME:
- FILING: dispute qualifies and the bank will file on the cardholder's behalf
- NOT_FILING: claim doesn't meet threshold or shows first-party indicators (e.g. pattern of prior disputes, transaction matches cardholder behaviour) — firm but professional, never accuse directly
- DECLINED_TXN: the transaction was already declined/reversed and there is no net loss to recover — explain this clearly so the customer understands
- INVESTIGATION: requires further information or review before a decision

CARD ACTION:
- CANCEL_RECOMMENDED: fraud confirmed or card may be compromised — advise cancellation and reissue
- MONITOR: suspicious activity but card status unclear
- NONE: no card action needed

WRITING RULES:
- Bank voice ("we" / "our")
- Empathetic for genuine fraud victims; firm but respectful if not filing
- Never accuse of fraud directly
- No legal jargon
- 3–4 short paragraphs in the body
- Do NOT include salutation or sign-off in the body field — those are injected separately
- Do NOT list specific documents or supporting materials in the body — document collection is handled separately. If outcome is INVESTIGATION, say only that we will be in touch regarding next steps.
- CRITICAL — WHO CONTACTS WHOM: The bank NEVER contacts the merchant directly. For fraud disputes, the chargeback is filed through the Visa/Mastercard network. For consumer disputes requiring merchant contact, the CARDHOLDER must reach out to the merchant themselves — if a next step references merchant contact, it must say "Contact [merchant] directly" addressed to the cardholder, never "We will contact the merchant on your behalf."

Return ONLY valid JSON:
{
  "outcome": "FILING" | "NOT_FILING" | "DECLINED_TXN" | "INVESTIGATION",
  "card_action": "CANCEL_RECOMMENDED" | "MONITOR" | "NONE",
  "subject": "Re: Your [brief description] — [merchant]",
  "body": "Letter body only. Separate paragraphs with \\n\\n.",
  "next_steps": ["Step 1", "Step 2", "Step 3"],
  "timeline": "e.g. 5–10 business days from the date of this letter"
}`

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1200,
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
      setComms(JSON.parse(text))
    } catch (e) {
      setCommsError(`Communication draft failed: ${e.message}`)
    } finally {
      setCommsLoading(false)
    }
  }

  // ─── Copy summary ─────────────────────────────────────────────────────────
  const copySummary = () => {
    if (!result?.dispute_summary) return
    const formatted = `DISPUTE REASON CODE: ${result.recommended_reason_code} — ${result.reason_code_title}\n\n${result.dispute_summary}`
    navigator.clipboard.writeText(formatted)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const commsOutcomeMap = {
    FILING:        { bg: 'bg-emerald-900', text: 'text-emerald-50', label: 'FILING DISPUTE'      },
    NOT_FILING:    { bg: 'bg-red-900',     text: 'text-red-50',     label: 'NOT FILING'          },
    DECLINED_TXN:  { bg: 'bg-stone-700',   text: 'text-stone-50',   label: 'TXN DECLINED'        },
    INVESTIGATION: { bg: 'bg-amber-800',   text: 'text-amber-50',   label: 'UNDER INVESTIGATION' },
  }
  const commsOc = comms ? (commsOutcomeMap[comms.outcome] || commsOutcomeMap.INVESTIGATION) : null
  const copyCommsLetter = () => {
    if (!comms) return
    const full = `Subject: ${comms.subject}\n\nDear Valued Cardholder,\n\n${comms.body}\n\nNext Steps:\n${comms.next_steps?.map(s => `• ${s}`).join('\n')}\n\nExpected timeline: ${comms.timeline}\n\nSincerely,\nCustomer Care Team`
    navigator.clipboard.writeText(full)
    setCommsCopied(true)
    setTimeout(() => setCommsCopied(false), 2000)
  }

  // ── Copy cardholder doc list (plain — paste into any channel) ──────────────
  const copyDocRequest = () => {
    if (!result || !evidence) return
    const items = evidence.cardholder.map((item, i) => `${i + 1}. ${item.text}`).join('\n')
    const missingSection = result.missing_information?.length > 0
      ? `\n\nAlso clarify:\n${result.missing_information.map(m => `• ${m}`).join('\n')}`
      : ''
    const full = `Documents needed — ${result.recommended_reason_code} (${result.reason_code_title}):\n\n${items}${missingSection}`
    navigator.clipboard.writeText(full)
    setDocRequestCopied(true)
    setTimeout(() => setDocRequestCopied(false), 2000)
  }

  // ── Goodwill copy helper ───────────────────────────────────────────────────
  const copyGoodwillScript = () => {
    if (!goodwillRec) return
    navigator.clipboard.writeText(goodwillRec.script)
    setGoodwillCopied(true)
    setTimeout(() => setGoodwillCopied(false), 2000)
  }

  // ── Provisional credit helpers ─────────────────────────────────────────────
  const addBusinessDays = (dateStr, bd) => {
    const d = new Date(dateStr)
    let added = 0
    const out = new Date(d)
    while (added < bd) {
      out.setDate(out.getDate() + 1)
      const dow = out.getDay()
      if (dow !== 0 && dow !== 6) added++
    }
    return out
  }
  const markProvCredit = (id) =>
    setOutcomes(prev => prev.map(o => o.id === id ? { ...o, provCreditDate: new Date().toISOString() } : o))

  // ── Pre-arb response drafter ──────────────────────────────────────────────
  const generatePreArbDraft = async (outcome) => {
    setPreArbLoading(true); setPreArbError(null); setPreArbDraft(null); setPreArbTargetId(outcome.id)
    const repNotes = merchantRepNotes[outcome.id] || ''
    const prompt = `You are a senior disputes analyst at a financial institution. Generate a formal pre-arbitration rebuttal.

CASE:
- ID: ${outcome.id}  - Merchant: ${outcome.merchant || 'N/A'}  - Amount: ${outcome.amount || 'N/A'}
- Network: ${(outcome.network || '').toUpperCase()}  - Reason Code: ${outcome.reasonCode || 'N/A'}
- Reason: ${outcome.reasonTitle || 'N/A'}  - Stage: ${outcome.status}

MERCHANT REPRESENTMENT:
${repNotes || 'No notes provided.'}

Return ONLY valid JSON:
{
  "summary": "2-sentence summary of issuer pre-arb position",
  "rebuttal_points": ["Point addressing each merchant argument with evidence/rule cite", "..."],
  "evidence_to_attach": ["Specific document to attach", "..."],
  "formal_statement": "200-300 word formal pre-arb statement for network submission",
  "filing_deadline_note": "Deadline and urgency note",
  "win_assessment": "STRONG" | "MODERATE" | "WEAK",
  "win_note": "1-2 sentences on success likelihood"
}`
    try {
      const res = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }) })
      if (!res.ok) throw new Error('API ' + res.status)
      const data = await res.json()
      const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('').replace(/```json|```/g, '').trim()
      setPreArbDraft(JSON.parse(text))
    } catch (e) { setPreArbError('Pre-arb draft failed: ' + e.message) }
    finally { setPreArbLoading(false) }
  }

  // ── Merchant dispute analyser ─────────────────────────────────────────────
  const analyzeMerchant = async () => {
    if (!complaint.trim()) { setMchError('Paste the chargeback notification or describe the dispute.'); return }
    setMchLoading(true); setMchError(null); setMchResult(null); setMchRepLetter(null)
    const tds = mchThreeDS === 'passed' ? 'Passed — liability shifts to issuer' : mchThreeDS === 'failed' ? 'Failed' : mchThreeDS === 'not_attempted' ? 'Not attempted' : 'Unknown'
    const prompt = 'You are an expert chargeback representment specialist advising a merchant. Analyze this chargeback and build the best defence strategy.\n\n'
      + 'CHARGEBACK DETAILS:\n- Reason Code: ' + (mchReasonCode || 'Not specified')
      + '\n- Network: ' + (network === 'visa' ? 'Visa' : 'Mastercard')
      + '\n- Amount: ' + (amount ? amount + ' ' + currency : 'Not specified')
      + '\n- Merchant: ' + (merchant || 'Not specified')
      + '\n- Order Date: ' + (mchOrderDate || 'Not specified')
      + '\n- Order ID: ' + (mchOrderId || 'Not specified')
      + '\n- Customer: ' + (mchCustomerEmail || 'Not specified')
      + '\n- Delivery Confirmed: ' + mchDeliveryConfirmed
      + '\n- 3DS: ' + tds
      + '\n- Refund Policy Shown at Checkout: ' + mchRefundPolicyShown
      + '\n- Prior Orders Same Customer: ' + (mchPriorOrders || 'Unknown')
      + '\n- IP/Location Notes: ' + (mchIpLogs || 'None')
      + '\n\nCHARGEBACK NOTIFICATION:\n"""' + complaint + '"""\n\n'
      + 'Return ONLY valid JSON:\n{\n'
      + '  "win_probability": "HIGH" | "MEDIUM" | "LOW",\n'
      + '  "win_note": "2-sentence win/loss likelihood",\n'
      + '  "rebuttal_strategy": "3-4 sentence representment strategy",\n'
      + '  "key_arguments": ["Argument 1", "Argument 2", "Argument 3"],\n'
      + '  "evidence_to_submit": [{"item": "Document", "priority": "required" | "strengthens", "note": "Why"}],\n'
      + '  "weaknesses": ["Weakness 1"],\n'
      + '  "deadline_note": "Representment deadline guidance",\n'
      + '  "liability_shift": true | false,\n'
      + '  "liability_shift_note": "One sentence or empty string"\n}'
    try {
      const res = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }) })
      if (!res.ok) throw new Error('API ' + res.status)
      const data = await res.json()
      const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('').replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(text)
      setMchResult(parsed)
      setOutcomes(prev => [{
        id: 'MCH-' + Date.now().toString(36).toUpperCase().slice(-5),
        date: new Date().toISOString(),
        merchant: merchant || '—',
        amount: amount ? amount + ' ' + currency : '—',
        network: network === 'visa' ? 'VISA' : 'MC',
        reasonCode: mchReasonCode || '—',
        reasonTitle: 'Merchant chargeback',
        status: 'pending',
        resolvedDate: null,
        mode: 'merchant',
      }, ...prev])
    } catch (e) { setMchError('Analysis failed: ' + e.message) }
    finally { setMchLoading(false) }
  }

  const generateRepLetter = async () => {
    if (!mchResult) return
    setMchRepLetterLoading(true); setMchRepLetterError(null); setMchRepLetter(null)
    const prompt = 'You are a professional chargeback representment writer. Draft a formal representment letter for a merchant to submit to their acquirer.\n\n'
      + 'CASE:\n- Reason Code: ' + (mchReasonCode || 'N/A') + ' (' + (network === 'visa' ? 'Visa' : 'Mastercard') + ')'
      + '\n- Amount: ' + (amount ? amount + ' ' + currency : 'N/A')
      + '\n- Merchant: ' + (merchant || 'N/A')
      + '\n- Order ID: ' + (mchOrderId || 'N/A')
      + '\n- Order Date: ' + (mchOrderDate || 'N/A')
      + '\n- Delivery Confirmed: ' + mchDeliveryConfirmed
      + '\n- 3DS: ' + mchThreeDS
      + '\n- Strategy: ' + (mchResult.rebuttal_strategy || '')
      + '\n- Key Arguments: ' + (mchResult.key_arguments || []).join('; ')
      + '\n\nWrite a professional representment letter (300-450 words) from the merchant to their acquirer. '
      + 'Opening: state purpose and chargeback reference. Body: make the case, cite evidence. Closing: state the request and contact. '
      + 'Merchant speaks as "we". Return ONLY the letter text, no JSON or metadata.'
    try {
      const res = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }) })
      if (!res.ok) throw new Error('API ' + res.status)
      const data = await res.json()
      setMchRepLetter(data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim())
    } catch (e) { setMchRepLetterError('Letter failed: ' + e.message) }
    finally { setMchRepLetterLoading(false) }
  }

  // ── CBR calculations (merchant mode) ──────────────────────────────────────
  const cbrPct = (mchCbDisputes && mchCbTransactions && parseFloat(mchCbTransactions) > 0)
    ? (parseFloat(mchCbDisputes) / parseFloat(mchCbTransactions)) * 100
    : null
  const cbrAmtNum     = parseFloat(mchCbAmount) || 0
  const visaVdmpBreach = cbrPct !== null && cbrPct >= 0.9  && cbrAmtNum >= 75000
  const visaVdmpWarn   = cbrPct !== null && cbrPct >= 0.65 && !visaVdmpBreach
  const mcMdmpBreach   = cbrPct !== null && cbrPct >= 1.5  && cbrAmtNum >= 1000
  const mcMdmpWarn     = cbrPct !== null && cbrPct >= 1.0  && !mcMdmpBreach

  // ── Outcome tracker helpers ────────────────────────────────────────────────
  const markCaseOutcome = (id, status) =>
    setOutcomes(prev => prev.map(o => o.id === id ? { ...o, status, resolvedDate: new Date().toISOString() } : o))

  const revertCase = (id) =>
    setOutcomes(prev => prev.map(o => o.id === id ? { ...o, status: 'pending', resolvedDate: null } : o))

  const startEdit = (o) => {
    setEditingRow(o.id)
    setEditDraft({ merchant: o.merchant, amount: o.amount, reasonCode: o.reasonCode, reasonTitle: o.reasonTitle, notes: o.notes || '' })
  }
  const cancelEdit = () => { setEditingRow(null); setEditDraft({}) }
  const saveEdit = (id) => {
    setOutcomes(prev => prev.map(o => o.id === id ? { ...o, ...editDraft } : o))
    setEditingRow(null)
    setEditDraft({})
  }
  const deleteCase = (id) => {
    if (window.confirm('Remove this case from the tracker?')) {
      setOutcomes(prev => prev.filter(o => o.id !== id))
      if (editingRow === id) { setEditingRow(null); setEditDraft({}) }
    }
  }

  const exportCSV = () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    const rows = outcomes.filter(o => new Date(o.date) > sixtyDaysAgo)
    const headers = ['Case ID', 'Date Opened', 'Merchant', 'Amount', 'Network', 'Reason Code', 'Status', 'Resolved Date', 'Prov Credit Date', '45BD Deadline']
    const csv = [
      headers.join(','),
      ...rows.map(o => {
        const pc45 = o.provCreditDate ? addBusinessDays(o.provCreditDate, 45) : null
        return [
          o.id,
          new Date(o.date).toLocaleDateString('en-CA'),
          `"${o.merchant}"`,
          `"${o.amount}"`,
          o.network,
          `"${o.reasonCode} — ${o.reasonTitle}"`,
          o.status,
          o.resolvedDate ? new Date(o.resolvedDate).toLocaleDateString('en-CA') : '',
          o.provCreditDate ? new Date(o.provCreditDate).toLocaleDateString('en-CA') : '',
          pc45 ? pc45.toLocaleDateString('en-CA') : '',
        ].join(',')
      })
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `dispute-desk-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── FI SAR deadline (30 days from detection date, FinCEN / FINTRAC) ────────
  const fiSarDeadlineRaw = sarDiscoveryDate
    ? new Date(new Date(sarDiscoveryDate).getTime() + 30 * 86400000)
    : null
  const fiSarDeadline  = fiSarDeadlineRaw ? fiSarDeadlineRaw.toLocaleDateString('en-CA') : null
  const fiSarDaysLeft  = fiSarDeadlineRaw ? Math.ceil((fiSarDeadlineRaw - new Date()) / 86400000) : null

  // ── Reg E provisional credit deadline (10 BD from when dispute is received) ──
  // Used when cardType === 'debit' and an analysis has been run
  const regEPcDue = (cardType === 'debit' && result)
    ? addBusinessDays(new Date().toISOString(), 10).toLocaleDateString('en-CA')
    : null
  const regEInvDue = (cardType === 'debit' && result)
    ? addBusinessDays(new Date().toISOString(), 45).toLocaleDateString('en-CA')
    : null

  const isFraud     = result?.category === 'fraud' || result?.category === 'mc_fraud'
  let filingWindow  = null
  try { filingWindow = filingWindowStatus(isFraud) } catch(e) { console.error('[DD] filingWindow crash:', e) }
  let evidence      = null
  try { evidence = result ? getEvidencePackage(result?.recommended_reason_code, result?.category) : null } catch(e) { console.error('[DD] evidence crash:', e) }

  // effectiveAmount: use disputed amount if provided (partial dispute), otherwise use full transaction amount
  const isPartialDispute   = disputedAmount && parseFloat(disputedAmount) > 0 && disputedAmount !== amount
  const effectiveAmount    = isPartialDispute ? disputedAmount : amount
  const effectiveAmtNum    = parseFloat(effectiveAmount) || 0
  const smallDollar        = effectiveAmtNum > 0 && effectiveAmtNum < settings.smallDollarThreshold

  // Goodwill recommendation — only set when goodwill is actually the recommended path
  let goodwillRec = null
  try {
    if (result) {
      const amtStr      = effectiveAmount ? `${effectiveAmount} ${currency}` : 'the disputed amount'
      const merchantStr = merchant || 'the merchant'
      const partialNote = isPartialDispute ? ` (partial dispute — cardholder is disputing ${disputedAmount} ${currency} of a ${amount} ${currency} transaction)` : ''
      if (smallDollar) {
        goodwillRec = {
          recommended: true, type: 'WRITE-OFF RECOMMENDED',
          typeColor: 'bg-amber-800 text-amber-50',
          rationale: `At ${amtStr}${partialNote}, investigation and network fees may exceed recovery (write-off threshold: $${settings.smallDollarThreshold}). A direct courtesy credit is the most efficient resolution.`,
          script: `Hi [Cardholder name],\n\nI've reviewed your dispute regarding ${merchantStr} for ${amtStr}. Given the amount, I'd like to resolve this right away by applying a one-time courtesy credit of ${amtStr} to your account — no formal chargeback required. This will appear within 3-5 business days.\n\nShall I go ahead and apply that credit now?`,
        }
      } else if (result.goodwill_outreach_required) {
        goodwillRec = {
          recommended: true, type: 'GOODWILL RECOMMENDED',
          typeColor: 'bg-amber-700 text-amber-50',
          rationale: result.goodwill_outreach_note || 'Case may not meet all dispute criteria. A goodwill credit protects the customer relationship.',
          script: `Hi [Cardholder name],\n\nThank you for your patience as we reviewed your dispute for ${amtStr} at ${merchantStr}${partialNote ? partialNote : ''}. While this case presents some challenges for a formal dispute, we value your relationship and want to make this right. I'd like to offer a one-time courtesy credit of ${amtStr} as a gesture of goodwill — it will appear within 3-5 business days.\n\nShall I go ahead and apply it?`,
        }
      } else {
        // Clear dispute path — goodwill is NOT recommended. No script needed.
        goodwillRec = {
          recommended: false, type: 'NOT RECOMMENDED',
          typeColor: 'bg-stone-700 text-stone-50',
          rationale: 'A clear chargeback path exists for this case. A courtesy credit would under-recover for the cardholder and is unnecessary — proceed with formal dispute filing using Steps 01–04.',
        }
      }
    }
  } catch(e) { console.error('[DD] goodwillRec crash:', e) }

  // Outcome tracker: 60-day window only
  // Lifecycle stages: pending → filed → representment → pre_arb → won | lost | withdrawn
  const LIFECYCLE_IN_PROGRESS = new Set(['filed', 'representment', 'pre_arb'])
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  const visibleOutcomes = outcomes.filter(o => new Date(o.date) > sixtyDaysAgo)
  const wonCount        = visibleOutcomes.filter(o => o.status === 'won').length
  const lostCount       = visibleOutcomes.filter(o => o.status === 'lost').length
  const withdrawnCount  = visibleOutcomes.filter(o => o.status === 'withdrawn').length
  const inProgressCount = visibleOutcomes.filter(o => LIFECYCLE_IN_PROGRESS.has(o.status)).length
  const resolvedCount   = wonCount + lostCount + withdrawnCount
  const winRate         = resolvedCount > 0 ? Math.round((wonCount / resolvedCount) * 100) : null

  // Advance a case to the next lifecycle stage
  const advanceStage = (id, newStatus) =>
    setOutcomes(prev => prev.map(o => o.id === id ? { ...o, status: newStatus } : o))

  // Analytics — derived from visibleOutcomes
  const [showAnalytics, setShowAnalytics] = useState(false)
  const analytics = React.useMemo(() => {
    const resolved = visibleOutcomes.filter(o => o.status === 'won' || o.status === 'lost')
    // by network
    const byNetwork = {}
    resolved.forEach(o => {
      const net = o.network || '—'
      if (!byNetwork[net]) byNetwork[net] = { won: 0, total: 0 }
      byNetwork[net].total++
      if (o.status === 'won') byNetwork[net].won++
    })
    // by reason code (top 6)
    const byCode = {}
    resolved.forEach(o => {
      const code = (o.reasonCode || '—').split(/[\s–—]/)[0].trim()
      if (!byCode[code]) byCode[code] = { won: 0, total: 0 }
      byCode[code].total++
      if (o.status === 'won') byCode[code].won++
    })
    const topCodes = Object.entries(byCode).sort((a, b) => b[1].total - a[1].total).slice(0, 6)
    // weekly trend (last 8 weeks)
    const weeks = []
    for (let w = 7; w >= 0; w--) {
      const from = new Date(Date.now() - (w + 1) * 7 * 24 * 60 * 60 * 1000)
      const to   = new Date(Date.now() - w * 7 * 24 * 60 * 60 * 1000)
      const wk   = visibleOutcomes.filter(o => { const d = new Date(o.date); return d >= from && d < to })
      const wWon = wk.filter(o => o.status === 'won').length
      const wRes = wk.filter(o => o.status === 'won' || o.status === 'lost').length
      weeks.push({ label: `W${8 - w}`, total: wk.length, won: wWon, resolved: wRes, rate: wRes > 0 ? Math.round(wWon / wRes * 100) : null })
    }
    // avg resolution time
    const times = visibleOutcomes.filter(o => o.resolvedDate && o.date).map(o => Math.round((new Date(o.resolvedDate) - new Date(o.date)) / (1000 * 60 * 60 * 24)))
    const avgDays = times.length > 0 ? Math.round(times.reduce((s, t) => s + t, 0) / times.length) : null
    return { byNetwork, topCodes, weeks, avgDays, resolvedCount: resolved.length }
  }, [visibleOutcomes])

  const impactStyle = (impact) => {
    if (impact === 'required')    return 'text-stone-900'
    if (impact === 'strengthens') return 'text-emerald-800'
    if (impact === 'weakens')     return 'text-red-800'
    return 'text-stone-700'
  }

  const impactLabel = (impact) => {
    if (impact === 'required')    return '— required'
    if (impact === 'strengthens') return '— strengthens case'
    if (impact === 'weakens')     return '— weakens case if present'
    if (impact === 'context')     return '— context only'
    return ''
  }

  const winRiskColor = (risk) => {
    if (risk === 'LOW')    return { bg: 'bg-emerald-900', text: 'text-emerald-50' }
    if (risk === 'MEDIUM') return { bg: 'bg-amber-800',   text: 'text-amber-50'   }
    if (risk === 'HIGH')   return { bg: 'bg-red-900',     text: 'text-red-50'     }
    return { bg: 'bg-stone-700', text: 'text-stone-50' }
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <ErrorBoundary>
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
        .network-btn {
          font-family: 'JetBrains Mono', monospace; font-size: 11px;
          letter-spacing: 0.12em; padding: 10px 20px;
          border: 1px solid #1A1814; cursor: pointer;
          transition: all 0.15s ease; flex: 1; text-align: center;
        }
        .network-btn.active { background: #1A1814; color: #F5F1EA; }
        .network-btn.inactive { background: #FAF7F1; color: #6B5F4D; }
        .network-btn.inactive:hover { background: #F0EBE2; }
      `}</style>

      <div className="max-w-6xl mx-auto px-4 py-8 sm:px-6 sm:py-12">

        {/* ── Masthead ── */}
        <div className="border-b-2 border-black pb-6 mb-8 sm:pb-8 sm:mb-12">
          <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
            <div className="mono-font text-xs tracking-widest text-stone-600 hidden sm:block">ISSUE Nº 002 — DISPUTE OPERATIONS</div>
            <div className="mono-font text-xs tracking-widest text-stone-600 sm:hidden">DISPUTE OPERATIONS</div>
            <div className="mono-font text-xs tracking-widest text-stone-600">
              {new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}
            </div>
          </div>
          <h1 className="display-font font-bold text-stone-900 leading-none" style={{ fontSize: 'clamp(48px, 7vw, 88px)', letterSpacing: '-0.03em' }}>
            The Dispute<br />
            <span style={{ fontStyle: 'italic', fontWeight: 500 }}>Desk</span>
          </h1>
          <p className="display-font text-stone-700 mt-4 max-w-2xl" style={{ fontSize: 'clamp(15px, 2vw, 17px)', lineHeight: '1.5' }}>
            An operational tool for translating customer complaints into compliant dispute summaries — with a built-in evidence package and merchant defense preview for every case.
          </p>
          <div className="flex items-center mt-6" style={{ borderTop: '1px solid #D4CCBC', paddingTop: '20px' }}>
            <button onClick={() => setPlatformMode('fi')} className={'mono-font text-xs tracking-widest px-5 py-2.5 border border-stone-900 transition-all ' + (platformMode === 'fi' ? 'bg-stone-900 text-stone-50' : 'bg-transparent text-stone-600 hover:bg-stone-100')}>ISSUER / FI MODE</button>
            <button onClick={() => setPlatformMode('merchant')} className={'mono-font text-xs tracking-widest px-5 py-2.5 border-t border-b border-r border-stone-900 transition-all ' + (platformMode === 'merchant' ? 'bg-stone-900 text-stone-50' : 'bg-transparent text-stone-600 hover:bg-stone-100')}>MERCHANT MODE</button>
            <span className={'mono-font text-[10px] tracking-wide ml-4 ' + (platformMode === 'merchant' ? 'text-amber-700' : 'text-stone-400')}>
              {platformMode === 'fi' ? 'Issuing bank — review cardholder disputes, file chargebacks' : 'Merchant — fight chargebacks, build representment packages'}
            </span>
          </div>
        </div>

        {/* ── Triage handoff banner ── */}
        {showHandoffBanner && triageHandoff && (
          <div className="mb-6 flex items-start gap-3 px-4 py-3" style={{ background: '#ECFDF5', border: '1px solid #6EE7B7' }}>
            <Shield className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#065F46' }} />
            <div className="flex-1 min-w-0">
              <span className="mono-font text-xs tracking-widest" style={{ color: '#064E3B' }}>PRE-FILLED FROM TRIAGE — </span>
              <span className="mono-font text-xs" style={{ color: '#065F46' }}>
                Case {triageHandoff.caseId} · {triageHandoff.classification?.replace(/_/g, ' ')} · {triageHandoff.confidence} confidence
              </span>
              {triageHandoff.headline && (
                <div className="display-font italic text-sm mt-1" style={{ color: '#065F46' }}>"{triageHandoff.headline}"</div>
              )}
            </div>
            <button onClick={dismissHandoffBanner} className="mono-font text-xs shrink-0" style={{ color: '#065F46' }}>✕</button>
          </div>
        )}

        {/* ── Steps 01 + 02 ── */}
        {platformMode === 'fi' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">


          {/* ════ FI INTAKE FORM ════ */}
          <div>
            <div className="flex items-baseline gap-3 mb-6">
              <span className="mono-font text-xs text-stone-500">01</span>
              <h2 className="display-font font-semibold text-2xl text-stone-900" style={{ letterSpacing: '-0.01em' }}>Case Intake</h2>
            </div>

            <div className="space-y-5">

              {/* Network + card type selectors */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="input-label">Card Network</label>
                  <div className="flex gap-0">
                    <button
                      onClick={() => setNetwork('visa')}
                      className={`network-btn ${network === 'visa' ? 'active' : 'inactive'}`}
                    >
                      VISA
                    </button>
                    <button
                      onClick={() => setNetwork('mastercard')}
                      className={`network-btn ${network === 'mastercard' ? 'active' : 'inactive'}`}
                    >
                      MASTERCARD
                    </button>
                  </div>
                </div>
                <div>
                  <label className="input-label">Card Type</label>
                  <div className="flex gap-0">
                    <button
                      onClick={() => setCardType('credit')}
                      className={`network-btn ${cardType === 'credit' ? 'active' : 'inactive'}`}
                    >
                      CREDIT
                    </button>
                    <button
                      onClick={() => setCardType('debit')}
                      className={`network-btn ${cardType === 'debit' ? 'active' : 'inactive'}`}
                    >
                      DEBIT
                    </button>
                  </div>
                  {cardType === 'debit' && (
                    <div className="mt-1.5 mono-font text-[10px] text-blue-800 tracking-wide">
                      Reg E / EFTA applies — PC required within 10 business days
                    </div>
                  )}
                </div>
              </div>

              {/* 3DS / authentication status */}
              <div>
                <label className="input-label">3DS / Authentication Status <span className="mono-font text-[10px] text-stone-400 normal-case tracking-normal">(for CNP disputes — affects reason code strength)</span></label>
                <div className="flex gap-0 flex-wrap">
                  {[
                    { id: 'not_attempted', label: 'NOT ATTEMPTED' },
                    { id: 'attempted_failed', label: 'ATTEMPTED — FAILED' },
                    { id: 'attempted_passed', label: 'ATTEMPTED — PASSED' },
                    { id: 'unknown', label: 'UNKNOWN' },
                  ].map(opt => (
                    <button key={opt.id} onClick={() => setThreeDSStatus(opt.id)}
                      className={"network-btn " + (threeDSStatus === opt.id ? 'active' : 'inactive')}
                    >{opt.label}</button>
                  ))}
                </div>
                {threeDSStatus === 'attempted_passed' && (
                  <div className="mt-1.5 mono-font text-[10px] text-red-800 tracking-wide">
                    ⚠ Passed 3DS typically shifts liability to issuer — review before filing 10.4 CNP
                  </div>
                )}
                {threeDSStatus === 'not_attempted' && (
                  <div className="mt-1.5 mono-font text-[10px] text-emerald-800 tracking-wide">
                    No 3DS strengthens fraud disputes — include in evidence package
                  </div>
                )}
              </div>

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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="input-label">Merchant</label>
                  <input type="text" value={merchant} onChange={e => setMerchant(e.target.value)} placeholder="e.g. Sephora" className="input-field" />
                </div>
                <div>
                  <label className="input-label">Transaction Amount</label>
                  <div className="flex gap-2">
                    <input type="text" value={amount} onChange={e => setAmount(e.target.value)} placeholder="345.81" className="input-field" style={{ flex: 2 }} />
                    <select value={currency} onChange={e => setCurrency(e.target.value)} className="input-field mono-font" style={{ flex: 1, fontSize: '13px' }}>
                      <option>CAD</option><option>USD</option><option>EUR</option><option>GBP</option>
                    </select>
                  </div>
                </div>
              </div>

              <div>
                <label className="input-label">Disputed Amount <span className="mono-font text-[10px] text-stone-400 normal-case tracking-normal">(if partial — leave blank if disputing full amount)</span></label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={disputedAmount}
                    onChange={e => setDisputedAmount(e.target.value)}
                    placeholder={amount || '0.00'}
                    className="input-field"
                    style={{ maxWidth: '200px' }}
                  />
                  {disputedAmount && parseFloat(disputedAmount) > 0 && disputedAmount !== amount && (
                    <span className="mono-font text-[10px] text-amber-700 self-center">PARTIAL — disputing {disputedAmount} of {amount || '?'} {currency}</span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="input-label">Transaction Date</label>
                  <input type="date" value={transactionDate} onChange={e => setTransactionDate(e.target.value)} className="input-field mono-font" style={{ fontSize: '13px' }} />
                </div>
                <div>
                  <label className="input-label">Expected Delivery (Optional)</label>
                  <input type="date" value={expectedDeliveryDate} onChange={e => setExpectedDeliveryDate(e.target.value)} className="input-field mono-font" style={{ fontSize: '13px' }} />
                </div>
              </div>

              {/* SAR discovery date — optional, shows SAR deadline when filled */}
              <div>
                <label className="input-label">
                  Date Fraud Detected / Reported <span className="mono-font text-[10px] text-stone-400 normal-case tracking-normal">(optional — enables SAR deadline tracking)</span>
                </label>
                <div className="flex items-center gap-3 flex-wrap">
                  <input type="date" value={sarDiscoveryDate} onChange={e => setSarDiscoveryDate(e.target.value)} className="input-field mono-font" style={{ fontSize: '13px', maxWidth: '200px' }} />
                  {fiSarDeadline && (
                    <div className={`mono-font text-xs px-2 py-1 ${fiSarDaysLeft !== null && fiSarDaysLeft <= 7 ? 'bg-red-900 text-red-50' : fiSarDaysLeft !== null && fiSarDaysLeft <= 14 ? 'bg-amber-800 text-amber-50' : 'bg-stone-700 text-stone-50'}`}>
                      SAR deadline: {fiSarDeadline} · {fiSarDaysLeft !== null ? `${fiSarDaysLeft}d remaining` : ''}
                    </div>
                  )}
                </div>
              </div>

              {smallDollar && (
                <div className="border border-stone-400 bg-stone-50 p-4">
                  <div className="mono-font text-xs tracking-widest text-stone-500 mb-1">⚠ SMALL DOLLAR — CONSIDER WRITE-OFF</div>
                  <p className="display-font text-stone-700 text-[14px] leading-relaxed">
                    At {effectiveAmount} {currency}{isPartialDispute ? ` (partial dispute on a ${amount} ${currency} transaction)` : ''}, staff time and network fees may exceed recovery. Consider a direct courtesy credit before filing a formal dispute.
                  </p>
                </div>
              )}

              {filingWindow && (
                <div className={`p-4 border ${filingWindow.color === 'red' ? 'border-red-700 bg-red-50' : filingWindow.color === 'amber' ? 'border-amber-700 bg-amber-50' : 'border-emerald-700 bg-emerald-50'}`}>
                  <div className="mono-font text-xs tracking-widest mb-1 text-stone-700">FILING WINDOW</div>
                  <div className="display-font text-sm text-stone-900">{filingWindow.text}</div>
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


          {/* ════ FI ANALYSIS (02) ════ */}
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

                {/* Network badge */}
                <div className="mono-font text-xs tracking-widest text-stone-500 flex items-center gap-2">
                  <span className={`px-2 py-0.5 text-white ${network === 'visa' ? 'bg-blue-800' : 'bg-red-900'}`}>
                    {network === 'visa' ? 'VISA' : 'MASTERCARD'}
                  </span>
                  <span>REASON CODE ANALYSIS</span>
                </div>

                {/* Reason code card */}
                <div className="border-2 border-stone-900 bg-stone-50 p-6">
                  <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
                    <div className="mono-font text-xs tracking-widest text-stone-600">RECOMMENDED REASON CODE</div>
                    <div className="flex gap-2 flex-wrap">
                      {result.category && (
                        <div className="mono-font text-xs px-2 py-1 bg-stone-200 text-stone-800">
                          {result.category.replace('mc_', '').replace('_', ' ').toUpperCase()}
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
                    <div className="mono-font text-xs tracking-widest text-stone-600">
                      DISPUTE SUMMARY — READY FOR {network === 'visa' ? 'VISA' : 'MASTERCARD'}
                    </div>
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
                        Note: for fraud disputes, liability shifts automatically. A brief summary is sufficient — the network does not require extended narrative for fraud reason codes.
                      </p>
                    </div>
                  )}
                </div>

                {/* Merchant contact required flag */}
                {result.goodwill_outreach_required && (
                  <div className="border-l-4 border-amber-700 bg-amber-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-amber-900 mb-2">⚠ CARDHOLDER MUST CONTACT MERCHANT FIRST</div>
                    <p className="display-font text-stone-900 text-[15px] leading-relaxed">{result.goodwill_outreach_note}</p>
                    <p className="mono-font text-xs text-amber-800 mt-2">The cardholder — not the bank — contacts the merchant directly. The bank cannot file until that outreach and the merchant's response (or non-response) are documented.</p>
                  </div>
                )}

                {/* SAR / STR reminder — with deadline countdown when discovery date is set */}
                {isFraud && effectiveAmtNum >= settings.sarThreshold && (
                  <div className="border-l-4 border-red-800 bg-red-50 p-5 space-y-3">
                    <div className="mono-font text-xs tracking-widest text-red-900">⚠ SAR / STR REVIEW REQUIRED</div>
                    <p className="display-font text-stone-900 text-[15px] leading-relaxed">
                      This fraud case meets or exceeds the ${settings.sarThreshold.toLocaleString()} threshold. Review for <strong>Suspicious Activity Report</strong> (SAR / FinCEN) or <strong>Suspicious Transaction Report</strong> (STR / FINTRAC) filing requirements per your institution's BSA/AML policy.
                    </p>
                    {fiSarDeadline ? (
                      <div className={`flex items-center gap-3 mono-font text-xs px-3 py-2 ${fiSarDaysLeft !== null && fiSarDaysLeft <= 7 ? 'bg-red-900 text-red-50' : fiSarDaysLeft !== null && fiSarDaysLeft <= 14 ? 'bg-amber-800 text-amber-50' : 'bg-stone-800 text-stone-100'}`}>
                        <span>SAR DEADLINE: {fiSarDeadline}</span>
                        {fiSarDaysLeft !== null && (
                          <span className="font-bold">
                            {fiSarDaysLeft > 0 ? `${fiSarDaysLeft} DAYS REMAINING` : fiSarDaysLeft === 0 ? 'DUE TODAY' : `${Math.abs(fiSarDaysLeft)} DAYS OVERDUE`}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="mono-font text-[11px] text-red-700 italic">
                        ↑ Enter the date fraud was detected in the intake form above to track the 30-day SAR filing deadline.
                      </div>
                    )}
                  </div>
                )}

                {/* Reg E / EFTA compliance block — debit cards only */}
                {cardType === 'debit' && (
                  <div className="border-l-4 p-5 space-y-2" style={{ borderColor: '#1d4ed8', background: '#eff6ff' }}>
                    <div className="mono-font text-xs tracking-widest" style={{ color: '#1e3a8a' }}>REG E / EFTA — DEBIT CARD</div>
                    <p className="display-font text-stone-900 text-[15px] leading-relaxed">
                      This is a debit card dispute. <strong>Regulation E</strong> requires the financial institution to issue provisional credit within <strong>10 business days</strong> of receiving the claim (5 business days for established accounts). Investigation must be completed within <strong>45 business days</strong> (20 business days for point-of-sale or foreign-initiated transactions).
                    </p>
                    {regEPcDue && (
                      <div className="flex flex-wrap gap-4 pt-1">
                        <div className="mono-font text-xs" style={{ color: '#1e40af' }}>
                          <span className="text-stone-500">PC DUE BY: </span><span className="font-bold">{regEPcDue}</span>
                        </div>
                        <div className="mono-font text-xs" style={{ color: '#1e40af' }}>
                          <span className="text-stone-500">INVESTIGATION DUE: </span><span className="font-bold">{regEInvDue}</span>
                        </div>
                      </div>
                    )}
                    <p className="mono-font text-[10px] text-stone-500 italic pt-1">
                      Note: these dates are calculated from today (date of analysis). Adjust if claim was received on a different date.
                    </p>
                  </div>
                )}

                {/* Visa CE3.0 warning — 10.4 Card-Not-Present disputes */}
                {result?.recommended_reason_code?.startsWith('10.4') && network === 'visa' && (
                  <div className="border-l-4 p-5 space-y-3" style={{ borderColor: '#7e22ce', background: '#faf5ff' }}>
                    <div className="mono-font text-xs tracking-widest" style={{ color: '#581c87' }}>⚠ VISA COMPELLING EVIDENCE 3.0 — VERIFY BEFORE FILING</div>
                    <p className="display-font text-stone-900 text-[15px] leading-relaxed">
                      <strong>Visa CE3.0</strong> (active since April 2023) allows merchants to defeat 10.4 CNP fraud chargebacks if they can show two or more prior <em>undisputed</em> transactions from the same device fingerprint and/or IP address within the 120 days preceding this transaction. If the merchant is CE3.0-enabled and has that evidence on file, your chargeback will be reversed.
                    </p>
                    <div className="space-y-1.5">
                      <div className="mono-font text-xs tracking-widest text-stone-500 mb-2">CHECK BEFORE FILING:</div>
                      {[
                        'Is this cardholder a repeat customer at this merchant? If yes, CE3.0 risk is high.',
                        'Pull IP address and device fingerprint from this transaction — do they match prior undisputed orders?',
                        'Ask cardholder: have they ever shopped at this merchant before, even successfully?',
                        'If prior undisputed transactions exist on the same device/IP, consider downgrading to 10.5 (VFMP) or escalating to fraud ops for further review before filing.',
                      ].map((item, i) => (
                        <div key={i} className="display-font text-[14px] flex gap-2 items-start leading-snug" style={{ color: '#4c1d95' }}>
                          <span className="shrink-0 mt-0.5" style={{ color: '#9333ea' }}>→</span>
                          <span>{item}</span>
                        </div>
                      ))}
                    </div>
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

        )}

        {/* ── Steps 01 + 02 — Merchant Mode ── */}
        {platformMode === 'merchant' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">

          {/* ════ MERCHANT INTAKE FORM ════ */}
          <div>
            <div className="flex items-baseline gap-3 mb-6">
              <span className="mono-font text-xs text-stone-500">01</span>
              <h2 className="display-font font-semibold text-2xl text-stone-900" style={{ letterSpacing: '-0.01em' }}>Chargeback Intake</h2>
            </div>
            <div className="space-y-5">

              <div>
                <label className="input-label">Card Network</label>
                <div className="flex gap-0">
                  <button onClick={() => setNetwork('visa')} className={'network-btn ' + (network === 'visa' ? 'active' : 'inactive')}>VISA</button>
                  <button onClick={() => setNetwork('mastercard')} className={'network-btn ' + (network === 'mastercard' ? 'active' : 'inactive')}>MASTERCARD</button>
                </div>
              </div>

              <div>
                <label className="input-label">Reason Code from Issuer <span className="mono-font text-[10px] text-stone-400 normal-case tracking-normal">(e.g. 10.4, 4853 — from your acquirer notification)</span></label>
                <input type="text" value={mchReasonCode} onChange={e => setMchReasonCode(e.target.value)} placeholder="e.g. 13.1" className="input-field" />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="input-label">Merchant / Store Name</label>
                  <input type="text" value={merchant} onChange={e => setMerchant(e.target.value)} placeholder="Your business name" className="input-field" />
                </div>
                <div>
                  <label className="input-label">Chargeback Amount</label>
                  <div className="flex gap-2">
                    <input type="text" value={amount} onChange={e => setAmount(e.target.value)} placeholder="345.81" className="input-field" style={{ flex: 2 }} />
                    <select value={currency} onChange={e => setCurrency(e.target.value)} className="input-field mono-font" style={{ flex: 1, fontSize: '13px' }}>
                      <option>CAD</option><option>USD</option><option>EUR</option><option>GBP</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="input-label">Original Order Date</label>
                  <input type="date" value={mchOrderDate} onChange={e => setMchOrderDate(e.target.value)} className="input-field mono-font" style={{ fontSize: '13px' }} />
                </div>
                <div>
                  <label className="input-label">Chargeback Received Date</label>
                  <input type="date" value={transactionDate} onChange={e => setTransactionDate(e.target.value)} className="input-field mono-font" style={{ fontSize: '13px' }} />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="input-label">Order ID / Reference</label>
                  <input type="text" value={mchOrderId} onChange={e => setMchOrderId(e.target.value)} placeholder="ORD-2024-00183" className="input-field" />
                </div>
                <div>
                  <label className="input-label">Customer Email / ID</label>
                  <input type="text" value={mchCustomerEmail} onChange={e => setMchCustomerEmail(e.target.value)} placeholder="customer@email.com" className="input-field" />
                </div>
              </div>

              <div>
                <label className="input-label">Chargeback Notification / Customer Claim</label>
                <textarea value={complaint} onChange={e => setComplaint(e.target.value)} placeholder="Paste the chargeback notification or describe the dispute..." rows={5} className="input-field" style={{ resize: 'vertical' }} />
              </div>

              <div>
                <label className="input-label">Delivery / Service Confirmed</label>
                <div className="flex gap-0 flex-wrap">
                  {[{ id: 'yes', label: 'YES — CONFIRMED' }, { id: 'no', label: 'NO / UNCONFIRMED' }, { id: 'unknown', label: 'UNKNOWN' }].map(opt => (
                    <button key={opt.id} onClick={() => setMchDeliveryConfirmed(opt.id)} className={'network-btn ' + (mchDeliveryConfirmed === opt.id ? 'active' : 'inactive')}>{opt.label}</button>
                  ))}
                </div>
                {mchDeliveryConfirmed === 'yes' && <div className="mt-1.5 mono-font text-[10px] text-emerald-800 tracking-wide">Confirmed delivery strengthens 13.1 / 4855 defence — include tracking proof</div>}
                {mchDeliveryConfirmed === 'no' && <div className="mt-1.5 mono-font text-[10px] text-amber-800 tracking-wide">Unconfirmed delivery weakens position — focus other arguments</div>}
              </div>

              <div>
                <label className="input-label">3DS Authentication Result</label>
                <div className="flex gap-0 flex-wrap">
                  {[{ id: 'passed', label: 'PASSED' }, { id: 'failed', label: 'FAILED' }, { id: 'not_attempted', label: 'NOT ATTEMPTED' }, { id: 'unknown', label: 'UNKNOWN' }].map(opt => (
                    <button key={opt.id} onClick={() => setMchThreeDS(opt.id)} className={'network-btn ' + (mchThreeDS === opt.id ? 'active' : 'inactive')}>{opt.label}</button>
                  ))}
                </div>
                {mchThreeDS === 'passed' && <div className="mt-1.5 mono-font text-[10px] text-emerald-800 tracking-wide">Liability shifts to issuer — strong defence for 10.4 / 4837 fraud chargebacks</div>}
                {mchThreeDS === 'not_attempted' && <div className="mt-1.5 mono-font text-[10px] text-amber-800 tracking-wide">No 3DS = no liability shift — harder to fight fraud-coded chargebacks</div>}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="input-label">Refund Policy Shown at Checkout</label>
                  <div className="flex gap-0">
                    {[{ id: 'yes', label: 'YES' }, { id: 'no', label: 'NO' }, { id: 'unknown', label: 'UNK' }].map(opt => (
                      <button key={opt.id} onClick={() => setMchRefundPolicyShown(opt.id)} className={'network-btn ' + (mchRefundPolicyShown === opt.id ? 'active' : 'inactive')}>{opt.label}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="input-label">Prior Orders (Same Customer)</label>
                  <input type="number" value={mchPriorOrders} onChange={e => setMchPriorOrders(e.target.value)} placeholder="0" className="input-field mono-font" style={{ fontSize: '13px' }} />
                </div>
              </div>

              <div>
                <label className="input-label">IP / Location Notes <span className="mono-font text-[10px] text-stone-400 normal-case tracking-normal">(AVS match, IP vs billing, device fingerprint)</span></label>
                <input type="text" value={mchIpLogs} onChange={e => setMchIpLogs(e.target.value)} placeholder="e.g. IP matches billing zip, AVS match, same device as prior orders" className="input-field" />
              </div>

              <div className="border border-stone-300 p-4 space-y-3" style={{ background: '#EEE9E0' }}>
                <div className="mono-font text-[10px] tracking-widest text-stone-600">CBR MONITOR — THIS MONTH</div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="input-label">DISPUTES</label>
                    <input type="number" value={mchCbDisputes} onChange={e => setMchCbDisputes(e.target.value)} placeholder="12" className="input-field mono-font" style={{ fontSize: '13px' }} />
                  </div>
                  <div>
                    <label className="input-label">TOTAL TXNS</label>
                    <input type="number" value={mchCbTransactions} onChange={e => setMchCbTransactions(e.target.value)} placeholder="2400" className="input-field mono-font" style={{ fontSize: '13px' }} />
                  </div>
                  <div>
                    <label className="input-label">DISPUTE VOL ($)</label>
                    <input type="number" value={mchCbAmount} onChange={e => setMchCbAmount(e.target.value)} placeholder="8500" className="input-field mono-font" style={{ fontSize: '13px' }} />
                  </div>
                </div>
                {cbrPct !== null && (
                  <div className={'mono-font text-[10px] px-3 py-2 flex flex-wrap items-center gap-3 ' + (visaVdmpBreach || mcMdmpBreach ? 'bg-red-900 text-red-50' : visaVdmpWarn || mcMdmpWarn ? 'bg-amber-800 text-amber-50' : 'bg-emerald-900 text-emerald-50')}>
                    <span className="font-bold">CBR: {cbrPct.toFixed(3)}%</span>
                    {visaVdmpBreach && <span>VISA VDMP BREACH — {cbrPct.toFixed(2)}% above 0.90% threshold</span>}
                    {!visaVdmpBreach && visaVdmpWarn && <span>Approaching VISA VDMP ({cbrPct.toFixed(2)}% — threshold 0.90%)</span>}
                    {mcMdmpBreach && <span>MC MDMP BREACH — {cbrPct.toFixed(2)}% above 1.50% threshold</span>}
                    {!mcMdmpBreach && mcMdmpWarn && <span>Approaching MC MDMP ({cbrPct.toFixed(2)}% — threshold 1.50%)</span>}
                    {!visaVdmpBreach && !visaVdmpWarn && !mcMdmpBreach && !mcMdmpWarn && <span>Within network thresholds</span>}
                  </div>
                )}
              </div>

              <button onClick={analyzeMerchant} disabled={mchLoading || !complaint.trim()}
                className="w-full bg-stone-900 text-stone-50 py-4 mono-font text-xs tracking-widest hover:bg-stone-800 disabled:bg-stone-400 transition-all flex items-center justify-center gap-3 group">
                {mchLoading
                  ? <><Loader2 className="w-4 h-4 animate-spin" /><span>ANALYZING CHARGEBACK</span></>
                  : <><span>ANALYZE &amp; BUILD DEFENCE</span><ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" /></>}
              </button>

              {mchError && (
                <div className="border border-red-700 bg-red-50 p-4 flex gap-3 items-start">
                  <AlertCircle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
                  <div className="display-font text-sm text-red-900">{mchError}</div>
                </div>
              )}
            </div>
          </div>

          {/* ════ MERCHANT ANALYSIS (02) ════ */}
          <div>
            <div className="flex items-baseline gap-3 mb-6">
              <span className="mono-font text-xs text-stone-500">02</span>
              <h2 className="display-font font-semibold text-2xl text-stone-900" style={{ letterSpacing: '-0.01em' }}>Defence Strategy</h2>
            </div>
            {!mchResult && !mchLoading && (
              <div className="border border-dashed border-stone-400 p-12 text-center">
                <Shield className="w-8 h-8 text-stone-400 mx-auto mb-3" />
                <p className="display-font text-stone-500 italic">Defence strategy will appear after analysis.</p>
              </div>
            )}
            {mchLoading && (
              <div className="border border-stone-300 p-12 text-center bg-stone-50">
                <Loader2 className="w-8 h-8 text-stone-700 mx-auto mb-3 animate-spin" />
                <p className="display-font text-stone-700 italic">Building representment strategy…</p>
              </div>
            )}
            {mchResult && (
              <div className="space-y-6">
                <div className="border-2 border-stone-900 bg-stone-50 p-6">
                  <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                    <div className="mono-font text-xs tracking-widest text-stone-600">WIN PROBABILITY</div>
                    <span className={'mono-font text-sm font-bold px-3 py-1 ' + (mchResult.win_probability === 'HIGH' ? 'bg-emerald-900 text-emerald-50' : mchResult.win_probability === 'MEDIUM' ? 'bg-amber-800 text-amber-50' : 'bg-red-900 text-red-50')}>
                      {mchResult.win_probability}
                    </span>
                  </div>
                  <p className="display-font text-stone-700 leading-relaxed text-[15px]">{mchResult.win_note}</p>
                  {mchResult.liability_shift && (
                    <div className="mt-3 pt-3 border-t border-stone-200">
                      <div className="mono-font text-[10px] tracking-widest text-emerald-800 mb-1">LIABILITY SHIFT</div>
                      <p className="display-font text-emerald-900 text-[14px]">{mchResult.liability_shift_note}</p>
                    </div>
                  )}
                </div>
                <div className="border border-stone-900 bg-white p-6">
                  <div className="mono-font text-xs tracking-widest text-stone-600 mb-4">REPRESENTMENT STRATEGY</div>
                  <p className="display-font text-stone-900 leading-relaxed text-[15px]" style={{ lineHeight: '1.7' }}>{mchResult.rebuttal_strategy}</p>
                </div>
                {mchResult.key_arguments && mchResult.key_arguments.length > 0 && (
                  <div className="border-l-4 border-stone-900 bg-stone-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-stone-600 mb-3">KEY ARGUMENTS</div>
                    <div className="space-y-2">
                      {mchResult.key_arguments.map((arg, i) => (
                        <div key={i} className="display-font text-stone-800 text-[14px] flex gap-2 leading-snug">
                          <span className="mono-font text-[11px] text-stone-500 shrink-0 mt-0.5">{i+1}.</span>
                          <span>{arg}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {mchResult.evidence_to_submit && mchResult.evidence_to_submit.length > 0 && (
                  <div className="border border-stone-300 p-5" style={{ background: '#FAF7F1' }}>
                    <div className="mono-font text-xs tracking-widest text-stone-600 mb-3">EVIDENCE TO SUBMIT</div>
                    <div className="space-y-3">
                      {mchResult.evidence_to_submit.map((ev, i) => (
                        <div key={i} className="flex gap-2 items-start">
                          <span className={'mono-font text-[9px] tracking-widest px-1.5 py-0.5 mt-0.5 shrink-0 ' + (ev.priority === 'required' ? 'bg-stone-900 text-stone-50' : 'bg-stone-300 text-stone-700')}>{(ev.priority || '').toUpperCase()}</span>
                          <div>
                            <div className="display-font text-stone-800 text-[14px] font-medium">{ev.item}</div>
                            <div className="display-font text-stone-500 text-[12px] italic">{ev.note}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {mchResult.weaknesses && mchResult.weaknesses.length > 0 && (
                  <div className="border-l-4 border-amber-700 bg-amber-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-amber-900 mb-2">WEAKNESSES TO ADDRESS</div>
                    <div className="space-y-1.5">
                      {mchResult.weaknesses.map((w, i) => (
                        <div key={i} className="display-font text-stone-800 text-[14px] flex gap-2 leading-snug">
                          <span className="text-amber-600 shrink-0 mt-0.5">→</span>
                          <span>{w}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {mchResult.deadline_note && (
                  <div className="mono-font text-[11px] text-amber-800 tracking-wide border border-amber-300 bg-amber-50 px-3 py-2">
                    {mchResult.deadline_note}
                  </div>
                )}
                {!mchRepLetter && !mchRepLetterLoading && (
                  <button onClick={generateRepLetter}
                    className="flex items-center gap-3 px-6 py-4 bg-stone-900 text-stone-50 mono-font text-xs tracking-widest hover:bg-stone-800 transition-all group w-full justify-center">
                    <FileText className="w-4 h-4" />
                    <span>GENERATE REPRESENTMENT LETTER</span>
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </button>
                )}
                {mchRepLetterLoading && (
                  <div className="border border-stone-300 p-8 bg-stone-50 flex items-center gap-3">
                    <Loader2 className="w-5 h-5 text-stone-600 animate-spin shrink-0" />
                    <p className="display-font text-stone-600 italic">Drafting representment letter…</p>
                  </div>
                )}
                {mchRepLetterError && (
                  <div className="border border-red-700 bg-red-50 p-4 flex gap-3 items-start">
                    <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
                    <span className="display-font text-sm text-red-900">{mchRepLetterError}</span>
                  </div>
                )}
                {mchRepLetter && (
                  <div className="border border-stone-900">
                    <div className="bg-stone-900 px-4 py-3 flex items-center justify-between">
                      <div className="mono-font text-[10px] tracking-widest text-stone-400">REPRESENTMENT LETTER</div>
                      <button onClick={() => { navigator.clipboard.writeText(mchRepLetter); setMchRepLetterCopied(true); setTimeout(() => setMchRepLetterCopied(false), 2000) }}
                        className="mono-font text-[10px] flex items-center gap-1.5 text-stone-400 hover:text-stone-200 transition-colors">
                        {mchRepLetterCopied ? <><Check className="w-3 h-3" /> COPIED</> : <><Copy className="w-3 h-3" /> COPY</>}
                      </button>
                    </div>
                    <div className="bg-white p-5">
                      {mchRepLetter.split('\n\n').map((para, i) => (
                        <p key={i} className={'display-font text-stone-800 text-[14px] leading-relaxed ' + (i > 0 ? 'mt-3' : '')}>{para}</p>
                      ))}
                    </div>
                    <div className="bg-stone-50 px-4 py-2 border-t border-stone-200">
                      <button onClick={generateRepLetter} className="mono-font text-[10px] tracking-widest text-stone-500 hover:text-stone-800 transition-colors">↺ REGENERATE</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

        </div>
        )}

        {platformMode === 'fi' && (<>
        {/* ── Step 03 — Evidence Package ── */}
            <div className="section-divider" />
            <div>
              <div className="flex items-baseline gap-3 mb-2">
                <span className="mono-font text-xs text-stone-500">03</span>
                <h2 className="display-font font-semibold text-2xl text-stone-900" style={{ letterSpacing: '-0.01em' }}>Evidence Package</h2>
              </div>
              <p className="display-font text-stone-500 text-[15px] mb-8 ml-7" style={{ lineHeight: '1.5' }}>
                {result ? <>Evidence checklist for <span className="font-semibold text-stone-700">{result.recommended_reason_code} — {result.reason_code_title}</span>. Check items off as you collect them.</> : <>What to collect from your systems, cardholder, and the merchant for each reason code.</>}
              </p>

              {!evidence && (
                <div className="border border-dashed border-stone-300 p-10 text-center" style={{ background: '#FAF7F1' }}>
                  <FileText className="w-7 h-7 text-stone-300 mx-auto mb-3" />
                  <p className="display-font text-stone-400 italic text-[14px]">Run an analysis first to generate the evidence package.</p>
                </div>
              )}

              {evidence && <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {evidence.systems.length > 0 && (
                  <div className="border border-stone-300 bg-stone-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-stone-600 mb-4">PULL FROM YOUR SYSTEMS</div>
                    <div className="space-y-3">
                      {evidence.systems.map((item, i) => {
                        const key = `sys-${i}`
                        const done = !!checked[key]
                        return (
                          <button key={key} onClick={() => toggleCheck(key)} className="w-full text-left flex gap-2.5 items-start group">
                            {done ? <CheckSquare className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" /> : <Square className="w-4 h-4 text-stone-400 shrink-0 mt-0.5 group-hover:text-stone-600" />}
                            <div>
                              <span className={`display-font text-[14px] leading-snug ${done ? 'line-through text-stone-400' : impactStyle(item.impact)}`}>{item.text}</span>
                              {!done && <span className="mono-font text-[10px] text-stone-400 ml-1">{impactLabel(item.impact)}</span>}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {evidence.cardholder.length > 0 && (
                  <div className="border border-stone-300 bg-stone-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-stone-600 mb-4">COLLECT FROM CARDHOLDER</div>
                    <div className="space-y-3">
                      {evidence.cardholder.map((item, i) => {
                        const key = `ch-${i}`
                        const done = !!checked[key]
                        return (
                          <button key={key} onClick={() => toggleCheck(key)} className="w-full text-left flex gap-2.5 items-start group">
                            {done ? <CheckSquare className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" /> : <Square className="w-4 h-4 text-stone-400 shrink-0 mt-0.5 group-hover:text-stone-600" />}
                            <div>
                              <span className={`display-font text-[14px] leading-snug ${done ? 'line-through text-stone-400' : impactStyle(item.impact)}`}>{item.text}</span>
                              {!done && <span className="mono-font text-[10px] text-stone-400 ml-1">{impactLabel(item.impact)}</span>}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {evidence.merchant.length > 0 && (
                  <div className="border border-stone-300 bg-stone-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-stone-600 mb-4">WATCH FOR FROM MERCHANT</div>
                    <p className="display-font text-stone-500 text-[13px] italic mb-3">Merchant may submit these at representment. Know what could weaken or support your position.</p>
                    <div className="space-y-3">
                      {evidence.merchant.map((item, i) => {
                        const key = `mer-${i}`
                        const done = !!checked[key]
                        return (
                          <button key={key} onClick={() => toggleCheck(key)} className="w-full text-left flex gap-2.5 items-start group">
                            {done ? <CheckSquare className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" /> : <Square className="w-4 h-4 text-stone-400 shrink-0 mt-0.5 group-hover:text-stone-600" />}
                            <div>
                              <span className={`display-font text-[14px] leading-snug ${done ? 'line-through text-stone-400' : impactStyle(item.impact)}`}>{item.text}</span>
                              {!done && <span className="mono-font text-[10px] text-stone-400 ml-1">{impactLabel(item.impact)}</span>}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>}
            </div>

        {/* ── Step 04 — Merchant Defense Preview ── */}
            <div className="section-divider" />
            <div>
              <div className="flex items-baseline gap-3 mb-2">
                <span className="mono-font text-xs text-stone-500">04</span>
                <h2 className="display-font font-semibold text-2xl text-stone-900" style={{ letterSpacing: '-0.01em' }}>Merchant Defense Preview</h2>
              </div>
              <p className="display-font text-stone-500 text-[15px] mb-6 ml-7" style={{ lineHeight: '1.5' }}>
                Anticipate what the merchant will argue at representment — before they file it.
              </p>

              {!result && (
                <div className="border border-dashed border-stone-300 p-10 text-center" style={{ background: '#FAF7F1' }}>
                  <Shield className="w-7 h-7 text-stone-300 mx-auto mb-3" />
                  <p className="display-font text-stone-400 italic text-[14px]">Run an analysis first to generate the merchant defense preview.</p>
                </div>
              )}
              {result && !rebuttal && !rebuttalLoading && (
                <button
                  onClick={fetchRebuttal}
                  className="flex items-center gap-3 px-6 py-4 bg-stone-900 text-stone-50 mono-font text-xs tracking-widest hover:bg-stone-800 transition-all group"
                >
                  <Shield className="w-4 h-4" />
                  <span>GENERATE MERCHANT DEFENSE PREVIEW</span>
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </button>
              )}

              {rebuttalLoading && (
                <div className="border border-stone-300 p-8 bg-stone-50 flex items-center gap-3">
                  <Loader2 className="w-5 h-5 text-stone-600 animate-spin shrink-0" />
                  <p className="display-font text-stone-600 italic">Modelling merchant representment strategy…</p>
                </div>
              )}

              {rebuttalError && (
                <div className="border border-red-700 bg-red-50 p-4 flex gap-3 items-start">
                  <AlertCircle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
                  <div className="display-font text-sm text-red-900">{rebuttalError}</div>
                </div>
              )}

              {rebuttal && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                  {/* Merchant arguments */}
                  <div className="border-2 border-stone-900 bg-stone-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-stone-600 mb-4">MERCHANT WILL ARGUE</div>
                    <div className="space-y-3">
                      {rebuttal.merchant_arguments?.map((arg, i) => (
                        <div key={i} className="display-font text-stone-800 text-[14px] flex gap-2 items-start leading-snug">
                          <span className="text-stone-400 shrink-0 mt-0.5">→</span>
                          <span>{arg}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Merchant evidence */}
                  <div className="border border-stone-300 bg-stone-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-stone-600 mb-4">EVIDENCE THEY'LL SUBMIT</div>
                    <div className="space-y-3">
                      {rebuttal.merchant_evidence?.map((ev, i) => (
                        <div key={i} className="display-font text-red-900 text-[14px] flex gap-2 items-start leading-snug">
                          <span className="text-red-400 shrink-0 mt-0.5">⚠</span>
                          <span>{ev}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Counter strategy */}
                  <div className="border border-stone-300 bg-stone-50 p-5">
                    <div className="mono-font text-xs tracking-widest text-stone-600 mb-4">HOW TO COUNTER</div>
                    <div className="space-y-3">
                      {rebuttal.counter_strategy?.map((pt, i) => (
                        <div key={i} className="display-font text-emerald-800 text-[14px] flex gap-2 items-start leading-snug">
                          <span className="text-emerald-600 shrink-0 mt-0.5">✓</span>
                          <span>{pt}</span>
                        </div>
                      ))}
                    </div>

                    {rebuttal.win_risk && (
                      <div className="mt-5 pt-4 border-t border-stone-200">
                        <div className="mono-font text-xs tracking-widest text-stone-500 mb-2">MERCHANT DEFENSE STRENGTH</div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`mono-font text-xs px-2 py-0.5 ${winRiskColor(rebuttal.win_risk).bg} ${winRiskColor(rebuttal.win_risk).text}`}>
                            {rebuttal.win_risk} RISK
                          </span>
                        </div>
                        <p className="display-font text-stone-600 text-[13px] italic leading-snug">{rebuttal.win_risk_note}</p>
                      </div>
                    )}
                  </div>

                </div>
              )}
            </div>

        {/* ── Step 05 — Customer Communication ── */}
            <div className="section-divider" />
            <div>
              <div className="flex items-baseline gap-3 mb-2">
                <span className="mono-font text-xs text-stone-500">05</span>
                <h2 className="display-font font-semibold text-2xl text-stone-900" style={{ letterSpacing: '-0.01em' }}>Customer Communication</h2>
              </div>
              <p className="display-font text-stone-500 text-[15px] mb-6 ml-7" style={{ lineHeight: '1.5' }}>
                Draft the cardholder letter based on desk findings — filing, not filing, declined transaction, or investigation.
              </p>

              {!result && (
                <div className="border border-dashed border-stone-300 p-10 text-center" style={{ background: '#FAF7F1' }}>
                  <MessageSquare className="w-7 h-7 text-stone-300 mx-auto mb-3" />
                  <p className="display-font text-stone-400 italic text-[14px]">Run an analysis first to generate the customer communication draft.</p>
                </div>
              )}
              {result && !comms && !commsLoading && (
                <button
                  onClick={fetchComms}
                  className="flex items-center gap-3 px-6 py-4 bg-stone-900 text-stone-50 mono-font text-xs tracking-widest hover:bg-stone-800 transition-all group"
                >
                  <MessageSquare className="w-4 h-4" />
                  <span>GENERATE CUSTOMER LETTER</span>
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </button>
              )}

              {commsLoading && (
                <div className="border border-stone-300 p-8 bg-stone-50 flex items-center gap-3">
                  <Loader2 className="w-5 h-5 text-stone-600 animate-spin shrink-0" />
                  <p className="display-font text-stone-600 italic">Drafting customer communication…</p>
                </div>
              )}

              {commsError && (
                <div className="border border-red-700 bg-red-50 p-4 flex gap-3 items-start">
                  <AlertCircle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
                  <div className="display-font text-sm text-red-900">{commsError}</div>
                </div>
              )}

              {comms && commsOc && (
                <div className="border border-stone-900">

                  {/* Letter header */}
                  <div className="bg-stone-900 p-4 flex items-start justify-between flex-wrap gap-3">
                    <div>
                      <div className="mono-font text-xs tracking-widest text-stone-400 mb-1">SUBJECT</div>
                      <div className="display-font text-stone-100 font-semibold">{comms.subject}</div>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      <span className={`mono-font text-xs px-2 py-1 ${commsOc.bg} ${commsOc.text}`}>{commsOc.label}</span>
                      {comms.card_action === 'CANCEL_RECOMMENDED' && (
                        <span className="mono-font text-xs px-2 py-1 bg-red-700 text-red-50">CANCEL CARD</span>
                      )}
                      {comms.card_action === 'MONITOR' && (
                        <span className="mono-font text-xs px-2 py-1 bg-amber-800 text-amber-50">MONITOR CARD</span>
                      )}
                    </div>
                  </div>

                  {/* Letter body */}
                  <div className="bg-white p-6 space-y-4 border-b border-stone-200">
                    <p className="display-font text-stone-600 text-[14px] italic">Dear Valued Cardholder,</p>
                    {comms.body?.split('\n\n').map((para, i) => (
                      <p key={i} className="display-font text-stone-900 text-[15px] leading-relaxed">{para}</p>
                    ))}
                    <p className="display-font text-stone-600 text-[14px] italic pt-2">
                      Sincerely,<br />Customer Care Team
                    </p>
                  </div>

                  {/* Next steps + timeline */}
                  <div className="bg-stone-50 p-5 grid grid-cols-1 sm:grid-cols-2 gap-6 border-b border-stone-200">
                    <div>
                      <div className="mono-font text-xs tracking-widest text-stone-500 mb-3">NEXT STEPS FOR CARDHOLDER</div>
                      <div className="space-y-2">
                        {comms.next_steps?.map((step, i) => (
                          <div key={i} className="display-font text-stone-800 text-[14px] flex gap-2 items-start">
                            <span className="text-stone-400 shrink-0 mt-0.5">→</span>
                            <span>{step}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="mono-font text-xs tracking-widest text-stone-500 mb-3">EXPECTED TIMELINE</div>
                      <div className="display-font text-stone-800 text-[15px]">{comms.timeline}</div>
                    </div>
                  </div>

                  {/* Copy */}
                  <div className="p-4 flex justify-end bg-stone-50">
                    <button onClick={copyCommsLetter} className="mono-font text-xs flex items-center gap-1.5 text-stone-700 hover:text-stone-900 transition-colors">
                      {commsCopied ? <><Check className="w-3 h-3" /> COPIED</> : <><Copy className="w-3 h-3" /> COPY LETTER</>}
                    </button>
                  </div>

                </div>
              )}

              {/* ── Documents to collect — inline agent reference ── */}
              {result && evidence && evidence.cardholder.length > 0 && (
                <div className="mt-4 border border-stone-300" style={{ background: '#FAF7F1' }}>
                  <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200 flex-wrap gap-3">
                    <div className="flex items-center gap-2">
                      <ClipboardList className="w-4 h-4 text-stone-400" />
                      <span className="mono-font text-xs tracking-widest text-stone-500">DOCUMENTS TO COLLECT FROM CARDHOLDER</span>
                    </div>
                    <button onClick={copyDocRequest} className="mono-font text-xs flex items-center gap-1.5 text-stone-600 hover:text-stone-900 transition-colors">
                      {docRequestCopied ? <><Check className="w-3 h-3" /> COPIED</> : <><Copy className="w-3 h-3" /> COPY LIST</>}
                    </button>
                  </div>
                  <div className="px-5 py-4 space-y-3">
                    {evidence.cardholder.map((item, i) => {
                      const key = `docreq-${i}`
                      const done = !!checked[key]
                      return (
                        <button key={key} onClick={() => toggleCheck(key)} className="w-full text-left flex gap-3 items-start group">
                          {done
                            ? <CheckSquare className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                            : <Square className="w-4 h-4 text-stone-400 shrink-0 mt-0.5 group-hover:text-stone-600" />}
                          <div>
                            <span className={`display-font text-[14px] leading-snug ${done ? 'line-through text-stone-400' : 'text-stone-800'}`}>{item.text}</span>
                            {!done && item.impact === 'required' && (
                              <span className="mono-font text-[9px] text-red-700 ml-2 tracking-wider">REQUIRED</span>
                            )}
                            {!done && item.impact === 'strengthens' && (
                              <span className="mono-font text-[9px] text-emerald-700 ml-2 tracking-wider">STRENGTHENS</span>
                            )}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                  {result.missing_information?.length > 0 && (
                    <div className="px-5 pb-4 border-t border-stone-200 pt-3">
                      <div className="mono-font text-xs tracking-widest text-stone-400 mb-2">ALSO CLARIFY</div>
                      {result.missing_information.map((m, i) => (
                        <div key={i} className="display-font text-stone-700 text-[14px] flex gap-2 items-start leading-snug mb-1">
                          <span className="text-stone-400">→</span><span>{m}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

        {/* ── Step 06 — Goodwill Credit ── */}
            <div className="section-divider" />
            <div>
              <div className="flex items-baseline gap-3 mb-2">
                <span className="mono-font text-xs text-stone-500">06</span>
                <h2 className="display-font font-semibold text-2xl text-stone-900" style={{ letterSpacing: '-0.01em' }}>Goodwill Credit</h2>
              </div>
              <p className="display-font text-stone-500 text-[15px] mb-6 ml-7" style={{ lineHeight: '1.5' }}>
                When a formal dispute isn't the right path — small dollar, relationship risk, or a case that doesn't quite meet threshold — use a courtesy credit instead.
              </p>

              {!result && (
                <div className="border border-dashed border-stone-300 p-10 text-center" style={{ background: '#FAF7F1' }}>
                  <Shield className="w-7 h-7 text-stone-300 mx-auto mb-3" />
                  <p className="display-font text-stone-400 italic text-[14px]">Run an analysis first to generate a goodwill recommendation.</p>
                </div>
              )}

              {result && goodwillRec && (
                <div className="border border-stone-300" style={{ background: '#FAF7F1' }}>
                  {/* Header */}
                  <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200 flex-wrap gap-3">
                    <span className={`mono-font text-xs px-2 py-1 ${goodwillRec.typeColor}`}>{goodwillRec.type}</span>
                    {goodwillRec.recommended && (
                      <button onClick={copyGoodwillScript} className="mono-font text-xs flex items-center gap-1.5 text-stone-600 hover:text-stone-900 transition-colors">
                        {goodwillCopied ? <><Check className="w-3 h-3" /> COPIED</> : <><Copy className="w-3 h-3" /> COPY SCRIPT</>}
                      </button>
                    )}
                  </div>

                  {/* Rationale */}
                  <div className="px-5 pt-4 pb-2">
                    <div className="mono-font text-xs tracking-widest text-stone-400 mb-2">RATIONALE</div>
                    <p className="display-font text-stone-700 text-[14px] leading-relaxed">{goodwillRec.rationale}</p>
                  </div>

                  {/* Script — only shown when goodwill is actually recommended */}
                  {goodwillRec.recommended && goodwillRec.script && (
                    <div className="px-5 pt-3 pb-5">
                      <div className="mono-font text-xs tracking-widest text-stone-400 mb-3">AGENT SCRIPT</div>
                      <div className="border border-stone-200 bg-white p-4">
                        {goodwillRec.script.split('\n\n').map((para, i) => (
                          <p key={i} className={`display-font text-stone-800 text-[14px] leading-relaxed ${i > 0 ? 'mt-3' : ''}`}>{para}</p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* NOT RECOMMENDED — redirect to formal dispute */}
                  {!goodwillRec.recommended && (
                    <div className="px-5 pt-2 pb-5">
                      <div className="flex items-center gap-2 text-stone-500">
                        <ArrowRight className="w-3.5 h-3.5 flex-shrink-0" />
                        <p className="mono-font text-xs tracking-wide">Proceed with formal chargeback filing — use Steps 01–04 above.</p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

        </>)}

        {/* ── Section 07 — Dispute Outcome Tracker ── */}
        {visibleOutcomes.length > 0 && (
          <>
            <div className="section-divider" />
            <div>
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                <span className="mono-font text-xs text-stone-500">07</span>
                <h2 className="display-font font-semibold text-2xl text-stone-900" style={{ letterSpacing: '-0.01em' }}>Dispute Tracker</h2>
                <div className="flex items-center gap-3 ml-auto flex-wrap">
                  <span className="mono-font text-xs text-stone-400">60-DAY WINDOW · {visibleOutcomes.length} CASE{visibleOutcomes.length !== 1 ? 'S' : ''}</span>
                  <button onClick={() => setShowSettings(v => !v)} className={`mono-font text-[10px] tracking-widest px-2.5 py-1 border transition-colors ${showSettings ? 'border-stone-900 bg-stone-900 text-stone-50' : 'border-stone-300 text-stone-500 hover:border-stone-600 hover:text-stone-700'}`}>
                    ⚙ THRESHOLDS
                  </button>
                </div>
              </div>
              <p className="display-font text-stone-500 text-[15px] mb-4 ml-7" style={{ lineHeight: '1.5' }}>
                Mark outcomes as cases resolve. Track provisional credit deadlines. Export to CSV for reporting.
              </p>

              {/* ── Compliance thresholds panel ── */}
              {showSettings && (
                <div className="border border-stone-400 mb-5" style={{ background: '#FAF7F1' }}>
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-stone-200" style={{ background: '#EEE9E0' }}>
                    <span className="mono-font text-[9px] tracking-widest text-stone-600">COMPLIANCE THRESHOLDS — INSTITUTION CONFIGURATION</span>
                    <button onClick={resetSettings} className="mono-font text-[9px] tracking-widest text-stone-400 hover:text-stone-700 transition-colors">RESET DEFAULTS</button>
                  </div>
                  <div className="px-4 py-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
                    {[
                      { key: 'smallDollarThreshold', label: 'WRITE-OFF THRESHOLD ($)', type: 'number', hint: 'Disputes below this amount trigger a write-off recommendation instead of formal dispute filing' },
                      { key: 'sarThreshold',          label: 'SAR TRIGGER ($)',          type: 'number', hint: 'Fraud disputes at or above this amount display a SAR filing reminder' },
                      { key: 'fraudWindowDays',       label: 'FRAUD WINDOW (DAYS)',       type: 'number', hint: 'Filing window for fraud disputes (Visa/MC standard: 120 days from transaction)' },
                      { key: 'consumerWindowDays',    label: 'CONSUMER WINDOW (DAYS)',    type: 'number', hint: 'Filing window for consumer disputes (typically 120 days from expected delivery)' },
                      { key: 'absoluteCapDays',       label: 'ABSOLUTE CAP (DAYS)',       type: 'number', hint: 'Hard cap on any filing, regardless of reason code (Visa: 540 days from transaction)' },
                    ].map(({ key, label, type, hint }) => (
                      <div key={key}>
                        <label className="mono-font text-[9px] tracking-widest text-stone-500 block mb-1">{label}</label>
                        <input
                          type={type}
                          value={settings[key]}
                          onChange={e => updateSetting(key, type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value)}
                          className="input-field"
                          style={{ fontSize: '13px', padding: '7px 10px' }}
                        />
                        <p className="display-font text-[11px] text-stone-400 mt-1 leading-snug italic">{hint}</p>
                      </div>
                    ))}
                    <div>
                      <label className="mono-font text-[9px] tracking-widest text-stone-500 block mb-1">PC MILESTONES (BUSINESS DAYS)</label>
                      <div className="flex gap-2">
                        {settings.pcMilestones.map((m, i) => (
                          <input key={i} type="number" value={m}
                            onChange={e => updateSetting('pcMilestones', settings.pcMilestones.map((v, j) => j === i ? parseInt(e.target.value) || v : v))}
                            className="input-field"
                            style={{ fontSize: '13px', padding: '7px 10px', textAlign: 'center' }}
                          />
                        ))}
                      </div>
                      <p className="display-font text-[11px] text-stone-400 mt-1 leading-snug italic">Three milestone deadlines (in business days) shown on the PC countdown row</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                {[
                  { label: 'TOTAL (60 DAYS)', value: visibleOutcomes.length,                         sub: 'cases analyzed'                            },
                  { label: 'IN PROGRESS',      value: inProgressCount,                               sub: `filed / representment / pre-arb`          },
                  { label: 'WIN RATE',         value: winRate !== null ? `${winRate}%` : '—',        sub: `${resolvedCount} resolved`                 },
                  { label: 'WON / LOST',       value: `${wonCount} / ${lostCount}`,                  sub: `${withdrawnCount} withdrawn`               },
                ].map(s => (
                  <div key={s.label} className="border border-stone-200 p-4" style={{ background: '#FAF7F1' }}>
                    <div className="mono-font text-xs tracking-widest text-stone-400 mb-1">{s.label}</div>
                    <div className="display-font font-semibold text-stone-900" style={{ fontSize: '22px', letterSpacing: '-0.02em' }}>{s.value}</div>
                    <div className="mono-font text-xs text-stone-400 mt-0.5">{s.sub}</div>
                  </div>
                ))}
              </div>

              {/* ── Analytics panel ── */}
              {analytics.resolvedCount >= 2 && (
                <div className="mb-5">
                  <button
                    onClick={() => setShowAnalytics(v => !v)}
                    className="w-full flex items-center justify-between px-4 py-2.5 border border-stone-300 mono-font text-[10px] tracking-widest text-stone-500 hover:border-stone-500 transition-colors"
                    style={{ background: '#EEE9E0' }}
                  >
                    <span>OUTCOME ANALYTICS ({analytics.resolvedCount} RESOLVED CASES)</span>
                    <span>{showAnalytics ? '▲' : '▼'}</span>
                  </button>
                  {showAnalytics && (
                    <div className="border border-t-0 border-stone-300 p-4 space-y-5" style={{ background: '#FAF7F1' }}>

                      {/* Network breakdown */}
                      {Object.keys(analytics.byNetwork).length > 0 && (
                        <div>
                          <div className="mono-font text-[9px] tracking-widest text-stone-400 mb-3">WIN RATE BY NETWORK</div>
                          <div className="flex gap-6 flex-wrap">
                            {Object.entries(analytics.byNetwork).map(([net, d]) => {
                              const rate = Math.round(d.won / d.total * 100)
                              return (
                                <div key={net} className="flex items-center gap-3">
                                  <span className="mono-font text-xs text-stone-600 w-8">{net}</span>
                                  <div style={{ width: '120px', height: '6px', background: '#D4CCBC', borderRadius: '2px' }}>
                                    <div style={{ height: '100%', width: `${rate}%`, background: rate >= 60 ? '#064e3b' : rate >= 40 ? '#92400e' : '#7f1d1d', borderRadius: '2px', transition: 'width 0.4s' }} />
                                  </div>
                                  <span className="mono-font text-xs font-medium text-stone-800">{rate}%</span>
                                  <span className="mono-font text-[10px] text-stone-400">{d.won}/{d.total}</span>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}

                      {/* Reason code breakdown */}
                      {analytics.topCodes.length > 0 && (
                        <div>
                          <div className="mono-font text-[9px] tracking-widest text-stone-400 mb-3">WIN RATE BY REASON CODE (TOP {analytics.topCodes.length})</div>
                          <div className="space-y-2">
                            {analytics.topCodes.map(([code, d]) => {
                              const rate = Math.round(d.won / d.total * 100)
                              return (
                                <div key={code} className="flex items-center gap-3">
                                  <span className="mono-font text-[11px] text-stone-600 w-10 shrink-0">{code}</span>
                                  <div style={{ flex: 1, height: '6px', background: '#D4CCBC', borderRadius: '2px', maxWidth: '160px' }}>
                                    <div style={{ height: '100%', width: `${rate}%`, background: rate >= 60 ? '#064e3b' : rate >= 40 ? '#92400e' : '#7f1d1d', borderRadius: '2px', transition: 'width 0.4s' }} />
                                  </div>
                                  <span className="mono-font text-[11px] font-medium text-stone-800 w-8">{rate}%</span>
                                  <span className="mono-font text-[10px] text-stone-400">{d.won}W / {d.total - d.won}L</span>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}

                      {/* Weekly filing trend */}
                      <div>
                        <div className="mono-font text-[9px] tracking-widest text-stone-400 mb-3">WEEKLY FILING TREND (LAST 8 WEEKS)</div>
                        <div className="flex items-end gap-1.5">
                          {analytics.weeks.map((w, i) => {
                            const barH = w.total > 0 ? Math.max(8, Math.round(w.total / Math.max(...analytics.weeks.map(x => x.total), 1) * 48)) : 2
                            const isLast = i === analytics.weeks.length - 1
                            return (
                              <div key={w.label} className="flex flex-col items-center gap-1" style={{ flex: 1 }}>
                                <div className="mono-font text-[8px] text-stone-400">{w.total > 0 ? w.total : ''}</div>
                                <div style={{ width: '100%', height: `${barH}px`, background: isLast ? '#1A1814' : '#D4CCBC', minHeight: '2px' }} />
                                <div className="mono-font text-[8px] text-stone-400">{w.label}</div>
                              </div>
                            )
                          })}
                        </div>
                      </div>

                      {/* Summary row */}
                      <div className="flex flex-wrap gap-6 pt-2 border-t border-stone-200">
                        {analytics.avgDays !== null && (
                          <div>
                            <div className="mono-font text-[9px] tracking-widest text-stone-400 mb-0.5">AVG RESOLUTION</div>
                            <div className="display-font font-semibold text-stone-900" style={{ fontSize: '20px' }}>{analytics.avgDays} days</div>
                          </div>
                        )}
                        <div>
                          <div className="mono-font text-[9px] tracking-widest text-stone-400 mb-0.5">OVERALL WIN RATE</div>
                          <div className="display-font font-semibold text-stone-900" style={{ fontSize: '20px' }}>{winRate !== null ? `${winRate}%` : '—'}</div>
                        </div>
                        <div>
                          <div className="mono-font text-[9px] tracking-widest text-stone-400 mb-0.5">CASES RESOLVED</div>
                          <div className="display-font font-semibold text-stone-900" style={{ fontSize: '20px' }}>{analytics.resolvedCount}</div>
                        </div>
                      </div>

                    </div>
                  )}
                </div>
              )}

              {/* Case table */}
              <div className="border border-stone-200 overflow-hidden" style={{ background: '#FAF7F1' }}>
                <div className="overflow-x-auto">
                  <div style={{ minWidth: '700px' }}>
                    {/* Header */}
                    {/* ── Deadline dashboard ── */}
                    {(() => {
                      const now = new Date()
                      const deadlines = visibleOutcomes
                        .filter(o => LIFECYCLE_IN_PROGRESS.has(o.status))
                        .flatMap(o => {
                          const entries = []
                          // Reg E PC deadline (10 BD)
                          if (o.provCreditDate) {
                            const pc10 = addBusinessDays(o.provCreditDate, settings.pcMilestones[0])
                            const daysLeft = Math.ceil((pc10 - now) / 86400000)
                            if (daysLeft <= 14) entries.push({ id: o.id, type: 'REG E PC', deadline: pc10.toLocaleDateString('en-CA'), daysLeft, merchant: o.merchant })
                          }
                          // Reg E investigation deadline (45 BD)
                          if (o.provCreditDate) {
                            const inv = addBusinessDays(o.provCreditDate, settings.pcMilestones[1])
                            const daysLeft = Math.ceil((inv - now) / 86400000)
                            if (daysLeft <= 21) entries.push({ id: o.id, type: 'REG E INV', deadline: inv.toLocaleDateString('en-CA'), daysLeft, merchant: o.merchant })
                          }
                          return entries
                        })
                        .sort((a, b) => a.daysLeft - b.daysLeft)
                      if (deadlines.length === 0) return null
                      return (
                        <div className="mb-4 border border-amber-700 bg-amber-50 p-4">
                          <div className="mono-font text-[10px] tracking-widest text-amber-900 mb-3">⚑ UPCOMING COMPLIANCE DEADLINES</div>
                          <div className="flex flex-wrap gap-3">
                            {deadlines.map((d, i) => (
                              <div key={i} className={"mono-font text-[10px] px-2 py-1.5 flex gap-2 items-center " + (d.daysLeft <= 3 ? 'bg-red-900 text-red-50' : d.daysLeft <= 7 ? 'bg-amber-800 text-amber-50' : 'bg-stone-800 text-stone-100')}>
                                <span>{d.type}</span>
                                <span className="font-bold">{d.merchant || d.id}</span>
                                <span>{d.deadline}</span>
                                <span>{d.daysLeft > 0 ? d.daysLeft + 'd' : d.daysLeft === 0 ? 'TODAY' : 'OVERDUE'}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })()}

                    <div className="grid px-4 py-2 border-b border-stone-300" style={{ gridTemplateColumns: '90px 60px 1fr 90px 1fr 44px 160px 40px', background: '#EEE9E0' }}>
                      {['CASE', 'DATE', 'MERCHANT', 'AMOUNT', 'REASON CODE', 'DFA', 'STATUS', ''].map(h => (
                        <span key={h} className="mono-font text-[10px] tracking-widest text-stone-500">{h}</span>
                      ))}
                    </div>
                    <div style={{ maxHeight: '480px', overflowY: 'auto' }}>
                      {visibleOutcomes.map(o => {
                        const [m0, m1, m2] = settings.pcMilestones
                        const pc10 = o.provCreditDate ? addBusinessDays(o.provCreditDate, m0) : null
                        const pc45 = o.provCreditDate ? addBusinessDays(o.provCreditDate, m1) : null
                        const pc90 = o.provCreditDate ? addBusinessDays(o.provCreditDate, m2) : null
                        const now  = new Date()
                        const isEditing = editingRow === o.id

                        return (
                          <div key={o.id} className="border-b border-stone-100">
                            {isEditing ? (
                              /* ── Edit mode ─────────────────────────────────── */
                              <div className="px-4 py-3 space-y-3" style={{ background: '#FDF9F3' }}>
                                <div className="mono-font text-[10px] tracking-widest text-stone-400 mb-2">EDITING {o.id}</div>
                                <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
                                  <div>
                                    <label className="mono-font text-[9px] tracking-widest text-stone-400 block mb-1">MERCHANT</label>
                                    <input
                                      className="input-field"
                                      value={editDraft.merchant || ''}
                                      onChange={e => setEditDraft(d => ({ ...d, merchant: e.target.value }))}
                                      style={{ fontSize: '13px', padding: '8px 10px' }}
                                    />
                                  </div>
                                  <div>
                                    <label className="mono-font text-[9px] tracking-widest text-stone-400 block mb-1">AMOUNT</label>
                                    <input
                                      className="input-field"
                                      value={editDraft.amount || ''}
                                      onChange={e => setEditDraft(d => ({ ...d, amount: e.target.value }))}
                                      style={{ fontSize: '13px', padding: '8px 10px' }}
                                    />
                                  </div>
                                  <div>
                                    <label className="mono-font text-[9px] tracking-widest text-stone-400 block mb-1">REASON CODE</label>
                                    <input
                                      className="input-field"
                                      value={editDraft.reasonCode || ''}
                                      onChange={e => setEditDraft(d => ({ ...d, reasonCode: e.target.value }))}
                                      style={{ fontSize: '13px', padding: '8px 10px' }}
                                    />
                                  </div>
                                  <div>
                                    <label className="mono-font text-[9px] tracking-widest text-stone-400 block mb-1">STATUS</label>
                                    <select
                                      className="input-field"
                                      value={o.status}
                                      onChange={e => markCaseOutcome(o.id, e.target.value)}
                                      style={{ fontSize: '13px', padding: '8px 10px' }}
                                    >
                                      <option value="pending">Pending — not yet filed</option>
                                      <option value="filed">Filed — submitted to network</option>
                                      <option value="representment">Representment received — merchant responded</option>
                                      <option value="pre_arb">Pre-arb filed — awaiting decision</option>
                                      <option value="won">Won</option>
                                      <option value="lost">Lost</option>
                                      <option value="withdrawn">Withdrawn</option>
                                    </select>
                                  </div>
                                </div>
                                <div>
                                  <label className="mono-font text-[9px] tracking-widest text-stone-400 block mb-1">NOTES</label>
                                  <input
                                    className="input-field"
                                    value={editDraft.notes || ''}
                                    onChange={e => setEditDraft(d => ({ ...d, notes: e.target.value }))}
                                    placeholder="Optional case notes..."
                                    style={{ fontSize: '13px', padding: '8px 10px' }}
                                  />
                                </div>
                                <div className="flex gap-2 pt-1">
                                  <button onClick={() => saveEdit(o.id)} className="mono-font text-[10px] tracking-widest px-3 py-1.5 bg-stone-900 text-stone-50 hover:bg-stone-700 transition-colors">SAVE</button>
                                  <button onClick={cancelEdit} className="mono-font text-[10px] tracking-widest px-3 py-1.5 border border-stone-300 text-stone-500 hover:border-stone-500 transition-colors">CANCEL</button>
                                  <button onClick={() => deleteCase(o.id)} className="mono-font text-[10px] tracking-widest px-3 py-1.5 border border-red-300 text-red-600 hover:bg-red-50 transition-colors ml-auto">DELETE CASE</button>
                                </div>
                              </div>
                            ) : (
                              /* ── View mode ─────────────────────────────────── */
                              <div className="grid px-4 py-3 items-center" style={{ gridTemplateColumns: '90px 60px 1fr 90px 1fr 44px 160px 40px' }}>
                                <span className="mono-font text-xs text-stone-400">{o.id}</span>
                                <span className="mono-font text-xs text-stone-500">{new Date(o.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                                <span className="display-font text-sm text-stone-700 truncate pr-2">{o.merchant}</span>
                                <span className="mono-font text-xs text-stone-600">{o.amount}</span>
                                <div className="pr-2">
                                  <span className="mono-font text-xs text-stone-600">{o.reasonCode}</span>
                                  {o.notes && <p className="display-font text-[11px] text-stone-400 truncate mt-0.5 italic">{o.notes}</p>}
                                </div>
                                {/* DFA grade badge */}
                                {(() => {
                                  const dfaG = estimateFundingGrade(o.reasonCode, o.amount)
                                  return dfaG
                                    ? <span className={`mono-font text-[10px] font-bold px-1.5 py-0.5 ${dfaG.bg} ${dfaG.text} justify-self-start`} title={`Estimated DFA funding grade — ${dfaG.label} based on reason code and amount. Open DFA for full underwriting.`}>{dfaG.label}</span>
                                    : <span className="text-stone-300 mono-font text-[10px]">—</span>
                                })()}
                                <div className="flex gap-1 flex-wrap items-center">
                                  {/* ── Lifecycle stage buttons ───────────────── */}
                                  {o.status === 'pending' && (
                                    <>
                                      <button onClick={() => advanceStage(o.id, 'filed')} title="Mark as filed with network" className="mono-font text-[10px] px-1.5 py-0.5 border border-stone-600 text-stone-600 hover:bg-stone-100 transition-colors">FILED</button>
                                      <button onClick={() => markCaseOutcome(o.id, 'won')} className="mono-font text-[10px] px-1.5 py-0.5 border border-emerald-700 text-emerald-700 hover:bg-emerald-50 transition-colors">WON</button>
                                      <button onClick={() => markCaseOutcome(o.id, 'lost')} className="mono-font text-[10px] px-1.5 py-0.5 border border-red-700 text-red-700 hover:bg-red-50 transition-colors">LOST</button>
                                      <button onClick={() => markCaseOutcome(o.id, 'withdrawn')} className="mono-font text-[10px] px-1.5 py-0.5 border border-stone-400 text-stone-500 hover:bg-stone-100 transition-colors">WD</button>
                                    </>
                                  )}
                                  {o.status === 'filed' && (
                                    <>
                                      <span className="mono-font text-[10px] px-1.5 py-0.5 bg-stone-700 text-stone-50">FILED</span>
                                      <button onClick={() => advanceStage(o.id, 'representment')} title="Merchant representment received" className="mono-font text-[10px] px-1.5 py-0.5 border border-amber-700 text-amber-700 hover:bg-amber-50 transition-colors">REPMT</button>
                                      <button onClick={() => markCaseOutcome(o.id, 'won')} className="mono-font text-[10px] px-1.5 py-0.5 border border-emerald-700 text-emerald-700 hover:bg-emerald-50 transition-colors">WON</button>
                                      <button onClick={() => markCaseOutcome(o.id, 'lost')} className="mono-font text-[10px] px-1.5 py-0.5 border border-red-700 text-red-700 hover:bg-red-50 transition-colors">LOST</button>
                                      <button onClick={() => revertCase(o.id)} className="mono-font text-[10px] text-stone-400 hover:text-stone-700 transition-colors px-1" title="Revert">↩</button>
                                    </>
                                  )}
                                  {o.status === 'representment' && (
                                    <>
                                      <span className="mono-font text-[10px] px-1.5 py-0.5 bg-amber-800 text-amber-50">REPMT RCV'D</span>
                                      <button onClick={() => {
                                        const amtNum = parseFloat((o.amount || '').replace(/[^0-9.]/g, ''))
                                        const arbFee = (o.network || '').toLowerCase().includes('visa') ? 500 : 200
                                        if (!isNaN(amtNum) && amtNum < arbFee) {
                                          if (!window.confirm('⚠ Arb fee warning: dispute amount (' + (o.amount || '?') + ') is less than the ' + (o.network || 'network') + ' arbitration fee (~$' + arbFee + '). Escalating to pre-arb will cost more than the dispute value. Proceed anyway?')) return
                                        }
                                        advanceStage(o.id, 'pre_arb')
                                      }} title="File pre-arbitration" className="mono-font text-[10px] px-1.5 py-0.5 border border-purple-700 text-purple-700 hover:bg-purple-50 transition-colors">PRE-ARB</button>
                                      <button onClick={() => generatePreArbDraft(o)} className="mono-font text-[10px] px-1.5 py-0.5 border border-stone-600 text-stone-600 hover:bg-stone-50 transition-colors">DRAFT PRE-ARB</button>
                                      <button onClick={() => markCaseOutcome(o.id, 'won')} className="mono-font text-[10px] px-1.5 py-0.5 border border-emerald-700 text-emerald-700 hover:bg-emerald-50 transition-colors">WON</button>
                                      <button onClick={() => markCaseOutcome(o.id, 'lost')} className="mono-font text-[10px] px-1.5 py-0.5 border border-red-700 text-red-700 hover:bg-red-50 transition-colors">LOST</button>
                                      <button onClick={() => revertCase(o.id)} className="mono-font text-[10px] text-stone-400 hover:text-stone-700 transition-colors px-1" title="Revert">↩</button>
                                    </>
                                  )}
                                  {o.status === 'pre_arb' && (
                                    <>
                                      <span className="mono-font text-[10px] px-1.5 py-0.5 bg-purple-900 text-purple-50">PRE-ARB FILED</span>
                                      <button onClick={() => generatePreArbDraft(o)} className="mono-font text-[10px] px-1.5 py-0.5 border border-stone-600 text-stone-600 hover:bg-stone-50 transition-colors">DRAFT PRE-ARB</button>
                                      <button onClick={() => markCaseOutcome(o.id, 'won')} className="mono-font text-[10px] px-1.5 py-0.5 border border-emerald-700 text-emerald-700 hover:bg-emerald-50 transition-colors">WON</button>
                                      <button onClick={() => markCaseOutcome(o.id, 'lost')} className="mono-font text-[10px] px-1.5 py-0.5 border border-red-700 text-red-700 hover:bg-red-50 transition-colors">LOST</button>
                                      <button onClick={() => revertCase(o.id)} className="mono-font text-[10px] text-stone-400 hover:text-stone-700 transition-colors px-1" title="Revert">↩</button>
                                    </>
                                  )}
                                  {(o.status === 'won' || o.status === 'lost' || o.status === 'withdrawn') && (
                                    <div className="flex items-center gap-1">
                                      <span className={`mono-font text-[10px] px-1.5 py-0.5 ${o.status === 'won' ? 'bg-emerald-900 text-emerald-50' : o.status === 'lost' ? 'bg-red-900 text-red-50' : 'bg-stone-600 text-stone-50'}`}>
                                        {o.status.toUpperCase()}
                                      </span>
                                      <button onClick={() => revertCase(o.id)} className="mono-font text-[10px] text-stone-400 hover:text-stone-700 transition-colors px-1" title="Re-mark">↩</button>
                                    </div>
                                  )}
                                  {/* PC button — available on all non-terminal stages */}
                                  {!o.provCreditDate && o.status !== 'withdrawn' && (
                                    <button onClick={() => markProvCredit(o.id)} className="mono-font text-[10px] px-1.5 py-0.5 border border-blue-700 text-blue-700 hover:bg-blue-50 transition-colors">PC</button>
                                  )}
                                </div>
                                <button onClick={() => startEdit(o)} className="text-stone-500 hover:text-stone-900 transition-colors" title="Edit row"><Pencil className="w-3.5 h-3.5" /></button>
                              </div>
                            )}

                            {/* Provisional credit deadline row */}
                            {!isEditing && o.provCreditDate && (
                              <div className="px-4 pb-2 flex items-center gap-4 flex-wrap" style={{ background: '#EEF2FF' }}>
                                <span className="mono-font text-[10px] text-blue-800 tracking-wider">PC ISSUED: {new Date(o.provCreditDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                                {[{ label: `${m0}BD`, date: pc10 }, { label: `${m1}BD`, date: pc45 }, { label: `${m2}BD`, date: pc90 }].map(({ label, date }) => {
                                  if (!date) return null
                                  const d = daysUntil(date)
                                  const past = d !== null && d < 0
                                  const urgent = !past && d !== null && d <= 5
                                  const warning = !past && !urgent && d !== null && d <= 14
                                  const cls = past ? 'text-red-700 font-bold' : urgent ? 'text-red-600 font-bold' : warning ? 'text-amber-700' : 'text-blue-600'
                                  const badge = past ? '⚠ PAST' : d !== null ? `(${d}d)` : ''
                                  return (
                                    <span key={label} className={`mono-font text-[10px] tracking-wider ${cls}`}>
                                      {label}: {date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} {badge}
                                    </span>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="mt-3 flex items-center justify-between flex-wrap gap-2">
                <button
                  onClick={() => { if (window.confirm('Clear all tracked cases?')) setOutcomes([]) }}
                  className="mono-font text-xs tracking-widest text-stone-400 hover:text-stone-600 transition-colors"
                >CLEAR LOG</button>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => exportDFACSV(visibleOutcomes)}
                    className="flex items-center gap-2 mono-font text-xs tracking-widest text-emerald-800 hover:text-emerald-900 border border-emerald-700 px-3 py-2 hover:bg-emerald-50 transition-colors"
                    style={{ background: '#FAF7F1' }}
                    title="Export pending cases as a DFA-ready CSV — upload directly to the Dispute Funding Assessor"
                  >
                    <Download className="w-3.5 h-3.5" />
                    EXPORT TO DFA
                  </button>
                  <button
                    onClick={exportCSV}
                    className="flex items-center gap-2 mono-font text-xs tracking-widest text-stone-700 hover:text-stone-900 border border-stone-300 px-3 py-2 hover:border-stone-500 transition-colors"
                    style={{ background: '#FAF7F1' }}
                  >
                    <Download className="w-3.5 h-3.5" />
                    EXPORT CSV
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── Pre-arb draft panel ── */}
        {(preArbDraft || preArbLoading || preArbError) && (
          <>
            <div className="section-divider" />
            <div>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="mono-font text-xs text-stone-500 mb-1">PRE-ARBITRATION RESPONSE DRAFTER</div>
                  <div className="display-font font-semibold text-xl text-stone-900" style={{ letterSpacing: '-0.01em' }}>
                    {preArbTargetId && 'Case ' + preArbTargetId}
                  </div>
                </div>
                <button onClick={() => { setPreArbDraft(null); setPreArbError(null); setPreArbTargetId(null) }}
                  className="mono-font text-[10px] text-stone-400 hover:text-stone-700 transition-colors tracking-widest">✕ CLOSE</button>
              </div>

              {preArbLoading && (
                <div className="border border-stone-300 p-10 text-center" style={{ background: '#FAF7F1' }}>
                  <Loader2 className="w-6 h-6 text-stone-600 mx-auto mb-2 animate-spin" />
                  <p className="display-font text-stone-600 italic text-sm">Drafting pre-arbitration rebuttal…</p>
                </div>
              )}
              {preArbError && (
                <div className="border border-red-700 bg-red-50 p-4 flex gap-3 items-start">
                  <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
                  <span className="display-font text-sm text-red-900">{preArbError}</span>
                </div>
              )}

              {preArbDraft && (
                <div className="space-y-5">
                  {/* Summary + win assessment */}
                  <div className="flex items-start gap-4 flex-wrap">
                    <div className="flex-1 min-w-0 border border-stone-300 p-4" style={{ background: '#FAF7F1' }}>
                      <div className="mono-font text-[10px] tracking-widest text-stone-400 mb-2">POSITION SUMMARY</div>
                      <p className="display-font text-stone-800 text-[14px] leading-relaxed">{preArbDraft.summary}</p>
                    </div>
                    <div className="border border-stone-300 p-4 text-center shrink-0" style={{ background: '#FAF7F1', minWidth: '130px' }}>
                      <div className="mono-font text-[10px] tracking-widest text-stone-400 mb-2">WIN ASSESSMENT</div>
                      <div className={"mono-font text-sm font-bold px-2 py-1 " + (preArbDraft.win_assessment === 'STRONG' ? 'bg-emerald-900 text-emerald-50' : preArbDraft.win_assessment === 'MODERATE' ? 'bg-amber-800 text-amber-50' : 'bg-red-900 text-red-50')}>
                        {preArbDraft.win_assessment}
                      </div>
                      <p className="display-font text-stone-500 text-[12px] mt-2 leading-snug">{preArbDraft.win_note}</p>
                    </div>
                  </div>

                  {/* Rebuttal points */}
                  <div className="border-l-4 border-stone-900 bg-stone-50 p-5">
                    <div className="mono-font text-[10px] tracking-widest text-stone-600 mb-3">REBUTTAL POINTS</div>
                    <div className="space-y-2">
                      {preArbDraft.rebuttal_points?.map((pt, i) => (
                        <div key={i} className="display-font text-stone-800 text-[14px] flex gap-2 leading-snug">
                          <span className="mono-font text-[11px] text-stone-500 shrink-0 mt-0.5">{i+1}.</span>
                          <span>{pt}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Evidence to attach */}
                  <div className="border border-stone-200 p-4" style={{ background: '#FAF7F1' }}>
                    <div className="mono-font text-[10px] tracking-widest text-stone-400 mb-3">EVIDENCE TO ATTACH</div>
                    <div className="flex flex-wrap gap-2">
                      {preArbDraft.evidence_to_attach?.map((e, i) => (
                        <span key={i} className="mono-font text-[10px] px-2 py-1 border border-stone-300 text-stone-700">{e}</span>
                      ))}
                    </div>
                  </div>

                  {/* Formal statement */}
                  <div className="border border-stone-900">
                    <div className="bg-stone-900 px-4 py-3 flex items-center justify-between">
                      <div className="mono-font text-[10px] tracking-widest text-stone-400">FORMAL PRE-ARB STATEMENT</div>
                      <button onClick={() => { navigator.clipboard.writeText(preArbDraft.formal_statement || ''); setPreArbCopied(true); setTimeout(() => setPreArbCopied(false), 2000) }}
                        className="mono-font text-[10px] flex items-center gap-1.5 text-stone-400 hover:text-stone-200 transition-colors">
                        {preArbCopied ? <><Check className="w-3 h-3" /> COPIED</> : <><Copy className="w-3 h-3" /> COPY</>}
                      </button>
                    </div>
                    <div className="bg-white p-5">
                      {(preArbDraft.formal_statement || '').split('\n\n').map((para, i) => (
                        <p key={i} className={"display-font text-stone-800 text-[14px] leading-relaxed " + (i > 0 ? 'mt-3' : '')}>{para}</p>
                      ))}
                    </div>
                  </div>

                  {preArbDraft.filing_deadline_note && (
                    <div className="mono-font text-[11px] text-amber-800 tracking-wide">⚠ {preArbDraft.filing_deadline_note}</div>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {platformMode === 'merchant' && cbrPct !== null && (
          <>
            <div className="section-divider" />
            <div>
              <div className="flex items-baseline gap-3 mb-2">
                <span className="mono-font text-xs text-stone-500">08</span>
                <h2 className="display-font font-semibold text-2xl text-stone-900" style={{ letterSpacing: '-0.01em' }}>Chargeback Ratio Monitor</h2>
              </div>
              <p className="display-font text-stone-500 text-[15px] mb-6 ml-7">Network monitoring program thresholds. Enter monthly dispute volume in Step 01 to track your exposure.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div className={'border-2 p-5 ' + (visaVdmpBreach ? 'border-red-700 bg-red-50' : visaVdmpWarn ? 'border-amber-600 bg-amber-50' : 'border-stone-300 bg-stone-50')}>
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="mono-font text-xs tracking-widest text-stone-600 mb-1">VISA VDMP</div>
                      <div className="display-font font-semibold text-stone-900">Visa Dispute Monitoring Programme</div>
                    </div>
                    <span className={'mono-font text-[10px] px-2 py-1 ' + (visaVdmpBreach ? 'bg-red-900 text-red-50' : visaVdmpWarn ? 'bg-amber-800 text-amber-50' : 'bg-emerald-900 text-emerald-50')}>
                      {visaVdmpBreach ? 'BREACH' : visaVdmpWarn ? 'WARNING' : 'OK'}
                    </span>
                  </div>
                  <div className="space-y-2 mb-4">
                    <div className="flex items-center justify-between"><span className="mono-font text-[11px] text-stone-500">THRESHOLD</span><span className="mono-font text-[11px] text-stone-700">≥ 0.90% CBR AND ≥ $75,000</span></div>
                    <div className="flex items-center justify-between"><span className="mono-font text-[11px] text-stone-500">YOUR CBR</span><span className={'mono-font text-sm font-bold ' + (visaVdmpBreach ? 'text-red-800' : visaVdmpWarn ? 'text-amber-800' : 'text-emerald-800')}>{cbrPct.toFixed(3)}%</span></div>
                    <div className="flex items-center justify-between"><span className="mono-font text-[11px] text-stone-500">DISPUTE VOLUME</span><span className={'mono-font text-[11px] font-bold ' + (cbrAmtNum >= 75000 ? 'text-red-700' : 'text-stone-700')}>${cbrAmtNum.toLocaleString()}</span></div>
                  </div>
                  <div style={{ height: '6px', background: '#D4CCBC', borderRadius: '2px' }}>
                    <div style={{ height: '100%', width: Math.min(cbrPct / 1.5 * 100, 100) + '%', background: visaVdmpBreach ? '#991b1b' : visaVdmpWarn ? '#92400e' : '#064e3b', borderRadius: '2px', transition: 'width 0.4s' }} />
                  </div>
                  <div className={'mt-3 display-font text-[13px] leading-snug ' + (visaVdmpBreach ? 'text-red-800' : visaVdmpWarn ? 'text-amber-800' : 'text-emerald-800')}>
                    {visaVdmpBreach ? 'Breach. Expect fines from $50/month escalating to $25,000/month. MID termination risk after 12 months.' : visaVdmpWarn ? 'Approaching VDMP. If dispute volume also reaches $75k you will be enrolled. Review top dispute codes now.' : 'Within Visa VDMP thresholds. Next threshold: 0.90% CBR + $75k volume.'}
                  </div>
                </div>
                <div className={'border-2 p-5 ' + (mcMdmpBreach ? 'border-red-700 bg-red-50' : mcMdmpWarn ? 'border-amber-600 bg-amber-50' : 'border-stone-300 bg-stone-50')}>
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="mono-font text-xs tracking-widest text-stone-600 mb-1">MC MDMP</div>
                      <div className="display-font font-semibold text-stone-900">Mastercard Dispute Monitoring Programme</div>
                    </div>
                    <span className={'mono-font text-[10px] px-2 py-1 ' + (mcMdmpBreach ? 'bg-red-900 text-red-50' : mcMdmpWarn ? 'bg-amber-800 text-amber-50' : 'bg-emerald-900 text-emerald-50')}>
                      {mcMdmpBreach ? 'BREACH' : mcMdmpWarn ? 'WARNING' : 'OK'}
                    </span>
                  </div>
                  <div className="space-y-2 mb-4">
                    <div className="flex items-center justify-between"><span className="mono-font text-[11px] text-stone-500">THRESHOLD</span><span className="mono-font text-[11px] text-stone-700">≥ 1.50% CBR AND ≥ $1,000</span></div>
                    <div className="flex items-center justify-between"><span className="mono-font text-[11px] text-stone-500">YOUR CBR</span><span className={'mono-font text-sm font-bold ' + (mcMdmpBreach ? 'text-red-800' : mcMdmpWarn ? 'text-amber-800' : 'text-emerald-800')}>{cbrPct.toFixed(3)}%</span></div>
                    <div className="flex items-center justify-between"><span className="mono-font text-[11px] text-stone-500">DISPUTE VOLUME</span><span className={'mono-font text-[11px] font-bold ' + (cbrAmtNum >= 1000 ? 'text-stone-800' : 'text-stone-500')}>${cbrAmtNum.toLocaleString()}</span></div>
                  </div>
                  <div style={{ height: '6px', background: '#D4CCBC', borderRadius: '2px' }}>
                    <div style={{ height: '100%', width: Math.min(cbrPct / 2.5 * 100, 100) + '%', background: mcMdmpBreach ? '#991b1b' : mcMdmpWarn ? '#92400e' : '#064e3b', borderRadius: '2px', transition: 'width 0.4s' }} />
                  </div>
                  <div className={'mt-3 display-font text-[13px] leading-snug ' + (mcMdmpBreach ? 'text-red-800' : mcMdmpWarn ? 'text-amber-800' : 'text-emerald-800')}>
                    {mcMdmpBreach ? 'Breach. Fines start at $100/month. Termination risk after 3 months. Mastercard threshold is lower than Visa — hits SMBs faster.' : mcMdmpWarn ? 'Approaching MC MDMP. Remediate by reducing disputes or increasing transaction volume.' : 'Within Mastercard MDMP thresholds. Next: 1.50% CBR + $1,000 dispute volume.'}
                  </div>
                </div>
              </div>
              <div className="mt-4 border border-stone-200 p-4 bg-stone-50">
                <div className="mono-font text-[10px] tracking-widest text-stone-400 mb-2">MONITORING PROGRAM PENALTIES</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 display-font text-[13px] text-stone-600" style={{ lineHeight: '1.5' }}>
                  <div><strong className="text-stone-800">Visa VDMP</strong> — $50/month (months 1–4), escalating to $25,000/month (month 10+). MID termination risk after 12 months without remediation.</div>
                  <div><strong className="text-stone-800">MC MDMP</strong> — $100/month + $1,000 per dispute exceeding threshold (months 1–2), escalating from month 3. Termination review at month 3.</div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── Footer ── */}
        <div className="section-divider" />
        <div className="flex flex-col sm:flex-row sm:items-baseline justify-between text-stone-600 gap-2">
          <div className="mono-font text-xs tracking-widest">BUILT BY ADEOTI FASHOKUN — RISK &amp; TRUST OPERATIONS</div>
          <div className="display-font italic text-sm">"Disputes resolve faster when the framework is written down."</div>
        </div>
      </div>
    </div>
    </ErrorBoundary>
  )
}
