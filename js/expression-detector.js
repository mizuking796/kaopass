/* KaoPass - Expression Detection, Gaze Calculation, Anti-Spoofing */
const ExpressionDetector = (() => {

  /* ── Expression definitions ── */
  const EXPRESSIONS = [
    { id: 'smile',      name: '笑顔',       emoji: '😊' },
    { id: 'mouth_open', name: '口開け',     emoji: '😮' },
    { id: 'kiss',       name: 'キス',       emoji: '😗' },
    { id: 'wink_left',  name: '左ウィンク', emoji: '😉' },
    { id: 'wink_right', name: '右ウィンク', emoji: '😜' },
    { id: 'brow_raise', name: '眉上げ',     emoji: '🤨' },
  ];

  /* ── Gaze directions ── */
  const GAZE_DIRS = [
    { id: 'tl', name: '左上',   col: 0, row: 0 },
    { id: 'tc', name: '上',     col: 1, row: 0 },
    { id: 'tr', name: '右上',   col: 2, row: 0 },
    { id: 'ml', name: '左',     col: 0, row: 1 },
    { id: 'mc', name: '正面',   col: 1, row: 1 },
    { id: 'mr', name: '右',     col: 2, row: 1 },
    { id: 'bl', name: '左下',   col: 0, row: 2 },
    { id: 'bc', name: '下',     col: 1, row: 2 },
    { id: 'br', name: '右下',   col: 2, row: 2 },
  ];

  /* ── Blendshape→Expression classification ── */
  function classifyExpression(blendshapes) {
    if (!blendshapes || blendshapes.length === 0) return { id: null, scores: {} };

    const bs = {};
    for (const b of blendshapes) {
      bs[b.categoryName] = b.score;
    }

    const scores = {};

    // Smile
    scores.smile = ((bs.mouthSmileLeft || 0) + (bs.mouthSmileRight || 0)) / 2;

    // Mouth open
    scores.mouth_open = bs.jawOpen || 0;

    // Kiss
    scores.kiss = bs.mouthPucker || 0;

    // Wink: MediaPipe blendshapes use subject's perspective (not camera)
    const blinkL = bs.eyeBlinkLeft || 0;  // user's LEFT eye
    const blinkR = bs.eyeBlinkRight || 0; // user's RIGHT eye
    const winkDiff = 0.15;
    scores.wink_left = (blinkL > 0.3 && blinkL - blinkR > winkDiff) ? (blinkL - blinkR) : 0;
    scores.wink_right = (blinkR > 0.3 && blinkR - blinkL > winkDiff) ? (blinkR - blinkL) : 0;

    // Brow raise
    scores.brow_raise = bs.browInnerUp || 0;

    const thresholds = {
      smile: 0.3, mouth_open: 0.3, kiss: 0.3,
      wink_left: 0.15, wink_right: 0.15, brow_raise: 0.25
    };

    let bestId = null;
    let bestScore = 0;
    for (const [id, score] of Object.entries(scores)) {
      if (score >= thresholds[id] && score > bestScore) {
        bestId = id;
        bestScore = score;
      }
    }

    return { id: bestId, scores, bestScore };
  }

  /* ── Compute match percentage for a target expression ── */
  function matchScore(blendshapes, targetExprId) {
    const result = classifyExpression(blendshapes);
    const raw = result.scores[targetExprId] || 0;
    // Simple linear scale: raw score → percentage (cap at 100)
    return Math.min(100, Math.round(raw * 150));
  }

  /* ── Gaze direction from iris landmarks ── */
  // MediaPipe iris landmarks (within the 478 set):
  // Left eye iris: 468-472 (center=468)
  // Right eye iris: 473-477 (center=473)
  // Left eye outline: 33(outer), 133(inner), 159(top), 145(bottom)
  // Right eye outline: 362(outer), 263(inner), 386(top), 374(bottom)
  function computeGaze(landmarks) {
    if (!landmarks || landmarks.length < 478) return { id: 'mc', x: 0.5, y: 0.5 };

    // Left eye
    const lIris = landmarks[468];
    const lOuter = landmarks[33];
    const lInner = landmarks[133];
    const lTop = landmarks[159];
    const lBottom = landmarks[145];

    const lx = (lIris.x - lOuter.x) / (lInner.x - lOuter.x);
    const ly = (lIris.y - lTop.y) / (lBottom.y - lTop.y);

    // Right eye
    const rIris = landmarks[473];
    const rOuter = landmarks[362];
    const rInner = landmarks[263];
    const rTop = landmarks[386];
    const rBottom = landmarks[374];

    const rx = (rIris.x - rInner.x) / (rOuter.x - rInner.x);
    const ry = (rIris.y - rTop.y) / (rBottom.y - rTop.y);

    // Average both eyes
    const x = (lx + rx) / 2;
    const y = (ly + ry) / 2;

    // Classify into 3x3 grid (mirrored for camera)
    let col, row;
    // Note: camera is mirrored, so left/right is inverted
    // Tight center zone (0.45-0.55) for high sensitivity
    if (x < 0.45) col = 2;      // user looking right → camera left
    else if (x > 0.55) col = 0;  // user looking left → camera right
    else col = 1;

    if (y < 0.43) row = 0;       // up
    else if (y > 0.57) row = 2;   // down
    else row = 1;

    const dir = GAZE_DIRS.find(g => g.col === col && g.row === row);
    return { id: dir ? dir.id : 'mc', x, y };
  }

  /* ── Gaze match score (0-100) ── */
  function gazeMatchScore(landmarks, targetGazeId) {
    const gaze = computeGaze(landmarks);
    if (gaze.id === targetGazeId) return 100;

    const target = GAZE_DIRS.find(g => g.id === targetGazeId);
    if (!target) return 0;

    // Partial match: adjacent cells get 50%
    const dx = Math.abs(gaze.id.charCodeAt(1) - targetGazeId.charCodeAt(1));
    const gRow = GAZE_DIRS.find(g => g.id === gaze.id);
    if (!gRow) return 0;
    const rowDiff = Math.abs(gRow.row - target.row);
    const colDiff = Math.abs(gRow.col - target.col);
    if (rowDiff <= 1 && colDiff <= 1) return 50;
    return 0;
  }

  /* ── Head pose estimation (yaw, pitch) from landmarks ── */
  function estimateHeadPose(landmarks) {
    if (!landmarks || landmarks.length < 478) return { yaw: 0, pitch: 0 };

    const noseTip = landmarks[1];
    const leftEar = landmarks[234];
    const rightEar = landmarks[454];
    const forehead = landmarks[10];
    const chin = landmarks[152];

    // Yaw: nose position relative to ears midpoint
    const earMidX = (leftEar.x + rightEar.x) / 2;
    const earWidth = Math.abs(rightEar.x - leftEar.x);
    const yaw = earWidth > 0 ? (noseTip.x - earMidX) / earWidth * 2 : 0;

    // Pitch: nose position relative to forehead-chin midpoint
    const faceMidY = (forehead.y + chin.y) / 2;
    const faceHeight = Math.abs(chin.y - forehead.y);
    const pitch = faceHeight > 0 ? (noseTip.y - faceMidY) / faceHeight * 2 : 0;

    return { yaw: Math.max(-1, Math.min(1, yaw)), pitch: Math.max(-1, Math.min(1, pitch)) };
  }

  /* ── Detect head angle for 5-angle registration ── */
  // Returns: 'front' | 'left' | 'right' | 'up' | 'down' | null
  function detectAngle(landmarks) {
    const { yaw, pitch } = estimateHeadPose(landmarks);
    const mirroredYaw = -yaw; // camera is mirrored
    const absYaw = Math.abs(mirroredYaw);
    const absPitch = Math.abs(pitch);

    // Front: tight pitch zone so slight up/down is detected quickly
    if (absYaw < 0.18 && absPitch < 0.12) return 'front';

    // Pitch (up/down) has smaller magnitude than yaw for similar movement,
    // so boost pitch by 2x to make up/down much easier to trigger
    if (absYaw > absPitch * 2) {
      return mirroredYaw < 0 ? 'left' : 'right';
    } else {
      return pitch < 0 ? 'up' : 'down';
    }
  }

  /* ── Z-depth anti-spoofing ── */
  function checkDepth(landmarks) {
    if (!landmarks || landmarks.length < 478) return { pass: false, range: 0 };

    const noseTip = landmarks[1];
    const leftEar = landmarks[234];
    const rightEar = landmarks[454];

    const noseZ = noseTip.z || 0;
    const earZ = ((leftEar.z || 0) + (rightEar.z || 0)) / 2;
    const zRange = Math.abs(noseZ - earZ);

    // Real face: z-range typically 0.03+ (MediaPipe normalized Z)
    // Photo/flat: z-range near 0
    return { pass: zRange > 0.02, range: zRange };
  }

  /* ── Parallax verification (during auth) ── */
  // Compare Z-changes when head turns: real face has non-uniform Z shift
  function checkParallax(landmarksBefore, landmarksAfter) {
    if (!landmarksBefore || !landmarksAfter) return { pass: false };
    if (landmarksBefore.length < 478 || landmarksAfter.length < 478) return { pass: false };

    const noseBefore = landmarksBefore[1];
    const noseAfter = landmarksAfter[1];
    const leftEarBefore = landmarksBefore[234];
    const leftEarAfter = landmarksAfter[234];
    const rightEarBefore = landmarksBefore[454];
    const rightEarAfter = landmarksAfter[454];

    // Z-deltas
    const dNose = (noseAfter.z || 0) - (noseBefore.z || 0);
    const dLeftEar = (leftEarAfter.z || 0) - (leftEarBefore.z || 0);
    const dRightEar = (rightEarAfter.z || 0) - (rightEarBefore.z || 0);

    // In a real 3D face, nose and ears Z-shifts should differ
    // In a flat photo, all Z-shifts are approximately equal
    const variance = Math.abs(dNose - dLeftEar) + Math.abs(dNose - dRightEar);

    return { pass: variance > 0.005, variance };
  }

  /* ── Blendshape biometric similarity ── */
  // Cosine similarity between current blendshapes and stored profile (0-1)
  function blendshapeSimilarity(currentBlendshapes, storedProfile) {
    if (!currentBlendshapes || !storedProfile) return 0;

    // Build current map
    const cur = {};
    for (const b of currentBlendshapes) {
      cur[b.categoryName] = b.score;
    }

    // Get all keys from both
    const keys = new Set([...Object.keys(cur), ...Object.keys(storedProfile)]);

    // Cosine similarity
    let dotProduct = 0, normA = 0, normB = 0;
    for (const k of keys) {
      const a = cur[k] || 0;
      const b = storedProfile[k] || 0;
      dotProduct += a * b;
      normA += a * a;
      normB += b * b;
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  return {
    EXPRESSIONS,
    GAZE_DIRS,
    classifyExpression,
    matchScore,
    computeGaze,
    gazeMatchScore,
    estimateHeadPose,
    detectAngle,
    checkDepth,
    checkParallax,
    blendshapeSimilarity,
  };
})();
