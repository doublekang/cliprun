// ClipRun content script — intentionally minimal. ClipRun is a side-panel
// extension and does not inject UI into pages. This placeholder keeps the
// entry point available for future features (e.g. context-menu capture).
console.log('[ClipRun] Content script loaded');

if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'ping') {
      sendResponse({ ok: true });
    }
    return false;
  });
}

export {};