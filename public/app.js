(() => {
  const els = {
    video: document.getElementById('webcam'),
    canvas: document.getElementById('capture-canvas'),
    resultView: document.getElementById('result-view'),
    resultImage: document.getElementById('result-image'),
    resultBadge: document.getElementById('result-badge'),
    cameraError: document.getElementById('camera-error'),
    cameraErrorMsg: document.getElementById('camera-error-msg'),
    retryCameraBtn: document.getElementById('retry-camera-btn'),
    countdownOverlay: document.getElementById('countdown-overlay'),
    countdownNumber: document.getElementById('countdown-number'),
    stripProgress: document.getElementById('strip-progress'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingText: document.getElementById('loading-text'),
    flashOverlay: document.getElementById('flash-overlay'),
    errorBanner: document.getElementById('error-banner'),
    errorBannerText: document.getElementById('error-banner-text'),
    dismissErrorBtn: document.getElementById('dismiss-error-btn'),
    cameraControls: document.getElementById('camera-controls'),
    resultControls: document.getElementById('result-controls'),
    captureBtn: document.getElementById('capture-btn'),
    captureBtnLabel: document.getElementById('capture-btn-label'),
    downloadBtn: document.getElementById('download-btn'),
    compareBtn: document.getElementById('compare-btn'),
    retakeBtn: document.getElementById('retake-btn'),
    modeButtons: document.querySelectorAll('.mode-btn'),
    styleCards: document.querySelectorAll('.style-card'),
    styleHint: document.getElementById('style-hint'),
    qrPanel: document.getElementById('qr-panel'),
    qrContainer: document.getElementById('qr-container'),
    copyLinkBtn: document.getElementById('copy-link-btn'),
    localhostWarning: document.getElementById('localhost-warning'),
  };

  const state = {
    mode: 'single', // 'single' | 'strip'
    selectedStyle: 'vintage-90s',
    stream: null,
    isCapturing: false,
    isGenerating: false,
    rawCapturedDataUrl: null,
    capturedMode: 'single',
    generatedDataUrl: null,
    generatedMimeType: 'image/png',
    generatedStyleName: '',
    shareUrl: null,
    showingOriginal: false,
    audioCtx: null,
  };

  // --- Audio Synthesis for Countdown Beeps & Shutter ---
  function playTone(frequency, durationMs, gainValue = 0.08) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      if (!state.audioCtx) state.audioCtx = new AudioContextClass();
      if (state.audioCtx.state === 'suspended') state.audioCtx.resume();

      const osc = state.audioCtx.createOscillator();
      const gain = state.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, state.audioCtx.currentTime);
      gain.gain.setValueAtTime(gainValue, state.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, state.audioCtx.currentTime + durationMs / 1000);
      osc.connect(gain);
      gain.connect(state.audioCtx.destination);
      osc.start();
      osc.stop(state.audioCtx.currentTime + durationMs / 1000);
    } catch {
      // Ignore audio errors if blocked by browser autoplay policy
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function showError(message) {
    els.errorBannerText.textContent = message;
    els.errorBanner.classList.remove('hidden');
  }

  function clearError() {
    els.errorBanner.classList.add('hidden');
    els.errorBannerText.textContent = '';
  }

  function setBusyUI(busy) {
    els.captureBtn.disabled = busy || !state.stream;
    els.downloadBtn.disabled = busy;
    els.compareBtn.disabled = busy;
    els.retakeBtn.disabled = busy;
    els.modeButtons.forEach((btn) => {
      btn.disabled = busy;
    });
    els.styleCards.forEach((card) => {
      card.disabled = busy;
    });
  }

  // --- Webcam Setup ---
  async function initCamera() {
    els.cameraError.classList.add('hidden');
    clearError();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      els.cameraErrorMsg.textContent =
        'Your browser blocked camera access. Use localhost or HTTPS to enable the webcam.';
      els.cameraError.classList.remove('hidden');
      els.captureBtn.disabled = true;
      return;
    }

    try {
      if (state.stream) {
        state.stream.getTracks().forEach((track) => track.stop());
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 960 },
          facingMode: 'user',
        },
        audio: false,
      });

      state.stream = stream;
      els.video.srcObject = stream;
      await els.video.play();
      els.captureBtn.disabled = false;
    } catch (err) {
      console.error('Webcam init error:', err);
      els.cameraErrorMsg.textContent =
        'Camera permission denied or no webcam detected. Please allow camera access and retry.';
      els.cameraError.classList.remove('hidden');
      els.captureBtn.disabled = true;
    }
  }

  // --- Flash & Countdown ---
  function triggerFlash() {
    playTone(880, 120, 0.1);
    els.flashOverlay.classList.remove('flash-active');
    // Force reflow to restart CSS keyframe animation
    void els.flashOverlay.offsetWidth;
    els.flashOverlay.classList.add('flash-active');
  }

  async function runCountdown(seconds, progressLabel = '') {
    els.countdownOverlay.classList.remove('hidden');
    if (progressLabel) {
      els.stripProgress.textContent = progressLabel;
      els.stripProgress.classList.remove('hidden');
    } else {
      els.stripProgress.classList.add('hidden');
    }

    for (let i = seconds; i >= 1; i -= 1) {
      els.countdownNumber.textContent = String(i);
      els.countdownNumber.style.animation = 'none';
      void els.countdownNumber.offsetWidth;
      els.countdownNumber.style.animation = '';
      playTone(520, 100, 0.07);
      await delay(950);
    }

    els.countdownOverlay.classList.add('hidden');
  }

  // --- Frame Capture & Canvas Stitching ---
  function drawMirroredVideoFrame(ctx, targetX, targetY, targetW, targetH) {
    const videoW = els.video.videoWidth || 1280;
    const videoH = els.video.videoHeight || 960;

    const targetRatio = targetW / targetH;
    const videoRatio = videoW / videoH;

    let srcW = videoW;
    let srcH = videoH;
    let srcX = 0;
    let srcY = 0;

    if (videoRatio > targetRatio) {
      srcW = videoH * targetRatio;
      srcX = (videoW - srcW) / 2;
    } else {
      srcH = videoW / targetRatio;
      srcY = (videoH - srcH) / 2;
    }

    ctx.save();
    ctx.translate(targetX + targetW, targetY);
    ctx.scale(-1, 1);
    ctx.drawImage(els.video, srcX, srcY, srcW, srcH, 0, 0, targetW, targetH);
    ctx.restore();
  }

  function captureFrameToOffscreen(width, height) {
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = width;
    frameCanvas.height = height;
    const fCtx = frameCanvas.getContext('2d');
    drawMirroredVideoFrame(fCtx, 0, 0, width, height);
    return frameCanvas;
  }

  async function captureSinglePhoto() {
    await runCountdown(3);
    triggerFlash();

    const width = 960;
    const height = 720;
    els.canvas.width = width;
    els.canvas.height = height;
    const ctx = els.canvas.getContext('2d');
    drawMirroredVideoFrame(ctx, 0, 0, width, height);

    return els.canvas.toDataURL('image/jpeg', 0.9);
  }

  async function captureThreeShotStrip() {
    const frameW = 580;
    const frameH = 435;
    const pad = 28;
    const gap = 20;
    const footerH = 104;

    const frames = [];
    for (let shot = 1; shot <= 3; shot += 1) {
      await runCountdown(3, `SHOT ${shot} OF 3`);
      triggerFlash();
      frames.push(captureFrameToOffscreen(frameW, frameH));
      if (shot < 3) {
        await delay(550);
      }
    }

    const totalW = frameW + pad * 2;
    const totalH = pad + frameH * 3 + gap * 2 + footerH;

    els.canvas.width = totalW;
    els.canvas.height = totalH;
    const ctx = els.canvas.getContext('2d');

    // Clean white photobooth paper background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalW, totalH);

    // Draw the 3 sequential frames vertically
    frames.forEach((frameCanvas, idx) => {
      const y = pad + idx * (frameH + gap);
      ctx.drawImage(frameCanvas, pad, y, frameW, frameH);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
      ctx.lineWidth = 2;
      ctx.strokeRect(pad, y, frameW, frameH);
    });

    // Clean photobooth footer typography
    const dateText = new Date().toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

    ctx.fillStyle = '#14141f';
    ctx.textAlign = 'center';
    ctx.font = '700 24px "Orbitron", sans-serif';
    ctx.fillText('NEON SNAP AI BOOTH', totalW / 2, totalH - 54);

    ctx.fillStyle = '#5c5f78';
    ctx.font = '500 16px "Space Grotesk", sans-serif';
    ctx.fillText(dateText.toUpperCase(), totalW / 2, totalH - 26);

    return els.canvas.toDataURL('image/jpeg', 0.9);
  }

  // --- Backend Gemini API Call ---
  async function generateStyledImage(imageDataUrl, styleId, mode) {
    state.isGenerating = true;
    clearError();
    setBusyUI(true);

    // Show raw capture underneath the loading spinner so the user sees their shot immediately
    els.resultImage.src = imageDataUrl;
    els.resultBadge.textContent = 'Original Capture';
    els.resultView.classList.remove('hidden');
    els.loadingText.textContent = 'Developing with Gemini AI...';
    els.loadingOverlay.classList.remove('hidden');

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: imageDataUrl,
          styleId,
          mode,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Generation failed (HTTP ${response.status}).`);
      }

      state.generatedDataUrl = payload.image;
      state.generatedMimeType = payload.mimeType || 'image/png';
      state.generatedStyleName = payload.styleName || 'AI Styled';
      state.shareUrl = payload.shareUrl || null;
      state.showingOriginal = false;

      els.resultImage.src = state.generatedDataUrl;
      els.resultBadge.textContent = state.generatedStyleName;
      els.compareBtn.textContent = 'View Original';
      els.cameraControls.classList.add('hidden');
      els.resultControls.classList.remove('hidden');
      els.styleHint.textContent = 'Click any style to re-render';

      renderQRCode(state.shareUrl);
    } catch (err) {
      console.error('Generation error:', err);
      showError(err.message || 'Could not generate styled image.');

      // If we failed on initial capture, still allow retaking or clicking another style
      els.cameraControls.classList.add('hidden');
      els.resultControls.classList.remove('hidden');
      els.downloadBtn.disabled = !state.generatedDataUrl;
      els.compareBtn.disabled = !state.generatedDataUrl;
    } finally {
      state.isGenerating = false;
      els.loadingOverlay.classList.add('hidden');
      setBusyUI(false);
      if (!state.generatedDataUrl) {
        els.downloadBtn.disabled = true;
        els.compareBtn.disabled = true;
      }
    }
  }

  // --- QR Code Rendering ---
  function renderQRCode(url) {
    els.qrContainer.innerHTML = '';
    if (!url || typeof window.QRCode === 'undefined') {
      els.qrPanel.classList.add('hidden');
      return;
    }

    new window.QRCode(els.qrContainer, {
      text: url,
      width: 128,
      height: 128,
      colorDark: '#090910',
      colorLight: '#ffffff',
      correctLevel: window.QRCode.CorrectLevel.M,
    });

    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url);
    els.localhostWarning.classList.toggle('hidden', !isLocalhost);
    els.qrPanel.classList.remove('hidden');
  }

  // --- Event Handlers ---
  async function handleCaptureClick() {
    if (state.isCapturing || state.isGenerating || !state.stream) return;

    state.isCapturing = true;
    state.generatedDataUrl = null;
    state.shareUrl = null;
    els.qrPanel.classList.add('hidden');
    clearError();
    setBusyUI(true);

    try {
      const capturedMode = state.mode;
      const dataUrl =
        capturedMode === 'strip' ? await captureThreeShotStrip() : await captureSinglePhoto();

      state.rawCapturedDataUrl = dataUrl;
      state.capturedMode = capturedMode;
      state.isCapturing = false;

      await generateStyledImage(dataUrl, state.selectedStyle, capturedMode);
    } catch (err) {
      console.error('Capture error:', err);
      state.isCapturing = false;
      setBusyUI(false);
      showError('Failed to capture photo from webcam.');
    }
  }

  function handleRetake() {
    if (state.isCapturing || state.isGenerating) return;
    state.rawCapturedDataUrl = null;
    state.generatedDataUrl = null;
    state.shareUrl = null;
    state.showingOriginal = false;

    clearError();
    els.resultView.classList.add('hidden');
    els.resultControls.classList.add('hidden');
    els.cameraControls.classList.remove('hidden');
    els.qrPanel.classList.add('hidden');
    els.styleHint.textContent = 'Pick before or after capture';
  }

  function handleDownload() {
    if (!state.generatedDataUrl) return;
    const ext = state.generatedMimeType === 'image/jpeg' ? 'jpg' : 'png';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const link = document.createElement('a');
    link.href = state.generatedDataUrl;
    link.download = `neon-snap-${state.selectedStyle}-${timestamp}.${ext}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function handleCompareToggle() {
    if (!state.rawCapturedDataUrl || !state.generatedDataUrl) return;
    state.showingOriginal = !state.showingOriginal;
    if (state.showingOriginal) {
      els.resultImage.src = state.rawCapturedDataUrl;
      els.resultBadge.textContent = 'Original Capture';
      els.compareBtn.textContent = 'View AI Result';
    } else {
      els.resultImage.src = state.generatedDataUrl;
      els.resultBadge.textContent = state.generatedStyleName;
      els.compareBtn.textContent = 'View Original';
    }
  }

  async function handleCopyLink() {
    if (!state.shareUrl) return;
    try {
      await navigator.clipboard.writeText(state.shareUrl);
      const originalText = els.copyLinkBtn.textContent;
      els.copyLinkBtn.textContent = 'Copied!';
      setTimeout(() => {
        els.copyLinkBtn.textContent = originalText;
      }, 1600);
    } catch {
      showError('Could not copy link to clipboard.');
    }
  }

  // Mode Toggle Listeners
  els.modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.isCapturing || state.isGenerating) return;
      state.mode = btn.dataset.mode;
      els.modeButtons.forEach((b) => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      els.captureBtnLabel.textContent =
        state.mode === 'strip' ? 'Start 3-Shot Strip' : 'Snap Single Photo';
    });
  });

  // Style Preset Card Listeners (usable both before and after capture)
  els.styleCards.forEach((card) => {
    card.addEventListener('click', () => {
      if (state.isCapturing || state.isGenerating) return;
      const newStyle = card.dataset.style;
      state.selectedStyle = newStyle;

      els.styleCards.forEach((c) => {
        const active = c === card;
        c.classList.toggle('active', active);
        c.setAttribute('aria-checked', String(active));
      });

      // If a photo/strip has already been captured, immediately restyle it
      if (state.rawCapturedDataUrl) {
        generateStyledImage(state.rawCapturedDataUrl, state.selectedStyle, state.capturedMode);
      }
    });
  });

  els.captureBtn.addEventListener('click', handleCaptureClick);
  els.retakeBtn.addEventListener('click', handleRetake);
  els.downloadBtn.addEventListener('click', handleDownload);
  els.compareBtn.addEventListener('click', handleCompareToggle);
  els.copyLinkBtn.addEventListener('click', handleCopyLink);
  els.retryCameraBtn.addEventListener('click', initCamera);
  els.dismissErrorBtn.addEventListener('click', clearError);

  initCamera();
})();
