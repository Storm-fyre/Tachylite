import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
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
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  SlidersHorizontal,
  Tag,
  X,
  Zap,
} from 'lucide-react';
import './obsidian.css';
import Reader, { RightInspector } from './Reader.jsx';
import GraphView from './GraphView.jsx';

const PREFS_KEY = 'obsidian-web-prefs-v1';
const BOOKMARKS_PREFIX = 'obsidian-web-bookmarks-';

const DEFAULT_PREFS = {
  theme: 'dark',
  pitchBlackGraph: true,
  fontSize: 16,
  fontFamily: 'sans',
  readableWidth: true,
};

const THEME_OPTIONS = [
  { id: 'dark', label: 'Dark', dot: '#262626' },
  { id: 'pitch-black', label: 'Pitch Black', dot: '#000000' },
  { id: 'warm', label: 'Warm', dot: '#e8dac3' },
  { id: 'light', label: 'Light', dot: '#f5f5f5' },
];

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

function buildHash(vaultId, entry) {
  if (!vaultId) return '#/';
  if (!entry || entry.type === 'graph') {
    return `#/${encodeURIComponent(vaultId)}/__graph__`;
  }
  return `#/${encodeURIComponent(vaultId)}/${encodePathSegments(entry.path)}`;
}

function getDisplayVaultName(vaultObj, fallbackId) {
  const raw = vaultObj?.name || fallbackId || 'Tachylite';
  return raw.toLowerCase() === 'web' ? 'Tachylite' : raw;
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
  const [findOpen, setFindOpen] = useState(false);

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
  const [activeHeadingSlug, setActiveHeadingSlug] = useState(null);
  const [lastOpenedNotePath, setLastOpenedNotePath] = useState(null);
  const [focusRevision, setFocusRevision] = useState(0);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchCorpus, setSearchCorpus] = useState(null);
  const [bookmarks, setBookmarks] = useState([]);

  const noteCacheRef = useRef(new Map());
  const settingsRef = useRef(null);
  const searchInputRef = useRef(null);

  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const historyRef = useRef(history);
  const historyIdxRef = useRef(historyIdx);
  const vaultIndexRef = useRef(vaultIndex);
  const activeVaultIdRef = useRef(activeVaultId);
  const overlaysRef = useRef({});
  const ignoreNextPopRef = useRef(false);

  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;
  historyRef.current = history;
  historyIdxRef.current = historyIdx;
  vaultIndexRef.current = vaultIndex;
  activeVaultIdRef.current = activeVaultId;
  overlaysRef.current = {
    showQuickSwitcher,
    findOpen,
    showSettings,
    leftOpen,
    rightOpen,
  };

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) || null,
    [tabs, activeTabId]
  );

  const activeNotePath = activeTab?.type === 'note' ? activeTab.path : null;
  const displayVaultName = useMemo(
    () => getDisplayVaultName(vaultIndex, activeVaultId),
    [vaultIndex, activeVaultId]
  );

  const activeNoteMeta = useMemo(() => {
    if (!vaultIndex || !activeNotePath) return null;
    return vaultIndex.notes.find((n) => n.path === activeNotePath) || null;
  }, [vaultIndex, activeNotePath]);

  const effectivePitchBlackGraph = Boolean(
    prefs.pitchBlackGraph || prefs.theme === 'pitch-black'
  );

  const handleTogglePitchBlackGraph = useCallback((nextVal) => {
    setPrefs((p) => ({ ...p, pitchBlackGraph: Boolean(nextVal) }));
  }, []);

  useEffect(() => {
    if (activeNotePath) {
      setLastOpenedNotePath(activeNotePath);
      setFocusRevision((r) => r + 1);
    } else {
      setFindOpen(false);
    }
    setActiveHeadingSlug(null);
  }, [activeNotePath]);

  useEffect(() => {
    if (!activeVaultId || !vaultIndex) {
      document.title = 'Tachylite';
      return;
    }
    if (activeTab?.type === 'graph') {
      document.title = `Graph view — ${displayVaultName}`;
    } else if (activeNoteMeta) {
      document.title = `${activeNoteMeta.title} — ${displayVaultName}`;
    } else {
      document.title = displayVaultName;
    }
  }, [activeVaultId, vaultIndex, activeTab?.type, activeNoteMeta, displayVaultName]);

  // Apply reading preferences & mobile theme-color meta tag across all 4 themes
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

    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      const metaColorMap = {
        'pitch-black': '#000000',
        dark: '#1e1e1e',
        warm: '#ebe0ce',
        light: '#f5f5f5',
      };
      const color =
        activeTab?.type === 'graph' && effectivePitchBlackGraph
          ? '#000000'
          : metaColorMap[prefs.theme] || '#1e1e1e';
      themeMeta.setAttribute('content', color);
    }
  }, [prefs, activeTab?.type, effectivePitchBlackGraph]);

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

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'o')) {
        if (!vaultIndex) return;
        e.preventDefault();
        setShowQuickSwitcher((prev) => !prev);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        if (!vaultIndex || activeTab?.type !== 'note') return;
        e.preventDefault();
        setFindOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [vaultIndex, activeTab?.type]);

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

  const applyNavigationEntry = useCallback(
    (entry) => {
      if (!entry) return;
      setTargetHeading(null);
      if (window.innerWidth <= 768) {
        setLeftOpen(false);
        setRightOpen(false);
      }

      const currentTabs = tabsRef.current;
      const currentActive = currentTabs.find((t) => t.id === activeTabIdRef.current) || null;

      if (entry.type === 'graph') {
        const existingGraph = currentTabs.find((t) => t.type === 'graph');
        if (existingGraph) {
          setActiveTabId(existingGraph.id);
        } else {
          const graphTab = { id: 'tab-graph', type: 'graph', title: 'Graph view' };
          setTabs((prev) => [graphTab, ...prev]);
          setActiveTabId(graphTab.id);
        }
        return;
      }

      if (entry.type === 'note' && entry.path) {
        revealPathInTree(entry.path);
        const existing = currentTabs.find((t) => t.type === 'note' && t.path === entry.path);
        if (existing) {
          setActiveTabId(existing.id);
          return;
        }
        if (currentActive && currentActive.type === 'note') {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === currentActive.id
                ? { ...t, path: entry.path, title: entry.title }
                : t
            )
          );
          setActiveTabId(currentActive.id);
        } else {
          const freshTab = {
            id: entry.id || `tab-${Date.now()}`,
            type: 'note',
            path: entry.path,
            title: entry.title,
          };
          setTabs((prev) => [...prev, freshTab]);
          setActiveTabId(freshTab.id);
        }
      }
    },
    [revealPathInTree]
  );

  useEffect(() => {
    const onPopState = (e) => {
      if (ignoreNextPopRef.current) {
        ignoreNextPopRef.current = false;
        return;
      }

      const ov = overlaysRef.current;
      const isMobile = window.innerWidth <= 768;

      if (
        ov.showQuickSwitcher ||
        ov.findOpen ||
        ov.showSettings ||
        (isMobile && (ov.leftOpen || ov.rightOpen))
      ) {
        if (ov.showQuickSwitcher) setShowQuickSwitcher(false);
        else if (ov.findOpen) setFindOpen(false);
        else if (ov.showSettings) setShowSettings(false);
        else {
          setLeftOpen(false);
          setRightOpen(false);
        }
        ignoreNextPopRef.current = true;
        window.history.forward();
        return;
      }

      const st = e.state;
      if (st?.appNav && st.entry) {
        if (typeof st.idx === 'number') {
          setHistoryIdx(st.idx);
        }
        applyNavigationEntry(st.entry);
        return;
      }

      const parsed = parseHash();
      const idxData = vaultIndexRef.current;
      if (!idxData) return;

      if (parsed.isGraph) {
        applyNavigationEntry({ id: 'tab-graph', type: 'graph', title: 'Graph view' });
      } else if (parsed.notePath) {
        const meta = idxData.notes.find((n) => n.path === parsed.notePath);
        if (meta) {
          applyNavigationEntry({
            id: `tab-${Date.now()}`,
            type: 'note',
            path: meta.path,
            title: meta.title,
          });
        }
      }
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyNavigationEntry]);

  useEffect(() => {
    if (!activeVaultId) {
      setVaultIndex(null);
      setTabs([]);
      setActiveTabId(null);
      setNoteData(null);
      setLastOpenedNotePath(null);
      setActiveHeadingSlug(null);
      setFindOpen(false);
      return;
    }

    let cancelled = false;
    setLoadingVault(true);
    noteCacheRef.current.clear();
    setSearchCorpus(null);
    setSearchQuery('');
    setLastOpenedNotePath(null);
    setActiveHeadingSlug(null);
    setFindOpen(false);

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
        let initialTabs = [{ id: 'tab-graph', type: 'graph', title: 'Graph view' }];
        let initialActive = initialTabs[0];

        if (hash.vaultId === activeVaultId && hash.notePath) {
          const found = idx.notes.find((n) => n.path === hash.notePath);
          if (found) {
            const noteTab = {
              id: `tab-${Date.now()}`,
              type: 'note',
              path: found.path,
              title: found.title,
            };
            initialTabs = [initialTabs[0], noteTab];
            initialActive = noteTab;
            revealPathInTree(found.path);
          }
        }

        setTabs(initialTabs);
        setActiveTabId(initialActive.id);
        setHistory([initialActive]);
        setHistoryIdx(0);

        const initialHash = buildHash(activeVaultId, initialActive);
        window.history.replaceState(
          { appNav: true, idx: 0, entry: initialActive },
          '',
          initialHash
        );
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
  }, [activeVaultId, revealPathInTree]);

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

  useEffect(() => {
    if (!activeVaultId || leftTab !== 'search' || searchCorpus) return;
    fetch(`./vault-data/${encodeURIComponent(activeVaultId)}/search.json`)
      .then((res) => res.json())
      .then((data) => setSearchCorpus(data))
      .catch(() => {});
  }, [activeVaultId, leftTab, searchCorpus]);

  const pushNavigation = useCallback((entry) => {
    const vId = activeVaultIdRef.current;
    if (!vId || !entry) return;

    const currentHist = historyRef.current;
    const currentIdx = historyIdxRef.current;
    const currentTop = currentHist[currentIdx];

    const isSameEntry =
      currentTop &&
      currentTop.type === entry.type &&
      (entry.type === 'graph' || currentTop.path === entry.path);

    if (isSameEntry) return;

    const nextHistory = [...currentHist.slice(0, currentIdx + 1), entry];
    const nextIdx = nextHistory.length - 1;

    setHistory(nextHistory);
    setHistoryIdx(nextIdx);

    const nextHash = buildHash(vId, entry);
    window.history.pushState({ appNav: true, idx: nextIdx, entry }, '', nextHash);
  }, []);

  const openNote = useCallback(
    (notePath, headingSlug = null, newTab = false) => {
      const idxData = vaultIndexRef.current;
      if (!idxData) return;
      const meta = idxData.notes.find((n) => n.path === notePath);
      if (!meta) return;

      revealPathInTree(notePath);
      setTargetHeading(headingSlug ? `${headingSlug}::${Date.now()}` : null);
      if (window.innerWidth <= 768) {
        setLeftOpen(false);
        setRightOpen(false);
      }

      const currentTabs = tabsRef.current;
      const currentActive = currentTabs.find((t) => t.id === activeTabIdRef.current) || null;

      const existing = currentTabs.find((t) => t.type === 'note' && t.path === notePath);
      if (existing && !newTab) {
        setActiveTabId(existing.id);
        pushNavigation(existing);
        return;
      }

      const freshTab = {
        id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'note',
        path: meta.path,
        title: meta.title,
      };

      if (newTab || !currentActive || currentActive.type === 'graph') {
        setTabs((prev) => [...prev, freshTab]);
      } else {
        setTabs((prev) => prev.map((t) => (t.id === currentActive.id ? freshTab : t)));
      }
      setActiveTabId(freshTab.id);
      pushNavigation(freshTab);
    },
    [revealPathInTree, pushNavigation]
  );

  const handleGraphSelectNote = useCallback(
    (path, newTab) => {
      openNote(path, null, newTab);
    },
    [openNote]
  );

  const handleConsumeTargetHeading = useCallback(() => {
    setTargetHeading(null);
  }, []);

  const handleCloseFind = useCallback(() => {
    setFindOpen(false);
  }, []);

  const handleCloseRightSidebar = useCallback(() => {
    setRightOpen(false);
  }, []);

  const openGraphTab = useCallback(
    (newTab = false) => {
      setTargetHeading(null);
      setFindOpen(false);
      if (window.innerWidth <= 768) {
        setLeftOpen(false);
        setRightOpen(false);
      }

      const currentTabs = tabsRef.current;
      const existing = currentTabs.find((t) => t.type === 'graph');
      if (existing && !newTab) {
        setActiveTabId(existing.id);
        pushNavigation(existing);
        return;
      }
      const graphTab = { id: `tab-graph-${Date.now()}`, type: 'graph', title: 'Graph view' };
      setTabs((prev) => [...prev, graphTab]);
      setActiveTabId(graphTab.id);
      pushNavigation(graphTab);
    },
    [pushNavigation]
  );

  const selectTab = useCallback(
    (tab) => {
      setTargetHeading(null);
      if (tab.type === 'graph') setFindOpen(false);
      setActiveTabId(tab.id);
      pushNavigation(tab);
    },
    [pushNavigation]
  );

  const closeTab = useCallback(
    (tabId, e) => {
      e?.stopPropagation();
      setTargetHeading(null);
      setTabs((prev) => {
        if (prev.length <= 1) return prev;
        const idx = prev.findIndex((t) => t.id === tabId);
        const filtered = prev.filter((t) => t.id !== tabId);
        if (tabId === activeTabIdRef.current) {
          const fallback = filtered[Math.max(0, idx - 1)] || filtered[0];
          setActiveTabId(fallback.id);
          pushNavigation(fallback);
        }
        return filtered;
      });
    },
    [pushNavigation]
  );

  const goBack = () => {
    if (historyIdx <= 0) return;
    window.history.back();
  };

  const goForward = () => {
    if (historyIdx >= history.length - 1) return;
    window.history.forward();
  };

  const openLeftSidebar = useCallback(() => {
    if (window.innerWidth <= 768) setRightOpen(false);
    setLeftOpen(true);
  }, []);

  const toggleRightSidebar = useCallback(() => {
    setRightOpen((prev) => {
      const next = !prev;
      if (next && window.innerWidth <= 768) setLeftOpen(false);
      return next;
    });
  }, []);

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

  const handleSearchTag = useCallback((tag) => {
    if (window.innerWidth <= 768) setRightOpen(false);
    setLeftOpen(true);
    setLeftTab('search');
    setSearchQuery(`#${tag}`);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);

  const sortedVaultTags = useMemo(() => {
    const entries = Object.entries(vaultIndex?.tags || {});
    return entries.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [vaultIndex?.tags]);

  const searchResults = useMemo(() => {
    if (!vaultIndex) return [];
    const rawQ = searchQuery.trim();
    if (!rawQ) return [];

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

  const pairedNote = useMemo(() => {
    if (!vaultIndex || !activeNoteMeta) return null;
    const summarySuffix = ' - Summary';
    if (activeNoteMeta.title.endsWith(summarySuffix)) {
      const motherTitle = activeNoteMeta.title.slice(0, -summarySuffix.length);
      const match = vaultIndex.notes.find((n) => n.title === motherTitle);
      if (match) {
        return { kind: 'mother', path: match.path, title: match.title, label: 'Full Chapter' };
      }
      return null;
    }
    const summaryTitle = `${activeNoteMeta.title}${summarySuffix}`;
    const match = vaultIndex.notes.find((n) => n.title === summaryTitle);
    if (match) {
      return { kind: 'summary', path: match.path, title: match.title, label: 'Summary' };
    }
    return null;
  }, [vaultIndex, activeNoteMeta]);

  const isBookmarked = activeNotePath ? bookmarks.includes(activeNotePath) : false;
  const readingMinutes = activeNoteMeta
    ? Math.max(1, Math.round((activeNoteMeta.wordCount || 0) / 220))
    : 0;

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
        <p className="obs-vault-hub-sub">Loading Tachylite...</p>
      </div>
    );
  }

  const vaultsList = manifest.vaults || [];

  if (!activeVaultId) {
    return (
      <div className="obs-vault-hub">
        <div className="obs-vault-hub-header">
          <h1 className="obs-vault-hub-title">Tachylite Vaults</h1>
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
                <div className="obs-vault-card-name">{getDisplayVaultName(v, v.id)}</div>
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
        {(leftOpen || rightOpen) && (
          <div
            className="obs-mobile-backdrop"
            onClick={() => {
              setLeftOpen(false);
              setRightOpen(false);
            }}
          />
        )}

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
                  title="Search all notes"
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
                <button
                  className={`obs-icon-btn ${leftTab === 'tags' ? 'is-active' : ''}`}
                  onClick={() => setLeftTab('tags')}
                  title="All vault tags"
                >
                  <Tag size={15} />
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
                    placeholder="Search all notes or #tag..."
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

            {leftTab === 'tags' && (
              <div className="obs-sidebar-body">
                <div className="obs-sidebar-heading">Vault Tags ({sortedVaultTags.length})</div>
                {sortedVaultTags.length === 0 ? (
                  <div className="obs-empty-hint">No tags found in this vault.</div>
                ) : (
                  sortedVaultTags.map(([tag, paths]) => (
                    <div
                      key={tag}
                      className="obs-tree-row"
                      style={{ justifyContent: 'space-between' }}
                      onClick={() => handleSearchTag(tag)}
                    >
                      <span className="obs-tree-label" style={{ color: 'var(--text-accent)' }}>
                        #{tag}
                      </span>
                      <span className="obs-backlink-badge">{paths.length}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </aside>
        )}

        <main className="obs-main">
          <div className="obs-tab-bar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, flex: 1 }}>
              {!leftOpen && (
                <button
                  className="obs-icon-btn"
                  style={{ marginBottom: 4 }}
                  onClick={openLeftSidebar}
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
                    onClick={() => selectTab(tab)}
                    onMouseDown={(e) => {
                      if (e.button === 1) e.preventDefault();
                    }}
                    onAuxClick={(e) => {
                      if (e.button === 1 && tabs.length > 1) {
                        e.preventDefault();
                        closeTab(tab.id, e);
                      }
                    }}
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
              {activeTab?.type === 'note' && (
                <button
                  className={`obs-icon-btn ${findOpen ? 'is-active' : ''}`}
                  onClick={() => setFindOpen((f) => !f)}
                  title="Find in this file (Ctrl+F)"
                >
                  <Search size={15} />
                </button>
              )}
              <button
                className={`obs-icon-btn ${rightOpen ? 'is-active' : ''}`}
                onClick={toggleRightSidebar}
                title="Toggle right sidebar"
              >
                <PanelRight size={15} />
              </button>
            </div>
          </div>

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
              {pairedNote && (
                <button
                  className={`obs-pair-btn ${
                    pairedNote.kind === 'summary' ? 'is-to-summary' : 'is-to-mother'
                  }`}
                  onClick={(e) => openNote(pairedNote.path, null, e.ctrlKey || e.metaKey)}
                  onAuxClick={(e) => {
                    if (e.button === 1) openNote(pairedNote.path, null, true);
                  }}
                  title={`Open ${pairedNote.title} (Ctrl+Click for new tab)`}
                >
                  {pairedNote.kind === 'summary' ? (
                    <Zap size={13} />
                  ) : (
                    <BookOpen size={13} />
                  )}
                  <span>{pairedNote.label}</span>
                </button>
              )}

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
                title="Reading appearance & themes"
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

                  <div className="obs-slider-row" style={{ marginBottom: 8 }}>
                    <span>Reading theme</span>
                    <div className="obs-theme-grid">
                      {THEME_OPTIONS.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className={`obs-theme-btn ${prefs.theme === t.id ? 'is-active' : ''}`}
                          onClick={() => setPrefs((p) => ({ ...p, theme: t.id }))}
                        >
                          <span
                            className="obs-theme-swatch"
                            style={{ background: t.dot }}
                          />
                          <span>{t.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="obs-toggle-row">
                    <span>Pitch-black graph canvas</span>
                    <input
                      type="checkbox"
                      checked={effectivePitchBlackGraph}
                      disabled={prefs.theme === 'pitch-black'}
                      onChange={(e) =>
                        setPrefs((p) => ({ ...p, pitchBlackGraph: e.target.checked }))
                      }
                    />
                  </label>

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
                </div>
              )}
            </div>
          </div>

          <div className="obs-pane-content">
            {vaultIndex && (
              <div
                className={`obs-pane-layer ${activeTab?.type === 'graph' ? '' : 'is-hidden'}`}
              >
                <GraphView
                  vaultIndex={vaultIndex}
                  mode="global"
                  isVisible={activeTab?.type === 'graph'}
                  pitchBlackGraph={effectivePitchBlackGraph}
                  onTogglePitchBlackGraph={handleTogglePitchBlackGraph}
                  activeNotePath={activeNotePath}
                  focusNotePath={lastOpenedNotePath}
                  focusRevision={focusRevision}
                  onSelectNote={handleGraphSelectNote}
                />
              </div>
            )}

            {activeTab?.type !== 'graph' && (
              <div className="obs-pane-layer">
                <Reader
                  vaultIndex={vaultIndex}
                  vaultId={activeVaultId}
                  noteData={noteData}
                  loading={loadingNote}
                  readableWidth={prefs.readableWidth}
                  targetHeading={targetHeading}
                  onConsumeTargetHeading={handleConsumeTargetHeading}
                  findOpen={findOpen}
                  onCloseFind={handleCloseFind}
                  fetchNote={fetchNote}
                  onNavigateNote={openNote}
                  onSearchTag={handleSearchTag}
                  onActiveHeadingChange={setActiveHeadingSlug}
                />
              </div>
            )}
          </div>
        </main>

        {rightOpen && vaultIndex && (
          <RightInspector
            vaultIndex={vaultIndex}
            activeNotePath={activeNotePath}
            noteData={noteData}
            activeHeadingSlug={activeHeadingSlug}
            rightTab={rightTab}
            setRightTab={setRightTab}
            pitchBlackGraph={effectivePitchBlackGraph}
            onClose={handleCloseRightSidebar}
            onNavigateNote={openNote}
          />
        )}
      </div>

      <footer className="obs-status-bar">
        <div className="obs-status-left">
          <button
            className="obs-status-btn"
            onClick={() => {
              if (vaultsList.length > 1) {
                setActiveVaultId(null);
                window.history.replaceState(null, '', '#/');
              } else {
                setShowQuickSwitcher(true);
              }
            }}
            title={
              vaultsList.length > 1
                ? 'Switch vault'
                : `${displayVaultName} (${vaultIndex?.notes.length || 0} notes)`
            }
          >
            <ChevronsUpDown size={12} />
            <span>{displayVaultName}</span>
          </button>
        </div>

        <div className="obs-status-right">
          {activeNoteMeta ? (
            <>
              <button
                className="obs-status-btn"
                onClick={() => {
                  if (window.innerWidth <= 768) setLeftOpen(false);
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
                  if (window.innerWidth <= 768) setLeftOpen(false);
                  setRightOpen(true);
                  setRightTab('outline');
                }}
                title="Open outline panel"
              >
                Outline
              </button>
              <span>~{readingMinutes} min read</span>
              <span className="obs-status-words">
                {activeNoteMeta.wordCount.toLocaleString()} words
              </span>
              <span className="obs-status-chars">
                {activeNoteMeta.charCount.toLocaleString()} characters
              </span>
            </>
          ) : (
            <span>{vaultIndex?.notes.length || 0} notes in graph</span>
          )}
        </div>
      </footer>

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