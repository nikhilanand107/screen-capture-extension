(function () {
  if (window.__fullPageScreenshotInjected) {
    return;
  }
  window.__fullPageScreenshotInjected = true;

  let initialScrollX = 0;
  let initialScrollY = 0;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function getPageDimensions() {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    const pageWidth = Math.max(
      document.body ? document.body.scrollWidth : 0,
      document.documentElement.scrollWidth,
      document.body ? document.body.offsetWidth : 0,
      document.documentElement.offsetWidth,
      document.body ? document.body.clientWidth : 0,
      document.documentElement.clientWidth
    );

    const pageHeight = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement.scrollHeight,
      document.body ? document.body.offsetHeight : 0,
      document.documentElement.offsetHeight,
      document.body ? document.body.clientHeight : 0,
      document.documentElement.clientHeight
    );

    const devicePixelRatio = window.devicePixelRatio || 1;
    initialScrollX = window.scrollX || window.pageXOffset || 0;
    initialScrollY = window.scrollY || window.pageYOffset || 0;

    return {
      viewportWidth,
      viewportHeight,
      pageWidth,
      pageHeight,
      devicePixelRatio,
      initialScrollX,
      initialScrollY
    };
  }

  function calculateScrollPositions(pageHeight, viewportHeight) {
    const positions = [];
    if (pageHeight <= viewportHeight) {
      positions.push(0);
      return positions;
    }

    const maxScroll = pageHeight - viewportHeight;
    let y = 0;

    while (y < maxScroll) {
      positions.push(y);
      y += viewportHeight;
    }

    if (positions[positions.length - 1] !== maxScroll) {
      positions.push(maxScroll);
    }

    return positions;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'GET_DIMENSIONS') {
      const dims = getPageDimensions();
      const positions = calculateScrollPositions(dims.pageHeight, dims.viewportHeight);
      sendResponse({ dimensions: dims, scrollPositions: positions });
    } else if (request.action === 'SCROLL_TO') {
      window.scrollTo(0, request.y);
      delay(250).then(() => {
        const actualY = window.scrollY || window.pageYOffset || 0;
        sendResponse({ status: 'scrolled', actualY });
      });
      return true;
    } else if (request.action === 'RESTORE_SCROLL') {
      window.scrollTo(initialScrollX, initialScrollY);
      delay(100).then(() => {
        sendResponse({ status: 'restored' });
      });
      return true;
    }
    return true;
  });
})();
