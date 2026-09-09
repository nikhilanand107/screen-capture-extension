// Background service worker for Manifest V3 extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('Full Page Screenshot extension installed successfully.');
});
