import axios from 'axios'

const BASE_URL = `http://${window.location.hostname}:8000`

// Token stored in memory — not localStorage (per security spec)
let _token = null

export function setToken(token) {
  _token = token
}

export function getToken() {
  return _token
}

export function clearToken() {
  _token = null
}

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
})

// Attach JWT to every request if present
api.interceptors.request.use((config) => {
  if (_token) {
    config.headers['Authorization'] = `Bearer ${_token}`
  }
  return config
})

// Normalise error responses into readable bank-style messages
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const detail = error?.response?.data?.detail
    if (typeof detail === 'string') {
      error.message = detail
    } else if (Array.isArray(detail)) {
      error.message = detail.map((d) => d.msg).join(', ')
    } else {
      error.message = 'A network error occurred. Please try again.'
    }
    return Promise.reject(error)
  }
)

// ── Auth ──────────────────────────────────────────────────────────────────────

export const authApi = {
  login: (customer_id, password) =>
    api.post('/auth/login', { customer_id, password }),

  verifyOtp: (customer_id, otp) =>
    api.post('/auth/verify-otp', { customer_id, otp }),

  getMe: () => api.get('/auth/me'),
}

// ── Transactions ───────────────────────────────────────────────────────────────

export const transactionsApi = {
  transfer: (receiver_account, amount, remarks) =>
    api.post('/transactions/transfer', { receiver_account, amount, remarks }),

  history: () => api.get('/transactions/history'),
}

// ── VID-LIVE ───────────────────────────────────────────────────────────────────

export const vidliveApi = {
  start: (transaction_id, is_enrollment) =>
    api.post('/vidlive/start', { transaction_id, is_enrollment }),

  analyzeFrame: (session_id, frame) =>
    api.post('/vidlive/analyze-frame', { session_id, frame }),

  submitScores: (payload) => api.post('/vidlive/submit-scores', payload),

  enrollFace: (landmarks, micro_baseline, reaction_baseline) =>
    api.post('/vidlive/enroll-face', { landmarks, micro_baseline, reaction_baseline }),
}

export default api
