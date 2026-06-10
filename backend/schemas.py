from pydantic import BaseModel
from typing import Optional, List, Any
from datetime import datetime


# ── Auth ──────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    customer_id: str
    password: str


class LoginResponse(BaseModel):
    otp_sent: bool
    phone_hint: str


class OTPVerifyRequest(BaseModel):
    customer_id: str
    otp: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


# ── Customer ───────────────────────────────────────────────────────────────────

class CustomerProfile(BaseModel):
    customer_id: str
    full_name: str
    phone_number: str
    account_number: str
    balance: float
    is_face_enrolled: bool
    registered_at: Optional[datetime]

    class Config:
        from_attributes = True


# ── Transactions ───────────────────────────────────────────────────────────────

class TransferRequest(BaseModel):
    receiver_account: str
    amount: float
    remarks: Optional[str] = ""


class TransferResponse(BaseModel):
    vidlive_required: bool
    success: Optional[bool] = None
    transaction_id: Optional[str] = None
    session_id: Optional[str] = None
    message: Optional[str] = None


class TransactionOut(BaseModel):
    transaction_id: str
    sender_account: str
    receiver_account: str
    receiver_name: str
    amount: float
    remarks: Optional[str]
    status: str
    vidlive_required: bool
    vidlive_passed: Optional[bool]
    created_at: Optional[datetime]

    class Config:
        from_attributes = True


class TransactionHistoryResponse(BaseModel):
    transactions: List[TransactionOut]


# ── VID-LIVE ───────────────────────────────────────────────────────────────────

class VidLiveStartRequest(BaseModel):
    transaction_id: Optional[str] = None
    is_enrollment: bool = False


class VidLiveStartResponse(BaseModel):
    session_id: str


class AnalyzeFrameRequest(BaseModel):
    session_id: str
    frame: str  # base64 JPEG


class AnalyzeFrameResponse(BaseModel):
    label: str
    confidence: float


class FrameResult(BaseModel):
    label: str
    confidence: float


class SubmitScoresRequest(BaseModel):
    session_id: str
    parallax_score: float
    reaction_ms: float
    micro_expression_score: float
    frame_results: List[FrameResult]
    avg_deepfake_conf: Optional[float] = None  # Option B: sent by frontend for adaptive threshold
    landmarks: Optional[List[Any]] = None  # Live landmarks to verify face match


class ScoreBreakdown(BaseModel):
    step3_geometry: float
    step4_deepfake: float
    step5_reaction: float
    step6_micro: float


class SubmitScoresResponse(BaseModel):
    trust_score: float
    result: str
    breakdown: ScoreBreakdown
    transaction_status: Optional[str] = None
    enrolled: Optional[bool] = None
    passing_threshold: Optional[float] = None
    auto_fail_reason: Optional[str] = None


class EnrollFaceRequest(BaseModel):
    landmarks: Any
    micro_baseline: Any
    reaction_baseline: float


class EnrollFaceResponse(BaseModel):
    success: bool
