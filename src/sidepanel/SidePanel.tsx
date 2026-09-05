import React, { useState, useEffect, useCallback, useMemo } from 'react';
import './SidePanel.css';

// ---------- Inline types (self-contained for preview) ----------
interface Snippet {
  id: string;
  text: string;
  createdAt: number;
}

type Filter = 'all' | 'recent';

interface RunResult {
  success: boolean;
  error?: string;
}

const STORAGE_KEY = 'cliprun_snippets';
const LOCK_KEY = 'cliprun_lockedTabId';
const SCHEMA_VERSION = 1;

// ---------- Persistence ----------
async function loadSnippets(): Promise<Snippet[]> {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const raw = data[STORAGE_KEY];
    if (!raw || typeof raw !== 'object') return [];
    if (raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.snippets)) {
      return [];
    }
    return raw.snippets
      .filter((s: unknown): s is Snippet =>
        !!s && typeof (s as Snippet).id === 'string' && typeof (s as Snippet).text === 'string')
      .map((s: Snippet) => ({ id: s.id, text: s.text, createdAt: Number(s.createdAt) || 0 }));
  } catch {
    return [];
  }
}

async function persistSnippets(snippets: Snippet[]): Promise<void> {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY]: { schemaVersion: SCHEMA_VERSION, snippets },
    });
  } catch {
    // storage unavailable (e.g. preview mode) — ignore
  }
}

async function loadLockedTabId(): Promise<number | null> {
  try {
    const data = await chrome.storage.local.get(LOCK_KEY);
    const v = data[LOCK_KEY];
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

async function persistLockedTabId(tabId: number | null): Promise<void> {
  try {
    if (tabId === null) await chrome.storage.local.remove(LOCK_KEY);
    else await chrome.storage.local.set({ [LOCK_KEY]: tabId });
  } catch {
    // ignore
  }
}

const newId = (): string =>
  (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

const timeAgo = (ts: number): string => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// ---------- Tab / script execution ----------
async function getTargetTabId(lockedTabId: number | null): Promise<number | null> {
  // Verify the locked tab still exists; reset the lock if not.
  if (lockedTabId !== null) {
    try {
      await chrome.tabs.get(lockedTabId);
      return lockedTabId;
    } catch {
      await persistLockedTabId(null);
      return null;
    }
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

const execScript = (code: string): void => {
  const handler = (ev: ErrorEvent) => {
    // Surface runtime errors from the injected code back to the panel.
    window.__clipRunError = ev.message || String(ev.error || 'Unknown error');
  };
  try {
    const prevError = window.__clipRunError;
    window.__clipRunError = undefined;
    window.addEventListener('error', handler);
    const script = document.createElement('script');
    script.textContent = code;
    document.documentElement.appendChild(script);
    script.remove();
    window.removeEventListener('error', handler);
    if (window.__clipRunError !== undefined) {
      const err = String(window.__clipRunError);
      window.__clipRunError = prevError;
      throw new Error(err);
    }
  } catch (e) {
    window.removeEventListener('error', handler);
    throw e;
  }
};

async function runCodeInTab(tabId: number, code: string): Promise<RunResult> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: execScript,
      args: [code],
    });
    const r = results?.[0]?.result as RunResult | undefined;
    return r ?? { success: true };
  } catch (e) {
    // Injection/syntax-level failure surfaced via thrown error inside MAIN world
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}

// ---------- Component ----------
const SidePanel: React.FC = () => {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Tab lock + runner state
  const [lockedTabId, setLockedTabId] = useState<number | null>(null);
  const [runStatus, setRunStatus] = useState<{ success: boolean; message: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [showEditCode, setShowEditCode] = useState(false);
  const [editedCode, setEditedCode] = useState('');

  useEffect(() => {
    loadSnippets().then((s) => {
      setSnippets(s);
      setLoading(false);
    });
    loadLockedTabId().then(setLockedTabId);
  }, []);

  const updateSnippets = useCallback((next: Snippet[]) => {
    setSnippets(next);
    void persistSnippets(next);
  }, []);

  // ---------- Runner actions ----------
  const toggleLock = useCallback(async () => {
    if (lockedTabId !== null) {
      setLockedTabId(null);
      await persistLockedTabId(null);
      setRunStatus({ success: true, message: 'Tab lock released — targeting the active tab.' });
      return;
    }
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) {
        setRunStatus({ success: false, message: 'Could not find an active tab to lock to.' });
        return;
      }
      setLockedTabId(tab.id);
      await persistLockedTabId(tab.id);
      setRunStatus({ success: true, message: `Locked to Tab #${tab.id}.` });
    } catch {
      setRunStatus({ success: false, message: 'Failed to lock the active tab.' });
    }
  }, [lockedTabId]);

  const executeCode = useCallback(async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) {
      setRunStatus({ success: false, message: 'Nothing to run — clipboard or editor is empty.' });
      return;
    }
    setRunning(true);
    setRunStatus(null);
    try {
      const target = await getTargetTabId(lockedTabId);
      if (target == null) {
        setRunStatus({ success: false, message: 'No target tab found. Open a page and try again.' });
        return;
      }
      const result = await runCodeInTab(target, trimmed);
      if (result.success) {
        setRunStatus({ success: true, message: `Code ran successfully in Tab #${target}.` });
      } else {
        setRunStatus({ success: false, message: result.error ?? 'Unknown runtime error.' });
      }
    } catch (e) {
      setRunStatus({ success: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  }, [lockedTabId]);

  const runFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      await executeCode(text);
    } catch {
      setRunStatus({ success: false, message: 'Could not read the clipboard (permission denied).' });
    }
  }, [executeCode]);

  const openEditCode = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setEditedCode(text);
    } catch {
      setEditedCode(''); // clipboard denied — start empty
    }
    setShowEditCode(true);
    setRunStatus(null);
  }, []);

  const runEditedCode = useCallback(async () => {
    await executeCode(editedCode);
  }, [editedCode, executeCode]);

  // ---------- Snippet actions ----------
  const addSnippet = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    if (text.length > 10000) {
      setError('Snippet too long (max 10,000 characters).');
      return;
    }
    setError(null);
    const snippet: Snippet = { id: newId(), text, createdAt: Date.now() };
    updateSnippets([snippet, ...snippets]);
    setDraft('');
  }, [draft, snippets, updateSnippets]);

  const copySnippet = useCallback(async (s: Snippet) => {
    try {
      await navigator.clipboard.writeText(s.text);
      setCopiedId(s.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === s.id ? null : cur)), 1500);
    } catch {
      setError('Could not access the clipboard.');
      window.setTimeout(() => setError(null), 2500);
    }
  }, []);

  const deleteSnippet = useCallback((id: string) => {
    updateSnippets(snippets.filter((s) => s.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setEditText('');
    }
  }, [snippets, updateSnippets, editingId]);

  const startEdit = useCallback((s: Snippet) => {
    setEditingId(s.id);
    setEditText(s.text);
  }, []);

  const saveEdit = useCallback(() => {
    if (!editingId) return;
    const text = editText.trim();
    if (!text) return;
    updateSnippets(
      snippets.map((s) => (s.id === editingId ? { ...s, text } : s)),
    );
    setEditingId(null);
    setEditText('');
  }, [editingId, editText, snippets, updateSnippets]);

  const resetAll = useCallback(() => {
    updateSnippets([]);
    setEditingId(null);
    setEditText('');
    setQuery('');
    setError(null);
  }, [updateSnippets]);

  const visible = useMemo(() => {
    let list = snippets;
    if (filter === 'recent') list = list.filter((s) => Date.now() - s.createdAt < 24 * 3600 * 1000);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((s) => s.text.toLowerCase().includes(q));
    return list;
  }, [snippets, filter, query]);

  const targetLabel = lockedTabId !== null ? `Locked to Tab #${lockedTabId}` : 'Target: Active Tab';

  return (
    <div className="flex flex-col h-screen w-full bg-slate-50 text-slate-800">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-indigo-600 to-sky-500 shadow-md">
        <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
          <svg viewBox="0 0 24 24" className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="6" y="4" width="12" height="17" rx="2" />
            <path d="M9 4a3 3 0 0 1 6 0" />
            <path d="M9 12l1.5 1.5L13.5 10" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-white font-semibold text-lg leading-tight truncate">ClipRun</h1>
          <p className="text-sky-100 text-xs">Save, search &amp; re-run snippets</p>
        </div>
        <button
          onClick={resetAll}
          title="Reset all snippets"
          className="text-white/80 hover:text-white transition-colors p-1.5 rounded-lg hover:bg-white/10 shrink-0"
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
          </svg>
        </button>
      </header>

      {/* Runner: tab lock + clipboard execution */}
      <div className="px-4 pt-3">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-3 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-xs font-medium flex items-center gap-1.5 ${lockedTabId !== null ? 'text-emerald-600' : 'text-slate-500'}`}>
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                {lockedTabId !== null
                  ? <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>
                  : <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.9-.9" /></>}
              </svg>
              {targetLabel}
            </span>
            <button
              onClick={toggleLock}
              disabled={running}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
                lockedTabId !== null
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                  : 'bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200'
              } disabled:opacity-40`}
            >
              {lockedTabId !== null ? 'Detach Tab' : 'Attach Tab'}
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={runFromClipboard}
              disabled={running}
              className="flex-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium
                         hover:bg-indigo-700 active:scale-95 disabled:opacity-40 transition-all
                         flex items-center justify-center gap-1.5"
            >
              {running ? (
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 3a9 9 0 1 0 9 9" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 3l14 9-14 9V3z" />
                </svg>
              )}
              {running ? 'Running…' : 'Run from Clipboard'}
            </button>
            <button
              onClick={openEditCode}
              disabled={running}
              className="px-3 py-1.5 rounded-lg bg-white text-indigo-600 border border-indigo-200 text-xs font-medium
                         hover:bg-indigo-50 disabled:opacity-40 transition-all"
            >
              Edit Code
            </button>
          </div>
          {showEditCode && (
            <div className="space-y-2">
              <textarea
                value={editedCode}
                onChange={(e) => setEditedCode(e.target.value)}
                rows={5}
                spellCheck={false}
                placeholder="// Code to run in the target tab…"
                className="w-full text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg p-2
                           focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => { setShowEditCode(false); setEditedCode(''); }}
                  className="px-3 py-1 text-xs rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={runEditedCode}
                  disabled={running || !editedCode.trim()}
                  className="px-3 py-1 text-xs rounded-lg bg-indigo-600 text-white hover:bg-indigo-700
                             disabled:opacity-40 transition-colors"
                >
                  {running ? 'Running…' : 'Run Edited Code'}
                </button>
              </div>
            </div>
          )}
          {runStatus && (
            <p
              className={`text-xs rounded-lg px-3 py-1.5 border break-words ${
                runStatus.success
                  ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                  : 'text-rose-700 bg-rose-50 border-rose-200 font-mono'
              }`}
              role="status"
            >
              {runStatus.success ? '✓ ' : '✗ '}
              {runStatus.message}
            </p>
          )}
        </div>
      </div>

      {/* Capture box */}
      <div className="px-4 pt-3">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') addSnippet();
            }}
            placeholder="Paste or type a snippet… (Ctrl+Enter to save)"
            rows={3}
            className="w-full resize-none bg-transparent px-3 py-2.5 text-sm rounded-xl focus:outline-none placeholder:text-slate-400"
          />
          <div className="flex items-center justify-between px-3 pb-2.5">
            <span className="text-xs text-slate-400">{draft.length ? `${draft.length} chars` : ''}</span>
            <button
              onClick={addSnippet}
              disabled={!draft.trim()}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium
                         hover:bg-indigo-700 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed
                         transition-all"
            >
              Save snippet
            </button>
          </div>
        </div>
        {error && (
          <p className="mt-2 text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-1.5">
            {error}
          </p>
        )}
      </div>

      {/* Search + filter */}
      <div className="px-4 pt-3 flex items-center gap-2 flex-wrap min-w-0">
        <div className="relative flex-1 min-w-[140px]">
          <svg viewBox="0 0 24 24" className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search snippets…"
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-slate-200 bg-white focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
          />
        </div>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden shrink-0">
          {(['all', 'recent'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                filter === f
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-100'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Snippet list */}
      <main className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5 min-h-0">
        {loading ? (
          <div className="space-y-2.5 animate-pulse">
            <div className="h-20 bg-slate-200 rounded-xl" />
            <div className="h-20 bg-slate-200 rounded-xl" />
            <div className="h-20 bg-slate-200 rounded-xl" />
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-10 text-slate-400">
            <svg viewBox="0 0 24 24" className="w-10 h-10 mb-3 opacity-50" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="6" y="4" width="12" height="17" rx="2" />
              <path d="M9 4a3 3 0 0 1 6 0" />
            </svg>
            <p className="text-sm font-medium text-slate-500">
              {snippets.length === 0 ? 'No snippets yet' : 'No matches found'}
            </p>
            <p className="text-xs mt-1 max-w-[220px]">
              {snippets.length === 0
                ? 'Paste text above and hit Save — your snippets live here, ready to re-run.'
                : 'Try a different search term or clear the filter.'}
            </p>
          </div>
        ) : (
          visible.map((s) => (
            <article
              key={s.id}
              className="group bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all"
            >
              {editingId === s.id ? (
                <div className="p-3">
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={3}
                    className="w-full text-sm border border-slate-200 rounded-lg p-2 focus:outline-none focus:border-indigo-400"
                  />
                  <div className="flex gap-2 mt-2 justify-end">
                    <button
                      onClick={() => { setEditingId(null); setEditText(''); }}
                      className="px-3 py-1 text-xs rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveEdit}
                      className="px-3 py-1 text-xs rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => copySnippet(s)}
                    className="w-full text-left p-3 focus:outline-none"
                    title="Click to copy"
                  >
                    <p className="text-sm whitespace-pre-wrap break-words line-clamp-3 max-h-[4.5rem] overflow-hidden">
                      {s.text}
                    </p>
                  </button>
                  <div className="flex items-center justify-between px-3 pb-2.5">
                    <span className="text-[11px] text-slate-400">{timeAgo(s.createdAt)}</span>
                    <div className="flex items-center gap-1">
                      {copiedId === s.id ? (
                        <span className="text-[11px] font-medium text-emerald-600 flex items-center gap-1">
                          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M5 13l4 4L19 7" />
                          </svg>
                          Copied!
                        </span>
                      ) : (
                        <>
                          <button
                            onClick={() => startEdit(s)}
                            className="text-[11px] px-2 py-0.5 rounded text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => deleteSnippet(s.id)}
                            className="text-[11px] px-2 py-0.5 rounded text-slate-500 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </>
              )}
            </article>
          ))
        )}
      </main>

      {/* Footer */}
      <footer className="px-4 py-2.5 border-t border-slate-200 bg-white flex items-center justify-between text-[11px] text-slate-400">
        <span>{snippets.length} snippet{snippets.length === 1 ? '' : 's'} stored locally</span>
        <span className="truncate">{targetLabel}</span>
      </footer>
    </div>
  );
};

export default SidePanel;