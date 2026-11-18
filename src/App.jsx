import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  BookmarkCheck,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Command,
  FileText,
  Folder,
  FolderOpen,
  GitFork,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  SlidersHorizontal,
  Sun,
  X,
} from 'lucide-react';
import './obsidian.css';
import Reader, { RightInspector } from './Reader.jsx';
import GraphView from './GraphView.jsx';

const PREFS_KEY = 'obsidian-web-prefs-v1';
const BOOKMARKS_PREFIX = 'obsidian-web-bookmarks-';

const DEFAULT_PREFS = {
  theme: 'dark',
  fontSize: 16,
  fontFamily: 'sans',
  readableWidth: true,
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

function encodePathSegments(relPath) {
  return relPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return { vaultId: null, notePath: null, isGraph: false };
  const parts = raw.split('/');
  const vaultId = decodeURIComponent(parts[0] || '');
  if (!vaultId) return { vaultId: null, notePath: null, isGraph: false };
  const rest = parts.slice(1).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const joined = rest.join('/');
  if (!joined || joined === '__graph__') {
    return { vaultId, notePath: null, isGraph: true };
  }
  return { vaultId, notePath: joined, isGraph: false };
}

function updateHash(vaultId, tab) {
  if (!vaultId) {
    window.history.replaceState(null, '', '#/');
    return;
  }
  if (!tab || tab.type === 'graph') {
    window.history.replaceState(null, '', `#/${encodeURIComponent(vaultId)}/__graph__`);
    return;
  }
  window.history.replaceState(
    null,
    '',
    `#/${encodeURIComponent(vaultId)}/${encodePathSegments(tab.path)}`
  );
}

function collectAllFolderPaths(nodes, acc = []) {
  for (const node of nodes) {
    if (node.type === 'folder') {
      acc.push(node.path);
      if (node.children) collectAllFolderPaths(node.children, acc);
    }
  }
  return acc;
}

function renderHighlightedText(text, query) {
  if (!query || query.startsWith('#')) return text;
  const q = query.trim();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="obs-highlight">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

function TreeNode({ node, expanded, onToggle, activePath, onSelectNote }) {
  if (node.type === 'folder') {
    const isOpen = expanded.has(node.path);
    return (
      <li>
        <div className="obs-tree-row" onClick={() => onToggle(node.path)}>
          <span className={`obs-tree-chevron ${isOpen ? 'is-open' : ''}`}>
            <ChevronRight size={13} />
          </span>
          {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span className="obs-tree-label">{node.name}</span>
        </div>
        {isOpen && node.children?.length > 0 && (
          <ul className="obs-tree obs-tree-children">
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                expanded={expanded}
                onToggle={onToggle}
                activePath={activePath}
                onSelectNote={onSelectNote}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isActive = activePath === node.path;
  return (
    <li>
      <div
        className={`obs-tree-row ${isActive ? 'is-active' : ''}`}
        onClick={(e) => onSelectNote(node.path, null, e.ctrlKey || e.metaKey)}
        onAuxClick={(e) => {
          if (e.button === 1) onSelectNote(node.path, null, true);
        }}
        title={node.path}
      >
        <span style={{ width: 14, flexShrink: 0 }} />
        <FileText size={14} style={{ flexShrink: 0, opacity: 0.75 }} />
        <span className="obs-tree-label">{node.name}</span>
      </div>
    </li>
  );
}

function App() {
  const [manifest, setManifest] = useState(null);
  const [manifestError, setManifestError] = useState(null);
  const [activeVaultId, setActiveVaultId] = useState(null);
  const [vaultIndex, setVaultIndex] = useState(null);
  const [loadingVault, setLoadingVault] = useState(false);

  const [prefs, setPrefs] = useState(loadPrefs);
  const [showSettings, setShowSettings] = useState(false);
  const [showQuickSwitcher, setShowQuickSwitcher] = useState(false);

  const isMobileInit = typeof window !== 'undefined' && window.innerWidth <= 768;
  const [leftOpen, setLeftOpen] = useState(!isMobileInit);
  const [leftTab, setLeftTab] = useState('files');
  const [rightOpen, setRightOpen] = useState(false);
  const [rightTab, setRightTab] = useState('outline');

  const [expandedFolders, setExpandedFolders] = useState(() => new Set());
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  const [noteData, setNoteData] = useState(null);
  const [loadingNote, setLoadingNote] = useState(false);
  const [targetHeading, setTargetHeading] = useState(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchCorpus, setSearchCorpus] = useState(null);
  const [bookmarks, setBookmarks] = useState([]);

  const noteCacheRef = useRef(new Map());
  const settingsRef = useRef(null);
  const searchInputRef = useRef(null);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) || null,
    [tabs, activeTabId]
  );

  const activeNotePath = activeTab?.type === 'note' ? activeTab.path : null;

  // Apply reading preferences to document CSS variables
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // ignore storage errors
    }
    const root = document.documentElement;
    root.setAttribute('data-theme', prefs.theme);
    root.style.setProperty('--reader-font-size', `${prefs.fontSize}px`);
    const fontMap = {
      sans: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
      mono: '"JetBrains Mono", "Fira Code", Consolas, Monaco, monospace',
    };
    root.style.setProperty('--reader-font-family', fontMap[prefs.fontFamily] || fontMap.sans);
  }, [prefs]);

  // Close reading popover when clicking outside
  useEffect(() => {
    if (!showSettings) return;
    function onDocClick(e) {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setShowSettings(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showSettings]);

  // Global keyboard shortcut: Ctrl/Cmd + K or Ctrl/Cmd + O for Quick Switcher
  useEffect(() => {
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'o')) {
        if (!vaultIndex) return;
        e.preventDefault();
        setShowQuickSwitcher((prev) => !prev);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [vaultIndex]);

  // Load manifest on startup
  useEffect(() => {
    fetch('./vault-data/manifest.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setManifest(data);
        const hash = parseHash();
        const available = data.vaults || [];
        if (hash.vaultId && available.some((v) => v.id === hash.vaultId)) {
          setActiveVaultId(hash.vaultId);
        } else if (available.length === 1) {
          setActiveVaultId(available[0].id);
        }
      })
      .catch((err) => setManifestError(err.message));
  }, []);

  // Load selected vault index
  useEffect(() => {
    if (!activeVaultId) {
      setVaultIndex(null);
      setTabs([]);
      setActiveTabId(null);
      setNoteData(null);
      return;
    }

    let cancelled = false;
    setLoadingVault(true);
    noteCacheRef.current.clear();
    setSearchCorpus(null);
    setSearchQuery('');

    try {
      const savedBm = localStorage.getItem(BOOKMARKS_PREFIX + activeVaultId);
      setBookmarks(savedBm ? JSON.parse(savedBm) : []);
    } catch {
      setBookmarks([]);
    }

    fetch(`./vault-data/${encodeURIComponent(activeVaultId)}/index.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load vault "${activeVaultId}"`);
        return res.json();
      })
      .then((idx) => {
        if (cancelled) return;
        setVaultIndex(idx);
        setExpandedFolders(new Set());

        const hash = parseHash();
        let initialTab = { id: 'tab-graph', type: 'graph', title: 'Graph view' };

        if (hash.vaultId === activeVaultId && hash.notePath) {
          const found = idx.notes.find((n) => n.path === hash.notePath);
          if (found) {
            initialTab = {
              id: `tab-${Date.now()}`,
              type: 'note',
              path: found.path,
              title: found.title,
            };
          }
        }

        setTabs([initialTab]);
        setActiveTabId(initialTab.id);
        setHistory([initialTab]);
        setHistoryIdx(0);
        updateHash(activeVaultId, initialTab);
        document.title = `${idx.name} — Obsidian Web`;
      })
      .catch((err) => {
        if (!cancelled) setManifestError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingVault(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeVaultId]);

  // Fetch a note JSON payload (cached)
  const fetchNote = useCallback(
    async (notePath) => {
      if (!activeVaultId || !notePath) return null;
      if (noteCacheRef.current.has(notePath)) {
        return noteCacheRef.current.get(notePath);
      }
      const url = `./vault-data/${encodeURIComponent(activeVaultId)}/notes/${encodePathSegments(
        notePath
      )}.json`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not load note ${notePath}`);
      const json = await res.json();
      noteCacheRef.current.set(notePath, json);
      return json;
    },
    [activeVaultId]
  );

  // Load note content whenever active note tab changes
  useEffect(() => {
    if (!activeNotePath) {
      setNoteData(null);
      return;
    }
    let cancelled = false;
    setLoadingNote(true);
    fetchNote(activeNotePath)
      .then((data) => {
        if (!cancelled) setNoteData(data);
      })
      .catch(() => {
        if (!cancelled) setNoteData(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingNote(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeNotePath, fetchNote]);

  // Lazy-load full-text search index when Search tab is opened
  useEffect(() => {
    if (!activeVaultId || leftTab !== 'search' || searchCorpus) return;
    fetch(`./vault-data/${encodeURIComponent(activeVaultId)}/search.json`)
      .then((res) => res.json())
      .then((data) => setSearchCorpus(data))
      .catch(() => {});
  }, [activeVaultId, leftTab, searchCorpus]);

  // Sync URL hash when active tab changes
  useEffect(() => {
    if (activeVaultId && activeTab) {
      updateHash(activeVaultId, activeTab);
    }
  }, [activeVaultId, activeTab]);

  // Expand parent folders so active note is visible in File Explorer
  const revealPathInTree = useCallback((notePath) => {
    const parts = notePath.split('/');
    if (parts.length <= 1) return;
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      for (let i = 1; i < parts.length; i++) {
        next.add(parts.slice(0, i).join('/'));
      }
      return next;
    });
  }, []);

  const pushHistoryEntry = useCallback(
    (tabSnapshot) => {
      setHistory((prev) => [...prev.slice(0, historyIdx + 1), tabSnapshot]);
      setHistoryIdx((prev) => prev + 1);
    },
    [historyIdx]
  );

  const openNote = useCallback(
    (notePath, headingSlug = null, newTab = false) => {
      if (!vaultIndex) return;
      const meta = vaultIndex.notes.find((n) => n.path === notePath);
      if (!meta) return;

      revealPathInTree(notePath);
      setTargetHeading(headingSlug ? `${headingSlug}::${Date.now()}` : null);
      if (window.innerWidth <= 768) setLeftOpen(false);

      const existing = tabs.find((t) => t.type === 'note' && t.path === notePath);
      if (existing && !newTab) {
        setActiveTabId(existing.id);
        pushHistoryEntry(existing);
        return;
      }

      const freshTab = {
        id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'note',
        path: meta.path,
        title: meta.title,
      };

      if (newTab || !activeTab || activeTab.type === 'graph') {
        setTabs((prev) => [...prev, freshTab]);
      } else {
        setTabs((prev) => prev.map((t) => (t.id === activeTab.id ? freshTab : t)));
      }
      setActiveTabId(freshTab.id);
      pushHistoryEntry(freshTab);
    },
    [vaultIndex, tabs, activeTab, revealPathInTree, pushHistoryEntry]
  );

  const openGraphTab = useCallback(
    (newTab = false) => {
      const existing = tabs.find((t) => t.type === 'graph');
      if (existing && !newTab) {
        setActiveTabId(existing.id);
        pushHistoryEntry(existing);
        return;
      }
      const graphTab = { id: `tab-graph-${Date.now()}`, type: 'graph', title: 'Graph view' };
      setTabs((prev) => [...prev, graphTab]);
      setActiveTabId(graphTab.id);
      pushHistoryEntry(graphTab);
    },
    [tabs, pushHistoryEntry]
  );

  const closeTab = useCallback(
    (tabId, e) => {
      e?.stopPropagation();
      setTabs((prev) => {
        if (prev.length <= 1) return prev;
        const idx = prev.findIndex((t) => t.id === tabId);
        const filtered = prev.filter((t) => t.id !== tabId);
        if (tabId === activeTabId) {
          const fallback = filtered[Math.max(0, idx - 1)] || filtered[0];
          setActiveTabId(fallback.id);
        }
        return filtered;
      });
    },
    [activeTabId]
  );

  const goBack = () => {
    if (historyIdx <= 0) return;
    const prevEntry = history[historyIdx - 1];
    setHistoryIdx(historyIdx - 1);
    const match = tabs.find((t) =>
      prevEntry.type === 'graph' ? t.type === 'graph' : t.path === prevEntry.path
    );
    if (match) {
      setActiveTabId(match.id);
    } else {
      setTabs((prev) => [...prev, prevEntry]);
      setActiveTabId(prevEntry.id);
    }
  };

  const goForward = () => {
    if (historyIdx >= history.length - 1) return;
    const nextEntry = history[historyIdx + 1];
    setHistoryIdx(historyIdx + 1);
    const match = tabs.find((t) =>
      nextEntry.type === 'graph' ? t.type === 'graph' : t.path === nextEntry.path
    );
    if (match) {
      setActiveTabId(match.id);
    } else {
      setTabs((prev) => [...prev, nextEntry]);
      setActiveTabId(nextEntry.id);
    }
  };

  const toggleFolder = (folderPath) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  const toggleExpandAll = () => {
    if (!vaultIndex) return;
    const allFolders = collectAllFolderPaths(vaultIndex.tree);
    if (expandedFolders.size >= allFolders.length && allFolders.length > 0) {
      setExpandedFolders(new Set());
    } else {
      setExpandedFolders(new Set(allFolders));
    }
  };

  const toggleBookmark = (notePath) => {
    if (!activeVaultId || !notePath) return;
    setBookmarks((prev) => {
      const next = prev.includes(notePath)
        ? prev.filter((p) => p !== notePath)
        : [...prev, notePath];
      try {
        localStorage.setItem(BOOKMARKS_PREFIX + activeVaultId, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const handleSearchTag = (tag) => {
    setLeftOpen(true);
    setLeftTab('search');
    setSearchQuery(`#${tag}`);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  };

  // Search computation
  const searchResults = useMemo(() => {
    if (!vaultIndex) return [];
    const rawQ = searchQuery.trim();
    if (!rawQ) return [];

    // Tag query (#subject-hub)
    if (rawQ.startsWith('#')) {
      const tagNeedle = rawQ.slice(1).toLowerCase();
      return vaultIndex.notes
        .filter((n) => n.tags.some((t) => t.toLowerCase().includes(tagNeedle)))
        .slice(0, 60)
        .map((n) => ({
          path: n.path,
          title: n.title,
          folder: n.folder,
          snippet: n.tags.map((t) => `#${t}`).join('  '),
        }));
    }

    const needle = rawQ.toLowerCase();
    const corpus = searchCorpus || vaultIndex.notes.map((n) => ({ ...n, text: n.excerpt }));
    const results = [];

    for (const item of corpus) {
      const titleHit = item.title.toLowerCase().includes(needle);
      const bodyLower = (item.text || '').toLowerCase();
      const bodyIdx = bodyLower.indexOf(needle);

      if (!titleHit && bodyIdx === -1) continue;

      let snippet = '';
      if (bodyIdx !== -1) {
        const start = Math.max(0, bodyIdx - 55);
        const end = Math.min(item.text.length, bodyIdx + needle.length + 95);
        snippet =
          (start > 0 ? '...' : '') +
          item.text.slice(start, end) +
          (end < item.text.length ? '...' : '');
      } else {
        snippet = (item.text || '').slice(0, 140);
      }

      results.push({
        path: item.path,
        title: item.title,
        folder: item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '',
        snippet,
        score: titleHit ? 2 : 1,
      });
    }

    results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return results.slice(0, 60);
  }, [vaultIndex, searchQuery, searchCorpus]);

  const activeNoteMeta = useMemo(() => {
    if (!vaultIndex || !activeNotePath) return null;
    return vaultIndex.notes.find((n) => n.path === activeNotePath) || null;
  }, [vaultIndex, activeNotePath]);

  const isBookmarked = activeNotePath ? bookmarks.includes(activeNotePath) : false;

  // 1. Loading / Error / Multi-Vault Hub states
  if (manifestError) {
    return (
      <div className="obs-vault-hub">
        <div className="obs-vault-hub-header">
          <h1 className="obs-vault-hub-title">Could not load vault index</h1>
          <p className="obs-vault-hub-sub">{manifestError}</p>
        </div>
      </div>
    );
  }

  if (!manifest || loadingVault) {
    return (
      <div className="obs-vault-hub">
        <p className="obs-vault-hub-sub">Loading vault...</p>
      </div>
    );
  }

  const vaultsList = manifest.vaults || [];

  if (!activeVaultId) {
    return (
      <div className="obs-vault-hub">
        <div className="obs-vault-hub-header">
          <h1 className="obs-vault-hub-title">Obsidian Web Vaults</h1>
          <p className="obs-vault-hub-sub">
            {vaultsList.length === 0
              ? 'No vaults found yet. Place your Obsidian vault folder inside vaults/ and push to GitHub.'
              : 'Select a vault to open'}
          </p>
        </div>
        {vaultsList.length > 0 && (
          <div className="obs-vault-grid">
            {vaultsList.map((v) => (
              <button
                key={v.id}
                className="obs-vault-card"
                onClick={() => setActiveVaultId(v.id)}
              >
                <div className="obs-vault-card-name">{v.name}</div>
                <div className="obs-vault-card-meta">
                  {v.noteCount} notes · {v.assetCount} attachments
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const allFoldersCount = vaultIndex ? collectAllFolderPaths(vaultIndex.tree).length : 0;

  return (
    <div className="obs-app">
      <div className="obs-workspace">
        {/* Mobile drawer backdrop */}
        {(leftOpen || rightOpen) && (
          <div
            className="obs-mobile-backdrop"
            onClick={() => {
              setLeftOpen(false);
              setRightOpen(false);
            }}
          />
        )}

        {/* LEFT SIDEBAR */}
        {leftOpen && (
          <aside className="obs-sidebar obs-sidebar--left">
            <div className="obs-sidebar-tabs">
              <div className="obs-sidebar-tab-group">
                <button
                  className={`obs-icon-btn ${leftTab === 'files' ? 'is-active' : ''}`}
                  onClick={() => setLeftTab('files')}
                  title="Files"
                >
                  <Folder size={15} />
                </button>
                <button
                  className={`obs-icon-btn ${leftTab === 'search' ? 'is-active' : ''}`}
                  onClick={() => {
                    setLeftTab('search');
                    setTimeout(() => searchInputRef.current?.focus(), 40);
                  }}
                  title="Search"
                >
                  <Search size={15} />
                </button>
                <button
                  className={`obs-icon-btn ${leftTab === 'bookmarks' ? 'is-active' : ''}`}
                  onClick={() => setLeftTab('bookmarks')}
                  title="Bookmarks"
                >
                  <Bookmark size={15} />
                </button>
              </div>
              <button
                className="obs-icon-btn"
                onClick={() => setLeftOpen(false)}
                title="Collapse sidebar"
              >
                <PanelLeft size={15} />
              </button>
            </div>

            {leftTab === 'files' && (
              <>
                <div className="obs-sidebar-toolbar">
                  <button
                    className="obs-icon-btn"
                    onClick={() => openGraphTab(false)}
                    title="Open graph view"
                  >
                    <GitFork size={15} />
                  </button>
                  <button
                    className="obs-icon-btn"
                    onClick={toggleExpandAll}
                    title={
                      expandedFolders.size >= allFoldersCount
                        ? 'Collapse all folders'
                        : 'Expand all folders'
                    }
                  >
                    {expandedFolders.size >= allFoldersCount && allFoldersCount > 0 ? (
                      <ChevronsDownUp size={15} />
                    ) : (
                      <ChevronsUpDown size={15} />
                    )}
                  </button>
                  <button
                    className="obs-icon-btn"
                    onClick={() => setShowQuickSwitcher(true)}
                    title="Quick switcher (Ctrl+K)"
                  >
                    <Command size={15} />
                  </button>
                </div>
                <div className="obs-sidebar-body">
                  {vaultIndex && (
                    <ul className="obs-tree">
                      {vaultIndex.tree.map((node) => (
                        <TreeNode
                          key={node.path}
                          node={node}
                          expanded={expandedFolders}
                          onToggle={toggleFolder}
                          activePath={activeNotePath}
                          onSelectNote={openNote}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}

            {leftTab === 'search' && (
              <div className="obs-sidebar-body">
                <div className="obs-search-box">
                  <Search size={13} color="var(--text-faint)" />
                  <input
                    ref={searchInputRef}
                    className="obs-search-input"
                    placeholder="Search notes or #tag..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button
                      className="obs-icon-btn"
                      style={{ width: 18, height: 18 }}
                      onClick={() => setSearchQuery('')}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>

                {searchQuery.trim() && (
                  <div className="obs-search-meta">{searchResults.length} result(s)</div>
                )}

                {searchResults.map((res) => (
                  <div
                    key={res.path}
                    className="obs-search-card"
                    onClick={(e) => openNote(res.path, null, e.ctrlKey || e.metaKey)}
                  >
                    <div className="obs-search-title">
                      {renderHighlightedText(res.title, searchQuery)}
                    </div>
                    {res.folder && <div className="obs-search-path">{res.folder}</div>}
                    {res.snippet && (
                      <div className="obs-search-snippet">
                        {renderHighlightedText(res.snippet, searchQuery)}
                      </div>
                    )}
                  </div>
                ))}

                {!searchQuery.trim() && (
                  <div className="obs-empty-hint">
                    Type any keyword to search all {vaultIndex?.notes.length || 0} notes, or start
                    with # to filter by tag.
                  </div>
                )}
              </div>
            )}

            {leftTab === 'bookmarks' && (
              <div className="obs-sidebar-body">
                <div className="obs-sidebar-heading">Bookmarks</div>
                {bookmarks.length === 0 ? (
                  <div className="obs-empty-hint">
                    No bookmarks yet. Click the bookmark icon in the top bar while reading a note to
                    save it here.
                  </div>
                ) : (
                  bookmarks.map((bmPath) => {
                    const meta = vaultIndex?.notes.find((n) => n.path === bmPath);
                    if (!meta) return null;
                    return (
                      <div
                        key={bmPath}
                        className={`obs-tree-row ${activeNotePath === bmPath ? 'is-active' : ''}`}
                        style={{ justifyContent: 'space-between' }}
                        onClick={() => openNote(bmPath)}
                      >
                        <span
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            minWidth: 0,
                          }}
                        >
                          <BookmarkCheck size={13} color="var(--text-accent)" />
                          <span className="obs-tree-label">{meta.title}</span>
                        </span>
                        <button
                          className="obs-icon-btn"
                          style={{ width: 20, height: 20 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleBookmark(bmPath);
                          }}
                          title="Remove bookmark"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </aside>
        )}

        {/* MAIN CENTER WORKSPACE */}
        <main className="obs-main">
          {/* Top Tab Bar */}
          <div className="obs-tab-bar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1 }}>
              {!leftOpen && (
                <button
                  className="obs-icon-btn"
                  style={{ marginBottom: 4 }}
                  onClick={() => setLeftOpen(true)}
                  title="Expand left sidebar"
                >
                  <PanelLeft size={15} />
                </button>
              )}

              <div className="obs-tabs-scroll">
                {tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={`obs-tab ${tab.id === activeTabId ? 'is-active' : ''}`}
                    onClick={() => setActiveTabId(tab.id)}
                    title={tab.path || tab.title}
                  >
                    {tab.type === 'graph' ? (
                      <GitFork size={13} style={{ flexShrink: 0 }} />
                    ) : (
                      <FileText size={13} style={{ flexShrink: 0 }} />
                    )}
                    <span className="obs-tab-title">{tab.title}</span>
                    {tabs.length > 1 && (
                      <button
                        className="obs-tab-close"
                        onClick={(e) => closeTab(tab.id, e)}
                        title="Close tab"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  className="obs-icon-btn"
                  style={{ marginBottom: 3 }}
                  onClick={() => setShowQuickSwitcher(true)}
                  title="Open note (Ctrl+K)"
                >
                  <Plus size={15} />
                </button>
              </div>
            </div>

            <div className="obs-tab-actions">
              <button
                className="obs-icon-btn"
                onClick={() => openGraphTab(false)}
                title="Open graph view"
              >
                <GitFork size={15} />
              </button>
              <button
                className={`obs-icon-btn ${rightOpen ? 'is-active' : ''}`}
                onClick={() => setRightOpen((o) => !o)}
                title="Toggle right sidebar"
              >
                <PanelRight size={15} />
              </button>
            </div>
          </div>

          {/* View Header / Breadcrumbs */}
          <div className="obs-view-header">
            <div className="obs-view-nav">
              <button
                className="obs-icon-btn"
                disabled={historyIdx <= 0}
                onClick={goBack}
                title="Navigate back"
              >
                <ArrowLeft size={15} />
              </button>
              <button
                className="obs-icon-btn"
                disabled={historyIdx >= history.length - 1}
                onClick={goForward}
                title="Navigate forward"
              >
                <ArrowRight size={15} />
              </button>

              <div className="obs-breadcrumbs">
                {activeTab?.type === 'graph' ? (
                  <span className="obs-crumb-current">Graph view</span>
                ) : activeNoteMeta ? (
                  <>
                    {activeNoteMeta.folder && (
                      <>
                        <span className="obs-crumb-folder">
                          {activeNoteMeta.folder.split('/').join(' / ')}
                        </span>
                        <span className="obs-crumb-sep">/</span>
                      </>
                    )}
                    <span className="obs-crumb-current">{activeNoteMeta.title}</span>
                  </>
                ) : null}
              </div>
            </div>

            <div className="obs-view-tools" ref={settingsRef}>
              {activeNotePath && (
                <button
                  className={`obs-icon-btn ${isBookmarked ? 'is-active' : ''}`}
                  onClick={() => toggleBookmark(activeNotePath)}
                  title={isBookmarked ? 'Remove bookmark' : 'Bookmark this note'}
                >
                  {isBookmarked ? (
                    <BookmarkCheck size={15} color="var(--text-accent)" />
                  ) : (
                    <Bookmark size={15} />
                  )}
                </button>
              )}

              <button
                className={`obs-icon-btn ${showSettings ? 'is-active' : ''}`}
                onClick={() => setShowSettings((s) => !s)}
                title="Reading appearance & font size"
              >
                <SlidersHorizontal size={15} />
              </button>

              {showSettings && (
                <div className="obs-popover">
                  <div className="obs-popover-title">Reading Comfort</div>

                  <div className="obs-slider-row">
                    <div className="obs-slider-head">
                      <span>Font size</span>
                      <strong>{prefs.fontSize}px</strong>
                    </div>
                    <input
                      type="range"
                      min={12}
                      max={24}
                      step={1}
                      value={prefs.fontSize}
                      onChange={(e) =>
                        setPrefs((p) => ({ ...p, fontSize: Number(e.target.value) }))
                      }
                    />
                  </div>

                  <div className="obs-slider-row">
                    <span>Font family</span>
                    <div className="obs-seg-control">
                      {[
                        { id: 'sans', label: 'Sans' },
                        { id: 'serif', label: 'Serif' },
                        { id: 'mono', label: 'Mono' },
                      ].map((opt) => (
                        <button
                          key={opt.id}
                          className={`obs-seg-btn ${prefs.fontFamily === opt.id ? 'is-active' : ''}`}
                          onClick={() => setPrefs((p) => ({ ...p, fontFamily: opt.id }))}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="obs-toggle-row">
                    <span>Readable line length</span>
                    <input
                      type="checkbox"
                      checked={prefs.readableWidth}
                      onChange={(e) =>
                        setPrefs((p) => ({ ...p, readableWidth: e.target.checked }))
                      }
                    />
                  </label>

                  <div
                    className="obs-toggle-row"
                    onClick={() =>
                      setPrefs((p) => ({ ...p, theme: p.theme === 'dark' ? 'light' : 'dark' }))
                    }
                  >
                    <span>Theme</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      {prefs.theme === 'dark' ? <Moon size={13} /> : <Sun size={13} />}
                      {prefs.theme === 'dark' ? 'Dark' : 'Light'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Active Pane Content */}
          <div className="obs-pane-content">
            {activeTab?.type === 'graph' && vaultIndex ? (
              <GraphView
                vaultIndex={vaultIndex}
                mode="global"
                activeNotePath={activeNotePath}
                onSelectNote={(path, newTab) => openNote(path, null, newTab)}
              />
            ) : (
              <Reader
                vaultIndex={vaultIndex}
                noteData={noteData}
                loading={loadingNote}
                readableWidth={prefs.readableWidth}
                targetHeading={targetHeading}
                fetchNote={fetchNote}
                onNavigateNote={openNote}
                onSearchTag={handleSearchTag}
              />
            )}
          </div>
        </main>

        {/* RIGHT SIDEBAR INSPECTOR */}
        {rightOpen && vaultIndex && (
          <RightInspector
            vaultIndex={vaultIndex}
            activeNotePath={activeNotePath}
            noteData={noteData}
            rightTab={rightTab}
            setRightTab={setRightTab}
            onClose={() => setRightOpen(false)}
            onNavigateNote={openNote}
            onSearchTag={handleSearchTag}
          />
        )}
      </div>

      {/* BOTTOM STATUS BAR */}
      <footer className="obs-status-bar">
        <div className="obs-status-left">
          <button
            className="obs-status-btn"
            onClick={() => {
              if (vaultsList.length > 1) {
                setActiveVaultId(null);
                updateHash(null, null);
              } else {
                setShowQuickSwitcher(true);
              }
            }}
            title={
              vaultsList.length > 1
                ? 'Switch vault'
                : `${vaultIndex?.name || activeVaultId} (${vaultIndex?.notes.length || 0} notes)`
            }
          >
            <ChevronsUpDown size={12} />
            <span>{vaultIndex?.name || activeVaultId}</span>
          </button>
        </div>

        <div className="obs-status-right">
          {activeNoteMeta ? (
            <>
              <button
                className="obs-status-btn"
                onClick={() => {
                  setRightOpen(true);
                  setRightTab('backlinks');
                }}
                title="Open backlinks panel"
              >
                {activeNoteMeta.backlinkCount} backlinks
              </button>
              <button
                className="obs-status-btn"
                onClick={() => {
                  setRightOpen(true);
                  setRightTab('outline');
                }}
                title="Open outline panel"
              >
                Outline
              </button>
              <span>{activeNoteMeta.wordCount.toLocaleString()} words</span>
              <span>{activeNoteMeta.charCount.toLocaleString()} characters</span>
            </>
          ) : (
            <span>{vaultIndex?.notes.length || 0} notes in graph</span>
          )}
        </div>
      </footer>

      {/* QUICK SWITCHER MODAL (Ctrl+K) */}
      {showQuickSwitcher && vaultIndex && (
        <QuickSwitcherModal
          notes={vaultIndex.notes}
          onClose={() => setShowQuickSwitcher(false)}
          onSelect={(path, newTab) => {
            setShowQuickSwitcher(false);
            openNote(path, null, newTab);
          }}
          onOpenGraph={() => {
            setShowQuickSwitcher(false);
            openGraphTab(false);
          }}
        />
      )}
    </div>
  );
}

function QuickSwitcherModal({ notes, onClose, onSelect, onOpenGraph }) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes.slice(0, 30);
    return notes
      .map((n) => {
        const titleLow = n.title.toLowerCase();
        const pathLow = n.path.toLowerCase();
        let score = 0;
        if (titleLow === q) score = 100;
        else if (titleLow.startsWith(q)) score = 80;
        else if (titleLow.includes(q)) score = 50;
        else if (n.aliases.some((a) => a.toLowerCase().includes(q))) score = 40;
        else if (pathLow.includes(q)) score = 20;
        return { note: n, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.note.title.localeCompare(b.note.title))
      .slice(0, 30)
      .map((x) => x.note);
  }, [notes, query]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, Math.max(0, matches.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && matches[selectedIdx]) {
      e.preventDefault();
      onSelect(matches[selectedIdx].path, e.ctrlKey || e.metaKey);
    }
  };

  return (
    <div className="obs-modal-backdrop" onClick={onClose}>
      <div className="obs-quick-switcher" onClick={(e) => e.stopPropagation()}>
        <div className="obs-quick-input-wrap">
          <Search size={15} color="var(--text-muted)" />
          <input
            ref={inputRef}
            className="obs-quick-input"
            placeholder="Find or open a note..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="obs-icon-btn"
            onClick={onOpenGraph}
            title="Open graph view"
          >
            <GitFork size={15} />
          </button>
        </div>

        <div className="obs-quick-list">
          {matches.length === 0 ? (
            <div className="obs-empty-hint">No matching notes found.</div>
          ) : (
            matches.map((n, i) => (
              <div
                key={n.path}
                className={`obs-quick-item ${i === selectedIdx ? 'is-selected' : ''}`}
                onMouseEnter={() => setSelectedIdx(i)}
                onClick={(e) => onSelect(n.path, e.ctrlKey || e.metaKey)}
              >
                <span className="obs-quick-item-title">{n.title}</span>
                <span className="obs-quick-item-path">{n.folder || 'Vault root'}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);