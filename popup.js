document.addEventListener('DOMContentLoaded', () => {
  const captureBtn = document.getElementById('captureBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const progressContainer = document.getElementById('progressContainer');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const sectionText = document.getElementById('sectionText');
  const statusMessage = document.getElementById('statusMessage');
  const infoBox = document.getElementById('infoBox');
  const viewportDim = document.getElementById('viewportDim');
  const pageDim = document.getElementById('pageDim');
  const dprVal = document.getElementById('dprVal');
  const resultContainer = document.getElementById('resultContainer');
  const resultDetails = document.getElementById('resultDetails');
  const resultPreview = document.getElementById('resultPreview');

  let activeTabId = null;
  let isCancelled = false;
  let isProcessing = false;
  let currentResultUrl = null;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function showStatus(text, type = 'info') {
    statusMessage.textContent = text;
    statusMessage.className = `status-message ${type}`;
    statusMessage.classList.remove('hidden');
  }

  function hideStatus() {
    statusMessage.classList.add('hidden');
  }

  function updateProgress(percent, labelText, sectionInfo = '') {
    progressBar.style.width = `${percent}%`;
    progressText.textContent = `${percent}%`;
    sectionText.textContent = sectionInfo ? `${labelText} (${sectionInfo})` : labelText;
  }

  function generateFilename() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const year = now.getFullYear();
    const month = pad(now.getMonth() + 1);
    const day = pad(now.getDate());
    const hours = pad(now.getHours());
    const minutes = pad(now.getMinutes());
    const seconds = pad(now.getSeconds());
    return `full-page-screenshot-${year}-${month}-${day}-${hours}-${minutes}-${seconds}.png`;
  }

  function isRestrictedUrl(url) {
    if (!url) return true;
    const restrictedProtocols = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'view-source:'];
    if (restrictedProtocols.some((proto) => url.startsWith(proto))) {
      return true;
    }
    if (url.includes('chrome.google.com/webstore') || url.includes('chromewebstore.google.com')) {
      return true;
    }
    return false;
  }

  function sendMessagePromise(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  function captureVisibleTabPromise(windowId) {
    return new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!dataUrl) {
          reject(new Error('Failed to capture visible tab area.'));
        } else {
          resolve(dataUrl);
        }
      });
    });
  }

  function downloadFilePromise(url, filename) {
    return new Promise((resolve, reject) => {
      if (chrome.downloads && typeof chrome.downloads.download === 'function') {
        chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(downloadId);
          }
        });
      } else {
        try {
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          resolve('anchor_download');
        } catch (err) {
          reject(new Error('Download failed: ' + (err.message || err)));
        }
      }
    });
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Page is too large to stitch safely (canvas memory allocation failed).'));
          }
        }, 'image/png');
      } catch (err) {
        reject(err);
      }
    });
  }

  async function stitchImages(frames, dimensions) {
    const { pageWidth, pageHeight, devicePixelRatio } = dimensions;
    const dpr = devicePixelRatio || 1;

    const canvasWidth = Math.round(pageWidth * dpr);
    const canvasHeight = Math.round(pageHeight * dpr);

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to allocate canvas 2D rendering context.');
    }

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const img = new Image();

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error(`Failed to process frame ${i + 1}`));
        img.src = frame.dataUrl;
      });

      const destY = Math.round(frame.y * dpr);
      ctx.drawImage(img, 0, destY);

      // Memory cleanup for image frame element
      img.onload = null;
      img.onerror = null;
      img.src = '';
    }

    const blob = await canvasToBlob(canvas);

    // Clear canvas reference
    canvas.width = 0;
    canvas.height = 0;

    return blob;
  }

  function cleanUpResultUrl() {
    if (currentResultUrl) {
      URL.revokeObjectURL(currentResultUrl);
      currentResultUrl = null;
    }
  }

  async function startCapture() {
    if (isProcessing) return;
    isProcessing = true;
    isCancelled = false;

    hideStatus();
    if (resultContainer) resultContainer.classList.add('hidden');
    cleanUpResultUrl();

    captureBtn.classList.add('hidden');
    cancelBtn.classList.remove('hidden');
    progressContainer.classList.remove('hidden');

    updateProgress(0, 'Preparing page...');

    // 1. Get active tab
    let tab;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs[0];
      if (!tab || !tab.id) {
        throw new Error('Cannot access active tab.');
      }
      activeTabId = tab.id;
    } catch (err) {
      console.error('Tab query error:', err);
      showStatus(err.message || 'Cannot access active tab.', 'error');
      resetUI();
      return;
    }

    // 2. Check restricted URLs
    if (isRestrictedUrl(tab.url)) {
      showStatus('Cannot capture this page. Chrome restricts extensions on this page.', 'error');
      resetUI();
      return;
    }

    // 3. Inject content script
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
    } catch (err) {
      console.error('Script injection failed:', err);
      showStatus('This page does not allow extensions to inject scripts.', 'error');
      resetUI();
      return;
    }

    // 4. Get page dimensions & positions
    let response;
    try {
      response = await sendMessagePromise(tab.id, { action: 'GET_DIMENSIONS' });
    } catch (err) {
      console.error('Failed to get page dimensions:', err);
      showStatus('Failed to connect to webpage script. Page may have navigated.', 'error');
      resetUI();
      return;
    }

    const { dimensions, scrollPositions } = response;
    if (!dimensions || !scrollPositions || scrollPositions.length === 0) {
      showStatus('Invalid page dimensions returned.', 'error');
      resetUI();
      return;
    }

    // Update info box
    viewportDim.textContent = `${dimensions.viewportWidth} × ${dimensions.viewportHeight} px`;
    pageDim.textContent = `${dimensions.pageWidth} × ${dimensions.pageHeight} px`;
    dprVal.textContent = `${dimensions.devicePixelRatio}x`;
    infoBox.classList.remove('hidden');

    const totalSections = scrollPositions.length;
    const frames = [];

    // 5. Capture Loop
    try {
      for (let i = 0; i < totalSections; i++) {
        if (isCancelled) {
          await sendMessagePromise(tab.id, { action: 'RESTORE_SCROLL' }).catch(() => {});
          showStatus('Capture cancelled by user.', 'info');
          resetUI();
          return;
        }

        const targetY = scrollPositions[i];

        // Scroll page
        const scrollRes = await sendMessagePromise(tab.id, { action: 'SCROLL_TO', y: targetY });
        const actualY = scrollRes.actualY;

        // Render settle delay
        await delay(150);

        // Capture visible viewport
        const dataUrl = await captureVisibleTabPromise(tab.windowId);
        frames.push({ dataUrl, y: actualY });

        // Update progress (ranges 5% to 85%)
        const percent = Math.round(5 + ((i + 1) / totalSections) * 80);
        updateProgress(percent, 'Capturing', `Section ${i + 1} / ${totalSections}`);
      }

      // Restore scroll position
      await sendMessagePromise(tab.id, { action: 'RESTORE_SCROLL' }).catch(() => {});

      if (isCancelled) {
        showStatus('Capture cancelled by user.', 'info');
        resetUI();
        return;
      }

      // 6. Stitch images
      updateProgress(90, 'Stitching screenshots...');
      const stitchedBlob = await stitchImages(frames, dimensions);

      // Clean base64 frame data from memory
      frames.length = 0;

      if (isCancelled) {
        showStatus('Capture cancelled by user.', 'info');
        resetUI();
        return;
      }

      // 7. Download PNG
      updateProgress(95, 'Preparing download...');
      currentResultUrl = URL.createObjectURL(stitchedBlob);
      const filename = generateFilename();

      await downloadFilePromise(currentResultUrl, filename);

      // Update UI with completion
      updateProgress(100, 'Completed');

      const finalWidth = Math.round(dimensions.pageWidth * dimensions.devicePixelRatio);
      const finalHeight = Math.round(dimensions.pageHeight * dimensions.devicePixelRatio);
      resultDetails.textContent = `${filename}\n(${finalWidth} × ${finalHeight} px, ${(stitchedBlob.size / (1024 * 1024)).toFixed(2)} MB)`;
      resultPreview.src = currentResultUrl;
      resultContainer.classList.remove('hidden');

      showStatus('Screenshot downloaded successfully!', 'success');
      resetUI();

      // Revoke Object URL after download grace period (5 seconds)
      setTimeout(() => {
        cleanUpResultUrl();
      }, 5000);

    } catch (err) {
      console.error('Capture process failed:', err);
      try {
        if (activeTabId) {
          await sendMessagePromise(activeTabId, { action: 'RESTORE_SCROLL' });
        }
      } catch (e) {
        /* ignore */
      }
      showStatus(err.message || 'Screenshot capture failed. Please try again.', 'error');
      resetUI();
    }
  }

  function cancelCapture() {
    isCancelled = true;
  }

  function resetUI() {
    isProcessing = false;
    captureBtn.classList.remove('hidden');
    cancelBtn.classList.add('hidden');
  }

  captureBtn.addEventListener('click', startCapture);
  cancelBtn.addEventListener('click', cancelCapture);
});
