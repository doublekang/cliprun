// ClipRun background service worker
// The toolbar icon opens the side panel — there is no popup.
if (typeof chrome !== 'undefined' && chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('[ClipRun] setPanelBehavior failed:', error));
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[ClipRun] Installed:', details.reason);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('[ClipRun] Message received:', message);
  sendResponse({ success: true });
  return true;
});

export {};