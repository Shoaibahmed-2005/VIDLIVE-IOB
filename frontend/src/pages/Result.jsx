import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import TrustMeter from '../components/TrustMeter'
import { useTxn } from '../App'

function formatIndianCurrency(amount) {
  const num = parseFloat(amount)
  return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function Result() {
  const navigate = useNavigate()
  const { vidliveResult, pendingTxn } = useTxn()
  const [forensicsOpen, setForensicsOpen] = useState(false)

  if (!vidliveResult) {
    navigate('/dashboard')
    return null
  }

  const { trust_score, result, breakdown, transaction_status, passing_threshold, auto_fail_reason } = vidliveResult
  const isPass = result === 'pass'
  const txnApproved = transaction_status === 'approved'

  const scoreCards = [
    { label: 'Step 3 — 3D Geometry', score: breakdown.step3_geometry, max: 15, icon: '🎯' },
    { label: 'Step 4 — AI Deepfake', score: breakdown.step4_deepfake, max: 35, icon: '🤖' },
    { label: 'Step 5 — Reaction Time', score: breakdown.step5_reaction, max: 25, icon: '⚡' },
    { label: 'Step 6 — Micro-expression', score: breakdown.step6_micro, max: 25, icon: '🔬' },
  ]

  return (
    <div style={s.page}>
      <Header showLogout />

      <div style={s.container}>
        {/* Result banner */}
        <div style={{ ...s.banner, ...(isPass ? s.bannerPass : s.bannerFail) }}>
          <span style={s.bannerIcon}>{isPass ? '✅' : '❌'}</span>
          <div>
            <h2 style={s.bannerTitle}>
              VID-LIVE Verification {isPass ? 'SUCCESSFUL' : 'FAILED'}
            </h2>
            {txnApproved ? (
              <p style={s.bannerDetail}>
                {formatIndianCurrency(pendingTxn?.amount || 0)} transferred successfully
                to account {pendingTxn?.receiver_account || '—'}
              </p>
            ) : (
              <p style={s.bannerDetail}>
                {isPass
                  ? 'Identity confirmed. Transaction has been processed.'
                  : auto_fail_reason ? `Transaction blocked. ${auto_fail_reason}.` : 'Transaction blocked. Score below adaptive threshold.'}
              </p>
            )}
          </div>
        </div>

        <div style={s.mainGrid}>
          {/* Trust meter */}
          <div style={s.meterCard}>
            <h3 style={s.cardTitle}>Trust Score</h3>
            <div style={s.meterWrap}>
              <TrustMeter score={Math.round(trust_score)} size={200} animate />
            </div>
            <p style={s.meterLabel}>
              {trust_score.toFixed(1)} / 100 &nbsp;—&nbsp;
              <strong style={{ color: isPass ? 'var(--iob-success)' : 'var(--iob-danger)' }}>
                {isPass ? 'VERIFIED' : 'NOT VERIFIED'}
              </strong>
            </p>
            <p style={s.threshold}>Threshold: {passing_threshold ? `${passing_threshold} / 100` : 'Adaptive'}</p>
          </div>

          {/* Score breakdown */}
          <div style={s.breakdownCard}>
            <h3 style={s.cardTitle}>Score Breakdown</h3>
            <div style={s.breakdownGrid}>
              {scoreCards.map((sc) => (
                <ScoreCard key={sc.label} {...sc} />
              ))}
            </div>
          </div>
        </div>

        {/* Forensic details */}
        <div style={s.forensicsSection}>
          <button
            style={s.forensicsToggle}
            onClick={() => setForensicsOpen((v) => !v)}
          >
            {forensicsOpen ? '▲' : '▼'} Forensic Details &amp; Audit Trail
          </button>

          {forensicsOpen && (
            <div style={s.forensicsBody}>
              <div style={s.forensicsGrid}>
                <ForensicRow label="Session ID" value={vidliveResult.session_id || '—'} mono />
                <ForensicRow label="Result" value={result.toUpperCase()} />
                <ForensicRow label="Trust Score" value={`${trust_score.toFixed(2)} / 100`} />
                <ForensicRow label="Step 3 (Geometry)" value={`${breakdown.step3_geometry} / 15`} />
                <ForensicRow label="Step 4 (Deepfake)" value={`${breakdown.step4_deepfake} / 35`} />
                <ForensicRow label="Step 5 (Reaction)" value={`${breakdown.step5_reaction} / 25`} />
                <ForensicRow label="Step 6 (Micro-expr)" value={`${breakdown.step6_micro} / 25`} />
                <ForensicRow label="Transaction Status" value={transaction_status || '—'} />
              </div>
              <p style={s.auditNote}>✓ This session has been recorded and saved for regulatory audit.</p>
            </div>
          )}
        </div>

        <button style={s.dashBtn} onClick={() => navigate('/dashboard')}>
          ← Return to Dashboard
        </button>
      </div>
    </div>
  )
}

function ScoreCard({ label, score, max, icon }) {
  const pct = Math.min((score / max) * 100, 100)
  const isGood = pct >= 60
  return (
    <div style={ss.card}>
      <div style={ss.top}>
        <span style={ss.icon}>{icon}</span>
        <span style={ss.label}>{label}</span>
      </div>
      <div style={ss.scoreRow}>
        <span style={{ ...ss.score, color: isGood ? 'var(--iob-success)' : 'var(--iob-danger)' }}>
          {typeof score === 'number' ? score.toFixed(1) : score}
        </span>
        <span style={ss.max}>/ {max}</span>
      </div>
      <div style={ss.barTrack}>
        <div
          style={{
            ...ss.barFill,
            width: `${pct}%`,
            backgroundColor: isGood ? 'var(--iob-success)' : 'var(--iob-danger)',
          }}
        />
      </div>
    </div>
  )
}

function ForensicRow({ label, value, mono }) {
  return (
    <div style={fs.row}>
      <span style={fs.label}>{label}</span>
      <span style={{ ...fs.value, ...(mono ? fs.mono : {}) }}>{value}</span>
    </div>
  )
}

const s = {
  page: { minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--iob-bg)' },
  container: { maxWidth: 900, margin: '0 auto', padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 20, width: '100%' },

  banner: {
    borderRadius: 10,
    padding: '20px 28px',
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    border: '2px solid',
  },
  bannerPass: { backgroundColor: '#E8F5E9', borderColor: 'var(--iob-success)' },
  bannerFail: { backgroundColor: '#FFEBEE', borderColor: 'var(--iob-danger)' },
  bannerIcon: { fontSize: 36, flexShrink: 0 },
  bannerTitle: { fontSize: 20, fontWeight: 700, color: 'var(--iob-text)', marginBottom: 4 },
  bannerDetail: { fontSize: 14, color: 'var(--iob-muted)', lineHeight: 1.5 },

  mainGrid: { display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 20 },

  meterCard: {
    backgroundColor: '#FFFFFF',
    border: '1px solid var(--iob-border)',
    borderRadius: 10,
    padding: '24px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
  },
  cardTitle: { fontSize: 15, fontWeight: 700, color: 'var(--iob-text)', alignSelf: 'flex-start' },
  meterWrap: { padding: '8px 0' },
  meterLabel: { fontSize: 14, color: 'var(--iob-text)', textAlign: 'center' },
  threshold: { fontSize: 11, color: 'var(--iob-muted)' },

  breakdownCard: {
    backgroundColor: '#FFFFFF',
    border: '1px solid var(--iob-border)',
    borderRadius: 10,
    padding: '24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  breakdownGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 },

  forensicsSection: {
    backgroundColor: '#FFFFFF',
    border: '1px solid var(--iob-border)',
    borderRadius: 10,
    overflow: 'hidden',
  },
  forensicsToggle: {
    width: '100%',
    textAlign: 'left',
    padding: '14px 20px',
    background: 'var(--iob-blue-light)',
    border: 'none',
    borderBottom: '1px solid var(--iob-border)',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--iob-blue)',
    cursor: 'pointer',
  },
  forensicsBody: { padding: '20px' },
  forensicsGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 },
  auditNote: { fontSize: 12, color: 'var(--iob-success)', fontWeight: 600 },

  dashBtn: {
    backgroundColor: 'var(--iob-blue)',
    color: '#FFFFFF',
    border: 'none',
    borderRadius: 8,
    padding: '13px 32px',
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    alignSelf: 'flex-start',
  },
}

const ss = {
  card: {
    backgroundColor: 'var(--iob-blue-light)',
    border: '1px solid var(--iob-border)',
    borderRadius: 8,
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  top: { display: 'flex', alignItems: 'center', gap: 8 },
  icon: { fontSize: 18 },
  label: { fontSize: 12, fontWeight: 600, color: 'var(--iob-text)' },
  scoreRow: { display: 'flex', alignItems: 'baseline', gap: 4 },
  score: { fontSize: 28, fontWeight: 700 },
  max: { fontSize: 14, color: 'var(--iob-muted)' },
  barTrack: { height: 6, backgroundColor: '#D0DCF0', borderRadius: 3, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 3, transition: 'width 0.8s ease' },
}

const fs = {
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    backgroundColor: 'var(--iob-bg)',
    borderRadius: 6,
    fontSize: 13,
  },
  label: { color: 'var(--iob-muted)' },
  value: { fontWeight: 600, color: 'var(--iob-text)' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
}
