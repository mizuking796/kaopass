/* KaoPass - Main Application (State Machine + Screen Logic) */
(() => {
  'use strict';

  /* ══════════ State ══════════ */
  let currentScreen = 'consent';
  let tutorialIndex = 0;
  let passwordLength = 4;
  let selectedSequence = [];  // [{exprId}]

  // Face registration
  const ANGLES = ['front', 'left', 'right', 'up', 'down'];
  const ANGLE_INSTRUCTIONS = {
    front: 'カメラのレンズを見てください',
    left: '少し左を向いてください',
    right: '少し右を向いてください',
    up: '少し上を向いてください（天井方向）',
    down: '少し下を向いてください（あご引く）',
  };
  let capturedAngles = {};  // { front: descriptor, left: descriptor, ... }
  let currentAngleIndex = 0;
  let angleHoldStart = 0;
  let isCapturing = false;
  const ANGLE_HOLD_MS = 300;

  // Expression recording
  let recordingStep = 0;
  let recordingHoldStart = 0;
  let recordingHoldPct = 0;
  const RECORDING_HOLD_MS = 500;
  const RECORDING_STABLE_RANGE = 20;
  const RECORDING_MIN_PCT = 30;
  let recordedTransitions = []; // timestamps for transition pattern
  let lastBlendshapes = null;  // latest blendshapes for capture
  let recordedProfiles = [];   // blendshape vectors per step

  // Expression biometric matching
  const EXPR_BIOMETRIC_WEIGHT = 0.3; // blend ratio: 0=category only, 1=biometric only
  const EXPR_BIOMETRIC_THRESHOLD = 0.5; // min cosine similarity to pass

  // Auth state
  const AUTH_TIMEOUT_MS = 30000; // 30 seconds total for face + expression auth
  let authStartTime = 0;
  let authStep = 0;
  let authHoldStart = 0;
  let authFailCount = 0;
  let parallaxBaseLandmarks = null;
  let authGlobalTimerId = null;

  // ── Continuous face verification during expression auth ──
  const FACE_RECHECK_INTERVAL = 1500; // ms between face re-checks
  const FACE_RECHECK_THRESHOLD = 0.45; // lower than initial (expressions distort face)
  let lastFaceRecheck = 0;
  let faceRecheckRunning = false;

  /* ══════════ Helpers ══════════ */
  function $(id) { return document.getElementById(id); }
  function show(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = $('screen-' + screenId);
    if (el) el.classList.add('active');
    currentScreen = screenId;
  }

  let loadingDotsTimer = null;
  function showLoading(text) {
    const base = text || 'モデルを読み込み中';
    const el = $('loading-text');
    el.textContent = base + '...';
    $('loading-overlay').classList.remove('hidden');
    // Animate dots so user sees it's alive
    let dots = 0;
    clearInterval(loadingDotsTimer);
    loadingDotsTimer = setInterval(() => {
      dots = (dots + 1) % 4;
      el.textContent = base + '.'.repeat(dots + 1);
    }, 500);
  }
  function hideLoading() {
    clearInterval(loadingDotsTimer);
    $('loading-overlay').classList.add('hidden');
  }

  function expressionSVG(exprId) {
    return `assets/expressions/${exprId.replaceAll('_', '-')}.svg`;
  }

  function exprById(id) {
    return ExpressionDetector.EXPRESSIONS.find(e => e.id === id);
  }

  /* ══════════ Consent Screen ══════════ */
  function initConsent() {
    const cb = $('consent-checkbox');
    const btn = $('btn-consent');

    function syncBtn() { btn.disabled = !cb.checked; }
    syncBtn();
    cb.addEventListener('change', syncBtn);
    // Browser may restore checkbox state after DOMContentLoaded
    setTimeout(syncBtn, 50);
    setTimeout(syncBtn, 200);

    btn.addEventListener('click', () => startAfterConsent());
  }

  async function startAfterConsent() {
    localStorage.setItem('kaopass_consent', new Date().toISOString());
    await loadModelsAndProceed();
  }

  async function loadModelsAndProceed() {
    showLoading('AIモデルを読み込み中...');
    try {
      await Promise.all([FaceEngine.initMediaPipe(), FaceEngine.initFaceApi()]);
    } catch (e) {
      console.error('Model init failed:', e);
      hideLoading();
      show('consent');
      alert('モデルの読み込みに失敗しました: ' + (e.message || e) + '\nページを再読み込みしてください。');
      return;
    }
    hideLoading();
    const hasReg = await KaoDB.hasRegistration();
    if (hasReg) {
      startAuthFace();
    } else {
      show('tutorial');
      initTutorial();
    }
  }

  /* ══════════ Tutorial Screen ══════════ */
  function initTutorial() {
    tutorialIndex = 0;
    updateTutorial();

    $('btn-tutorial-next').addEventListener('click', () => {
      tutorialIndex++;
      if (tutorialIndex >= 3) {
        startRegisterFace();
      } else {
        updateTutorial();
      }
    });

    $('btn-skip-tutorial').addEventListener('click', () => {
      startRegisterFace();
    });

    // Touch swipe
    let touchStartX = 0;
    const slides = $('tutorial-slides');
    slides.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
    slides.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 50) {
        if (dx < 0 && tutorialIndex < 2) { tutorialIndex++; updateTutorial(); }
        if (dx > 0 && tutorialIndex > 0) { tutorialIndex--; updateTutorial(); }
      }
    }, { passive: true });
  }

  function updateTutorial() {
    const slides = $('tutorial-slides');
    // All slides share the same translateX (flex positions them side-by-side)
    slides.querySelectorAll('.tutorial-slide').forEach((s) => {
      s.style.transform = `translateX(${-tutorialIndex * 100}%)`;
    });
    $('tutorial-dots').querySelectorAll('.dot').forEach((d, i) => {
      d.classList.toggle('active', i === tutorialIndex);
    });
    $('btn-tutorial-next').textContent = tutorialIndex === 2 ? '顔登録へ' : '次へ';
  }

  /* ══════════ Register Face ══════════ */
  async function startRegisterFace() {
    show('register-face');
    capturedAngles = {};
    currentAngleIndex = 0;
    angleHoldStart = 0;
    updateAngleChips();
    updateFaceProgress();

    const video = $('register-face-video');
    try {
      await FaceEngine.startCamera(video);
    } catch (e) {
      alert('カメラの起動に失敗しました。カメラへのアクセスを許可してください。');
      return;
    }

    FaceEngine.startDetectionLoop(video, onRegisterFaceFrame);
  }

  function onRegisterFaceFrame(result) {
    if (currentScreen !== 'register-face') return;
    if (Object.keys(capturedAngles).length >= 5) return;

    const targetAngle = ANGLES[currentAngleIndex];
    const overlay = $('camera-look-overlay');

    // Show overlay ONLY for 'front' angle
    if (targetAngle === 'front') {
      overlay.classList.remove('hidden');
    } else {
      overlay.classList.add('hidden');
    }

    if (!result) {
      $('register-face-instruction').textContent = '顔が検出されません';
      angleHoldStart = 0;
      return;
    }

    // Skip anti-spoofing during registration (enforced during auth)
    if (isCapturing) return; // prevent re-entry

    const detectedAngle = ExpressionDetector.detectAngle(result.landmarks);
    $('register-face-instruction').textContent = ANGLE_INSTRUCTIONS[targetAngle];

    if (detectedAngle === targetAngle) {
      // Hide overlay once user looks at camera (front detected)
      if (targetAngle === 'front') overlay.classList.add('hidden');

      if (angleHoldStart === 0) {
        angleHoldStart = performance.now();
      } else if (performance.now() - angleHoldStart > ANGLE_HOLD_MS) {
        captureAngle(targetAngle);
      }
    } else {
      angleHoldStart = 0;
    }
  }

  async function captureAngle(angle) {
    if (isCapturing) return;
    isCapturing = true;
    angleHoldStart = 0;

    // Flash effect
    const flash = $('register-face-flash');
    flash.classList.add('flash');
    setTimeout(() => flash.classList.remove('flash'), 200);

    // Extract face descriptor (with retry)
    const video = $('register-face-video');
    let descriptor = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        descriptor = await FaceEngine.extractDescriptor(video);
        if (descriptor) break;
      } catch (e) {
        console.warn(`extractDescriptor attempt ${attempt} failed:`, e);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    // Save descriptor (or empty placeholder if extraction failed)
    capturedAngles[angle] = descriptor ? Array.from(descriptor) : new Array(128).fill(0);
    console.log(`Captured ${angle}: descriptor ${descriptor ? 'OK' : 'FALLBACK'}`);

    currentAngleIndex++;
    updateAngleChips();
    updateFaceProgress();
    isCapturing = false;

    if (Object.keys(capturedAngles).length >= 5) {
      FaceEngine.stopDetectionLoop();
      FaceEngine.stopCamera($('register-face-video'));
      await KaoDB.saveFace({
        descriptors: Object.values(capturedAngles),
        angles: Object.keys(capturedAngles),
        createdAt: Date.now(),
      });
      setTimeout(() => startRegisterExpression(), 500);
    }
  }

  function updateAngleChips() {
    const chips = document.querySelectorAll('.angle-chip');
    chips.forEach((chip, i) => {
      const angle = chip.dataset.angle;
      chip.classList.remove('active', 'complete');
      if (capturedAngles[angle]) {
        chip.classList.add('complete');
      } else if (i === currentAngleIndex) {
        chip.classList.add('active');
      }
    });
  }

  function updateFaceProgress() {
    const count = Object.keys(capturedAngles).length;
    $('register-face-bar').style.width = (count / 5 * 100) + '%';
    $('register-face-count').textContent = count + ' / 5';
  }

  /* ══════════ Register Expression (Selection Phase) ══════════ */
  let exprSetupInitialized = false;
  async function startRegisterExpression() {
    show('register-expression');
    selectedSequence = [];

    // Build expression palette
    buildExpressionPalette();
    updateSequenceBar();

    // Bind events only once
    if (!exprSetupInitialized) {
      exprSetupInitialized = true;

      document.querySelectorAll('.length-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          passwordLength = parseInt(btn.dataset.len);
          document.querySelectorAll('.length-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          while (selectedSequence.length > passwordLength) selectedSequence.pop();
          updateSequenceBar();
          updateExprButtons();
        });
      });

      $('btn-undo-expr').addEventListener('click', () => {
        if (selectedSequence.length > 0) {
          selectedSequence.pop();
          updateSequenceBar();
          updateExprButtons();
        }
      });

      $('btn-confirm-expr').addEventListener('click', () => {
        if (selectedSequence.length === passwordLength) {
          startRecording();
        }
      });
    }

    // Start mini camera
    const miniVideo = $('expr-preview-video');
    try {
      await FaceEngine.startCamera(miniVideo);
      FaceEngine.startDetectionLoop(miniVideo, result => {
        if (currentScreen !== 'register-expression') return;
        if (result) {
          const cls = ExpressionDetector.classifyExpression(result.blendshapes);
          const expr = cls.id ? exprById(cls.id) : null;

          $('expr-preview-label').textContent = expr ? expr.name : '--';
        } else {
          $('expr-preview-label').textContent = '--';
        }
      });
    } catch (e) {
      // Camera may already be in use or denied
      console.warn('Mini camera start failed:', e);
    }
  }

  function buildExpressionPalette() {
    const palette = $('expression-palette');
    palette.innerHTML = '';
    ExpressionDetector.EXPRESSIONS.forEach(expr => {
      const card = document.createElement('div');
      card.className = 'expr-card';
      card.dataset.exprId = expr.id;
      card.innerHTML = `
        <img class="expr-icon" src="${expressionSVG(expr.id)}" alt="${expr.name}"
             onerror="this.outerHTML='<span class=expr-icon style=font-size:28px>${expr.emoji}</span>'">
        <span class="expr-name">${expr.name}</span>
      `;
      card.addEventListener('click', () => onExpressionSelect(expr.id));
      palette.appendChild(card);
    });
  }

  function onExpressionSelect(exprId) {
    if (selectedSequence.length >= passwordLength) return;
    selectedSequence.push({ exprId });
    updateSequenceBar();
    updateExprButtons();
  }

  function updateSequenceBar() {
    const bar = $('sequence-bar');
    if (selectedSequence.length === 0) {
      bar.innerHTML = '<div class="sequence-placeholder">表情を選択してください</div>';
    } else {
      bar.innerHTML = selectedSequence.map((item, i) => {
        const expr = exprById(item.exprId);
        return `<div class="sequence-item">
          <span class="seq-num">${i + 1}</span>
          <img class="seq-icon" src="${expressionSVG(item.exprId)}" alt="${expr.name}"
               onerror="this.outerHTML='<span class=seq-icon style=font-size:24px>${expr.emoji}</span>'">
        </div>`;
      }).join('');
    }

    $('btn-undo-expr').disabled = selectedSequence.length === 0;
    $('btn-confirm-expr').disabled = selectedSequence.length !== passwordLength;
  }

  function updateExprButtons() {
    // Highlight last selected
    document.querySelectorAll('.expr-card').forEach(c => c.classList.remove('selected'));
    if (selectedSequence.length > 0) {
      const last = selectedSequence[selectedSequence.length - 1].exprId;
      const card = document.querySelector(`.expr-card[data-expr-id="${last}"]`);
      if (card) card.classList.add('selected');
    }
  }

  /* ══════════ Register Expression (Recording Phase) ══════════ */
  async function startRecording() {
    FaceEngine.stopDetectionLoop();
    FaceEngine.stopCamera($('expr-preview-video'));

    show('register-recording');
    recordingStep = 0;
    recordingHoldStart = 0;
    recordedTransitions = [performance.now()];
    recordedProfiles = [];
    lastBlendshapes = null;

    buildRecordingSteps();
    updateRecordingTarget();

    const video = $('recording-video');
    await FaceEngine.startCamera(video);
    FaceEngine.startDetectionLoop(video, onRecordingFrame);
  }

  function buildRecordingSteps() {
    const container = $('recording-steps');
    container.innerHTML = '';
    for (let i = 0; i < selectedSequence.length; i++) {
      const dot = document.createElement('div');
      dot.className = 'step-dot' + (i === 0 ? ' active' : '');
      container.appendChild(dot);
    }
  }

  function updateRecordingTarget() {
    if (recordingStep >= selectedSequence.length) return;
    const item = selectedSequence[recordingStep];
    const expr = exprById(item.exprId);

    // Update target icon
    const icon = $('recording-target-icon');
    icon.innerHTML = `<img src="${expressionSVG(item.exprId)}" alt="${expr.name}" style="width:36px;height:36px"
      onerror="this.outerHTML='<span style=font-size:28px>${expr.emoji}</span>'">`;

    $('recording-instruction').textContent = `${expr.name}の表情をしてください (${recordingStep + 1}/${selectedSequence.length})`;
  }

  function onRecordingFrame(result) {
    if (currentScreen !== 'register-recording') return;
    if (recordingStep >= selectedSequence.length) return;

    const item = selectedSequence[recordingStep];

    if (!result) {
      $('recording-match-pct').textContent = '0%';
      $('recording-match-fill').style.width = '0%';
      recordingHoldStart = 0;
      return;
    }

    // Save latest blendshapes for capture at completeRecordingStep
    lastBlendshapes = result.blendshapes;

    // Expression match
    let pct = ExpressionDetector.matchScore(result.blendshapes, item.exprId);

    const classified = ExpressionDetector.classifyExpression(result.blendshapes);
    const isTarget = classified.id === item.exprId;

    // Update UI
    $('recording-match-pct').textContent = pct + '%';
    const fill = $('recording-match-fill');
    fill.style.width = pct + '%';
    fill.classList.toggle('high', isTarget && pct >= RECORDING_MIN_PCT);
    fill.classList.toggle('low', !isTarget || pct < RECORDING_MIN_PCT);

    // Hold detection: target expression detected + score stable for 1s
    if (isTarget && pct >= RECORDING_MIN_PCT) {
      if (recordingHoldStart === 0) {
        recordingHoldStart = performance.now();
        recordingHoldPct = pct;
      } else if (Math.abs(pct - recordingHoldPct) > RECORDING_STABLE_RANGE) {
        // Score changed too much → restart hold with new baseline
        recordingHoldStart = performance.now();
        recordingHoldPct = pct;
      } else if (performance.now() - recordingHoldStart > RECORDING_HOLD_MS) {
        completeRecordingStep();
      }
    } else {
      recordingHoldStart = 0;
      recordingHoldPct = 0;
    }
  }

  function completeRecordingStep() {
    recordingHoldStart = 0;
    recordedTransitions.push(performance.now());

    // Capture blendshape profile for this step
    if (lastBlendshapes) {
      const profile = {};
      for (const b of lastBlendshapes) {
        profile[b.categoryName] = b.score;
      }
      recordedProfiles.push(profile);
    } else {
      recordedProfiles.push(null);
    }

    // Update step dots
    const dots = $('recording-steps').querySelectorAll('.step-dot');
    dots[recordingStep].classList.remove('active');
    dots[recordingStep].classList.add('complete');

    recordingStep++;
    if (recordingStep >= selectedSequence.length) {
      finishRecording();
    } else {
      dots[recordingStep].classList.add('active');
      updateRecordingTarget();
    }
  }

  async function finishRecording() {
    FaceEngine.stopDetectionLoop();
    FaceEngine.stopCamera($('recording-video'));

    // Calculate transition intervals
    const intervals = [];
    for (let i = 1; i < recordedTransitions.length; i++) {
      intervals.push(recordedTransitions[i] - recordedTransitions[i - 1]);
    }

    // Save expression password + blendshape profiles
    await KaoDB.saveExpression({
      sequence: selectedSequence,
      transitionIntervals: intervals,
      blendshapeProfiles: recordedProfiles,
      passwordLength: passwordLength,
      createdAt: Date.now(),
    });

    // Registration complete → start auth immediately
    setTimeout(() => startAuthFace(), 500);
  }

  /* ══════════ Auth Face ══════════ */
  async function startAuthFace() {
    show('auth-face');
    authStartTime = performance.now();
    // authFailCount is NOT reset here — persists across retries for cooldown
    parallaxBaseLandmarks = null;

    // Start 30s global timer
    startAuthGlobalTimer();

    $('auth-face-status-text').textContent = '認識中...';
    $('auth-face-spinner').style.display = '';

    const video = $('auth-face-video');
    try {
      await FaceEngine.startCamera(video);
    } catch (e) {
      alert('カメラの起動に失敗しました。');
      return;
    }

    let lastAttempt = 0;
    const ATTEMPT_INTERVAL = 500; // Try twice per second

    FaceEngine.startDetectionLoop(video, async (result) => {
      if (currentScreen !== 'auth-face') return;

      if (!result) {
        $('auth-face-instruction').textContent = '顔が検出されません';
        return;
      }

      // Anti-spoofing
      const depth = ExpressionDetector.checkDepth(result.landmarks);
      if (!depth.pass) {
        $('auth-face-instruction').textContent = '本物の顔を検出してください';
        return;
      }

      // Save baseline landmarks for parallax check later
      if (!parallaxBaseLandmarks) {
        parallaxBaseLandmarks = result.landmarks.map(l => ({ x: l.x, y: l.y, z: l.z }));
      }

      $('auth-face-instruction').textContent = 'カメラに顔を向けてください';

      const now = performance.now();
      if (now - lastAttempt < ATTEMPT_INTERVAL) return;
      lastAttempt = now;

      // Extract descriptor and compare
      const testDesc = await FaceEngine.extractDescriptor(video);
      if (!testDesc) return;

      const faceData = await KaoDB.getFace();
      if (!faceData) return;

      const similarity = FaceEngine.matchFace(testDesc, faceData.descriptors);

      if (similarity > 0.6) {
        $('auth-face-status-text').textContent = '認証OK！';
        $('auth-face-spinner').style.display = 'none';
        FaceEngine.stopDetectionLoop();
        FaceEngine.stopCamera(video);
        setTimeout(() => startAuthExpression(), 500);
      } else {
        $('auth-face-instruction').textContent = `認識中... (${Math.round(similarity * 100)}%)`;
      }
    });
  }

  /* ══════════ Auth Expression ══════════ */
  async function startAuthExpression() {
    show('auth-expression');
    authStep = 0;
    authHoldStart = 0;
    lastFaceRecheck = performance.now();
    faceRecheckRunning = false;

    const exprData = await KaoDB.getExpression();
    if (!exprData) { alert('表情パスワードが登録されていません'); return; }

    buildAuthSteps(exprData.sequence.length);
    updateAuthTarget(exprData);
    const video = $('auth-expr-video');
    await FaceEngine.startCamera(video);
    FaceEngine.startDetectionLoop(video, result => onAuthExprFrame(result, exprData));
  }

  function buildAuthSteps(count) {
    const container = $('auth-steps');
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const dot = document.createElement('div');
      dot.className = 'step-dot' + (i === 0 ? ' active' : '');
      container.appendChild(dot);
    }
  }

  function updateAuthTarget(exprData) {
    if (authStep >= exprData.sequence.length) return;
    const item = exprData.sequence[authStep];
    const expr = exprById(item.exprId);

    const icon = $('auth-target-icon');
    icon.innerHTML = `<img src="${expressionSVG(item.exprId)}" alt="${expr.name}" style="width:36px;height:36px"
      onerror="this.outerHTML='<span style=font-size:28px>${expr.emoji}</span>'">`;

    $('auth-expr-instruction').textContent = `${expr.name} (${authStep + 1}/${exprData.sequence.length})`;
  }

  let authTimerId = null;
  function startAuthTimer(stepCount) {
    if (authTimerId) { cancelAnimationFrame(authTimerId); authTimerId = null; }
    const totalTime = stepCount * 8000; // 8 seconds per step
    const startTime = performance.now();
    const fill = $('auth-timer-fill');
    fill.style.background = ''; // Reset color

    function tick() {
      const elapsed = performance.now() - startTime;
      const pct = Math.max(0, 1 - elapsed / totalTime);
      fill.style.width = (pct * 100) + '%';
      if (pct <= 0.3) fill.style.background = 'var(--orange)';
      if (pct <= 0.1) fill.style.background = 'var(--red)';

      if (elapsed >= totalTime) {
        onAuthFail();
        return;
      }
      if (currentScreen === 'auth-expression') {
        authTimerId = requestAnimationFrame(tick);
      }
    }
    tick();
  }

  function onAuthExprFrame(result, exprData) {
    if (currentScreen !== 'auth-expression') return;
    if (authStep >= exprData.sequence.length) return;

    const item = exprData.sequence[authStep];

    if (!result) {
      $('auth-match-pct').textContent = '0%';
      $('auth-match-fill').style.width = '0%';
      authHoldStart = 0;
      return;
    }

    // ── Continuous face verification (every FACE_RECHECK_INTERVAL ms) ──
    const now = performance.now();
    if (!faceRecheckRunning && now - lastFaceRecheck > FACE_RECHECK_INTERVAL) {
      faceRecheckRunning = true;
      lastFaceRecheck = now;
      const video = $('auth-expr-video');
      (async () => {
        try {
          const desc = await FaceEngine.extractDescriptor(video);
          if (desc && currentScreen === 'auth-expression') {
            const faceData = await KaoDB.getFace();
            if (faceData) {
              const sim = FaceEngine.matchFace(desc, faceData.descriptors);
              console.log(`[FaceRecheck] similarity=${sim.toFixed(3)} threshold=${FACE_RECHECK_THRESHOLD}`);
              if (sim < FACE_RECHECK_THRESHOLD) {
                console.warn('[FaceRecheck] FAILED - different person detected');
                onAuthFail();
                return;
              }
            }
          }
        } catch (e) {
          console.warn('[FaceRecheck] error:', e);
        } finally {
          faceRecheckRunning = false;
        }
      })();
    }

    // ── Expression matching (category + biometric) ──
    let categoryPct = ExpressionDetector.matchScore(result.blendshapes, item.exprId);

    // Biometric: compare blendshape vector against registered profile
    let bioPct = 100; // default pass if no profile stored
    const storedProfile = exprData.blendshapeProfiles && exprData.blendshapeProfiles[authStep];
    if (storedProfile) {
      const sim = ExpressionDetector.blendshapeSimilarity(result.blendshapes, storedProfile);
      bioPct = Math.round(sim * 100);
      console.log(`[ExprBio] step=${authStep} cosine=${sim.toFixed(3)} bioPct=${bioPct}`);
    }

    // Blend category match + biometric match
    const pct = Math.round(
      categoryPct * (1 - EXPR_BIOMETRIC_WEIGHT) + bioPct * EXPR_BIOMETRIC_WEIGHT
    );

    const classified = ExpressionDetector.classifyExpression(result.blendshapes);
    const isTarget = classified.id === item.exprId;

    $('auth-match-pct').textContent = pct + '%';
    const fill = $('auth-match-fill');
    fill.style.width = pct + '%';
    fill.classList.toggle('high', isTarget && pct >= RECORDING_MIN_PCT);
    fill.classList.toggle('low', !isTarget || pct < RECORDING_MIN_PCT);

    if (isTarget && pct >= RECORDING_MIN_PCT) {
      if (authHoldStart === 0) {
        authHoldStart = performance.now();
      } else if (performance.now() - authHoldStart > RECORDING_HOLD_MS) {
        completeAuthStep(exprData);
      }
    } else {
      authHoldStart = 0;
    }
  }

  function completeAuthStep(exprData) {
    authHoldStart = 0;
    const dots = $('auth-steps').querySelectorAll('.step-dot');
    dots[authStep].classList.remove('active');
    dots[authStep].classList.add('complete');

    authStep++;
    if (authStep >= exprData.sequence.length) {
      onAuthSuccess(exprData);
    } else {
      dots[authStep].classList.add('active');
      updateAuthTarget(exprData);
    }
  }

  function onAuthSuccess(exprData) {
    stopAuthGlobalTimer();
    if (authTimerId) { cancelAnimationFrame(authTimerId); authTimerId = null; }
    FaceEngine.stopDetectionLoop();
    FaceEngine.stopCamera($('auth-expr-video'));
    authFailCount = 0; // Reset on success

    const elapsed = performance.now() - authStartTime;
    show('auth-success');

    $('auth-time').textContent = `認証時間: ${(elapsed / 1000).toFixed(1)}秒`;

    // Details
    const details = $('success-details');
    const seqText = exprData.sequence.map((item, i) => {
      const expr = exprById(item.exprId);
      return `${i + 1}. ${expr.name}`;
    }).join('\n');

    const hasBio = exprData.blendshapeProfiles && exprData.blendshapeProfiles.some(p => p);
    details.innerHTML = `
      <div><strong>表情組み合わせ数:</strong> ${exprData.sequence.length}</div>
      <div><strong>表情バイオメトリクス:</strong> ${hasBio ? 'ON（筋肉パターン照合）' : 'OFF'}</div>
      <div><strong>常時顔照合:</strong> ON</div>
      <div><strong>シーケンス:</strong></div>
      <div style="padding-left:12px;white-space:pre-line">${seqText}</div>
    `;
  }

  /* ── 30s global auth timer ── */
  function startAuthGlobalTimer() {
    stopAuthGlobalTimer();
    const el = $('auth-global-timer');
    if (el) el.classList.remove('hidden');
    const start = performance.now();
    function tick() {
      const remaining = Math.max(0, AUTH_TIMEOUT_MS - (performance.now() - start));
      const secs = Math.ceil(remaining / 1000);
      // Update both screens' timer display
      document.querySelectorAll('.auth-countdown').forEach(e => {
        e.textContent = secs + '秒';
        if (secs <= 10) e.style.color = 'var(--red)';
        else if (secs <= 20) e.style.color = 'var(--orange)';
        else e.style.color = 'var(--text2)';
      });
      if (remaining <= 0) {
        // Time's up — stop everything and fail
        FaceEngine.stopDetectionLoop();
        const faceVideo = $('auth-face-video');
        const exprVideo = $('auth-expr-video');
        if (faceVideo) FaceEngine.stopCamera(faceVideo);
        if (exprVideo) FaceEngine.stopCamera(exprVideo);
        if (authTimerId) { cancelAnimationFrame(authTimerId); authTimerId = null; }
        authFailCount++;
        const cooldown = authFailCount >= 5 ? 30 : authFailCount >= 3 ? 10 : 3;
        showCooldown(cooldown);
        return;
      }
      if (currentScreen === 'auth-face' || currentScreen === 'auth-expression') {
        authGlobalTimerId = requestAnimationFrame(tick);
      }
    }
    tick();
  }

  function stopAuthGlobalTimer() {
    if (authGlobalTimerId) { cancelAnimationFrame(authGlobalTimerId); authGlobalTimerId = null; }
  }

  function onAuthFail() {
    stopAuthGlobalTimer();
    if (authTimerId) { cancelAnimationFrame(authTimerId); authTimerId = null; }
    FaceEngine.stopDetectionLoop();
    FaceEngine.stopCamera($('auth-expr-video'));

    authFailCount++;
    const cooldown = authFailCount >= 5 ? 30 : authFailCount >= 3 ? 10 : 0;

    if (cooldown > 0) {
      showCooldown(cooldown);
    } else {
      // Just retry
      startAuthFace();
    }
  }

  function showCooldown(seconds) {
    const overlay = $('auth-cooldown');
    overlay.classList.remove('hidden');
    let remaining = seconds;
    $('cooldown-timer').textContent = remaining;

    const iv = setInterval(() => {
      remaining--;
      $('cooldown-timer').textContent = remaining;
      if (remaining <= 0) {
        clearInterval(iv);
        overlay.classList.add('hidden');
        startAuthFace();
      }
    }, 1000);
  }

  /* ══════════ Re-register ══════════ */
  async function startReRegister() {
    if (!confirm('現在の登録を削除して、新しく登録し直しますか？')) return;
    // Stop any running camera/detection
    FaceEngine.stopDetectionLoop();
    document.querySelectorAll('video').forEach(v => FaceEngine.stopCamera(v));
    stopAuthGlobalTimer();
    if (authTimerId) { cancelAnimationFrame(authTimerId); authTimerId = null; }
    // Clear DB but keep consent
    await KaoDB.clearAll();
    authFailCount = 0;
    startRegisterFace();
  }

  /* ══════════ Auth Success Screen ══════════ */
  function initSuccessScreen() {
    $('btn-retry-auth').addEventListener('click', () => {
      startAuthFace();
    });

    $('btn-reregister').addEventListener('click', () => startReRegister());

    $('btn-reset').addEventListener('click', async () => {
      if (!confirm('登録データをすべて削除しますか？')) return;
      await KaoDB.clearAll();
      localStorage.removeItem('kaopass_consent');
      location.reload();
    });
  }

  /* ══════════ Boot ══════════ */
  async function boot() {
    initConsent();
    initSuccessScreen();
    $('btn-reregister-from-auth').addEventListener('click', () => startReRegister());

    const consent = localStorage.getItem('kaopass_consent');
    if (consent) {
      // Already consented → show loading immediately, skip consent screen
      await loadModelsAndProceed();
    } else {
      show('consent');
    }
  }

  // DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
