import React, { useState, useEffect, useCallback, useRef } from 'react';
import './Popup.css';

type RunResult = {
  ok: boolean;
  message: string;
};

type StoredLock = {
  lockEnabled?: boolean;
  lockedTabId?: number;
};

const LOCK_KEY = 'cliprun_lock';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 8000;
const OPERATION_TIMEOUT_MS = 6000;

/* ---------- Environment guards ---------- */
const hasChrome = (): boolean => typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
const hasStorage = (): boolean => hasChrome() && typeof chrome.storage?.local?.get === 'function';
const hasTabs = (): boolean => hasChrome() && typeof chrome.tabs?.query === 'function';
const hasScripting = (): boolean => hasChrome() && typeof chrome.scripting?.executeScript === 'function';

/** Wrap any promise with a strict timeout rejection to prevent hanging UI */
function withTimeout<T>(promise: Promise<T>, ms: number, timeoutErrorMsg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutErrorMsg));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

/** In-memory lock fallback for non-extension environments (sandbox/preview). */
let mockLock: StoredLock | null = null;

/** Injected into the page's MAIN world. Creates a <script> tag that runs the
 *  clipboard code, capturing runtime errors (try/catch) and whole-tag syntax
 *  errors (window 'error' listener) into window.__clipRun. */
function injectCodeInPage(code: string): void {
  const w = window as unknown as {
    __clipRun?: { done: boolean; ok: boolean; error: string | null };
  };
  w.__clipRun = { done: false, ok: true, error: null };

  w.addEventListener(
    'error',
    (ev: ErrorEvent) => {
      if (w.__clipRun && !w.__clipRun.done) {
        w.__clipRun = {
          done: true,
          ok: false,
          error: `${ev.message}${ev.lineno ? ` (line ${ev.lineno})` : ''}`,
        };
      }
    },
    true
  );

  const script = document.createElement('script');
  script.textContent = `(function(){\n  var __st = window.__clipRun;\n  (async function(){\n    try {\n      (function(){\n        ${code}\n      })();\n      __st.done = true;\n    } catch (err) {\n      __st.done = true;\n      __st.ok = false;\n      __st.error = (err && err.stack) ? String(err.stack) : String(err);\n    }\n  })();\n})();`;
  document.documentElement.appendChild(script);
  script.remove();
}

/** Injected to poll the result state left behind by injectCodeInPage. */
function pollResultInPage(): { done: boolean; ok: boolean; error: string | null } | null {
  const w = window as unknown as {
    __clipRun?: { done: boolean; ok: boolean; error: string | null };
  };
  return w.__clipRun ?? null;
}

const Popup: React.FC = () => {
  const [lockEnabled, setLockEnabled] = useState<boolean>(false);
  const [lockedTabTitle, setLockedTabTitle] = useState<string>('');
  const [lockValid, setLockValid] = useState<boolean>(true);
  const [code, setCode] = useState<string>('');
  const [showEditor, setShowEditor] = useState<boolean>(false);
  const [running, setRunning] = useState<boolean>(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const mounted = useRef<boolean>(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Load persisted lock on mount and verify the tab still exists with timeout guard.
  useEffect(() => {
    (async () => {
      try {
        if (!hasStorage()) return;
        const stored = (await withTimeout(
          chrome.storage.local.get(LOCK_KEY),
          3000,
          'Storage read timed out'
        )) as StoredLock;
        if (!stored.lockEnabled || typeof stored.lockedTabId !== 'number') return;
        try {
          const tab = await withTimeout(
            chrome.tabs.get(stored.lockedTabId),
            3000,
            'Tab retrieval timed out'
          );
          if (!mounted.current) return;
          setLockEnabled(true);
          setLockValid(true);
          setLockedTabTitle(tab.title || `Tab ${tab.id}`);
        } catch {
          if (!mounted.current) return;
          await chrome.storage.local.remove(LOCK_KEY).catch(() => {});
          setLockEnabled(false);
          setLockValid(false);
          setResult({ ok: false, message: 'Locked tab no longer exists — lock cleared.' });
        }
      } catch (err) {
        if (mounted.current) {
          setResult({ ok: false, message: `Storage initialisation error: ${(err as Error).message}` });
        }
      }
    })();
  }, []);

  const toggleLock = useCallback(async () => {
    try {
      if (lockEnabled) {
        setLockEnabled(false);
        setLockedTabTitle('');
        mockLock = null;
        if (hasStorage()) await chrome.storage.local.remove(LOCK_KEY).catch(() => {});
        if (mounted.current) setResult({ ok: true, message: 'Lock released — executing on the active tab.' });
      } else {
        if (!hasTabs()) {
          if (mounted.current) setResult({ ok: false, message: 'chrome.tabs unavailable in this environment.' });
          return;
        }
        const tabs = await withTimeout(
          chrome.tabs.query({ active: true, currentWindow: true }),
          OPERATION_TIMEOUT_MS,
          'Active tab query timed out'
        );
        const tab = tabs[0];
        if (!tab?.id) {
          if (mounted.current) setResult({ ok: false, message: 'No active tab found to lock.' });
          return;
        }
        setLockEnabled(true);
        setLockValid(true);
        setLockedTabTitle(tab.title || `Tab ${tab.id}`);
        mockLock = { lockEnabled: true, lockedTabId: tab.id };
        if (hasStorage()) {
          await chrome.storage.local.set({
            [LOCK_KEY]: { lockEnabled: true, lockedTabId: tab.id } satisfies StoredLock,
          }).catch(() => {});
        }
        if (mounted.current) setResult({ ok: true, message: `Locked to: ${tab.title || `Tab ${tab.id}`}` });
      }
    } catch (err) {
      if (mounted.current) setResult({ ok: false, message: `Lock error: ${(err as Error).message}` });
    }
  }, [lockEnabled]);

  /** Resolve which tab to execute against safely with timeout. */
  const resolveTargetTab = useCallback(async (): Promise<{ id: number; title: string }> => {
    if (lockEnabled) {
      if (!hasTabs() && mockLock && typeof mockLock.lockedTabId === 'number') {
        return { id: mockLock.lockedTabId, title: lockedTabTitle || `Tab ${mockLock.lockedTabId}` };
      }
      try {
        const stored = hasStorage()
          ? ((await withTimeout(
              chrome.storage.local.get(LOCK_KEY),
              3000,
              'Storage query timed out'
            )) as StoredLock)
          : (mockLock ?? ({} as StoredLock));
        const id = stored.lockedTabId;
        if (typeof id === 'number') {
          const tab = await withTimeout(
            chrome.tabs.get(id),
            OPERATION_TIMEOUT_MS,
            'Locked tab request timed out'
          );
          return { id: tab.id!, title: tab.title || `Tab ${tab.id}` };
        }
      } catch {
        if (mounted.current) {
          setLockEnabled(false);
          setLockValid(false);
        }
        mockLock = null;
        if (hasStorage()) await chrome.storage.local.remove(LOCK_KEY).catch(() => {});
        throw new Error('Locked tab is unreachable or closed — lock cleared.');
      }
    }
    if (!hasTabs()) {
      return { id: -1, title: 'Sandbox (no real tab)' };
    }
    const tabs = await withTimeout(
      chrome.tabs.query({ active: true, currentWindow: true }),
      OPERATION_TIMEOUT_MS,
      'Active tab query timed out'
    );
    const tab = tabs[0];
    if (!tab?.id) throw new Error('No active tab found.');
    return { id: tab.id, title: tab.title || `Tab ${tab.id}` };
  }, [lockEnabled, lockedTabTitle]);

  /** Inject + poll the MAIN world for the result with fallback and error handling. */
  const executeOnTab = useCallback(async (tabId: number, codeToRun: string): Promise<RunResult> => {
    if (!hasScripting()) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        // eslint-disable-next-line no-new-func
        new Function(codeToRun)();
        return { ok: true, message: '✓ Simulated execution succeeded (sandbox mode).' };
      } catch (err) {
        return { ok: false, message: (err as Error).message || 'Simulated execution error.' };
      }
    }

    try {
      await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: injectCodeInPage,
          args: [codeToRun],
        }),
        OPERATION_TIMEOUT_MS,
        'Script injection timed out (the tab may be unresponsive or restricted).'
      );
    } catch (err) {
      const errMsg = (err as Error).message || 'Failed to inject script';
      if (errMsg.includes('chrome://') || errMsg.includes('Cannot access')) {
        return { ok: false, message: 'Chrome prohibits running scripts on browser internal pages (chrome://, Web Store).' };
      }
      return { ok: false, message: `Injection failed: ${errMsg}` };
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (!mounted.current) {
        return { ok: true, message: 'Popup closed while code was running — execution continues in the page.' };
      }
      try {
        const results = await withTimeout(
          chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: pollResultInPage,
          }),
          3000,
          'Result polling timed out'
        );
        const state = results?.[0]?.result;
        if (state) {
          if (!state.done) continue;
          return state.ok
            ? { ok: true, message: '✓ Code executed successfully.' }
            : { ok: false, message: state.error || 'Unknown runtime error.' };
        }
      } catch {
        // Target tab might have navigated or closed while polling
        break;
      }
    }
    return {
      ok: true,
      message: '✓ Injected. Code is running asynchronously or completed without return value.',
    };
  }, []);

  const runCode = useCallback(
    async (codeToRun: string) => {
      if (!codeToRun.trim()) {
        if (mounted.current) setResult({ ok: false, message: 'Clipboard/code is empty — nothing to run.' });
        return;
      }
      if (mounted.current) {
        setRunning(true);
        setResult(null);
      }
      try {
        const target = await resolveTargetTab();
        const res = await executeOnTab(target.id, codeToRun);
        if (mounted.current) setResult(res);
      } catch (err) {
        if (mounted.current) setResult({ ok: false, message: (err as Error).message });
      } finally {
        if (mounted.current) setRunning(false);
      }
    },
    [resolveTargetTab, executeOnTab]
  );

  const runFromClipboard = useCallback(async () => {
    try {
      if (!navigator.clipboard?.readText) {
        if (mounted.current) setResult({ ok: false, message: 'Clipboard API unavailable — use Edit Code directly.' });
        return;
      }
      const text = await withTimeout(
        navigator.clipboard.readText(),
        OPERATION_TIMEOUT_MS,
        'Clipboard read timed out'
      );
      if (!text.trim()) {
        if (mounted.current) setResult({ ok: false, message: 'Clipboard is empty.' });
        return;
      }
      await runCode(text);
    } catch (err) {
      if (mounted.current) {
        setResult({ ok: false, message: `Clipboard read failed: ${(err as Error).message || 'Permission denied'}` });
      }
    }
  }, [runCode]);

  const editCode = useCallback(async () => {
    try {
      if (navigator.clipboard?.readText) {
        const text = await withTimeout(
          navigator.clipboard.readText(),
          3000,
          'Clipboard read timed out'
        ).catch(() => '');
        if (mounted.current && text) {
          setCode(text);
          setResult({ ok: true, message: 'Clipboard loaded into editor.' });
        }
      }
    } catch {
      // Quiet fallback to empty editor if clipboard access fails
    }
    if (mounted.current) setShowEditor(true);
  }, []);

  const runEditedCode = useCallback(async () => {
    await runCode(code);
  }, [code, runCode]);

  return (
    <div className="popup-container">
      <header className="header">
        <div className="brand">
          <span className="brand-icon">{'{ }'}</span>
          <h1>ClipRun</h1>
        </div>
        <span className="badge">MAIN world</span>
      </header>

      {/* Attach Tab toggle */}
      <button
        className={`lock-toggle ${lockEnabled ? 'locked' : ''}`}
        onClick={toggleLock}
        title="Lock execution to the current tab"
      >
        <span className={`lock-indicator ${lockEnabled ? 'on' : ''}`} />
        <span className="lock-label">
          {lockEnabled ? 'Attached' : 'Attach Tab'}
        </span>
        {lockEnabled && (
          <span className="lock-target">{lockValid ? lockedTabTitle : 'tab missing'}</span>
        )}
      </button>

      {/* Primary actions */}
      <div className="actions">
        <button
          className="btn btn-primary"
          onClick={runFromClipboard}
          disabled={running}
        >
          {running ? 'Running…' : '▶ Run from Clipboard'}
        </button>
        <button className="btn btn-secondary" onClick={editCode} disabled={running}>
          ✎ Edit Code
        </button>
      </div>

      {/* Hidden-by-default editor */}
      {showEditor && (
        <div className="editor">
          <div className="editor-head">
            <span>Code Editor</span>
            <button
              className="editor-close"
              onClick={() => setShowEditor(false)}
              aria-label="Close editor"
            >
              ✕
            </button>
          </div>
          <textarea
            className="code-area"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            placeholder="// JavaScript to run in the page…"
          />
          <button
            className="btn btn-primary btn-run-sub"
            onClick={runEditedCode}
            disabled={running || !code.trim()}
          >
            {running ? 'Running…' : '▶ Run'}
          </button>
        </div>
      )}

      {/* Message / result area */}
      <div className={`message-area ${result ? (result.ok ? 'ok' : 'err') : ''}`}>
        {running && <p className="msg-running">Injecting into page…</p>}
        {!running && !result && (
          <p className="msg-idle">
            Ready. Copy code anywhere, then run it into the {lockEnabled ? 'attached' : 'active'} tab.
          </p>
        )}
        {!running && result && (
          <pre className="msg-text">{result.message}</pre>
        )}
      </div>

      <footer className="footer">
        Executes user code — use only on pages you trust.
      </footer>
    </div>
  );
};

export default Popup;