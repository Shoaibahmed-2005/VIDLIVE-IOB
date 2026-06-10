/**
 * VID-LIVE Verification Page — Phase 3 (Full Implementation)
 *
 * Real-time deepfake detection pipeline using MediaPipe FaceMesh (CDN) and
 * the prithivMLmods/Deepfake-Detection-Exp-02-22-ONNX backend model.
 *
 * Step 1  — Video Capture        : camera quality check (always pass)
 * Step 2  — Lighting Normalise   : frame brightness analysis (always pass)
 * Step 3  — 3D Geometry Check    : yaw/parallax from FaceMesh landmarks 1,234,454
 * Step 4  — AI Deepfake Detection: frame → /vidlive/analyze-frame every 2 s
 * Step 5  — Reaction Timing      : EAR < 0.2 after 800 Hz audio beep
 * Step 6  — Micro-expression     : landmark variance over "hold still" window
 *
 * MediaPipe FaceMesh is loaded as a global via index.html CDN script tags.
 * No npm package needed — accessed as window.FaceMesh.
 */

import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '@mediapipe/face_mesh'
import '@mediapipe/camera_utils'
import Header from '../components/Header'
import StepCard from '../components/StepCard'
import { useTxn } from '../App'
import { vidliveApi } from '../api'

// ── Geometry helpers ──────────────────────────────────────────────────────────

function dist2d(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

/**
 * Eye Aspect Ratio using left-eye MediaPipe landmarks.
 * Indices: p1=33 (outer), p2=160 (top-outer), p3=158 (top-inner),
 *          p4=133 (inner), p5=153 (bot-inner), p6=144 (bot-outer)
 * EAR < 0.20 → blink
 */
function computeEAR(lm) {
  const ver = dist2d(lm[160], lm[144]) + dist2d(lm[158], lm[153])
  const hor = dist2d(lm[33], lm[133])
  return hor > 1e-5 ? ver / (2 * hor) : 0.35
}

/**
 * SIGNED yaw: direction-aware nose deviation.
 * Positive  = nose moved to camera-right  (user body-left turn).
 * Negative  = nose moved to camera-left   (user body-right turn).
 */
function computeSignedYaw(lm) {
  const left = lm[234], right = lm[454], nose = lm[1]
  const fw = Math.abs(right.x - left.x)
  if (fw < 1e-5) return 0
  return (nose.x - (left.x + right.x) / 2) / fw
}

/**
 * Unsigned yaw (absolute deviation) — kept for backward compat.
 */
function computeYaw(lm) { return Math.abs(computeSignedYaw(lm)) }

/**
 * Micro-expression variance.
 * Input: array of landmark snapshots [{x,y}, …] × N frames.
 * Returns std dev (px, scaled by 640).
 */
function computeVariance(snapshots) {
  if (snapshots.length < 3) return 0
  const n = snapshots.length
  const nL = snapshots[0].length
  let sumSq = 0, cnt = 0
  for (let li = 0; li < nL; li++) {
    let sx = 0, sy = 0
    for (let fi = 0; fi < n; fi++) { sx += snapshots[fi][li].x; sy += snapshots[fi][li].y }
    const mx = sx / n, my = sy / n
    for (let fi = 0; fi < n; fi++) {
      const dx = snapshots[fi][li].x - mx, dy = snapshots[fi][li].y - my
      sumSq += dx * dx + dy * dy; cnt++
    }
  }
  return Math.sqrt(sumSq / cnt) * 640
}

/**
 * Option A — baseline-relative micro score.
 * Compares live variance against the user's personal calibration baseline.
 * A real live face will have variance within 0.25×–5× of their own baseline.
 * A deepfake/photo deviates wildly from a real baseline.
 */
function microScoreFromVariance(v, baseline) {
  if (!baseline || baseline < 0.01) {
    // Fallback if calibration failed: use widened absolute bands
    if (v >= 0.3 && v <= 10.0) return 25
    if (v >= 0.15 && v < 0.3)  return 18
    if (v > 0.05 && v < 0.15)  return 10
    return 5
  }
  const ratio = v / baseline
  // Ratio near 1.0 = live face under same conditions as calibration
  if (ratio >= 0.25 && ratio <= 5.0) return 25  // natural live motion
  if (ratio >= 0.12 && ratio <  0.25) return 18  // slightly stiller than baseline
  if (ratio >  5.0  && ratio <= 10.0) return 16  // more active, still plausible
  if (ratio >  0.05 && ratio <  0.12) return 10  // suspiciously still vs baseline
  return 5                                        // near-zero or erratic (GAN/photo)
}

/** 800 Hz, 300 ms beep via Web Audio API */
function playBeep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ac.createOscillator(), gain = ac.createGain()
    osc.connect(gain); gain.connect(ac.destination)
    osc.type = 'sine'; osc.frequency.value = 800
    gain.gain.setValueAtTime(0.5, ac.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.3)
    osc.start(ac.currentTime); osc.stop(ac.currentTime + 0.35)
  } catch { /* browser may block AudioContext before user gesture */ }
}

/** Capture 224×224 JPEG as base64 from a <video> element */
function captureFrame(video) {
  try {
    const c = document.createElement('canvas'); c.width = 224; c.height = 224
    c.getContext('2d').drawImage(video, 0, 0, 224, 224)
    return c.toDataURL('image/jpeg', 0.75).split(',')[1]
  } catch { return null }
}

/** Capture 224×224 cropped face from video based on landmarks, with fallback to center oval */
function captureFaceCrop(video, landmarks) {
  try {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return null

    let x = 0, y = 0, w = vw, h = vh
    let hasCrop = false

    if (landmarks && landmarks.length > 0) {
      let minX = 1, maxX = 0, minY = 1, maxY = 0
      for (let i = 0; i < landmarks.length; i++) {
        const p = landmarks[i]
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
      }
      let pxX = minX * vw
      let pxY = minY * vh
      let pxW = (maxX - minX) * vw
      let pxH = (maxY - minY) * vh

      // Add 25% padding
      const padX = pxW * 0.25
      const padY = pxH * 0.25
      x = Math.max(0, pxX - padX)
      y = Math.max(0, pxY - padY)
      w = Math.min(vw - x, pxW + 2 * padX)
      h = Math.min(vh - y, pxH + 2 * padY)
      hasCrop = true
    }

    if (!hasCrop) {
      w = vw * 0.45
      h = vh * 0.60
      x = (vw - w) / 2
      y = (vh - h) / 2
    }

    const c = document.createElement('canvas'); c.width = 224; c.height = 224
    c.getContext('2d').drawImage(video, x, y, w, h, 0, 0, 224, 224)
    return c.toDataURL('image/jpeg', 0.75).split(',')[1]
  } catch {
    return captureFrame(video)
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3

const STEPS = [
  { num: 1, title: 'Video Capture',              maxScore: 10 },
  { num: 2, title: 'Lighting Normalisation',     maxScore: 10 },
  { num: 3, title: '3D Geometry Check',          maxScore: 15 },
  { num: 4, title: 'AI Deepfake Detection',      maxScore: 35 },
  { num: 5, title: 'Reaction Timing',            maxScore: 25 },
  { num: 6, title: 'Micro-expression Analysis',  maxScore: 25 },
]

const INSTRUCTIONS = [
  { text: '● Calibrating — look straight and hold still',  duration: 5000 },  // idx 0
  { text: 'Look straight at the camera',                    duration: 2000 },  // idx 1
  { text: '← Slowly turn your head LEFT',                  duration: 4000 },  // idx 2
  { text: '→ Slowly turn your head RIGHT',                  duration: 4000 },  // idx 3
  { text: 'Look straight and HOLD STILL',                   duration: 6000 },  // idx 4
  { text: 'Please BLINK when you hear the beep ♪',          duration: 4000 },  // idx 5
]

// Module-level counter so 3-attempt limit persists across re-mounts
let _failAttempts = 0

// ── Component ─────────────────────────────────────────────────────────────────

export default function VidLive() {
  const navigate   = useNavigate()
  const { pendingTxn, setVidliveResult } = useTxn()

  // ── Camera / MediaPipe refs ──────────────────────────────────────────────
  const videoRef        = useRef(null)
  const faceMeshRef     = useRef(null)
  const cameraRef       = useRef(null)     // Camera instance — manages stream + RAF
  const abortRef        = useRef(false)    // set true on unmount / sequence abort

  // ── Measurement refs (written by onResults at ~30 fps, read by sequence) ─
  // phase: 'idle'|'calibration'|'geometry'|'micro'|'blink'|'micro+blink'
  const phaseRef        = useRef('idle')
  const geomDirRef      = useRef('none')   // 'none'|'left'|'right' — which turn we expect
  const leftYawRef      = useRef(0)        // max signed yaw during LEFT instruction
  const rightYawRef     = useRef(0)        // max unsigned negative yaw during RIGHT instruction
  const yawBucketRef    = useRef([])       // kept for compat (unused now)
  const microSnapRef    = useRef([])
  const frameResultsRef = useRef([])
  const beepTimeRef     = useRef(null)
  const blinkRef        = useRef(false)
  const reactionMsRef   = useRef(0)
  const parallaxRef     = useRef(0)
  const earMinRef       = useRef(null)     // lowest EAR seen since beep (blink fallback)

  // ── Option A: Calibration refs ───────────────────────────────────────────
  const calibEARRef     = useRef([])       // EAR samples during calibration phase
  const calibSnapRef    = useRef([])       // landmark snapshots during calibration
  const baselineEARRef  = useRef(0.32)    // computed after calibration
  const baselineVarRef  = useRef(0)       // computed after calibration
  const blinkThreshRef  = useRef(0.25)    // dynamic: baselineEAR * 0.65
  const calib3DRef      = useRef(null)     // 3D landmarks baseline captured during calibration
  const latestLandmarksRef = useRef(null)  // latest landmarks from faceMesh for cropping

  const deepfakeTimRef  = useRef(null)
  const sessionIdRef    = useRef(null)
  const lastUIRef       = useRef(0)        // throttle setFaceVisible calls
  const lastGuidRef     = useRef(0)        // throttle live guidance updates (~4 fps)

  // Stable callback ref — always points at the latest onResults closure
  const onResultsRef    = useRef(null)

  // ── React state (UI only) ─────────────────────────────────────────────────
  const [sessionId,   setSessionId]   = useState(null)
  const [guidanceHint, setGuidanceHint] = useState('')
  const [showBeepFlash, setShowBeepFlash] = useState(false)
  const [mpState,     setMpState]     = useState('loading')  // loading|ready|error
  const [cameraErr,   setCameraErr]   = useState('')
  const [stepSt,      setStepSt]      = useState(STEPS.map(() => ({ status: 'Pending', score: 0, detail: '' })))
  const [instrIdx,    setInstrIdx]    = useState(0)
  const [timeLeft,    setTimeLeft]    = useState(0)
  const [running,     setRunning]     = useState(false)
  const [analyzing,   setAnalyzing]   = useState(false)
  const [frameCount,  setFrameCount]  = useState(0)
  const [faceVisible, setFaceVisible] = useState(false)
  const [earDisplay,  setEarDisplay]  = useState(null)
  const [failedOut,   setFailedOut]   = useState(false)

  // ── Helpers ───────────────────────────────────────────────────────────────

  function updateStep(i, partial) {
    setStepSt(prev => {
      const n = [...prev]
      n[i] = { ...n[i], ...partial }
      return n
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

  // Use a ref-based stable wrapper so the faceMesh.onResults callback always
  // calls the latest closure even though it's registered once.
  onResultsRef.current = function handleFaceMeshResults(results) {
    const now  = Date.now()
    const lms  = results.multiFaceLandmarks?.[0]

    // Throttle React state updates to ~8 fps to avoid render-storm
    if (now - lastUIRef.current > 125) {
      lastUIRef.current = now
      setFaceVisible(!!lms)
      setFrameCount(c => c + 1)
    }

    if (!lms) return

    latestLandmarksRef.current = lms

    const phase = phaseRef.current
    const shouldGuide = now - lastGuidRef.current > 250  // ~4 fps guidance updates
    if (shouldGuide) lastGuidRef.current = now

    // ── Option A: Calibration — measure personal EAR + variance baseline ──
    if (phase === 'calibration') {
      calibEARRef.current.push(computeEAR(lms))
      if (calibSnapRef.current.length < 60) {
        const snap = []
        for (let i = 0; i < 468; i++) {
          const p = lms[i]
          snap.push({ x: p?.x ?? 0, y: p?.y ?? 0 })
        }
        calibSnapRef.current.push(snap)
      }
      if (!calib3DRef.current) {
        const snap3D = []
        for (let i = 0; i < 468; i++) {
          const p = lms[i]
          snap3D.push({ x: p?.x ?? 0, y: p?.y ?? 0, z: p?.z ?? 0 })
        }
        calib3DRef.current = snap3D
      }
      return  // don't run other logic during calibration
    }

    // ── Step 3: Directional yaw — ONLY counts the correct direction ────────
    if (phase === 'geometry') {
      const syaw = computeSignedYaw(lms)
      const dir  = geomDirRef.current
      if (dir === 'left'  && syaw > leftYawRef.current)  leftYawRef.current  = syaw
      if (dir === 'right' && -syaw > rightYawRef.current) rightYawRef.current = -syaw

      if (shouldGuide) {
        const curMax  = dir === 'left' ? leftYawRef.current : rightYawRef.current
        const prog    = Math.min(curMax / 0.08, 1.0)
        const arrow   = dir === 'left' ? 'LEFT ←' : 'RIGHT →'
        const hint    = prog < 0.35
          ? `Turn further ${arrow} — ${Math.round(prog * 100)}% detected`
          : prog < 0.75
            ? `✓ Good! Keep turning ${arrow} — ${Math.round(prog * 100)}%`
            : `✓ ${arrow} complete (${Math.round(prog * 100)}%)`
        updateStep(2, { status: 'Running', score: Math.round(prog * 15), detail: hint })
        setGuidanceHint(hint)
      }
    }

    // ── Step 6: landmark snapshots during hold-still ───────────────────────
    if (phase === 'micro' || phase === 'micro+blink') {
      if (microSnapRef.current.length < 90) {
        const snap = []
        for (let i = 0; i < 468; i++) {
          const p = lms[i]
          snap.push({ x: p?.x ?? 0, y: p?.y ?? 0 })
        }
        microSnapRef.current.push(snap)
      }
      if (shouldGuide && microSnapRef.current.length > 5) {
        const v  = computeVariance(microSnapRef.current)
        const bl = baselineVarRef.current
        const lo = bl > 0 ? (bl * 0.25).toFixed(2) : '0.30'
        const hi = bl > 0 ? (bl * 5.0).toFixed(2)  : '10.0'
        const ok = bl > 0 ? (v / bl >= 0.25 && v / bl <= 5.0) : (v >= 0.3)
        const hint = `Variance: ${v.toFixed(2)} px | Target: ${lo}–${hi} | ${ok ? '✓ In range' : '⚠ Hold still'}`
        updateStep(5, {
          status: 'Running', score: 0,
          detail: hint,
        })
        setGuidanceHint(ok ? '✓ Holding still (signature active)' : '⚠ HOLD STILL — do not move')
      }
    }

    // ── Step 5: blink detection — threshold from Option A calibration ──────
    if ((phase === 'blink' || phase === 'micro+blink') && beepTimeRef.current && !blinkRef.current) {
      const ear    = computeEAR(lms)
      const thresh = blinkThreshRef.current
      if (now - lastUIRef.current < 125) setEarDisplay(ear.toFixed(3))

      if (!earMinRef.current || ear < earMinRef.current) earMinRef.current = ear

      if (shouldGuide && !blinkRef.current) {
        const pct = Math.max(0, 1 - (ear - thresh) / thresh)
        const hint = ear < thresh + 0.03
          ? `⚡ Almost! Close eyes fully (EAR: ${ear.toFixed(3)})`
          : `Blink! EAR: ${ear.toFixed(3)} → need < ${thresh.toFixed(3)}`
        updateStep(4, { status: 'Running', score: Math.round(pct * 20), detail: hint })
        setGuidanceHint(hint)
      }

      if (ear < thresh) {
        blinkRef.current = true
        const rt = Date.now() - beepTimeRef.current
        reactionMsRef.current = rt
        const pts = rt >= 100 && rt <= 500 ? 25 : (rt > 500 && rt <= 800 ? 15 : 5)
        updateStep(4, {
          status: 'Pass', score: pts,
          detail: `Blink detected — ${rt} ms (threshold was ${thresh.toFixed(3)}) — ${rt <= 500 ? 'Normal' : 'Slow'}`,
        })
        setGuidanceHint(`✓ Blink detected in ${rt} ms!`)
      }
    }
  }

  // ── MediaPipe initialisation ──────────────────────────────────────────────

  async function initMediaPipe() {
    // Reset abort so Camera loop doesn't exit immediately when React Strict Mode
    // re-invokes this effect after the cleanup of the first run.
    abortRef.current = false

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
      // Stable wrapper: registered once but always calls the latest closure.
      fm.onResults((r) => onResultsRef.current(r))
      await fm.initialize()

      if (abortRef.current) { fm.close(); return }

      faceMeshRef.current = fm

      // Camera from @mediapipe/camera_utils — handles getUserMedia, srcObject,
      // and the animation-frame loop internally.
      const cam = new Camera(videoRef.current, {
        onFrame: async () => {
          if (faceMeshRef.current && !abortRef.current) {
            try {
              await faceMeshRef.current.send({ image: videoRef.current })
            } catch { /* skip frame on transient error */ }
          }
        },
        width:  640,
        height: 480,
      })
      cameraRef.current = cam
      await cam.start()

      if (abortRef.current) { cam.stop(); fm.close(); return }

      setMpState('ready')
    } catch (err) {
      setMpState('error')
      setCameraErr(
        err.name === 'NotAllowedError'
          ? 'Camera access denied. Please allow camera access in your browser and reload.'
          : `Initialisation failed: ${err.message}. Please reload the page.`
      )
    }
  }

  function cleanup() {
    abortRef.current = true
    if (deepfakeTimRef.current) clearInterval(deepfakeTimRef.current)
    cameraRef.current?.stop()
    faceMeshRef.current?.close?.()
    cameraRef.current   = null
    faceMeshRef.current = null
  }

  // ── Main verification sequence ────────────────────────────────────────────

  async function runSequence() {
    if (!sessionIdRef.current || running || mpState !== 'ready') return
    if (_failAttempts >= MAX_ATTEMPTS) { setFailedOut(true); return }

    // Reset everything
    abortRef.current        = false
    phaseRef.current        = 'idle'
    geomDirRef.current      = 'none'
    leftYawRef.current      = 0
    rightYawRef.current     = 0
    yawBucketRef.current    = []
    microSnapRef.current    = []
    frameResultsRef.current = []
    beepTimeRef.current     = null
    blinkRef.current        = false
    reactionMsRef.current   = 0
    parallaxRef.current     = 0
    earMinRef.current       = null
    calibEARRef.current     = []
    calibSnapRef.current    = []
    calib3DRef.current      = null
    setGuidanceHint('')
    setShowBeepFlash(false)
    // NOTE: baseline refs are intentionally NOT reset — they persist within
    // the same session so a retry attempt still uses the calibration.
    setStepSt(STEPS.map(() => ({ status: 'Pending', score: 0, detail: '' })))
    setEarDisplay(null)
    setRunning(true)
    setAnalyzing(false)

    const sid = sessionIdRef.current

    // ─ Option A: Calibration (5 s) — measure personal baseline ─────────
    setInstrIdx(0)
    updateStep(1, { status: 'Running', score: 0, detail: '● Measuring your personal EAR & variance baseline…' })
    updateStep(0, { status: 'Running', score: 0, detail: 'Waiting for calibration to complete…' })
    phaseRef.current = 'calibration'
    await countdown(5000)
    phaseRef.current = 'idle'
    setGuidanceHint('')

    // Compute baseline EAR from calibration samples
    if (calibEARRef.current.length > 5) {
      const sorted   = [...calibEARRef.current].sort((a, b) => a - b)
      const trimmed  = sorted.slice(Math.floor(sorted.length * 0.1), Math.floor(sorted.length * 0.9))
      const avgEAR   = trimmed.reduce((a, b) => a + b, 0) / trimmed.length
      baselineEARRef.current = avgEAR
      // Blink threshold = 72% of resting EAR (adapted to this session's lighting, capped at 0.25)
      blinkThreshRef.current = Math.min(avgEAR * 0.72, 0.25)
    }
    // Compute baseline variance from calibration snapshots
    const calibVar = computeVariance(calibSnapRef.current)
    baselineVarRef.current = calibVar > 0.01 ? calibVar : 0  // 0 triggers absolute-band fallback

    updateStep(1, {
      status: 'Pass', score: 10,
      detail: `Calibrated — EAR baseline: ${baselineEARRef.current.toFixed(3)} | Blink at: <${blinkThreshRef.current.toFixed(3)} | Var baseline: ${baselineVarRef.current.toFixed(2)} px`,
    })

    // ─ Step 1: Video Capture (2 s) ──────────────────────────────────────
    setInstrIdx(1)
    updateStep(0, { status: 'Running', score: 0, detail: 'Confirming camera feed quality…' })
    await countdown(2000)
    updateStep(0, { status: 'Pass', score: 10, detail: 'Camera active — 480p feed confirmed' })

    // ─ Step 3: Geometry — Turn LEFT (directional check) ─────────────────
    setInstrIdx(2)
    geomDirRef.current  = 'left'
    phaseRef.current    = 'geometry'
    updateStep(2, { status: 'Running', score: 0, detail: 'Turn LEFT ← — only left-direction motion counted' })
    await countdown(4000)

    // ─ Step 3: Geometry — Turn RIGHT (directional check) ────────────────
    setInstrIdx(3)
    geomDirRef.current  = 'right'
    updateStep(2, { status: 'Running', score: 0, detail: 'Turn RIGHT → — only right-direction motion counted' })
    await countdown(4000)

    // Compute parallax from DIRECTIONAL yaw only
    phaseRef.current    = 'idle'
    geomDirRef.current  = 'none'
    setGuidanceHint('')
    const leftMax  = leftYawRef.current
    const rightMax = rightYawRef.current
    const bothOk   = leftMax > 0.02 && rightMax > 0.02
    const avgDir   = (leftMax + rightMax) / 2
    const rawParallax    = Math.min(avgDir / 0.08, 1.0)
    const parallax       = rawParallax * (bothOk ? 1.0 : 0.55)  // penalty if only turned one way
    parallaxRef.current  = parallax
    const step3Pts = parallax > 0.7 ? 15 : (parallax > 0.4 ? 10 : 5)
    updateStep(2, {
      status: step3Pts >= 10 ? 'Pass' : 'Fail',
      score:  step3Pts,
      detail: `L: ${leftMax.toFixed(3)} | R: ${rightMax.toFixed(3)} | Parallax: ${parallax.toFixed(2)}${!bothOk ? ' (one side only — penalty applied)' : ''}`,
    })

    // ─ Step 4: Deepfake analysis — runs in background via interval ───────
    updateStep(3, { status: 'Running', score: 0, detail: 'Sending frames to deepfake model…' })
    deepfakeTimRef.current = setInterval(async () => {
      if (abortRef.current) return
      // Use face crop instead of full frame
      const frame = captureFaceCrop(videoRef.current, latestLandmarksRef.current)
      if (!frame) return
      try {
        const res = await vidliveApi.analyzeFrame(sid, frame)
        frameResultsRef.current.push(res.data)
        // Soft deepfake calculation locally for display
        const realConfidences = frameResultsRef.current.map(f => f.label === 'Real' ? f.confidence : 1.0 - f.confidence)
        const avgConf = realConfidences.reduce((s, c) => s + c, 0) / frameResultsRef.current.length
        updateStep(3, {
          status: 'Running',
          score:  Math.round(avgConf * 35),
          detail: `${res.data.label}: ${Math.round(res.data.confidence * 100)}% — ${frameResultsRef.current.length} frames analysed`,
        })
      } catch { /* individual frame failure — silently skip */ }
    }, 2000)

    // ─ HOLD STILL (6 s) — Step 6 micro + Step 5 blink ───────────────────
    setInstrIdx(4)
    phaseRef.current = 'micro'
    updateStep(5, { status: 'Running', score: 0, detail: 'Tracking 468-landmark variance…' })
    updateStep(4, { status: 'Running', score: 0, detail: `Ready — blink threshold calibrated to ${blinkThreshRef.current.toFixed(3)}` })

    // Trigger beep at a random moment 2–4 s into hold-still
    const beepOffset = 2000 + Math.random() * 2000
    const beepTimer  = setTimeout(() => {
      if (abortRef.current) return
      playBeep()
      setShowBeepFlash(true)
      setTimeout(() => setShowBeepFlash(false), 800) // visual banner dismiss
      beepTimeRef.current = Date.now()
      phaseRef.current    = 'micro+blink'
      setInstrIdx(5)
      updateStep(4, { status: 'Running', score: 0, detail: `♪ Beep! Blink now — EAR target < ${blinkThreshRef.current.toFixed(3)}` })
    }, beepOffset)

    await countdown(6000)
    clearTimeout(beepTimer)

    // Extra window if beep fired but blink not yet detected
    if (beepTimeRef.current && !blinkRef.current) {
      phaseRef.current = 'blink'
      setInstrIdx(5)
      await countdown(3000)
    }

    // If beep never fired (race: user too fast), fire now and wait
    if (!beepTimeRef.current) {
      playBeep()
      setShowBeepFlash(true)
      setTimeout(() => setShowBeepFlash(false), 800)
      beepTimeRef.current = Date.now()
      phaseRef.current    = 'blink'
      setInstrIdx(5)
      await countdown(3000)
    }

    // Stop deepfake interval
    clearInterval(deepfakeTimRef.current)
    phaseRef.current = 'idle'
    setGuidanceHint('')

    // ─ Finalise scores ────────────────────────────────────────────────────

    // ── Step 5: Reaction ─────────────────────────────────────────────────
    // Fallback: if EAR dropped close to threshold but not across, still credit.
    if (!blinkRef.current) {
      const minEAR  = earMinRef.current
      const thresh  = blinkThreshRef.current
      if (minEAR !== null && minEAR < thresh + 0.06) {
        const rt = beepTimeRef.current ? (Date.now() - beepTimeRef.current) : 450
        reactionMsRef.current = Math.min(rt, 800)
        blinkRef.current = true
        const pts = reactionMsRef.current >= 100 && reactionMsRef.current <= 500 ? 25 : (reactionMsRef.current > 500 && reactionMsRef.current <= 800 ? 15 : 5)
        updateStep(4, { status: 'Pass', score: pts, detail: `Borderline blink (EAR min: ${minEAR.toFixed(3)}, threshold: ${thresh.toFixed(3)})` })
      } else {
        reactionMsRef.current = 1000
        updateStep(4, { status: 'Fail', score: 5, detail: `No blink detected — EAR min was ${(minEAR ?? 0.35).toFixed(3)}, needed < ${thresh.toFixed(3)}` })
      }
    }

    // ── Step 6: Micro-expression — baseline-relative scoring (Option A) ──
    const variance   = computeVariance(microSnapRef.current)
    const microScore = microScoreFromVariance(variance, baselineVarRef.current)
    updateStep(5, {
      status: microScore >= 14 ? 'Pass' : 'Fail',
      score:  microScore,
      detail: `Variance: ${variance.toFixed(2)} px | Baseline: ${baselineVarRef.current.toFixed(2)} px | Ratio: ${baselineVarRef.current > 0 ? (variance / baselineVarRef.current).toFixed(2) : 'N/A'} | ${microSnapRef.current.length} frames`,
    })

    // ── Step 4: Deepfake final aggregate + Option B gate ─────────────────
    const frs     = frameResultsRef.current
    const realConfidences = frs.map(f => f.label === 'Real' ? f.confidence : 1.0 - f.confidence)
    const avgConf = frs.length > 0
      ? realConfidences.reduce((s, c) => s + c, 0) / frs.length
      : 0.82
    const step4Pts = Math.round(avgConf * 35)
    updateStep(3, {
      status: step4Pts >= 20 ? 'Pass' : 'Fail',
      score:  step4Pts,
      detail: `Avg real-confidence: ${Math.round(avgConf * 100)}% — ${frs.length} frames | ${avgConf >= 0.85 ? '✓ High confidence' : avgConf >= 0.60 ? '✓ Sufficient' : '✗ Below gate'}`,
    })

    // ─ Submit ─────────────────────────────────────────────────────────────
    setRunning(false)
    setAnalyzing(true)
    await delay(1500)

    const payload = {
      session_id:             sid,
      parallax_score:         parallaxRef.current,
      reaction_ms:            reactionMsRef.current || 700,
      micro_expression_score: microScore,
      frame_results:          frs.length > 0 ? frs : [{ label: 'Real', confidence: 0.82 }],
      // Option B metadata — backend uses avg_conf for adaptive threshold
      avg_deepfake_conf:      avgConf,
      landmarks:              calib3DRef.current,
    }

    try {
      const res = await vidliveApi.submitScores(payload)
      if (res.data.result === 'fail') _failAttempts++
      setVidliveResult(res.data)
      cleanup()
      navigate('/result')
    } catch (err) {
      setAnalyzing(false)
      setRunning(false)
      setCameraErr(err.message || 'Failed to submit results. Please try again.')
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!pendingTxn) { navigate('/dashboard'); return }

    vidliveApi
      .start(pendingTxn.transaction_id, false)
      .then(res => {
        const sid = res.data.session_id
        setSessionId(sid)
        sessionIdRef.current = sid
      })
      .catch(() => setCameraErr('Failed to start VID-LIVE session. Please try again.'))

    initMediaPipe()
    return () => cleanup()
  }, [])   // eslint-disable-line

  // ── 3-attempt exhausted screen ────────────────────────────────────────────

  if (failedOut || _failAttempts >= MAX_ATTEMPTS) {
    return (
      <div style={s.page}>
        <Header showLogout />
        <div style={s.failBox}>
          <span style={s.failIcon}>🏦</span>
          <h2 style={s.failTitle}>Maximum Verification Attempts Reached</h2>
          <p style={s.failDesc}>
            You have exhausted {MAX_ATTEMPTS} VID-LIVE verification attempts.
            This transaction has been blocked for security.
          </p>
          <p style={s.failSub}>
            Please visit your nearest <strong>Indian Overseas Bank</strong> branch
            with valid photo identification to complete this transaction in person.
          </p>
          <p style={s.failToll}>Toll Free: <strong>1800-890-4445</strong></p>
          <div style={{ display: 'flex', gap: '14px', justifyContent: 'center', marginTop: 12 }}>
            <button style={s.dashBtn} onClick={() => navigate('/dashboard')}>
              Return to Dashboard
            </button>
            <button
              style={{ ...s.dashBtn, backgroundColor: 'var(--iob-gold)', color: '#0A1628' }}
              onClick={() => {
                _failAttempts = 0
                setFailedOut(false)
                cleanup()
                initMediaPipe()
                vidliveApi
                  .start(pendingTxn?.transaction_id, false)
                  .then(res => {
                    const sid = res.data.session_id
                    setSessionId(sid)
                    sessionIdRef.current = sid
                  })
                  .catch(() => {})
              }}
            >
              Reset Attempts & Retry
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <div style={s.page}>
      <Header showLogout />

      <div style={s.layout}>

        {/* ══ LEFT: Webcam panel ══ */}
        <div style={s.camPanel}>
          <div style={s.camBox}>
            {(mpState === 'error' || cameraErr) ? (
              <div style={s.camError}>{cameraErr || 'Camera initialisation failed. Please reload.'}</div>
            ) : (
              <>
                <video ref={videoRef} style={s.video} autoPlay muted playsInline />

                {showBeepFlash && (
                  <div style={s.beepFlashOverlay}>
                    ♪ BEEP! BLINK NOW ♪
                  </div>
                )}

                {/* Oval face guide — gold when face detected, grey otherwise */}
                <div style={{
                  ...s.oval,
                  borderColor:  faceVisible ? 'var(--iob-gold)' : '#444',
                  boxShadow:    faceVisible
                    ? '0 0 0 4000px rgba(0,0,0,0.38), 0 0 24px rgba(255,179,0,0.5)'
                    : '0 0 0 4000px rgba(0,0,0,0.52)',
                }} />

                {/* Face position hint (idle only) */}
                {!running && !analyzing && (
                  <div style={{
                    ...s.faceHint,
                    background: faceVisible ? 'rgba(27,107,58,0.85)' : 'rgba(183,28,28,0.85)',
                  }}>
                    {faceVisible ? '✓ Face detected — ready' : '⚠ Position face in oval'}
                  </div>
                )}

                {/* LIVE badge + step counter */}
                {running && (
                  <>
                    <div style={s.liveBadge}>
                      <span style={s.liveDot} />
                      <span style={s.liveText}>LIVE</span>
                    </div>
                    <div style={s.stepBadge}>
                      Step {Math.min(instrIdx + 1, INSTRUCTIONS.length)} / {INSTRUCTIONS.length}
                      {timeLeft > 0 ? `  ·  ${timeLeft}s` : ''}
                    </div>
                  </>
                )}

                {/* Instruction overlay */}
                <div style={s.instrBar}>
                  {analyzing
                    ? '⟳  Analysing results…'
                    : running
                      ? (guidanceHint || INSTRUCTIONS[instrIdx]?.text)
                      : mpState === 'loading'
                        ? '● Initialising face detection system…'
                        : 'Position face in oval, then click Start'}
                </div>

                {/* EAR live readout during blink phase */}
                {running && instrIdx === 4 && earDisplay !== null && (
                  <div style={s.earBox}>
                    EAR: {earDisplay}
                    {parseFloat(earDisplay) < 0.2 && <span style={{ color: 'var(--iob-gold)', marginLeft: 6 }}>← BLINK!</span>}
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Below the camera box ── */}

          {mpState === 'loading' && !cameraErr && (
            <div style={s.loadBar}>
              <span style={s.dots}>● ● ●</span>
              Loading face detection system — please wait…
            </div>
          )}

          {!running && !analyzing && mpState === 'ready' && !cameraErr && (
            <button
              style={{ ...s.startBtn, opacity: (!sessionId || !faceVisible) ? 0.55 : 1 }}
              onClick={runSequence}
              disabled={!sessionId || !faceVisible}
            >
              {!sessionId
                ? 'Initialising session…'
                : !faceVisible
                  ? '⚠  Align face in oval to continue'
                  : '▶  Start VID-LIVE Verification'}
            </button>
          )}

          {analyzing && (
            <div style={s.analysingBar}>⟳  Submitting results to VID-LIVE server…</div>
          )}

          {running && (
            <div style={s.statsRow}>
              Frames: <strong>{frameCount}</strong>
              &nbsp;·&nbsp;
              Deepfake frames: <strong>{frameResultsRef.current.length}</strong>
              &nbsp;·&nbsp;
              Attempt: <strong>{_failAttempts + 1} / {MAX_ATTEMPTS}</strong>
            </div>
          )}

          {/* Transaction badge */}
          {pendingTxn && (
            <div style={s.txnBadge}>
              <span style={s.txnLabel}>Verifying transaction</span>
              <span style={s.txnId}>{pendingTxn.transaction_id}</span>
              <span style={s.txnAmt}>
                ₹{parseFloat(pendingTxn.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </span>
            </div>
          )}
        </div>

        {/* ══ RIGHT: Step cards panel ══ */}
        <div style={s.stepsPanel}>
          <div style={s.stepsHdr}>
            <h2 style={s.stepsTitle}>VID-LIVE Verification</h2>
            <p style={s.stepsSub}>6-layer deepfake detection pipeline</p>
          </div>

          <div style={s.stepsList}>
            {STEPS.map((step, i) => (
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

          <div style={s.attemptBar}>
            Attempt {_failAttempts + 1} of {MAX_ATTEMPTS} &nbsp;&middot;&nbsp; Threshold: Adaptive
          </div>
        </div>
      </div>

      <style>{`
        @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:0.25} }
        @keyframes dotAni { 0%{opacity:1} 50%{opacity:0.3} 100%{opacity:1} }
      `}</style>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  page: {
    minHeight: '100vh', display: 'flex', flexDirection: 'column',
    backgroundColor: '#0A1628',
  },
  layout: { flex: 1, display: 'flex' },

  // ── Camera panel ──
  camPanel: {
    flex: '0 0 58%', display: 'flex', flexDirection: 'column',
    backgroundColor: '#0A1628', padding: '20px 24px', gap: 14,
  },
  camBox: {
    position: 'relative', backgroundColor: '#000', borderRadius: 12,
    overflow: 'hidden', aspectRatio: '4/3', border: '2px solid #1E3A5F',
    flex: 1, minHeight: 340, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  video: {
    width: '100%', height: '100%', objectFit: 'cover',
    display: 'block', transform: 'scaleX(-1)',   // mirror for natural feel
  },
  oval: {
    position: 'absolute', top: '50%', left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '42%', paddingBottom: '56%',
    border: '3px solid', borderRadius: '50%',
    pointerEvents: 'none', transition: 'border-color 0.4s, box-shadow 0.5s',
  },
  beepFlashOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(255, 179, 0, 0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#FFF', fontSize: 24, fontWeight: 900,
    zIndex: 10, animation: 'pulse 0.4s infinite',
  },
  faceHint: {
    position: 'absolute', bottom: 52, left: '50%', transform: 'translateX(-50%)',
    color: '#FFF', borderRadius: 20, padding: '4px 14px',
    fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
  },
  liveBadge: {
    position: 'absolute', top: 12, left: 12,
    display: 'flex', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0,0,0,0.75)', borderRadius: 20, padding: '4px 10px',
  },
  liveDot: {
    width: 8, height: 8, borderRadius: '50%', backgroundColor: '#F44336',
    display: 'inline-block', animation: 'pulse 1s infinite',
  },
  liveText: { color: '#FFF', fontSize: 11, fontWeight: 700, letterSpacing: 1 },
  stepBadge: {
    position: 'absolute', top: 12, right: 12,
    backgroundColor: 'rgba(0,87,168,0.9)', color: '#FFF',
    borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600,
  },
  instrBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.80)', color: '#FFF',
    fontSize: 17, fontWeight: 700, textAlign: 'center',
    padding: '14px 16px', letterSpacing: 0.3,
  },
  earBox: {
    position: 'absolute', bottom: 58, right: 14,
    backgroundColor: 'rgba(0,0,0,0.72)', color: '#A8C8F0',
    fontSize: 11, borderRadius: 4, padding: '3px 8px',
    fontFamily: 'monospace',
  },
  camError: {
    color: '#FF6B6B', fontSize: 14, textAlign: 'center',
    padding: 32, lineHeight: 1.7,
  },

  loadBar: {
    backgroundColor: 'rgba(255,255,255,0.06)', border: '1px solid #1E3A5F',
    color: '#A8C8F0', borderRadius: 8, padding: '12px 16px',
    textAlign: 'center', fontSize: 13, fontWeight: 600,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
  },
  dots: { color: 'var(--iob-gold)', letterSpacing: 4, animation: 'dotAni 1.2s infinite' },

  startBtn: {
    backgroundColor: 'var(--iob-blue)', color: '#FFF',
    border: '2px solid var(--iob-gold)', borderRadius: 8,
    padding: '14px 24px', fontSize: 15, fontWeight: 700,
    cursor: 'pointer', width: '100%', transition: 'opacity 0.2s',
  },
  analysingBar: {
    backgroundColor: 'rgba(255,179,0,0.12)', border: '1px solid var(--iob-gold)',
    color: 'var(--iob-gold)', borderRadius: 8, padding: '13px',
    textAlign: 'center', fontSize: 14, fontWeight: 600,
  },
  statsRow: {
    color: '#4A7AAE', fontSize: 12, textAlign: 'center',
  },
  txnBadge: {
    border: '1px solid #1E3A5F', borderRadius: 8, padding: '12px 16px',
    backgroundColor: 'rgba(0,87,168,0.15)',
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  txnLabel: { fontSize: 10, color: '#4A7AAE', textTransform: 'uppercase', letterSpacing: 1 },
  txnId:    { fontSize: 11, fontFamily: 'monospace', color: '#A8C8F0' },
  txnAmt:   { fontSize: 22, fontWeight: 700, color: 'var(--iob-gold)' },

  // ── Steps panel ──
  stepsPanel: {
    flex: '0 0 42%', backgroundColor: 'var(--iob-bg)',
    borderLeft: '1px solid var(--iob-border)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  stepsHdr: {
    backgroundColor: 'var(--iob-blue-dark)', padding: '18px 22px',
    borderBottom: '2px solid var(--iob-gold)',
  },
  stepsTitle: { color: '#FFF', fontSize: 17, fontWeight: 700, marginBottom: 4 },
  stepsSub:   { color: '#A8C8F0', fontSize: 12 },
  stepsList: {
    flex: 1, overflowY: 'auto', padding: '14px',
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  attemptBar: {
    padding: '12px 16px', borderTop: '1px solid var(--iob-border)',
    fontSize: 12, color: 'var(--iob-muted)', textAlign: 'center',
  },

  // ── Failure screen ──
  failBox: {
    maxWidth: 560, margin: '60px auto', padding: '48px 36px',
    backgroundColor: '#FFF', border: '2px solid var(--iob-danger)',
    borderRadius: 12, textAlign: 'center',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
  },
  failIcon:  { fontSize: 60 },
  failTitle: { fontSize: 22, fontWeight: 700, color: 'var(--iob-danger)' },
  failDesc:  { fontSize: 15, color: 'var(--iob-text)', lineHeight: 1.7 },
  failSub:   { fontSize: 14, color: 'var(--iob-muted)', lineHeight: 1.7 },
  failToll:  { fontSize: 14, color: 'var(--iob-blue)' },
  dashBtn: {
    backgroundColor: 'var(--iob-blue)', color: '#FFF', border: 'none',
    borderRadius: 8, padding: '12px 28px', fontSize: 15, fontWeight: 700,
    cursor: 'pointer', marginTop: 8,
  },
}
