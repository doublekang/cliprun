import React from 'react';
import { createRoot } from 'react-dom/client';
import Popup from './Popup';
import './Popup.css';

// Fail-safe mount: never throw or block if #root is missing (e.g. during
// sandboxed preview mounts). Retry once on the next frame, then give up quietly.
function mount() {
  const container = document.getElementById('root');
  if (!container) {
    requestAnimationFrame(() => {
      const retry = document.getElementById('root');
      if (retry) {
        createRoot(retry).render(
          <React.StrictMode>
            <Popup />
          </React.StrictMode>
        );
      }
    });
    return;
  }
  createRoot(container).render(
    <React.StrictMode>
      <Popup />
    </React.StrictMode>
  );
}

try {
  mount();
} catch (err) {
  console.error('[ClipRun] Mount failed:', err);
}