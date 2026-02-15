/* KaoPass - MediaPipe + face-api.js Engine */
const FaceEngine = (() => {
  let faceLandmarker = null;
  let faceApiReady = false;
  let stream = null;
  let animFrameId = null;

  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model';

  /* ── Initialize MediaPipe Face Landmarker ── */
  async function initMediaPipe() {
    // Dynamic import of ESM bundle (vision_bundle.min.js doesn't exist in 0.10.18)
    const vision = await import(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs'
    );

    const filesetResolver = await vision.FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
    );

    const opts = {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    };

    try {
      opts.baseOptions.delegate = 'GPU';
      faceLandmarker = await vision.FaceLandmarker.createFromOptions(filesetResolver, opts);
    } catch (gpuErr) {
      console.warn('GPU delegate failed, falling back to CPU:', gpuErr);
      opts.baseOptions.delegate = 'CPU';
      faceLandmarker = await vision.FaceLandmarker.createFromOptions(filesetResolver, opts);
    }
  }

  /* ── Initialize face-api.js ── */
  async function initFaceApi() {
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    faceApiReady = true;
  }

  /* ── Start camera ── */
  async function startCamera(videoEl, constraints) {
    const c = constraints || { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } };
    stream = await navigator.mediaDevices.getUserMedia(c);
    videoEl.srcObject = stream;
    return new Promise(resolve => {
      videoEl.onloadedmetadata = () => { videoEl.play(); resolve(); };
    });
  }

  /* ── Stop camera ── */
  function stopCamera(videoEl) {
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    if (videoEl) videoEl.srcObject = null;
  }

  /* ── Detect face (MediaPipe) - returns landmarks + blendshapes ── */
  function detect(videoEl) {
    if (!faceLandmarker || !videoEl || videoEl.readyState < 2) return null;
    try {
      const result = faceLandmarker.detectForVideo(videoEl, performance.now());
      if (!result || !result.faceLandmarks || result.faceLandmarks.length === 0) return null;
      return {
        landmarks: result.faceLandmarks[0],
        blendshapes: result.faceBlendshapes && result.faceBlendshapes[0]
          ? result.faceBlendshapes[0].categories : [],
      };
    } catch {
      return null;
    }
  }

  /* ── Extract 128-dim descriptor (face-api.js) ── */
  async function extractDescriptor(videoOrCanvas) {
    if (!faceApiReady) return null;
    const detection = await faceapi
      .detectSingleFace(videoOrCanvas)
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (!detection) return null;
    return detection.descriptor; // Float32Array(128)
  }

  /* ── Compare two descriptors (euclidean distance → similarity) ── */
  function compareDescriptors(d1, d2) {
    if (!d1 || !d2 || d1.length !== d2.length) return 0;
    let sum = 0;
    for (let i = 0; i < d1.length; i++) {
      const diff = d1[i] - d2[i];
      sum += diff * diff;
    }
    const dist = Math.sqrt(sum);
    // distance 0 = perfect match, ~0.6 threshold for same person
    // Convert to similarity: 1 - (dist / maxDist)
    return Math.max(0, 1 - dist / 1.2);
  }

  /* ── Match against stored descriptors ── */
  function matchFace(testDescriptor, storedDescriptors) {
    if (!testDescriptor || !storedDescriptors || storedDescriptors.length === 0) return 0;
    let bestSim = 0;
    for (const stored of storedDescriptors) {
      const arr = stored instanceof Float32Array ? stored : new Float32Array(stored);
      const sim = compareDescriptors(testDescriptor, arr);
      if (sim > bestSim) bestSim = sim;
    }
    return bestSim;
  }

  /* ── Detection loop helper ── */
  function startDetectionLoop(videoEl, callback) {
    function loop() {
      const result = detect(videoEl);
      callback(result);
      animFrameId = requestAnimationFrame(loop);
    }
    animFrameId = requestAnimationFrame(loop);
  }

  function stopDetectionLoop() {
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  }

  return {
    initMediaPipe,
    initFaceApi,
    startCamera,
    stopCamera,
    detect,
    extractDescriptor,
    compareDescriptors,
    matchFace,
    startDetectionLoop,
    stopDetectionLoop,
  };
})();
