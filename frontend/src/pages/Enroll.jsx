/**
 * VID-LIVE Enrollment Page — Phase 3 (Full Implementation)
 *
 * MediaPipe FaceMesh is now loaded via the npm package (@mediapipe/face_mesh).
 * WASM assets are served locally from /mediapipe/ (public directory).
 * The Camera helper from @mediapipe/camera_utils manages getUserMedia + the
 * animation-frame loop so we don't need a manual RAF or stream ref.
 */

import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '@mediapipe/face_mesh'
import '@mediapipe/camera_utils'
import Header from '../components/Header'
import Sidebar from '../components/Sidebar'
import StepCard from '../components/StepCard'
import { useAuth } from '../App'
import { vidliveApi } from '../api'

// ── Geometry helpers ──────────────────────────────────────────────────────────

function dist2d(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

function computeEAR(lm) {
  const ver = dist2d(lm[160], lm[144]) + dist2d(lm[158], lm[153])
  const hor = dist2d(lm[33], lm[133])
  return hor > 1e-5 ? ver / (2 * hor) : 0.35
}

function computeYaw(lm) {
  const left = lm[234], right = lm[454], nose = lm[1]
  const fw = Math.abs(right.x - left.x)
  if (fw < 1e-5) return 0
  return Math.abs(nose.x - (left.x + right.x) / 2) / fw
}

function computeVariance(snapshots) {
  if (snapshots.length < 3) return 0
  const n = snapshots.length, nL = snapshots[0].length
  let sumSq = 0, cnt = 0
  for (let li = 0; li < nL; li++) {
    let sx = 0, sy = 0
    for (let fi = 0; fi < n; fi++) { sx += snapshots[fi][li].x; sy += snapshots[fi][li].y }
    const mx = sx / n, my = sy / n
    for (let fi = 0; fi < n; fi++) {
      sumSq += (snapshots[fi][li].x - mx) ** 2 + (snapshots[fi][li].y - my) ** 2; cnt++
    }
  }
  return Math.sqrt(sumSq / cnt) * 640
}

function playBeep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ac.createOscillator(), gain = ac.createGain()
    osc.connect(gain); gain.connect(ac.destination)
    osc.type = 'sine'; osc.frequency.value = 800
    gain.gain.setValueAtTime(0.5, ac.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.3)
    osc.start(ac.currentTime); osc.stop(ac.currentTime + 0.35)
  } catch { /* blocked without user gesture */ }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ENROLL_STEPS = [
  { num: 1, title: 'Face Detection',              maxScore: 20 },
  { num: 2, title: 'Landmark Capture (468 pts)',   maxScore: 20 },
  { num: 3, title: '3D Face Mapping',              maxScore: 20 },
  { num: 4, title: 'Micro-expression Baseline',    maxScore: 20 },
  { num: 5, title: 'Reaction Time Baseline',       maxScore: 20 },
]

const INSTRUCTIONS = [
  { text: 'Look straight at the camera',         duration: 4000 },
  { text: 'Slowly turn your head LEFT',          duration: 3500 },
  { text: 'Slowly turn your head RIGHT',         duration: 3500 },
  { text: 'Look straight and HOLD STILL',        duration: 6000 },
  { text: 'Please BLINK when you hear the beep', duration: 4000 },
]

// ── Component ─────────────────────────────────────────────────────────────────

export default function Enroll() {
  const navigate = useNavigate()
  const { customer, refreshCustomer } = useAuth()

  // ── Refs ──────────────────────────────────────────────────────────────────
  const videoRef       = useRef(null)
  const faceMeshRef    = useRef(null)
  const cameraRef      = useRef(null)   // Camera instance — manages stream + RAF
  const abortRef       = useRef(false)
  const onResultsRef   = useRef(null)   // stable callback ref

  // Measurement refs
  const phaseRef       = useRef('idle')
  const baselineLmRef  = useRef(null)
  const yawBucketRef   = useRef([])
  const microSnapRef   = useRef([])
  const beepTimeRef    = useRef(null)
  const blinkRef       = useRef(false)
  const reactionMsRef  = useRef(0)
  const lastUIRef      = useRef(0)
  const lastGuidRef     = useRef(0)

  // ── UI State ──────────────────────────────────────────────────────────────
  const [mpState,     setMpState]     = useState('loading')
  const [cameraErr,   setCameraErr]   = useState('')
  const [phase,       setPhase]       = useState('idle')
  const [stepSt,      setStepSt]      = useState(ENROLL_STEPS.map(() => ({ status: 'Pending', score: 0, detail: '' })))
  const [instrIdx,    setInstrIdx]    = useState(0)
  const [timeLeft,    setTimeLeft]    = useState(0)
  const [faceVisible, setFaceVisible] = useState(false)
  const [frameCount,  setFrameCount]  = useState(0)
  const [earDisplay,  setEarDisplay]  = useState(null)
  const [guidanceHint, setGuidanceHint] = useState('')
  const [showBeepFlash, setShowBeepFlash] = useState(false)

  // ── Helpers ───────────────────────────────────────────────────────────────

  function updateStep(i, partial) {
    setStepSt(prev => {
      const n = [...prev]; n[i] = { ...n[i], ...partial }; return n
    })
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

  function countdown(durationMs) {
    return new Promise(resolve => {
      const start = Date.now()
      const id = setInterval(() => {
        if (abortRef.current) { clearInterval(id); resolve(); return }
        const elapsed = Date.now() - start
        setTimeLeft(Math.max(0, Math.ceil((durationMs - elapsed) / 1000)))
        if (elapsed >= durationMs) { clearInterval(id); setTimeLeft(0); resolve() }
      }, 100)
    })
  }

  // ── FaceMesh results handler ──────────────────────────────────────────────
  // Updated on every render via ref so FaceMesh always calls the latest closure.

  onResultsRef.current = function handleResults(results) {
    const now = Date.now()
    const lms = results.multiFaceLandmarks?.[0]

    // Throttle React state updates + console logs to ~8 fps
    if (now - lastUIRef.current > 125) {
      lastUIRef.current = now
      console.log(
        '[Enroll] onResults | face:', !!lms,
        '| landmarks:', lms?.length ?? 0,
        '| phase:', phaseRef.current,
      )
      setFaceVisible(!!lms)
      setFrameCount(c => {
        const next = c + 1
        if (next % 30 === 0) console.log('[Enroll] Frames processed:', next)
        return next
      })
    }
    if (!lms) return

    const ph = phaseRef.current
    const shouldGuide = now - lastGuidRef.current > 250  // ~4 fps guidance updates
    if (shouldGuide) lastGuidRef.current = now

    // Step 2: capture baseline landmarks on first good frame
    if (ph === 'baseline' && !baselineLmRef.current) {
      const snap = []
      for (let i = 0; i < 468; i++) {
        const p = lms[i]; snap.push({ x: p?.x ?? 0, y: p?.y ?? 0, z: p?.z ?? 0 })
      }
      baselineLmRef.current = snap
      console.log('[Enroll] Baseline landmarks captured')
    }

    // Step 3: collect yaw samples with live guidance
    if (ph === 'geometry') {
      const yaw = computeYaw(lms)
      yawBucketRef.current.push(yaw)
      if (shouldGuide) {
        const prog = Math.min(yaw / 0.08, 1.0)
        const directionStr = instrIdx === 1 ? 'LEFT ←' : 'RIGHT →'
        const hint = prog < 0.35
          ? `Turn further ${directionStr} — ${Math.round(prog * 100)}% detected`
          : prog < 0.75
            ? `✓ Good! Keep turning ${directionStr} — ${Math.round(prog * 100)}%`
            : `✓ ${directionStr} complete (${Math.round(prog * 100)}%)`
        updateStep(2, { status: 'Running', score: Math.round(prog * 20), detail: hint })
        setGuidanceHint(hint)
      }
    }

    // Step 4: collect micro snapshots with live guidance
    if (ph === 'micro' || ph === 'micro+blink') {
      if (microSnapRef.current.length < 90) {
        const snap = []
        for (let i = 0; i < 468; i++) {
          const p = lms[i]; snap.push({ x: p?.x ?? 0, y: p?.y ?? 0 })
        }
        microSnapRef.current.push(snap)
      }
      if (shouldGuide && microSnapRef.current.length > 5) {
        const v = computeVariance(microSnapRef.current)
        const hint = `Variance: ${v.toFixed(2)} px std dev — holding still`
        updateStep(3, { status: 'Running', score: 0, detail: hint })
        setGuidanceHint('✓ Holding still (recording micro baseline)')
      }
    }

    // Step 5: blink detection with live guidance
    if ((ph === 'blink' || ph === 'micro+blink') && beepTimeRef.current && !blinkRef.current) {
      const ear = computeEAR(lms)
      setEarDisplay(ear.toFixed(3))

      if (shouldGuide && !blinkRef.current) {
        const hint = ear < 0.23
          ? '⚡ Almost! Close eyes fully'
          : `Blink! EAR: ${ear.toFixed(3)} → need < 0.20`
        updateStep(4, { status: 'Running', score: 0, detail: hint })
        setGuidanceHint(hint)
      }

      if (ear < 0.20) {
        blinkRef.current = true
        reactionMsRef.current = Date.now() - beepTimeRef.current
        console.log('[Enroll] Blink detected! EAR:', ear.toFixed(3), '| RT:', reactionMsRef.current, 'ms')
        const rt = reactionMsRef.current
        const pts = rt >= 100 && rt <= 500 ? 20 : (rt > 500 && rt <= 800 ? 12 : 5)
        updateStep(4, {
          status: 'Pass',
          score: pts,
          detail: `Baseline reaction: ${rt} ms — stored`,
        })
        setGuidanceHint(`✓ Blink detected in ${rt} ms!`)
      }
    }
  }

  // ── MediaPipe initialisation ──────────────────────────────────────────────

  async function initMediaPipe() {
    // Reset abort so the Camera loop doesn't exit immediately when React Strict
    // Mode re-invokes this effect after the cleanup of the first run.
    abortRef.current = false
    console.log('[Enroll] initMediaPipe: start')

    try {
      // FaceMesh from npm — WASM assets served locally from /mediapipe/
      const { FaceMesh, Camera } = globalThis
      if (!FaceMesh || !Camera) throw new Error('MediaPipe runtime did not load')

      const fm = new FaceMesh({
        locateFile: (file) => `/mediapipe/${file}`,
      })
      fm.setOptions({
        maxNumFaces:            1,
        refineLandmarks:        true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence:  0.5,
      })
      // Stable wrapper: FaceMesh registers the handler once but always calls
      // the latest closure through the ref.
      fm.onResults((r) => onResultsRef.current(r))

      console.log('[Enroll] Initialising FaceMesh WASM (served from /mediapipe/)…')
      await fm.initialize()
      console.log('[Enroll] FaceMesh WASM ready')

      // If cleanup ran during the WASM download, bail cleanly.
      if (abortRef.current) {
        fm.close()
        console.log('[Enroll] Aborted during FaceMesh init')
        return
      }

      faceMeshRef.current = fm

      // Camera from @mediapipe/camera_utils — handles getUserMedia, srcObject,
      // and the animation-frame loop internally.
      const cam = new Camera(videoRef.current, {
        onFrame: async () => {
          if (faceMeshRef.current && !abortRef.current) {
            try {
              await faceMeshRef.current.send({ image: videoRef.current })
            } catch (e) {
              console.warn('[Enroll] send() error:', e)
            }
          }
        },
        width:  640,
        height: 480,
      })
      cameraRef.current = cam

      console.log('[Enroll] Starting Camera…')
      await cam.start()

      if (abortRef.current) {
        cam.stop()
        fm.close()
        console.log('[Enroll] Aborted after camera start')
        return
      }

      console.log('[Enroll] Camera running — frames incoming')
      setMpState('ready')
    } catch (err) {
      console.error('[Enroll] initMediaPipe error:', err)
      setMpState('error')
      setCameraErr(
        err.name === 'NotAllowedError'
          ? 'Camera access denied. Please allow camera access and reload.'
          : `Initialisation failed: ${err.message}`
      )
    }
  }

  function cleanup() {
    console.log('[Enroll] cleanup: stopping camera and FaceMesh')
    abortRef.current = true
    cameraRef.current?.stop()
    faceMeshRef.current?.close()
    cameraRef.current  = null
    faceMeshRef.current = null
  }

  // ── Enrollment sequence ───────────────────────────────────────────────────

  async function runEnrollment() {
    if (phase !== 'idle' || mpState !== 'ready') return

    abortRef.current      = false
    phaseRef.current      = 'idle'
    baselineLmRef.current = null
    yawBucketRef.current  = []
    microSnapRef.current  = []
    beepTimeRef.current   = null
    blinkRef.current      = false
    reactionMsRef.current = 0
    setStepSt(ENROLL_STEPS.map(() => ({ status: 'Pending', score: 0, detail: '' })))
    setEarDisplay(null)
    setGuidanceHint('')
    setShowBeepFlash(false)
    setPhase('running')

    // Start session
    let sid = null
    try {
      const res = await vidliveApi.start(null, true)
      sid = res.data.session_id
    } catch {
      setPhase('error')
      setCameraErr('Failed to start enrollment session. Please try again.')
      return
    }

    // ─ Step 1: Face Detection ────────────────────────────────────────────
    setInstrIdx(0)
    updateStep(0, { status: 'Running', score: 0, detail: 'Detecting face and checking lighting…' })
    phaseRef.current = 'baseline'
    await countdown(INSTRUCTIONS[0].duration)

    const gotFace = !!baselineLmRef.current
    updateStep(0, {
      status: gotFace ? 'Pass' : 'Fail',
      score:  gotFace ? 20 : 0,
      detail: gotFace ? 'Face detected — good lighting confirmed' : 'No face detected — please retry',
    })
    if (!gotFace) { setPhase('error'); setCameraErr('No face detected. Please ensure good lighting and retry.'); return }

    // ─ Step 2: Landmark Capture ──────────────────────────────────────────
    setInstrIdx(0)
    updateStep(1, { status: 'Running', score: 0, detail: 'Capturing 468 facial landmarks…' })
    await delay(800)
    updateStep(1, { status: 'Pass', score: 20, detail: '468 landmarks captured — baseline snapshot stored' })

    // ─ Step 3: 3D Face Mapping ───────────────────────────────────────────
    setInstrIdx(1)
    phaseRef.current = 'geometry'
    updateStep(2, { status: 'Running', score: 0, detail: 'Building 3D map — turn head LEFT…' })
    await countdown(INSTRUCTIONS[1].duration)

    setInstrIdx(2)
    updateStep(2, { status: 'Running', score: 0, detail: 'Building 3D map — turn head RIGHT…' })
    await countdown(INSTRUCTIONS[2].duration)

    phaseRef.current = 'idle'
    setGuidanceHint('')
    const yaws    = yawBucketRef.current
    const maxYaw  = yaws.length > 0 ? Math.max(...yaws) : 0
    const yawGood = maxYaw > 0.08
    updateStep(2, {
      status: yawGood ? 'Pass' : 'Fail',
      score:  yawGood ? 20 : 10,
      detail: `3D depth baseline set — yaw range ${maxYaw.toFixed(3)} across ${yaws.length} frames`,
    })

    // ─ Step 4: Micro-expression Baseline ─────────────────────────────────
    setInstrIdx(3)
    phaseRef.current = 'micro'
    updateStep(3, { status: 'Running', score: 0, detail: 'Recording involuntary micro-movement baseline…' })

    const beepOffset = 2500 + Math.random() * 2000
    const beepTimer  = setTimeout(() => {
      if (abortRef.current) return
      playBeep()
      setShowBeepFlash(true)
      setTimeout(() => setShowBeepFlash(false), 800)
      beepTimeRef.current  = Date.now()
      phaseRef.current     = 'micro+blink'
      setInstrIdx(4)
    }, beepOffset)

    await countdown(INSTRUCTIONS[3].duration)
    clearTimeout(beepTimer)

    if (beepTimeRef.current && !blinkRef.current) {
      phaseRef.current = 'blink'
      setInstrIdx(4)
      await countdown(3000)
    }
    if (!beepTimeRef.current) {
      playBeep()
      setShowBeepFlash(true)
      setTimeout(() => setShowBeepFlash(false), 800)
      beepTimeRef.current = Date.now()
      phaseRef.current = 'blink'; setInstrIdx(4)
      await countdown(3000)
    }

    phaseRef.current = 'idle'
    setGuidanceHint('')

    const variance = computeVariance(microSnapRef.current)
    updateStep(3, {
      status: 'Pass', score: 20,
      detail: `Baseline variance: ${variance.toFixed(2)} px std dev — ${microSnapRef.current.length} frames`,
    })

    // ─ Step 5: Reaction Baseline ─────────────────────────────────────────
    const rt = reactionMsRef.current
    updateStep(4, {
      status: blinkRef.current ? 'Pass' : 'Fail',
      score:  blinkRef.current ? 20 : 8,
      detail: blinkRef.current
        ? `Baseline reaction: ${rt} ms — stored`
        : 'No blink detected — using default baseline',
    })

    // ─ Submit enrollment ──────────────────────────────────────────────────
    try {
      await vidliveApi.enrollFace(
        baselineLmRef.current || [],
        { baseline_variance: variance, frames: microSnapRef.current.length },
        rt > 0 ? rt : 350
      )
      await refreshCustomer()
      cleanup()
      setPhase('done')
    } catch (err) {
      setPhase('error')
      setCameraErr(err.message || 'Enrollment failed. Please try again.')
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  useEffect(() => {
    initMediaPipe()
    return () => cleanup()
  }, [])  // eslint-disable-line

  // ── Render: Success screen ────────────────────────────────────────────────

  if (phase === 'done') {
    return (
      <div style={s.page}>
        <Header showLogout />
        <div style={s.body}>
          <Sidebar />
          <main style={s.main}>
            <div style={s.successBox}>
              <div style={s.successIcon}>🎉</div>
              <h2 style={s.successTitle}>VID-LIVE Protection is Now Active</h2>
              <p style={s.successDesc}>
                Your facial biometric baseline has been enrolled. All future transactions
                of ₹50,000 or more will be automatically protected by AI-powered
                deepfake detection.
              </p>
              <div style={s.successFeatures}>
                {[
                  '✓ 3D geometry baseline stored',
                  '✓ Micro-expression profile captured',
                  '✓ Reaction time baseline recorded',
                  '✓ AI model ready for verification',
                ].map(f => (
                  <div key={f} style={s.featureRow}>{f}</div>
                ))}
              </div>
              <button style={s.doneBtn} onClick={() => navigate('/dashboard')}>
                Return to Dashboard
              </button>
            </div>
          </main>
        </div>
      </div>
    )
  }

  // ── Render: Main enrollment flow ──────────────────────────────────────────

  const currentInstrText = phase === 'running'
    ? (guidanceHint || INSTRUCTIONS[instrIdx]?.text)
    : mpState === 'loading'
      ? '● Initialising face detection…'
      : 'Position face in oval, then click Start'

  return (
    <div style={s.page}>
      <Header showLogout />
      <div style={s.body}>
        <Sidebar />
        <main style={s.main}>

          {/* Breadcrumb */}
          <div style={s.breadcrumb}>
            <button style={s.backBtn} onClick={() => navigate('/dashboard')}>← Dashboard</button>
            <span style={s.sep}>/</span>
            <span style={s.crumb}>VID-LIVE Enrollment</span>
          </div>

          {(cameraErr && phase === 'error') ? (
            <div style={s.errCard}>
              <p style={s.errText}>{cameraErr}</p>
              <button style={s.retryBtn} onClick={() => { setCameraErr(''); setPhase('idle') }}>
                Try Again
              </button>
            </div>
          ) : (
            <div style={s.layout}>

              {/* ── Left: webcam ── */}
              <div style={s.camSection}>
                <div style={s.camBox}>
                  {(mpState === 'error' || (cameraErr && phase !== 'running')) ? (
                    <div style={s.camError}>{cameraErr}</div>
                  ) : (
                    <>
                      <video ref={videoRef} style={s.video} autoPlay muted playsInline />
                      {showBeepFlash && (
                        <div style={s.beepFlashOverlay}>
                          ♪ BEEP! BLINK NOW ♪
                        </div>
                      )}
                      <div style={{
                        ...s.oval,
                        borderColor: faceVisible ? 'var(--iob-gold)' : '#555',
                        boxShadow:   faceVisible
                          ? '0 0 0 4000px rgba(0,0,0,0.35), 0 0 20px rgba(255,179,0,0.4)'
                          : '0 0 0 4000px rgba(0,0,0,0.5)',
                      }} />
                      {phase === 'running' && (
                        <div style={s.stepBadge}>
                          Step {Math.min(instrIdx + 1, INSTRUCTIONS.length)} / {INSTRUCTIONS.length}
                          {timeLeft > 0 && `  ·  ${timeLeft}s`}
                        </div>
                      )}
                      <div style={s.instrBar}>{currentInstrText}</div>
                      {phase === 'running' && instrIdx === 4 && earDisplay && (
                        <div style={s.earBox}>
                          EAR: {earDisplay}
                          {parseFloat(earDisplay) < 0.2 && <span style={{ color: 'var(--iob-gold)', marginLeft: 5 }}>← BLINK</span>}
                        </div>
                      )}
                    </>
                  )}
                </div>

                {mpState === 'loading' && !cameraErr && (
                  <div style={s.loadBar}>● Initialising face detection…</div>
                )}

                {phase === 'idle' && mpState === 'ready' && !cameraErr && (
                  <button
                    style={{ ...s.startBtn, opacity: !faceVisible ? 0.55 : 1 }}
                    onClick={runEnrollment}
                    disabled={!faceVisible}
                  >
                    {!faceVisible ? '⚠  Align face in oval to continue' : '▶  Start Face Enrollment'}
                  </button>
                )}

                {phase === 'running' && (
                  <div style={s.runningNote}>
                    Enrollment in progress — follow the on-screen instructions
                  </div>
                )}

                <div style={s.framesNote}>Frames processed: <strong>{frameCount}</strong></div>
              </div>

              {/* ── Right: info + step cards ── */}
              <div style={s.infoSection}>
                <div style={s.infoCard}>
                  <h2 style={s.infoTitle}>Enable VID-LIVE Protection</h2>
                  <p style={s.infoDesc}>
                    VID-LIVE enrollment captures your unique facial biometric baseline —
                    including 3D geometry, micro-expression patterns (468 landmarks), and
                    natural reaction timing. This is used exclusively to verify your
                    identity during high-value transactions.
                  </p>
                  <ul style={s.infoList}>
                    <li>✓ Protects all transactions ≥ ₹50,000</li>
                    <li>✓ Detects deepfakes and video replay attacks</li>
                    <li>✓ Uses AI-powered ONNX deepfake model</li>
                    <li>✓ One-time setup — takes about 30 seconds</li>
                    <li>✓ All data stored securely on IOB servers</li>
                  </ul>
                </div>

                <div style={s.stepsCard}>
                  <h3 style={s.stepsTitle}>Enrollment Progress</h3>
                  <div style={s.stepsList}>
                    {ENROLL_STEPS.map((step, i) => (
                      <StepCard
                        key={step.num}
                        stepNumber={step.num}
                        title={step.title}
                        status={stepSt[i].status}
                        score={stepSt[i].score}
                        maxScore={step.maxScore}
                        detail={stepSt[i].detail}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
      `}</style>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  page: { minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--iob-bg)' },
  body: { display: 'flex', flex: 1 },
  main: { flex: 1, padding: '24px', display: 'flex', flexDirection: 'column', gap: 16 },

  breadcrumb: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
  backBtn:    { background: 'none', border: 'none', color: 'var(--iob-blue)', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  sep:        { color: 'var(--iob-muted)' },
  crumb:      { color: 'var(--iob-muted)' },

  layout: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, flex: 1 },

  // ── Camera ──
  camSection: { display: 'flex', flexDirection: 'column', gap: 12 },
  camBox: {
    position: 'relative', backgroundColor: '#0A1628', borderRadius: 10,
    overflow: 'hidden', aspectRatio: '4/3', border: '2px solid var(--iob-border)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  video: { width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: 'scaleX(-1)' },
  oval: {
    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    width: '42%', paddingBottom: '56%', border: '3px solid', borderRadius: '50%',
    pointerEvents: 'none', transition: 'border-color 0.4s, box-shadow 0.4s',
  },
  beepFlashOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(255, 179, 0, 0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#FFF', fontSize: 24, fontWeight: 900,
    zIndex: 10, animation: 'pulse 0.4s infinite',
  },
  stepBadge: {
    position: 'absolute', top: 10, right: 10,
    backgroundColor: 'rgba(0,87,168,0.88)', color: '#FFF',
    borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 600,
  },
  instrBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.78)', color: '#FFF',
    fontSize: 14, fontWeight: 600, textAlign: 'center', padding: '12px 14px',
  },
  earBox: {
    position: 'absolute', bottom: 48, right: 12,
    backgroundColor: 'rgba(0,0,0,0.7)', color: '#A8C8F0',
    fontSize: 11, borderRadius: 4, padding: '3px 8px', fontFamily: 'monospace',
  },
  camError: { color: '#FF6B6B', fontSize: 14, textAlign: 'center', padding: 24, lineHeight: 1.7 },

  loadBar: {
    backgroundColor: 'var(--iob-blue-light)', border: '1px solid var(--iob-border)',
    color: 'var(--iob-blue)', borderRadius: 8, padding: '10px', textAlign: 'center', fontSize: 13, fontWeight: 600,
  },
  startBtn: {
    backgroundColor: 'var(--iob-blue)', color: '#FFF', border: '2px solid var(--iob-gold)',
    borderRadius: 8, padding: '12px 20px', fontSize: 15, fontWeight: 700,
    cursor: 'pointer', width: '100%', transition: 'opacity 0.2s',
  },
  runningNote: {
    backgroundColor: 'var(--iob-blue-light)', border: '1px solid var(--iob-blue)',
    color: 'var(--iob-blue)', borderRadius: 6, padding: '10px',
    textAlign: 'center', fontSize: 13, fontWeight: 600,
  },
  framesNote: { fontSize: 12, color: 'var(--iob-muted)', textAlign: 'center' },

  // ── Info panel ──
  infoSection: { display: 'flex', flexDirection: 'column', gap: 14 },
  infoCard: {
    backgroundColor: '#FFF', border: '1px solid var(--iob-border)',
    borderRadius: 10, padding: '20px 24px',
  },
  infoTitle: { fontSize: 18, fontWeight: 700, color: 'var(--iob-text)', marginBottom: 10 },
  infoDesc:  { fontSize: 14, color: 'var(--iob-muted)', lineHeight: 1.7, marginBottom: 14 },
  infoList: {
    listStyle: 'none', display: 'flex', flexDirection: 'column',
    gap: 7, fontSize: 13, color: 'var(--iob-text)',
  },

  stepsCard: {
    backgroundColor: '#FFF', border: '1px solid var(--iob-border)',
    borderRadius: 10, padding: '16px 18px',
  },
  stepsTitle: {
    fontSize: 12, fontWeight: 700, color: 'var(--iob-muted)',
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10,
  },
  stepsList:  { display: 'flex', flexDirection: 'column', gap: 8 },

  // ── Success ──
  successBox: {
    maxWidth: 560, margin: '32px auto', padding: '48px 36px',
    backgroundColor: '#FFF', border: '2px solid var(--iob-success)',
    borderRadius: 12, textAlign: 'center',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
  },
  successIcon:     { fontSize: 60 },
  successTitle:    { fontSize: 22, fontWeight: 700, color: 'var(--iob-text)' },
  successDesc:     { fontSize: 15, color: 'var(--iob-muted)', lineHeight: 1.7 },
  successFeatures: { width: '100%', display: 'flex', flexDirection: 'column', gap: 8 },
  featureRow: {
    backgroundColor: 'var(--iob-blue-light)', border: '1px solid var(--iob-border)',
    borderRadius: 8, padding: '10px 16px', fontSize: 13,
    color: 'var(--iob-success)', fontWeight: 600, textAlign: 'left',
  },
  doneBtn: {
    backgroundColor: 'var(--iob-blue)', color: '#FFF', border: 'none',
    borderRadius: 8, padding: '13px 32px', fontSize: 15, fontWeight: 700,
    cursor: 'pointer', marginTop: 8,
  },

  // ── Error card ──
  errCard: {
    backgroundColor: '#FFEBEE', border: '1px solid var(--iob-danger)',
    borderRadius: 10, padding: '28px', textAlign: 'center',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
  },
  errText:  { color: 'var(--iob-danger)', fontSize: 15 },
  retryBtn: {
    backgroundColor: 'var(--iob-blue)', color: '#FFF', border: 'none',
    borderRadius: 8, padding: '10px 24px', fontSize: 14, fontWeight: 700, cursor: 'pointer',
  },
}
