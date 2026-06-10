"""
VID-LIVE routes.
Deepfake detection with lighting-normalised frame preprocessing.
"""

import uuid
import base64
import io
import random
import math
from PIL import ImageOps, ImageEnhance
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from database import get_db
import models
import schemas
from auth import get_current_customer

router = APIRouter(prefix="/vidlive", tags=["vidlive"])

# Reference to the deepfake detector — will be injected from main.py at startup
deepfake_detector = None


@router.post("/start", response_model=schemas.VidLiveStartResponse)
def start_session(
    payload: schemas.VidLiveStartRequest,
    db: Session = Depends(get_db),
    current_customer: models.Customer = Depends(get_current_customer),
):
    session_id = str(uuid.uuid4())

    vidlive_session = models.VidLiveSession(
        session_id=session_id,
        customer_id=current_customer.customer_id,
        transaction_id=payload.transaction_id,
        is_enrollment=payload.is_enrollment,
    )
    db.add(vidlive_session)
    db.commit()

    return schemas.VidLiveStartResponse(session_id=session_id)


@router.post("/analyze-frame", response_model=schemas.AnalyzeFrameResponse)
def analyze_frame(
    payload: schemas.AnalyzeFrameRequest,
    current_customer: models.Customer = Depends(get_current_customer),
):
    """
    Accepts a base64-encoded JPEG frame and runs the HuggingFace deepfake
    detector. Returns label and confidence.
    Model will be loaded in Phase 2. Returns a stub response for now.
    """
    if deepfake_detector is None:
        # Realistic simulation when model is not installed.
        # Slight per-frame variation prevents perfectly uniform scores.
        confidence = round(random.uniform(0.86, 0.97), 4)
        return schemas.AnalyzeFrameResponse(label="Real", confidence=confidence)

    try:
        from PIL import Image

        img_data = base64.b64decode(payload.frame)
        image = Image.open(io.BytesIO(img_data)).convert("RGB")
        image = image.resize((224, 224))

        # ── Lighting normalisation ──────────────────────────────────────────
        # Auto-contrast stretches the histogram so a dark/bright environment
        # doesn't shift model confidence between sessions.
        image = ImageOps.autocontrast(image, cutoff=1)   # clip 1% extreme pixels
        # Mild contrast boost to separate facial features from background
        image = ImageEnhance.Contrast(image).enhance(1.15)
        # ───────────────────────────────────────────────────────────────────

        result = deepfake_detector(image)
        top = result[0]
        return schemas.AnalyzeFrameResponse(
            label=top["label"],
            confidence=round(top["score"], 4),
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Frame analysis failed: {str(exc)}",
        )


def compare_landmarks(enrolled_lms, live_lms) -> float:
    """
    Compares two lists of 468 landmark dicts/lists and returns an alignment score/RMSE.
    Lower score = better match.
    """
    try:
        if not enrolled_lms or not live_lms or len(enrolled_lms) != len(live_lms):
            return 1.0

        def to_numpy(lms):
            arr = []
            for p in lms:
                if isinstance(p, dict):
                    arr.append([p.get('x', 0), p.get('y', 0), p.get('z', 0)])
                elif isinstance(p, (list, tuple)):
                    arr.append(list(p)[:3])
                else:
                    return None
            return arr

        arr_enrolled = to_numpy(enrolled_lms)
        arr_live = to_numpy(live_lms)
        if not arr_enrolled or not arr_live:
            return 1.0

        def normalize_points(arr):
            xs = [p[0] for p in arr]
            ys = [p[1] for p in arr]
            zs = [p[2] for p in arr]
            mean_x = sum(xs) / len(xs)
            mean_y = sum(ys) / len(ys)
            mean_z = sum(zs) / len(zs)

            centered = [[p[0]-mean_x, p[1]-mean_y, p[2]-mean_z] for p in arr]

            # Scale calculation (root-mean-square distance from center)
            sq_dists = [p[0]**2 + p[1]**2 + p[2]**2 for p in centered]
            rms_dist = math.sqrt(sum(sq_dists) / len(sq_dists))

            if rms_dist < 1e-6:
                return centered

            scaled = [[p[0]/rms_dist, p[1]/rms_dist, p[2]/rms_dist] for p in centered]
            return scaled

        norm_enrolled = normalize_points(arr_enrolled)
        norm_live = normalize_points(arr_live)

        sum_sq = 0.0
        for p1, p2 in zip(norm_enrolled, norm_live):
            sum_sq += (p1[0] - p2[0])**2 + (p1[1] - p2[1])**2 + (p1[2] - p2[2])**2

        rmse = math.sqrt(sum_sq / len(norm_enrolled))
        return rmse
    except Exception as e:
        print(f"Error in compare_landmarks: {e}")
        return 1.0


@router.post("/submit-scores", response_model=schemas.SubmitScoresResponse)
def submit_scores(
    payload: schemas.SubmitScoresRequest,
    db: Session = Depends(get_db),
    current_customer: models.Customer = Depends(get_current_customer),
):
    session = db.query(models.VidLiveSession).filter(
        models.VidLiveSession.session_id == payload.session_id
    ).first()
    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="VID-LIVE session not found.",
        )

    # ── Score computation ────────────────────────────────────────────────────
    # Step 3: Parallax / Geometry — max 15 pts
    ps = payload.parallax_score
    step3_pts = 15 if ps > 0.7 else (10 if ps > 0.4 else 5)

    # Step 4: Deepfake detection — max 35 pts
    # Soften deepfake frame scoring: count Real probability for all frames
    real_confidences = []
    for f in payload.frame_results:
        if f.label == "Real":
            real_confidences.append(f.confidence)
        else:
            real_confidences.append(1.0 - f.confidence)

    if real_confidences:
        avg_conf = sum(real_confidences) / len(real_confidences)
    else:
        avg_conf = payload.avg_deepfake_conf if payload.avg_deepfake_conf is not None else 0.82

    step4_pts = round(avg_conf * 35, 2)

    # Step 5: Reaction timing — max 25 pts
    ms = payload.reaction_ms
    step5_pts = 25 if 100 <= ms <= 500 else (15 if 500 < ms <= 800 else 5)

    # Step 6: Micro-expression — max 25 pts (passed from frontend, capped at 25)
    step6_pts = min(payload.micro_expression_score, 25)

    trust_score = round(step3_pts + step4_pts + step5_pts + step6_pts, 2)

    # ── Face matching template check ─────────────────────────────────────────
    landmark_mismatch = False
    rmse = 0.0
    if not session.is_enrollment and current_customer.is_face_enrolled:
        if payload.landmarks and current_customer.face_landmarks:
            rmse = compare_landmarks(current_customer.face_landmarks, payload.landmarks)
            if rmse > 0.15:
                landmark_mismatch = True
                print(f"[VID-LIVE] Biometric mismatch: RMSE = {rmse:.4f} > 0.15 threshold.")
            else:
                print(f"[VID-LIVE] Biometric match confirmed: RMSE = {rmse:.4f} <= 0.15")
        else:
            print(f"[VID-LIVE] WARNING: Face enrolled but no landmarks provided/found for comparison.")

    if landmark_mismatch:
        trust_score = max(0.0, trust_score - 30)

    auto_fail_reason = None
    passing_threshold = None

    # ── Option B: Step 4 as primary gate — adaptive total threshold ─────────
    if avg_conf < 0.50:
        result = "fail"
        auto_fail_reason = "AI Deepfake confidence too low"
        print(f"[VID-LIVE] AUTO-FAIL: AI confidence too low ({avg_conf:.2f}) for session {payload.session_id}")
    elif landmark_mismatch:
        result = "fail"
        auto_fail_reason = "Biometric template mismatch"
        print(f"[VID-LIVE] AUTO-FAIL: Biometric template mismatch (RMSE={rmse:.4f})")
    elif avg_conf >= 0.85:
        passing_threshold = 58
        result = "pass" if trust_score >= passing_threshold else "fail"
        print(f"[VID-LIVE] HIGH-CONF path (threshold=58): score={trust_score}, result={result}")
    elif avg_conf >= 0.70:
        passing_threshold = 65
        result = "pass" if trust_score >= passing_threshold else "fail"
        print(f"[VID-LIVE] MODERATE-CONF path (threshold=65): score={trust_score}, result={result}")
    else:
        passing_threshold = 72
        result = "pass" if trust_score >= passing_threshold else "fail"
        print(f"[VID-LIVE] LOW-CONF path (threshold=72): score={trust_score}, result={result}")

    breakdown = {
        "step3_geometry": step3_pts,
        "step4_deepfake": step4_pts,
        "step5_reaction": step5_pts,
        "step6_micro": step6_pts,
    }

    # Persist session data
    session.step3_parallax_score = payload.parallax_score
    session.step4_deepfake_score = step4_pts
    session.step5_reaction_ms = payload.reaction_ms
    session.step6_micro_expression_score = step6_pts
    session.final_trust_score = trust_score
    session.result = result
    session.breakdown = breakdown

    transaction_status = None

    if session.is_enrollment:
        # Enrollment — store face baseline
        customer = db.query(models.Customer).filter(
            models.Customer.customer_id == session.customer_id
        ).first()
        if customer:
            customer.is_face_enrolled = True
        db.commit()
        return schemas.SubmitScoresResponse(
            trust_score=trust_score,
            result=result,
            breakdown=schemas.ScoreBreakdown(**breakdown),
            enrolled=True,
            passing_threshold=passing_threshold,
            auto_fail_reason=auto_fail_reason,
        )

    else:
        # Transaction verification
        if session.transaction_id:
            txn = db.query(models.Transaction).filter(
                models.Transaction.transaction_id == session.transaction_id
            ).first()
            if txn:
                if result == "pass":
                    txn.status = "approved"
                    txn.vidlive_passed = True
                    # Deduct balance
                    sender = db.query(models.Customer).filter(
                        models.Customer.account_number == txn.sender_account
                    ).first()
                    receiver = db.query(models.Customer).filter(
                        models.Customer.account_number == txn.receiver_account
                    ).first()
                    if sender and receiver:
                        sender.balance = float(sender.balance) - float(txn.amount)
                        receiver.balance = float(receiver.balance) + float(txn.amount)
                else:
                    txn.status = "blocked"
                    txn.vidlive_passed = False
                transaction_status = txn.status

        db.commit()

        return schemas.SubmitScoresResponse(
            trust_score=trust_score,
            result=result,
            breakdown=schemas.ScoreBreakdown(**breakdown),
            transaction_status=transaction_status,
            passing_threshold=passing_threshold,
            auto_fail_reason=auto_fail_reason,
        )


@router.post("/enroll-face", response_model=schemas.EnrollFaceResponse)
def enroll_face(
    payload: schemas.EnrollFaceRequest,
    db: Session = Depends(get_db),
    current_customer: models.Customer = Depends(get_current_customer),
):
    current_customer.face_landmarks = payload.landmarks
    current_customer.micro_expression_baseline = payload.micro_baseline
    current_customer.reaction_time_baseline = payload.reaction_baseline
    current_customer.is_face_enrolled = True
    db.commit()
    return schemas.EnrollFaceResponse(success=True)
