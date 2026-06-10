# VID-LIVE Review Preparation Document

This document contains a comprehensive breakdown of the VID-LIVE project to help you prepare for your technical review. It covers the architecture, technology choices, the multi-layered security pipeline, and the intricate details of how the biometric and deepfake models work.

---

## 1. Project Overview & Objective
**VID-LIVE** is a deepfake-resilient, multi-layered authentication system built for Indian Overseas Bank (IOB). Its primary objective is to prevent high-value financial fraud by verifying that the user initiating a transaction is:
1. **Live and present** (defeating static photos, 2D masks, and pre-recorded videos).
2. **Human, not AI** (defeating deepfakes, face-swaps, and AI-generated video injections).
3. **The genuine account holder** (defeating impersonators via biometric template matching).

---

## 2. Technology Stack & Architecture

### Frontend (Client-Side)
* **Framework:** React (Vite)
* **Face Tracking & Landmarking:** Google MediaPipe (FaceMesh)
    * *Why MediaPipe?* It runs entirely in the browser using WebAssembly/WebGL, achieving 30+ FPS. This allows us to track 468 3D facial landmarks in real-time without overwhelming the backend with continuous video streaming.
* **Audio-Visual Liveness:** Web Audio API (for randomized beep generation).
* **Styling:** Pure CSS (following strict IOB brand guidelines).

### Backend (Server-Side)
* **Framework:** Python FastAPI (chosen for high performance and asynchronous request handling).
* **Database:** PostgreSQL with SQLAlchemy ORM (for transactions, user profiles, and audit trails).
* **Authentication:** JWT tokens + bcrypt password hashing.
* **Deepfake Inference:** ONNX Runtime.

### Why ONNX Runtime? (Crucial Talking Point)
Initially, the prompt called for standard HuggingFace `transformers` and `torch`. However, we transitioned the AI deepfake model to **ONNX (Open Neural Network Exchange)**. 
* **The Problem:** Running heavy PyTorch models on standard CPUs is extremely slow, leading to high latency during verification.
* **The Solution:** ONNX is heavily optimized for fast, efficient inference on edge devices and CPUs. Since we lacked dedicated GPU hardware for the backend, ONNX allowed us to run the deepfake classification model locally and extremely fast, ensuring real-time feedback without crashing or lagging the server.

---

## 3. The 6-Layer Security Pipeline Explained

When a user initiates a high-value transfer (≥ ₹50,000), they must pass the VID-LIVE pipeline. Here is exactly how it works under the hood.

### Step 1 & 2: Video Capture & Lighting Normalization
* **How it works:** The camera feed is established. Before processing, the frames are normalized for brightness and contrast. This ensures that the deepfake model doesn't fail simply because the user is in a dimly lit room.

### Step 3: 3D Geometry (Active Liveness)
* **What it does:** Forces the user to turn their head left and right.
* **How it works:** Using the 468 3D coordinates from MediaPipe, we calculate the **Yaw** (horizontal rotation) and **Pitch** (vertical tilt). We measure the relative distance between the nose tip and the center of the face. 
* **Why it matters:** 2D masks or photos cannot accurately replicate 3D depth rotation (parallax).

### Step 4: AI Deepfake Detection (The ONNX Model)
* **What it does:** Detects AI-generated artifacts, synthetic skin textures, and face-swap blending lines.
* **How it works:** The frontend takes a base64 snapshot of the user's face, heavily crops it (using a bounding box derived from the MediaPipe landmarks) to remove background noise, and sends it to the backend. The FastAPI backend runs this cropped face through the ONNX deepfake classification model. 
* **Adaptive Security:** Instead of a hard pass/fail, it averages the deepfake confidence over multiple frames. If the AI confidence falls below a specific threshold (e.g., 50%), the transaction is **auto-failed**, overriding all other scores.

### Step 5: Reaction Time (Challenge-Response Liveness)
* **What it does:** Prevents attackers from using pre-recorded videos.
* **How it works:** The system plays an 800Hz beep at a **randomized** time. The user must blink immediately. We detect the blink by calculating the **Eye Aspect Ratio (EAR)** using specific eye landmarks. 
* **The Math:** `EAR = (vertical distance between eyelids) / (horizontal distance)`. When EAR drops below a calibrated threshold, a blink is registered. If the reaction time is outside the normal human range (100ms - 500ms), it's flagged as a potential pre-recorded injection attack.

### Step 6: Micro-expression Analysis (Passive Liveness)
* **What it does:** Ensures the face is a living, breathing human.
* **How it works:** Deepfakes often struggle to replicate involuntary micro-muscle movements, appearing unnaturally stiff. Conversely, poorly rendered deepfakes might have erratic, jittery landmarks. We calculate the mathematical **variance (standard deviation)** of the 468 facial landmarks over a 5-second "hold still" period. If the variance is too low (static photo) or too high (glitchy deepfake), it fails.

---

## 4. Biometric Face-Matching (Enrollment vs. Verification)

This is a critical security feature we implemented to prevent a genuine human from using *their* face to authorize *someone else's* account.

* **Enrollment:** The first time a user uses VID-LIVE, their 468 3D facial landmarks, their resting blink rate (EAR baseline), and their natural micro-expression variance are stored in the PostgreSQL database as a biometric template.
* **Verification (Template Matching):** During future transactions, the live facial landmarks are sent to the backend. The backend uses a custom algorithm to calculate the **Root Mean Square Error (RMSE)**.
* **The Math:** We normalize both sets of 3D points (to account for the user being closer or further from the camera than last time), and compute the spatial difference (RMSE) between the live face and the enrolled face.
* **Auto-fail:** If the RMSE exceeds the threshold (e.g., `0.15`), it means the geometry of the face doesn't match the account owner. The system subtracts 30 points as a penalty and instantly blocks the transaction due to a "Biometric Template Mismatch."

---

## 5. Potential Interview Questions & Answers

**Q: Why use MediaPipe on the frontend instead of sending video to the backend?**
A: Sending continuous 30fps video to a backend server requires massive bandwidth and GPU processing power. By offloading the heavy geometric lifting (landmark tracking, EAR calculation, variance) to the user's browser using MediaPipe, we make the system infinitely scalable and fast. We only send lightweight telemetry and specific image frames to the backend.

**Q: How do you handle different lighting conditions or camera qualities?**
A: We implemented adaptive thresholds. For example, instead of a hardcoded threshold for blinks, we calculate the user's resting Eye Aspect Ratio (EAR) during the setup phase and set the blink threshold dynamically to 65-72% of *their specific* resting EAR. We also apply image enhancement algorithms to frames before sending them to the deepfake model.

**Q: How did you fix the AI deepfake model accuracy?**
A: The model was initially analyzing the entire room background, which confused it. We implemented a dynamic bounding box using the face landmarks. We find the min/max X and Y coordinates of the face, add a 15% padding, crop the image on the frontend, and send *only the face* to the backend. This drastically improved the ONNX model's confidence scores.

**Q: Why does the Trust Score have an "Adaptive Threshold"?**
A: Security isn't binary. If the AI is 95% confident the user is real, we can be slightly lenient on their reaction time (e.g., they might just be slow to blink). But if the AI is only 60% confident, we raise the required total score threshold higher, forcing them to have performed perfectly on the 3D geometry and micro-expression tests to pass. If AI confidence drops below 50%, it's a hard auto-fail.

---

## 6. Next Process / Live Demonstration Phase

To prove the efficacy of the system to stakeholders, our next immediate step is to build a **Live Hacking Demonstration Mode**. 

We will update the frontend verification screen to allow the user to select their video input source from a dropdown menu. This allows us to toggle between a **Normal Camera** (genuine user) and an **OBS Virtual Camera** (simulated hacker).

### The Attack Scenario (DeepFaceLive)
1. **The Setup:** The hacker routes their physical webcam through **DeepFaceLive** (a real-time face-swapping application). 
2. **The Injection:** DeepFaceLive superimposes a trained deepfake model of the *genuine user's face* onto the hacker's face in real-time. 
3. **The Feed:** The resulting deepfake video is piped out via **OBS Virtual Camera** and selected as the input device on the VID-LIVE web portal.

### How VID-LIVE Defeats It During the Demo
When the hacker attempts the VID-LIVE sequence wearing the digital face:
*   **Step 3 (3D Geometry):** *Likely PASSES.* MediaPipe is robust and will track the deepfake face overlay as the hacker turns their head left and right.
*   **Step 4 (AI Deepfake):** *FAILS.* The ONNX deepfake classification model catches the face-swap blending edges, synthetic skin textures, and mismatched lighting on the cropped frame. The AI confidence will plummet, likely triggering an auto-fail.
*   **Step 5 (Reaction Time):** *FAILS.* Real-time deepfake rendering introduces significant latency. Furthermore, deepfake models frequently struggle to render rapid eyelid closures cleanly. When the random beep plays, the latency and rendering failure will cause the blink detection to either miss entirely or register significantly outside the normal human 100ms-500ms window.
*   **Step 6 (Micro-expressions):** *FAILS.* DeepFaceLive applies heavy temporal smoothing to prevent the fake face from flickering. This completely eliminates natural involuntary human micro-muscle movements. The mathematical variance of the 468 landmarks will be unnaturally low (too smooth), flagging the face as synthetic.
