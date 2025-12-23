import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * Notes model used by the UI.
 * @typedef {{ id: string, title: string, content: string, updatedAt: string, createdAt: string }} Note
 */

/**
 * Derive API base URL from provided env vars.
 * Prefer REACT_APP_API_BASE; fallback to REACT_APP_BACKEND_URL; else empty (in-memory mode).
 */
function getApiBaseUrl() {
  const apiBase = (process.env.REACT_APP_API_BASE || "").trim();
  const backend = (process.env.REACT_APP_BACKEND_URL || "").trim();
  return apiBase || backend || "";
}

/**
 * Minimal fetch wrapper that:
 * - prefixes with API base
 * - provides consistent error handling
 */
async function apiRequest(path, options = {}) {
  const base = getApiBaseUrl();
  if (!base) {
    const err = new Error("API base URL is not configured");
    err.code = "NO_API_BASE";
    throw err;
  }

  const url = `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const contentType = res.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const message =
      (payload && typeof payload === "object" && (payload.detail || payload.message)) ||
      (typeof payload === "string" && payload) ||
      `Request failed: ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

/**
 * Local persistence (used for in-memory mode, and as a resilient cache).
 */
const STORAGE_KEY = "simple_notes_app__notes_v1";
const STORAGE_SELECTED_KEY = "simple_notes_app__selected_id_v1";

function loadNotesFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveNotesToStorage(notes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // ignore
  }
}

function loadSelectedIdFromStorage() {
  try {
    return localStorage.getItem(STORAGE_SELECTED_KEY) || "";
  } catch {
    return "";
  }
}

function saveSelectedIdToStorage(id) {
  try {
    if (id) localStorage.setItem(STORAGE_SELECTED_KEY, id);
    else localStorage.removeItem(STORAGE_SELECTED_KEY);
  } catch {
    // ignore
  }
}

/**
 * Create a stable, unique-ish id for local notes without dependencies.
 */
function makeId() {
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatRelativeTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 30) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d ago`;
  return d.toLocaleDateString();
}

function normalizeNoteFromApi(n) {
  // Try to accommodate common API shapes.
  // Expected: {id, title, content, updatedAt, createdAt} but tolerate snake_case.
  return {
    id: String(n.id ?? n.note_id ?? makeId()),
    title: String(n.title ?? ""),
    content: String(n.content ?? n.body ?? ""),
    createdAt: String(n.createdAt ?? n.created_at ?? new Date().toISOString()),
    updatedAt: String(n.updatedAt ?? n.updated_at ?? n.modified_at ?? new Date().toISOString()),
  };
}

/**
 * Attempt to load notes from a backend if available.
 * This function is intentionally tolerant: if the backend isn't there, UI still works with local mode.
 */
async function tryFetchNotesFromApi() {
  // Try a few common endpoints; accept whichever works.
  const candidates = ["/notes", "/api/notes"];
  let lastErr = null;

  for (const path of candidates) {
    try {
      const payload = await apiRequest(path, { method: "GET" });
      if (Array.isArray(payload)) return payload.map(normalizeNoteFromApi);
      if (payload && Array.isArray(payload.notes)) return payload.notes.map(normalizeNoteFromApi);
      return [];
    } catch (e) {
      lastErr = e;
    }
  }

  // If API base isn't configured, that's expected.
  if (lastErr && lastErr.code === "NO_API_BASE") return null;
  // API configured but not responding/compatible; treat as unavailable.
  return null;
}

async function tryCreateNoteApi(note) {
  const candidates = ["/notes", "/api/notes"];
  let lastErr = null;
  for (const path of candidates) {
    try {
      const payload = await apiRequest(path, {
        method: "POST",
        body: JSON.stringify({ title: note.title, content: note.content }),
      });
      if (payload && typeof payload === "object") return normalizeNoteFromApi(payload);
      return note;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr && lastErr.code === "NO_API_BASE") return null;
  return null;
}

async function tryUpdateNoteApi(id, patch) {
  const candidates = [`/notes/${encodeURIComponent(id)}`, `/api/notes/${encodeURIComponent(id)}`];
  let lastErr = null;
  for (const path of candidates) {
    try {
      const payload = await apiRequest(path, {
        method: "PUT",
        body: JSON.stringify({ title: patch.title, content: patch.content }),
      });
      if (payload && typeof payload === "object") return normalizeNoteFromApi(payload);
      return null;
    } catch (e) {
      lastErr = e;
    }
  }

  // Some APIs use PATCH
  const patchCandidates = [`/notes/${encodeURIComponent(id)}`, `/api/notes/${encodeURIComponent(id)}`];
  for (const path of patchCandidates) {
    try {
      const payload = await apiRequest(path, {
        method: "PATCH",
        body: JSON.stringify({ title: patch.title, content: patch.content }),
      });
      if (payload && typeof payload === "object") return normalizeNoteFromApi(payload);
      return null;
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastErr && lastErr.code === "NO_API_BASE") return null;
  return null;
}

async function tryDeleteNoteApi(id) {
  const candidates = [`/notes/${encodeURIComponent(id)}`, `/api/notes/${encodeURIComponent(id)}`];
  let lastErr = null;
  for (const path of candidates) {
    try {
      await apiRequest(path, { method: "DELETE" });
      return true;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr && lastErr.code === "NO_API_BASE") return null;
  return null;
}

// PUBLIC_INTERFACE
function App() {
  /** @type {[Note[], Function]} */
  const [notes, setNotes] = useState(() => {
    const existing = loadNotesFromStorage();
    // Seed with a friendly default if empty.
    if (!existing.length) {
      const now = new Date().toISOString();
      return [
        {
          id: makeId(),
          title: "Welcome to Simple Notes",
          content:
            "Create notes with a title and content.\n\n• Click a note in the sidebar to view/edit\n• Use the + button to create a new note\n• Your notes are saved locally in this browser",
          createdAt: now,
          updatedAt: now,
        },
      ];
    }
    return existing;
  });

  const [selectedId, setSelectedId] = useState(() => loadSelectedIdFromStorage() || "");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState({ kind: "idle", message: "" }); // {kind: idle|saving|saved|error|syncing}
  const [isDirty, setIsDirty] = useState(false);

  const selectedNote = useMemo(() => notes.find((n) => n.id === selectedId) || null, [notes, selectedId]);

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes.slice().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return notes
      .filter((n) => (n.title || "").toLowerCase().includes(q) || (n.content || "").toLowerCase().includes(q))
      .slice()
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }, [notes, query]);

  const editorTitleRef = useRef(null);
  const saveTimerRef = useRef(null);

  // Persist to local storage on change
  useEffect(() => {
    saveNotesToStorage(notes);
  }, [notes]);

  useEffect(() => {
    saveSelectedIdToStorage(selectedId);
  }, [selectedId]);

  // Ensure a selection exists
  useEffect(() => {
    if (!notes.length) {
      setSelectedId("");
      return;
    }
    if (selectedId && notes.some((n) => n.id === selectedId)) return;
    setSelectedId(notes[0].id);
  }, [notes, selectedId]);

  // Optional: try to sync from API on mount (non-blocking)
  useEffect(() => {
    let mounted = true;
    (async () => {
      setStatus({ kind: "syncing", message: "Syncing…" });
      const apiNotes = await tryFetchNotesFromApi();
      if (!mounted) return;

      if (apiNotes === null) {
        // API not available; keep local.
        setStatus({ kind: "idle", message: "" });
        return;
      }

      // Merge strategy: if API returns notes, prefer API as source of truth.
      setNotes(apiNotes);
      setStatus({ kind: "saved", message: "Synced" });
      window.setTimeout(() => mounted && setStatus({ kind: "idle", message: "" }), 900);
    })();

    return () => {
      mounted = false;
    };
  }, []);

  function setSavingState() {
    setStatus({ kind: "saving", message: "Saving…" });
  }

  function setSavedState() {
    setStatus({ kind: "saved", message: "Saved" });
    window.setTimeout(() => setStatus({ kind: "idle", message: "" }), 850);
  }

  function setErrorState(message) {
    setStatus({ kind: "error", message });
  }

  function updateSelectedNoteLocal(patch) {
    if (!selectedNote) return;
    const now = new Date().toISOString();
    setNotes((prev) =>
      prev.map((n) =>
        n.id === selectedNote.id
          ? {
              ...n,
              ...patch,
              updatedAt: now,
            }
          : n
      )
    );
  }

  async function flushSaveToApi(noteId) {
    const note = notes.find((n) => n.id === noteId);
    if (!note) return;

    setSavingState();
    const apiUpdated = await tryUpdateNoteApi(noteId, { title: note.title, content: note.content });
    if (apiUpdated === null) {
      // API not available; treat local save as successful.
      setSavedState();
      setIsDirty(false);
      return;
    }

    // If backend returns updated note, apply it (server may alter fields).
    setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, ...apiUpdated } : n)));
    setSavedState();
    setIsDirty(false);
  }

  function scheduleAutoSave(noteId) {
    setIsDirty(true);
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      flushSaveToApi(noteId).catch((e) => setErrorState(e.message || "Failed to save"));
    }, 650);
  }

  // PUBLIC_INTERFACE
  const handleNewNote = async () => {
    const now = new Date().toISOString();
    const local = {
      id: makeId(),
      title: "Untitled",
      content: "",
      createdAt: now,
      updatedAt: now,
    };

    // Optimistically add locally first
    setNotes((prev) => [local, ...prev]);
    setSelectedId(local.id);
    setQuery("");

    // Focus title editor
    window.setTimeout(() => {
      editorTitleRef.current?.focus?.();
      editorTitleRef.current?.select?.();
    }, 0);

    // Try create on API; if it works, reconcile IDs
    try {
      setStatus({ kind: "saving", message: "Creating…" });
      const created = await tryCreateNoteApi(local);
      if (created === null) {
        setSavedState();
        return;
      }

      // Replace local note with created note (may have different id)
      setNotes((prev) => prev.map((n) => (n.id === local.id ? created : n)));
      setSelectedId(created.id);
      setSavedState();
    } catch (e) {
      setErrorState(e.message || "Failed to create note");
    }
  };

  // PUBLIC_INTERFACE
  const handleDeleteSelected = async () => {
    if (!selectedNote) return;
    const ok = window.confirm(`Delete "${selectedNote.title || "Untitled"}"? This cannot be undone.`);
    if (!ok) return;

    const deleteId = selectedNote.id;

    // Optimistic UI removal
    setNotes((prev) => prev.filter((n) => n.id !== deleteId));
    setStatus({ kind: "saving", message: "Deleting…" });

    try {
      const deleted = await tryDeleteNoteApi(deleteId);
      if (deleted === null) {
        // API not available; local delete considered successful.
        setSavedState();
        return;
      }
      setSavedState();
    } catch (e) {
      // Rollback on error
      setNotes((prev) => [selectedNote, ...prev].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")));
      setSelectedId(deleteId);
      setErrorState(e.message || "Failed to delete note");
    }
  };

  // PUBLIC_INTERFACE
  const handleSelectNote = (id) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    setIsDirty(false);
    setSelectedId(id);
  };

  const apiConfigured = Boolean(getApiBaseUrl());

  return (
    <div className="NotesApp">
      <header className="Topbar" role="banner">
        <div className="Topbar-left">
          <div className="BrandMark" aria-hidden="true">
            <span className="BrandDot BrandDot--primary" />
            <span className="BrandDot BrandDot--success" />
          </div>
          <div className="BrandText">
            <div className="BrandTitle">Simple Notes</div>
            <div className="BrandSubtitle">Create • Edit • Organize</div>
          </div>
        </div>

        <nav className="Topbar-right" aria-label="App actions">
          <div className={`StatusPill StatusPill--${status.kind}`} role="status" aria-live="polite">
            {status.kind === "idle" ? (
              <>
                <span className="StatusDot" aria-hidden="true" />
                <span className="StatusText">{apiConfigured ? "Ready" : "Local mode"}</span>
              </>
            ) : (
              <>
                <span className="StatusDot" aria-hidden="true" />
                <span className="StatusText">{status.message}</span>
              </>
            )}
          </div>

          <button className="Btn Btn--ghost" type="button" onClick={handleNewNote}>
            New note
          </button>

          <button
            className="Btn Btn--danger"
            type="button"
            onClick={handleDeleteSelected}
            disabled={!selectedNote}
            aria-disabled={!selectedNote}
          >
            Delete
          </button>
        </nav>
      </header>

      <div className="Shell">
        <aside className="Sidebar" aria-label="Notes list">
          <div className="SidebarHeader">
            <label className="Search" aria-label="Search notes">
              <span className="SearchIcon" aria-hidden="true">
                ⌕
              </span>
              <input
                className="SearchInput"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search notes…"
              />
            </label>
          </div>

          <div className="SidebarList" role="list">
            {filteredNotes.length === 0 ? (
              <div className="EmptyState">
                <div className="EmptyTitle">No notes found</div>
                <div className="EmptyDesc">Try a different search, or create a new note.</div>
                <button className="Btn Btn--primary Btn--full" type="button" onClick={handleNewNote}>
                  Create note
                </button>
              </div>
            ) : (
              filteredNotes.map((n) => {
                const active = n.id === selectedId;
                const preview = (n.content || "").replace(/\s+/g, " ").trim();
                return (
                  <button
                    key={n.id}
                    className={`NoteItem ${active ? "NoteItem--active" : ""}`}
                    type="button"
                    onClick={() => handleSelectNote(n.id)}
                    role="listitem"
                  >
                    <div className="NoteItemTitleRow">
                      <div className="NoteItemTitle">{n.title || "Untitled"}</div>
                      <div className="NoteItemTime">{formatRelativeTime(n.updatedAt)}</div>
                    </div>
                    <div className="NoteItemPreview">{preview ? preview.slice(0, 80) : "No content"}</div>
                  </button>
                );
              })
            )}
          </div>

          <div className="SidebarFooter">
            <div className="Hint">
              {apiConfigured ? (
                <>
                  API: <span className="Mono">{getApiBaseUrl()}</span>
                </>
              ) : (
                <>Tip: configure <span className="Mono">REACT_APP_API_BASE</span> to enable backend sync.</>
              )}
            </div>
          </div>
        </aside>

        <main className="Main" aria-label="Note editor">
          {!selectedNote ? (
            <div className="MainEmpty">
              <div className="MainEmptyCard">
                <div className="MainEmptyTitle">Select a note</div>
                <div className="MainEmptyDesc">Choose a note from the sidebar, or create a new one.</div>
                <button className="Btn Btn--primary" type="button" onClick={handleNewNote}>
                  New note
                </button>
              </div>
            </div>
          ) : (
            <div className="Editor">
              <div className="EditorHeader">
                <div className="EditorMeta">
                  <div className="EditorMetaRow">
                    <span className="MetaLabel">Last updated</span>
                    <span className="MetaValue">{new Date(selectedNote.updatedAt).toLocaleString()}</span>
                  </div>
                  {isDirty ? <div className="DirtyBadge">Unsaved changes</div> : null}
                </div>

                <div className="EditorActions">
                  <button
                    className="Btn Btn--secondary"
                    type="button"
                    onClick={() => flushSaveToApi(selectedNote.id).catch((e) => setErrorState(e.message || "Failed to save"))}
                  >
                    Save
                  </button>
                </div>
              </div>

              <div className="EditorBody">
                <label className="Field">
                  <span className="FieldLabel">Title</span>
                  <input
                    ref={editorTitleRef}
                    className="Input"
                    type="text"
                    value={selectedNote.title}
                    onChange={(e) => {
                      updateSelectedNoteLocal({ title: e.target.value });
                      scheduleAutoSave(selectedNote.id);
                    }}
                    placeholder="Untitled"
                  />
                </label>

                <label className="Field Field--grow">
                  <span className="FieldLabel">Content</span>
                  <textarea
                    className="Textarea"
                    value={selectedNote.content}
                    onChange={(e) => {
                      updateSelectedNoteLocal({ content: e.target.value });
                      scheduleAutoSave(selectedNote.id);
                    }}
                    placeholder="Write your note…"
                  />
                </label>
              </div>

              {status.kind === "error" ? (
                <div className="ErrorBanner" role="alert">
                  <div className="ErrorTitle">Something went wrong</div>
                  <div className="ErrorMessage">{status.message}</div>
                </div>
              ) : null}
            </div>
          )}
        </main>
      </div>

      <button className="Fab" type="button" onClick={handleNewNote} aria-label="Add new note">
        <span className="FabPlus" aria-hidden="true">
          +
        </span>
      </button>
    </div>
  );
}

export default App;
