// Background service worker — minimal: ClipRun's work happens in the popup
// via chrome.scripting against the target tab with guarded error boundaries.
try {
  console.log('[ClipRun] Background service worker started');

  chrome.runtime.onInstalled.addListener((details) => {
    try {
      console.log('[ClipRun] Installed:', details.reason);
    } catch (e) {
      console.warn('[ClipRun] onInstalled handler warning:', e);
    }
  });
} catch (error) {
  console.error('[ClipRun] Background worker initialization error:', error);
}

export {};