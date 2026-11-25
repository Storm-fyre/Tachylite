import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force';
import {
  Crosshair,
  ExternalLink,
  Eye,
  EyeOff,
  Maximize2,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';

function matchesSingleTerm(node, term) {
  const clean = term.trim();
  if (!clean) return true;

  let negated = false;
  let expr = clean;
  if (expr.startsWith('-')) {
    negated = true;
    expr = expr.slice(1);
  }

  let matched = false;
  const tagMatch = expr.match(/^tag:#?(.+)$/i);
  const pathMatch = expr.match(/^path:"?([^"]+)"?$/i);
  const fileMatch = expr.match(/^file:"?([^"]+)"?$/i);

  if (tagMatch) {
    const targetTag = tagMatch[1].replace(/^#/, '').toLowerCase();
    matched = (node.tags || []).some(
      (t) => t.toLowerCase() === targetTag || t.toLowerCase().startsWith(`${targetTag}/`)
    );
  } else if (pathMatch) {
    const targetPath = pathMatch[1].toLowerCase();
    matched =
      (node.path || '').toLowerCase().startsWith(targetPath) ||
      (node.folder || '').toLowerCase().includes(targetPath);
  } else if (fileMatch) {
    const targetFile = fileMatch[1].toLowerCase();
    matched = (node.title || '').toLowerCase().includes(targetFile);
  } else {
    const q = expr.replace(/^"|"$/g, '').toLowerCase();
    matched =
      (node.title || '').toLowerCase().includes(q) ||
      (node.path || '').toLowerCase().includes(q);
  }

  return negated ? !matched : matched;
}

function matchesGraphQuery(node, query) {
  if (!query || !query.trim()) return true;
  const orBranches = query.split(/\s+OR\s+/);
  return orBranches.some((branch) => {
    const tokens = branch.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    return tokens.every((tok) => matchesSingleTerm(node, tok));
  });
}

function getThemeColors() {
  const styles = getComputedStyle(document.documentElement);
  const get = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  return {
    isLight,
    bg: get('--bg-primary', '#1e1e1e'),
    nodeDefault: get('--graph-node', '#9a9a9a'),
    nodeUnresolved: get('--graph-node-unresolved', '#4e4e4e'),
    line: get(
      '--graph-line',
      isLight ? 'rgba(110, 110, 110, 0.24)' : 'rgba(165, 165, 165, 0.26)'
    ),
    lineActive: get('--graph-line-active', 'rgba(168, 139, 250, 0.92)'),
    accent: get('--text-accent', '#a88bfa'),
    text: get('--graph-text', isLight ? '#333333' : '#d2d2d2'),
  };
}

function getNodeRole(node) {
  if (node.unresolved) return 'unresolved';
  const tags = (node.tags || []).map((t) => t.toLowerCase());
  const folder = (node.folder || '').toLowerCase();
  const deg = node.degree || 0;

  if (tags.includes('subject-hub') || deg >= 16) return 'hub';
  if (folder === 'trivia' || folder.startsWith('trivia/') || folder === 'good to know') {
    return 'trivia';
  }
  if (deg <= 1 || folder.startsWith('how stuff works summary')) return 'summary';
  return 'chapter';
}

function classifyLink(link) {
  const s = typeof link.source === 'object' ? link.source : null;
  const t = typeof link.target === 'object' ? link.target : null;
  if (!s || !t) return 'cross';

  const rA = s.role || 'chapter';
  const rB = t.role || 'chapter';
  const sameFolder = Boolean(s.folder && t.folder && s.folder === t.folder);

  if (rA === 'summary' || rB === 'summary') return 'summary';
  if (rA === 'hub' && rB === 'hub') return 'hub-loop';
  if ((rA === 'hub' || rB === 'hub') && sameFolder) return 'hub-spoke';
  if (rA === 'chapter' && rB === 'chapter' && sameFolder) return 'sibling';
  if (rA === 'trivia' || rB === 'trivia') return 'trivia';
  return 'cross';
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

// Airy filament spoke geometry (avoids tight concentric "daisy" rings)
function computeLinkDistance(link, baseDistance, isLocal) {
  if (isLocal) return baseDistance * 0.55;
  const kind = classifyLink(link);
  const s = link.source;
  const t = link.target;
  const jitter = (hashString(`${s.id}|${t.id}`) - 0.5) * 0.24;

  switch (kind) {
    case 'summary':
      return baseDistance * (0.78 + jitter * 0.65);
    case 'sibling':
      return baseDistance * (0.72 + jitter * 0.4);
    case 'hub-spoke':
      return baseDistance * (0.94 + jitter * 0.85);
    case 'trivia':
      return baseDistance * 1.05;
    case 'hub-loop':
      return baseDistance * 1.45;
    case 'cross':
    default:
      return baseDistance * 1.12;
  }
}

// Balanced ~2.5:1 elasticity ratio: clean non-cluttered clusters woven into one unified web
function computeLinkStrength(link, baseStrength, isLocal) {
  if (isLocal) return Math.min(1, baseStrength * 0.7);
  const kind = classifyLink(link);

  switch (kind) {
    case 'summary':
      return Math.min(1, baseStrength * 0.72);
    case 'hub-spoke':
      return Math.min(1, baseStrength * 0.54);
    case 'sibling':
      return Math.min(1, baseStrength * 0.22);
    case 'trivia':
      return Math.min(1, baseStrength * 0.28);
    case 'cross':
      return Math.min(1, baseStrength * 0.24);
    case 'hub-loop':
    default:
      return Math.min(1, baseStrength * 0.14);
  }
}

// Smooth, near-uniform electrostatic repulsion for airy negative space
function computeNodeCharge(node, baseRepel, isLocal) {
  if (isLocal) return -baseRepel * 26;
  const role = node.role || 'chapter';
  const deg = node.degree || 1;

  if (role === 'hub') {
    return -baseRepel * (50 + Math.min(18, deg * 0.45));
  }
  if (role === 'trivia') {
    return -baseRepel * 42;
  }
  if (role === 'summary') {
    return -baseRepel * 31;
  }
  return -baseRepel * 38;
}

// Minimal overlap-only floor (no artificial billiard-ball rigidity)
function computeCollideRadius(node, isLocal) {
  if (isLocal) return 14;
  const role = node.role || 'chapter';
  if (role === 'hub') return 10;
  if (role === 'trivia') return 7;
  if (role === 'summary') return 5;
  return 6;
}

// Loose organic pre-seeding to prevent tangled crossings without forcing rigid circles
function seedConstellationPositions(nodes, links, baseDistance) {
  const hubs = nodes.filter((n) => n.role === 'hub');
  if (hubs.length < 3) return;

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map();
  for (const l of links) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (!adj.has(s)) adj.set(s, new Set());
    if (!adj.has(t)) adj.set(t, new Set());
    adj.get(s).add(t);
    adj.get(t).add(s);
  }

  const hubRadius = baseDistance * 2.1;
  const hubPos = new Map();

  hubs.forEach((hub, idx) => {
    const hRand = hashString(hub.id);
    const angle = (idx / hubs.length) * Math.PI * 2 + (hRand - 0.5) * 0.28;
    const ringScale = hubs.length > 10 && idx % 3 === 0 ? 0.52 + hRand * 0.14 : 0.88 + hRand * 0.24;
    const r = hubRadius * ringScale;
    if (!Number.isFinite(hub.x) || !Number.isFinite(hub.y)) {
      hub.x = Math.cos(angle) * r;
      hub.y = Math.sin(angle) * r;
    }
    hubPos.set(hub.id, { x: hub.x, y: hub.y, angle });
  });

  const hubByFolder = new Map();
  for (const h of hubs) {
    if (h.folder) hubByFolder.set(h.folder, h);
  }

  const chaptersByHub = new Map();
  for (const n of nodes) {
    if (n.role !== 'chapter') continue;
    let owner = n.folder ? hubByFolder.get(n.folder) : null;
    if (!owner) {
      for (const nbId of adj.get(n.id) || []) {
        const nb = nodeById.get(nbId);
        if (nb?.role === 'hub') {
          owner = nb;
          break;
        }
      }
    }
    if (owner) {
      if (!chaptersByHub.has(owner.id)) chaptersByHub.set(owner.id, []);
      chaptersByHub.get(owner.id).push(n);
    }
  }

  for (const [hubId, chapters] of chaptersByHub.entries()) {
    const hp = hubPos.get(hubId);
    if (!hp) continue;
    chapters.forEach((ch, i) => {
      if (Number.isFinite(ch.x) && Number.isFinite(ch.y)) return;
      const jitter = hashString(ch.id);
      const a = hp.angle + (i / Math.max(1, chapters.length)) * Math.PI * 2 + (jitter - 0.5) * 0.35;
      const rad = baseDistance * (0.7 + jitter * 0.45);
      ch.x = hp.x + Math.cos(a) * rad;
      ch.y = hp.y + Math.sin(a) * rad;
    });
  }

  for (const n of nodes) {
    if (n.role !== 'summary') continue;
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) continue;
    const nbs = [...(adj.get(n.id) || [])];
    const parent = nbs.length ? nodeById.get(nbs[0]) : null;
    if (parent && Number.isFinite(parent.x) && Number.isFinite(parent.y)) {
      const ownerHub = parent.folder ? hubByFolder.get(parent.folder) : null;
      const ox = ownerHub && Number.isFinite(ownerHub.x) ? ownerHub.x : 0;
      const oy = ownerHub && Number.isFinite(ownerHub.y) ? ownerHub.y : 0;
      const jitter = (hashString(n.id) - 0.5) * 0.6;
      const outAngle = Math.atan2(parent.y - oy, parent.x - ox) + jitter;
      const rad = baseDistance * (0.65 + hashString(`${n.id}:r`) * 0.3);
      n.x = parent.x + Math.cos(outAngle) * rad;
      n.y = parent.y + Math.sin(outAngle) * rad;
    }
  }

  for (const n of nodes) {
    if (n.role !== 'trivia') continue;
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) continue;
    let sx = 0;
    let sy = 0;
    let cnt = 0;
    for (const nbId of adj.get(n.id) || []) {
      const nb = nodeById.get(nbId);
      if (nb && Number.isFinite(nb.x) && Number.isFinite(nb.y)) {
        sx += nb.x;
        sy += nb.y;
        cnt += 1;
      }
    }
    if (cnt > 0) {
      const jitterA = hashString(n.id) * Math.PI * 2;
      n.x = sx / cnt + Math.cos(jitterA) * 28;
      n.y = sy / cnt + Math.sin(jitterA) * 28;
    } else {
      n.x = (hashString(n.id) - 0.5) * 120;
      n.y = (hashString(`${n.id}!`) - 0.5) * 120;
    }
  }
}

function wrapLabelLines(ctx, text, maxWidth, maxLines = 2) {
  if (!text) return [];
  if (ctx.measureText(text).width <= maxWidth) return [text];

  const words = text.split(/\s+/);
  const lines = [];
  let current = '';

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
        current = word;
        if (lines.length === maxLines - 1) {
          let rest = [current, ...words.slice(i + 1)].join(' ');
          while (rest.length > 4 && ctx.measureText(`${rest}…`).width > maxWidth) {
            rest = rest.slice(0, -1).trimEnd();
          }
          lines.push(
            ctx.measureText(rest).width <= maxWidth ? rest : `${rest}…`
          );
          return lines;
        }
      } else {
        let truncated = word;
        while (truncated.length > 4 && ctx.measureText(`${truncated}…`).width > maxWidth) {
          truncated = truncated.slice(0, -1);
        }
        lines.push(`${truncated}…`);
        current = '';
        if (lines.length >= maxLines) return lines;
      }
    }
  }

  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

function makeEdgePairKey(a, b) {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

function findShortestPath(startId, endId, neighborMap) {
  if (startId === endId) return [startId];
  const visited = new Set([startId]);
  const parent = new Map();
  const queue = [startId];

  while (queue.length > 0) {
    const curr = queue.shift();
    for (const nb of neighborMap.get(curr) || []) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      parent.set(nb, curr);
      if (nb === endId) {
        const chain = [endId];
        let step = endId;
        while (parent.has(step)) {
          step = parent.get(step);
          chain.push(step);
        }
        chain.reverse();
        return chain;
      }
      queue.push(nb);
    }
  }
  return null;
}

export default function GraphView({
  vaultIndex,
  mode = 'global',
  isVisible = true,
  activeNotePath = null,
  focusNotePath = null,
  focusRevision = 0,
  onSelectNote,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);

  const initialConfig = vaultIndex?.graphConfig || {};
  const [settings, setSettings] = useState(() => ({
    search: initialConfig.search || '',
    hideUnresolved: initialConfig.hideUnresolved ?? true,
    showOrphans: initialConfig.showOrphans ?? true,
    showArrow: initialConfig.showArrow ?? false,
    textFadeMultiplier: initialConfig.textFadeMultiplier ?? 0,
    nodeSizeMultiplier: initialConfig.nodeSizeMultiplier ?? 1,
    lineSizeMultiplier: initialConfig.lineSizeMultiplier ?? 1,
    centerStrength: initialConfig.centerStrength ?? 0.5,
    repelStrength: initialConfig.repelStrength ?? 10,
    linkStrength: initialConfig.linkStrength ?? 1,
    linkDistance: initialConfig.linkDistance ?? 200,
    localDepth: 1,
  }));

  const [panelOpen, setPanelOpen] = useState(false);
  const [themeColors, setThemeColors] = useState(getThemeColors);

  // Interactive Color Group Controls (solo highlight or hide layer)
  const [hiddenGroups, setHiddenGroups] = useState(() => new Set());
  const [soloGroupIdx, setSoloGroupIdx] = useState(null);

  // Subtle bottom status pill (lock or shortest-path clickable hop trail)
  const [statusPill, setStatusPill] = useState(null);

  // Pinned interactive Quick Peek card (2nd two-finger tap / 2nd long-press on locked node)
  const [pinnedPeek, setPinnedPeek] = useState(null);

  // Alt + Hover passive quick peek card (desktop)
  const [hoverPeek, setHoverPeek] = useState(null);

  // Double-tap empty space dismisses visual highlight while keeping Crosshair locate working
  const [focusDismissed, setFocusDismissed] = useState(false);

  const locateTargetPath = focusNotePath || activeNotePath;
  const visualFocusPath =
    mode === 'global' && focusDismissed ? activeNotePath || null : locateTargetPath;

  const notesByPathMap = useMemo(() => {
    const map = new Map();
    for (const n of vaultIndex?.notes || []) {
      map.set(n.path, n);
    }
    return map;
  }, [vaultIndex]);

  // Re-enable visual highlight whenever a note is newly opened/viewed
  useEffect(() => {
    setFocusDismissed(false);
  }, [focusNotePath, focusRevision]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setThemeColors(getThemeColors());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const cfg = vaultIndex?.graphConfig || {};
    setHiddenGroups(new Set());
    setSoloGroupIdx(null);
    setPinnedPeek(null);
    setStatusPill(null);
    setFocusDismissed(false);
    hasFittedRef.current = false;
    setSettings((prev) => ({
      ...prev,
      search: cfg.search || '',
      hideUnresolved: cfg.hideUnresolved ?? true,
      showOrphans: cfg.showOrphans ?? true,
      showArrow: cfg.showArrow ?? false,
      textFadeMultiplier: cfg.textFadeMultiplier ?? 0,
      nodeSizeMultiplier: cfg.nodeSizeMultiplier ?? 1,
      lineSizeMultiplier: cfg.lineSizeMultiplier ?? 1,
      centerStrength: cfg.centerStrength ?? 0.5,
      repelStrength: cfg.repelStrength ?? 10,
      linkStrength: cfg.linkStrength ?? 1,
      linkDistance: cfg.linkDistance ?? 200,
    }));
  }, [vaultIndex?.id]);

  const colorGroups = vaultIndex?.graphConfig?.colorGroups || [];

  const graphData = useMemo(() => {
    const rawNodes = vaultIndex?.graph?.nodes || [];
    const rawLinks = vaultIndex?.graph?.links || [];

    const validIds = new Set();
    let baseNodes = rawNodes.filter((n) => {
      if (settings.hideUnresolved && n.unresolved) return false;
      if (mode === 'global' && settings.search.trim() && !matchesGraphQuery(n, settings.search)) {
        return false;
      }
      if (mode === 'global' && hiddenGroups.size > 0 && !n.unresolved) {
        for (let gi = 0; gi < colorGroups.length; gi++) {
          const grp = colorGroups[gi];
          if (grp.query && matchesGraphQuery(n, grp.query)) {
            if (hiddenGroups.has(gi)) return false;
            break;
          }
        }
      }
      return true;
    });

    baseNodes.forEach((n) => validIds.add(n.id));
    let filteredDirectedLinks = rawLinks.filter(
      (l) => validIds.has(l.source) && validIds.has(l.target) && l.source !== l.target
    );

    if (mode === 'local' && activeNotePath && validIds.has(activeNotePath)) {
      const adj = new Map();
      for (const l of filteredDirectedLinks) {
        if (!adj.has(l.source)) adj.set(l.source, new Set());
        if (!adj.has(l.target)) adj.set(l.target, new Set());
        adj.get(l.source).add(l.target);
        adj.get(l.target).add(l.source);
      }

      const visited = new Set([activeNotePath]);
      let frontier = [activeNotePath];
      for (let depth = 0; depth < settings.localDepth; depth++) {
        const nextFrontier = [];
        for (const id of frontier) {
          for (const nb of adj.get(id) || []) {
            if (!visited.has(nb)) {
              visited.add(nb);
              nextFrontier.push(nb);
            }
          }
        }
        frontier = nextFrontier;
      }

      baseNodes = baseNodes.filter((n) => visited.has(n.id));
      filteredDirectedLinks = filteredDirectedLinks.filter(
        (l) => visited.has(l.source) && visited.has(l.target)
      );
    }

    const pairMap = new Map();
    const neighborSets = new Map();

    for (const l of filteredDirectedLinks) {
      if (!neighborSets.has(l.source)) neighborSets.set(l.source, new Set());
      if (!neighborSets.has(l.target)) neighborSets.set(l.target, new Set());
      neighborSets.get(l.source).add(l.target);
      neighborSets.get(l.target).add(l.source);

      const key = makeEdgePairKey(l.source, l.target);
      const existing = pairMap.get(key);
      if (!existing) {
        pairMap.set(key, {
          source: l.source,
          target: l.target,
          unresolved: Boolean(l.unresolved),
          bidirectional: false,
        });
      } else {
        if (existing.source === l.target && existing.target === l.source) {
          existing.bidirectional = true;
        }
        existing.unresolved = existing.unresolved && Boolean(l.unresolved);
      }
    }

    let uniqueLinks = [...pairMap.values()];

    if (!settings.showOrphans && mode === 'global') {
      baseNodes = baseNodes.filter((n) => (neighborSets.get(n.id)?.size || 0) > 0);
      const keepIds = new Set(baseNodes.map((n) => n.id));
      uniqueLinks = uniqueLinks.filter((l) => keepIds.has(l.source) && keepIds.has(l.target));
    }

    const nodes = baseNodes.map((n) => {
      let groupColor = null;
      let groupIndex = -1;
      if (!n.unresolved) {
        for (let gi = 0; gi < colorGroups.length; gi++) {
          const grp = colorGroups[gi];
          if (grp.query && matchesGraphQuery(n, grp.query)) {
            groupColor = grp.color;
            groupIndex = gi;
            break;
          }
        }
      }
      const degree = neighborSets.get(n.id)?.size || 0;
      const enriched = {
        ...n,
        degree,
        groupColor,
        groupIndex,
      };
      enriched.role = getNodeRole(enriched);
      return enriched;
    });

    const links = uniqueLinks.map((l) => ({ ...l }));
    return { nodes, links };
  }, [
    vaultIndex,
    mode,
    activeNotePath,
    settings.hideUnresolved,
    settings.showOrphans,
    settings.search,
    settings.localDepth,
    colorGroups,
    hiddenGroups,
  ]);

  const simRef = useRef(null);
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const neighborMapRef = useRef(new Map());
  const cameraRef = useRef({ x: 0, y: 0, k: 0.3 });
  const overviewScaleRef = useRef(0.3);
  const hasFittedRef = useRef(false);

  // Hover + Right-Click Lock + Pinned Peek + Shortest-Path + Fly-To refs
  const hoveredNodeRef = useRef(null);
  const spotlightNodeRef = useRef(null);
  const hoverBlendRef = useRef(0);
  const hoverRafRef = useRef(null);

  const lockedNodeRef = useRef(null);
  const lockDeg1Ref = useRef(new Set());
  const pinnedPeekRef = useRef(null);

  const pathStartRef = useRef(null);
  const pathNodesRef = useRef(new Set());
  const pathEdgesRef = useRef(new Set());

  const soloGroupIdxRef = useRef(null);
  const flyRafRef = useRef(null);
  const pulseRef = useRef(null);
  const pulseRafRef = useRef(null);
  const altKeyRef = useRef(false);
  const lastCursorRef = useRef({ x: 0, y: 0 });
  const lastEmptyTapRef = useRef({ time: 0, x: 0, y: 0 });

  const draggedNodeRef = useRef(null);
  const drawRef = useRef(() => {});
  const settingsRef = useRef(settings);
  const themeRef = useRef(themeColors);
  const activeNoteRef = useRef(visualFocusPath);
  const locateTargetRef = useRef(locateTargetPath);
  const notesByPathRef = useRef(notesByPathMap);
  const onSelectNoteRef = useRef(onSelectNote);
  const isVisibleRef = useRef(isVisible);

  settingsRef.current = settings;
  themeRef.current = themeColors;
  activeNoteRef.current = visualFocusPath;
  locateTargetRef.current = locateTargetPath;
  soloGroupIdxRef.current = soloGroupIdx;
  notesByPathRef.current = notesByPathMap;
  onSelectNoteRef.current = onSelectNote;
  isVisibleRef.current = isVisible;
  pinnedPeekRef.current = pinnedPeek;

  // Razor-sharp native Obsidian pinpoint radii (UNCHANGED)
  const getScreenRadius = (node, camK) => {
    const mult = settingsRef.current.nodeSizeMultiplier || 1;
    const relZoom =
      mode === 'local'
        ? 1.35
        : camK / Math.max(0.04, overviewScaleRef.current);
    const zoomScale = Math.min(2.65, Math.max(0.78, Math.pow(Math.max(0.4, relZoom), 0.38)));

    if (node.unresolved) return 1.3 * mult * zoomScale;

    const deg = Math.max(1, node.degree || 1);
    const base = 1.32 + Math.pow(deg - 1, 0.55) * 0.38;
    return Math.min(3.75, base) * mult * zoomScale;
  };

  const clearAllModes = useCallback(() => {
    pinnedPeekRef.current = null;
    setPinnedPeek(null);
    lockedNodeRef.current = null;
    lockDeg1Ref.current = new Set();
    pathStartRef.current = null;
    pathNodesRef.current = new Set();
    pathEdgesRef.current = new Set();
    setSoloGroupIdx(null);
    setStatusPill(null);
    if (!hoveredNodeRef.current) {
      spotlightNodeRef.current = null;
      hoverBlendRef.current = 0;
    }
    drawRef.current();
  }, []);

  const fitViewToNodes = useCallback(() => {
    const canvas = canvasRef.current;
    const nodes = nodesRef.current;
    if (!canvas || nodes.length === 0) return false;

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const n of nodes) {
      if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }

    if (!Number.isFinite(minX)) return false;

    const spanX = Math.max(200, maxX - minX);
    const spanY = Math.max(200, maxY - minY);
    const pad = mode === 'local' ? 0.68 : 0.88;
    const k = Math.min(
      mode === 'local' ? 1.4 : 1.15,
      Math.max(0.04, Math.min((rect.width * pad) / spanX, (rect.height * pad) / spanY))
    );

    if (mode === 'global') {
      overviewScaleRef.current = k;
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    if (flyRafRef.current) {
      cancelAnimationFrame(flyRafRef.current);
      flyRafRef.current = null;
    }

    cameraRef.current = {
      k,
      x: rect.width / 2 - cx * k,
      y: rect.height / 2 - cy * k,
    };
    hasFittedRef.current = true;
    drawRef.current();
    return true;
  }, [mode]);

  // Smooth camera glide & pulse ring to locate active/last-read note
  const flyToNote = useCallback((targetPath) => {
    const canvas = canvasRef.current;
    if (!canvas || !targetPath) return;
    const targetNode = nodesRef.current.find((n) => n.id === targetPath);
    if (!targetNode || !Number.isFinite(targetNode.x) || !Number.isFinite(targetNode.y)) return;

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    // Re-show visual highlight when user explicitly clicks Crosshair / presses F
    setFocusDismissed(false);
    activeNoteRef.current = targetPath;

    if (flyRafRef.current) cancelAnimationFrame(flyRafRef.current);
    if (pulseRafRef.current) cancelAnimationFrame(pulseRafRef.current);

    const startCam = { ...cameraRef.current };
    const targetK = Math.min(2.8, Math.max(overviewScaleRef.current * 2.75, 0.72));
    const targetX = rect.width / 2 - targetNode.x * targetK;
    const targetY = rect.height / 2 - targetNode.y * targetK;

    const duration = 420;
    const t0 = performance.now();

    const animateCamera = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      cameraRef.current = {
        k: startCam.k + (targetK - startCam.k) * eased,
        x: startCam.x + (targetX - startCam.x) * eased,
        y: startCam.y + (targetY - startCam.y) * eased,
      };
      drawRef.current();
      if (p < 1) {
        flyRafRef.current = requestAnimationFrame(animateCamera);
      } else {
        flyRafRef.current = null;
      }
    };

    flyRafRef.current = requestAnimationFrame(animateCamera);

    const pulseStart = performance.now();
    const pulseDuration = 1200;
    pulseRef.current = { nodeId: targetNode.id, progress: 0 };

    const animatePulse = (now) => {
      const p = Math.min(1, (now - pulseStart) / pulseDuration);
      pulseRef.current = { nodeId: targetNode.id, progress: p };
      drawRef.current();
      if (p < 1) {
        pulseRafRef.current = requestAnimationFrame(animatePulse);
      } else {
        pulseRef.current = null;
        pulseRafRef.current = null;
        drawRef.current();
      }
    };

    pulseRafRef.current = requestAnimationFrame(animatePulse);
  }, []);

  // When switching back to kept-alive Graph tab, fit once if never fitted yet, else redraw exact view
  useEffect(() => {
    if (!isVisible) return;
    const rafId = requestAnimationFrame(() => {
      if (!hasFittedRef.current) {
        fitViewToNodes();
      } else {
        drawRef.current();
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [isVisible, fitViewToNodes]);

  // Keyboard shortcuts: Esc steps back/clears; F flies to active note; Alt toggles passive peek
  useEffect(() => {
    const onKeyDown = (e) => {
      if (!isVisibleRef.current) return;

      if (e.key === 'Alt') {
        altKeyRef.current = true;
        const h = hoveredNodeRef.current;
        if (mode === 'global' && h && !h.unresolved && !pinnedPeekRef.current) {
          const meta = notesByPathRef.current.get(h.path);
          if (meta) {
            const { x, y } = lastCursorRef.current;
            setHoverPeek({
              title: meta.title,
              folder: meta.folder,
              wordCount: meta.wordCount,
              degree: h.degree,
              excerpt: meta.excerpt,
              x: Math.min(window.innerWidth - 340, Math.max(12, x + 16)),
              y: Math.min(window.innerHeight - 210, Math.max(12, y + 16)),
            });
          }
        }
        return;
      }

      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        if (pinnedPeekRef.current) {
          pinnedPeekRef.current = null;
          setPinnedPeek(null);
          if (lockedNodeRef.current) {
            const locked = lockedNodeRef.current;
            const deg1 = lockDeg1Ref.current;
            setStatusPill({
              kind: 'lock',
              text: `Locked: ${locked.title} · ${deg1.size} connected`,
              hint: 'Right-click again for quick preview',
            });
          }
        } else if (
          lockedNodeRef.current ||
          pathNodesRef.current.size > 0 ||
          soloGroupIdxRef.current !== null
        ) {
          clearAllModes();
        } else if (mode === 'global' && activeNoteRef.current) {
          setFocusDismissed(true);
          activeNoteRef.current = null;
          drawRef.current();
        }
      } else if (
        mode === 'global' &&
        e.key.toLowerCase() === 'f' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        if (locateTargetRef.current) {
          e.preventDefault();
          flyToNote(locateTargetRef.current);
        }
      }
    };

    const onKeyUp = (e) => {
      if (e.key === 'Alt') {
        altKeyRef.current = false;
        setHoverPeek(null);
      }
    };

    const onBlur = () => {
      altKeyRef.current = false;
      setHoverPeek(null);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [clearAllModes, flyToNote, mode]);

  useEffect(() => {
    const nodes = graphData.nodes;
    const links = graphData.links;
    const isLocal = mode === 'local';

    const prevPos = new Map(nodesRef.current.map((n) => [n.id, { x: n.x, y: n.y }]));
    for (const n of nodes) {
      const old = prevPos.get(n.id);
      if (old && Number.isFinite(old.x) && Number.isFinite(old.y)) {
        n.x = old.x;
        n.y = old.y;
      }
    }

    if (!isLocal && prevPos.size === 0) {
      seedConstellationPositions(nodes, links, settings.linkDistance);
    }

    const neighborMap = new Map();
    for (const l of links) {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      if (!neighborMap.has(s)) neighborMap.set(s, new Set());
      if (!neighborMap.has(t)) neighborMap.set(t, new Set());
      neighborMap.get(s).add(t);
      neighborMap.get(t).add(s);
    }

    nodesRef.current = nodes;
    linksRef.current = links;
    neighborMapRef.current = neighborMap;

    // Re-validate lock if graph filter changed
    if (lockedNodeRef.current) {
      const stillPresent = nodes.find((n) => n.id === lockedNodeRef.current.id);
      if (stillPresent) {
        lockedNodeRef.current = stillPresent;
        lockDeg1Ref.current = new Set(neighborMap.get(stillPresent.id) || []);
      } else {
        lockedNodeRef.current = null;
        lockDeg1Ref.current = new Set();
        pinnedPeekRef.current = null;
        setPinnedPeek(null);
        setStatusPill(null);
      }
    }

    if (simRef.current) simRef.current.stop();

    const centerPull = isLocal
      ? settings.centerStrength * 0.08
      : settings.centerStrength * 0.125;

    const sim = forceSimulation(nodes)
      .force(
        'link',
        forceLink(links)
          .id((d) => d.id)
          .distance((l) => computeLinkDistance(l, settings.linkDistance, isLocal))
          .strength((l) => computeLinkStrength(l, settings.linkStrength, isLocal))
          .iterations(2)
      )
      .force(
        'charge',
        forceManyBody().strength((d) => computeNodeCharge(d, settings.repelStrength, isLocal))
      )
      .force('x', forceX(0).strength(centerPull))
      .force('y', forceY(0).strength(centerPull))
      .force(
        'collide',
        forceCollide((d) => computeCollideRadius(d, isLocal)).iterations(1)
      )
      .alphaDecay(0.02);

    sim.tick(prevPos.size === 0 ? 340 : 75);
    simRef.current = sim;

    fitViewToNodes();

    sim.on('tick', () => {
      drawRef.current();
    });

    return () => {
      sim.stop();
    };
  }, [graphData, mode, fitViewToNodes]);

  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const isLocal = mode === 'local';

    const linkForce = sim.force('link');
    if (linkForce) {
      linkForce
        .distance((l) => computeLinkDistance(l, settings.linkDistance, isLocal))
        .strength((l) => computeLinkStrength(l, settings.linkStrength, isLocal))
        .iterations(2);
    }
    const chargeForce = sim.force('charge');
    if (chargeForce) {
      chargeForce.strength((d) => computeNodeCharge(d, settings.repelStrength, isLocal));
    }
    const centerPull = isLocal
      ? settings.centerStrength * 0.08
      : settings.centerStrength * 0.125;
    const xForce = sim.force('x');
    const yForce = sim.force('y');
    if (xForce) xForce.strength(centerPull);
    if (yForce) yForce.strength(centerPull);

    sim.alpha(0.4).restart();
  }, [
    settings.linkDistance,
    settings.linkStrength,
    settings.repelStrength,
    settings.centerStrength,
    mode,
  ]);

  useEffect(() => {
    drawRef.current();
  }, [
    themeColors,
    settings.nodeSizeMultiplier,
    settings.lineSizeMultiplier,
    settings.textFadeMultiplier,
    settings.showArrow,
    visualFocusPath,
    soloGroupIdx,
  ]);

  // Smooth 140ms hover/lock spotlight animation + Canvas renderer + full interaction handlers
  // Note: uses onSelectNoteRef so outer App re-renders NEVER tear down listeners or cancel animations.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');

    const isNodeGlowingInLock = (nodeId) => {
      const locked = lockedNodeRef.current;
      if (!locked) return false;
      if (nodeId === locked.id) return true;
      if (lockDeg1Ref.current.has(nodeId)) return true;
      return false;
    };

    const startHoverTransition = (nextNode) => {
      if (nextNode) {
        spotlightNodeRef.current = nextNode;
      }
      hoveredNodeRef.current = nextNode;

      if (lockedNodeRef.current) {
        hoverBlendRef.current = 1;
        draw();
        return;
      }

      if (hoverRafRef.current) {
        cancelAnimationFrame(hoverRafRef.current);
        hoverRafRef.current = null;
      }

      const target = nextNode ? 1 : 0;
      const startVal = hoverBlendRef.current;
      if (Math.abs(target - startVal) < 0.01) {
        hoverBlendRef.current = target;
        if (!nextNode) spotlightNodeRef.current = null;
        draw();
        return;
      }

      const duration = 140;
      const t0 = performance.now();

      const step = (now) => {
        const p = Math.min(1, (now - t0) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        hoverBlendRef.current = startVal + (target - startVal) * eased;
        draw();
        if (p < 1) {
          hoverRafRef.current = requestAnimationFrame(step);
        } else {
          hoverRafRef.current = null;
          if (!hoveredNodeRef.current && !lockedNodeRef.current) {
            spotlightNodeRef.current = null;
          }
          draw();
        }
      };

      hoverRafRef.current = requestAnimationFrame(step);
    };

    const openPinnedPeek = (node, isTouchInput = false) => {
      if (!node || node.unresolved) return;
      const meta = notesByPathRef.current.get(node.path);
      if (!meta) return;

      const rect = wrap.getBoundingClientRect();
      const cam = cameraRef.current;
      const sx = node.x * cam.k + cam.x;
      const sy = node.y * cam.k + cam.y;

      const cardW = Math.min(335, rect.width - 24);
      const cardH = 235;
      let left = sx + 18;
      if (left + cardW > rect.width - 12) {
        left = sx - cardW - 18;
      }
      left = Math.max(12, Math.min(rect.width - cardW - 12, left));

      let top = sy - 36;
      if (top + cardH > rect.height - 56) {
        top = rect.height - cardH - 56;
      }
      top = Math.max(12, top);

      const paper = meta.properties?.paper ? String(meta.properties.paper) : null;
      const peekObj = {
        id: node.id,
        path: meta.path,
        title: meta.title,
        folder: meta.folder,
        paper,
        tags: (meta.tags || []).slice(0, 5),
        wordCount: meta.wordCount || 0,
        degree: node.degree || 0,
        excerpt: meta.excerpt || '',
        left,
        top,
      };
      pinnedPeekRef.current = peekObj;
      setPinnedPeek(peekObj);
      setHoverPeek(null);

      setStatusPill({
        kind: 'lock',
        text: `Preview: ${node.title} · ${lockDeg1Ref.current.size} connected`,
        hint: isTouchInput
          ? 'Tap empty space to hide preview'
          : 'Click empty space to hide preview',
      });
    };

    const closePinnedPeekOnly = (isTouchInput = false) => {
      pinnedPeekRef.current = null;
      setPinnedPeek(null);
      const locked = lockedNodeRef.current;
      if (locked) {
        setStatusPill({
          kind: 'lock',
          text: `Locked: ${locked.title} · ${lockDeg1Ref.current.size} connected`,
          hint: isTouchInput
            ? 'Long-press again to preview · Tap empty to unlock'
            : 'Right-click again to preview · Click empty to unlock',
        });
      }
    };

    const engageLock = (node, isTouchInput = false) => {
      pathStartRef.current = null;
      pathNodesRef.current = new Set();
      pathEdgesRef.current = new Set();
      pinnedPeekRef.current = null;
      setPinnedPeek(null);
      setSoloGroupIdx(null);

      lockedNodeRef.current = node;
      const deg1 = new Set(neighborMapRef.current.get(node.id) || []);
      lockDeg1Ref.current = deg1;
      spotlightNodeRef.current = node;
      hoverBlendRef.current = 1;

      setStatusPill({
        kind: 'lock',
        text: `Locked: ${node.title} · ${deg1.size} connected`,
        hint: isTouchInput
          ? 'Long-press again to preview'
          : 'Right-click again to preview',
      });
      draw();
    };

    const releaseLock = () => {
      pinnedPeekRef.current = null;
      setPinnedPeek(null);
      lockedNodeRef.current = null;
      lockDeg1Ref.current = new Set();
      setStatusPill(null);
      startHoverTransition(null);
    };

    const clearPath = () => {
      pathStartRef.current = null;
      pathNodesRef.current = new Set();
      pathEdgesRef.current = new Set();
      setStatusPill(null);
      draw();
    };

    const handleEmptySpaceTapForDoubleTap = (clientX, clientY) => {
      if (mode !== 'global') return;
      const now = performance.now();
      const prev = lastEmptyTapRef.current;
      const dist = Math.hypot(clientX - prev.x, clientY - prev.y);
      if (now - prev.time < 380 && dist < 40) {
        lastEmptyTapRef.current = { time: 0, x: 0, y: 0 };
        if (activeNoteRef.current) {
          setFocusDismissed(true);
          activeNoteRef.current = null;
          draw();
        }
      } else {
        lastEmptyTapRef.current = { time: now, x: clientX, y: clientY };
      }
    };

    const draw = () => {
      const rect = wrap.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.round(rect.width * dpr);
      const targetH = Math.round(rect.height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const colors = themeRef.current;
      const cfg = settingsRef.current;
      const cam = cameraRef.current;
      const activePath = activeNoteRef.current;
      const hovered = hoveredNodeRef.current;

      // Active highlight priority: Path > Lock > SoloGroup > Hover
      const hasPath = pathNodesRef.current.size > 0;
      const locked = !hasPath ? lockedNodeRef.current : null;
      const lockDeg1 = lockDeg1Ref.current;
      const soloGroup = !hasPath && !locked ? soloGroupIdxRef.current : null;

      const blend = locked ? 1 : hoverBlendRef.current;
      const hoverSpotlight =
        !hasPath && !locked && soloGroup === null && blend > 0.005
          ? spotlightNodeRef.current
          : null;
      const hoverNeighbors = hoverSpotlight
        ? neighborMapRef.current.get(hoverSpotlight.id)
        : null;

      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, rect.width, rect.height);

      const toScreenX = (wx) => wx * cam.k + cam.x;
      const toScreenY = (wy) => wy * cam.k + cam.y;

      const relZoom =
        mode === 'local'
          ? 1.4
          : cam.k / Math.max(0.04, overviewScaleRef.current);

      const zoomLineScale = Math.min(1.7, Math.max(0.85, Math.pow(Math.max(0.5, relZoom), 0.24)));
      const baseLineWidth = Math.max(0.4, 0.56 * (cfg.lineSizeMultiplier || 1) * zoomLineScale);

      // 1. Draw translucent hairline edges
      for (const l of linksRef.current) {
        const s = l.source;
        const t = l.target;
        if (typeof s !== 'object' || typeof t !== 'object') continue;

        const sx = toScreenX(s.x);
        const sy = toScreenY(s.y);
        const tx = toScreenX(t.x);
        const ty = toScreenY(t.y);

        if (
          (sx < -60 && tx < -60) ||
          (sx > rect.width + 60 && tx > rect.width + 60) ||
          (sy < -60 && ty < -60) ||
          (sy > rect.height + 60 && ty > rect.height + 60)
        ) {
          continue;
        }

        const baseAlpha = l.unresolved ? 0.14 : 0.48;
        let alpha = baseAlpha;
        let lineWidth = baseLineWidth;
        let stroke = colors.line;

        if (hasPath) {
          const eKey = makeEdgePairKey(s.id, t.id);
          if (pathEdgesRef.current.has(eKey)) {
            alpha = 0.96;
            lineWidth = baseLineWidth * 2.25;
            stroke = colors.lineActive;
          } else {
            alpha = baseAlpha * 0.1;
          }
        } else if (locked) {
          const isDeg1Edge = s.id === locked.id || t.id === locked.id;
          if (isDeg1Edge) {
            alpha = 0.94;
            lineWidth = baseLineWidth * 1.75;
            stroke = colors.lineActive;
          } else {
            alpha = baseAlpha * 0.12;
          }
        } else if (soloGroup !== null) {
          if (s.groupIndex === soloGroup && t.groupIndex === soloGroup) {
            alpha = 0.78;
            lineWidth = baseLineWidth * 1.3;
          } else if (s.groupIndex === soloGroup || t.groupIndex === soloGroup) {
            alpha = 0.25;
          } else {
            alpha = baseAlpha * 0.1;
          }
        } else if (hoverSpotlight) {
          const isConnected = s.id === hoverSpotlight.id || t.id === hoverSpotlight.id;
          if (isConnected) {
            alpha = baseAlpha + (0.94 - baseAlpha) * blend;
            lineWidth = baseLineWidth * (1 + 0.75 * blend);
            if (blend > 0.25) stroke = colors.lineActive;
          } else {
            alpha = baseAlpha * (1 - 0.88 * blend);
          }
        }

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lineWidth;

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
        ctx.stroke();

        if (cfg.showArrow) {
          const drawArrow = (fromX, fromY, toX, toY, targetNode) => {
            const angle = Math.atan2(toY - fromY, toX - fromX);
            const tr = getScreenRadius(targetNode, cam.k) + 2.5;
            const ax = toX - Math.cos(angle) * tr;
            const ay = toY - Math.sin(angle) * tr;
            const arrowLen = 5.5;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(
              ax - arrowLen * Math.cos(angle - Math.PI / 6),
              ay - arrowLen * Math.sin(angle - Math.PI / 6)
            );
            ctx.lineTo(
              ax - arrowLen * Math.cos(angle + Math.PI / 6),
              ay - arrowLen * Math.sin(angle + Math.PI / 6)
            );
            ctx.closePath();
            ctx.fillStyle = stroke;
            ctx.fill();
          };
          drawArrow(sx, sy, tx, ty, t);
          if (l.bidirectional) {
            drawArrow(tx, ty, sx, sy, s);
          }
        }
        ctx.restore();
      }

      // 2. Draw crisp pinpoint nodes
      for (const n of nodesRef.current) {
        if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
        const sx = toScreenX(n.x);
        const sy = toScreenY(n.y);
        if (sx < -30 || sx > rect.width + 30 || sy < -30 || sy > rect.height + 30) {
          continue;
        }

        const r = getScreenRadius(n, cam.k);
        const isActiveNote = activePath && n.id === activePath;
        const isHovered = hovered && hovered.id === n.id;

        let nodeAlpha = 1;
        let drawR = r;
        let ringAlpha = 0;

        if (hasPath) {
          const onPath = pathNodesRef.current.has(n.id);
          if (onPath) {
            drawR = r * 1.35;
            ringAlpha = 0.95;
          } else {
            nodeAlpha = 0.14;
          }
        } else if (locked) {
          const isPrimary = n.id === locked.id;
          const isDeg1 = lockDeg1.has(n.id);

          if (isPrimary) {
            drawR = r * 1.32;
            ringAlpha = 1;
          } else if (isDeg1) {
            drawR = isHovered ? r * 1.28 : r;
            ringAlpha = isHovered ? 0.9 : 0;
          } else {
            nodeAlpha = 0.15;
          }
        } else if (soloGroup !== null) {
          if (n.groupIndex !== soloGroup) {
            nodeAlpha = 0.14;
          } else if (isHovered) {
            drawR = r * 1.25;
            ringAlpha = 0.9;
          }
        } else if (hoverSpotlight) {
          const isSpot = hoverSpotlight.id === n.id;
          const isNb = hoverNeighbors?.has(n.id);
          if (!isSpot && !isNb) {
            nodeAlpha = 1 - 0.84 * blend;
          }
          if (isSpot) {
            drawR = r * (1 + 0.3 * blend);
            ringAlpha = blend;
          }
        }

        ctx.save();
        ctx.globalAlpha = nodeAlpha;

        ctx.beginPath();
        ctx.arc(sx, sy, drawR, 0, Math.PI * 2);
        ctx.fillStyle = n.unresolved
          ? colors.nodeUnresolved
          : n.groupColor || colors.nodeDefault;
        ctx.fill();

        if (ringAlpha > 0.05) {
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = colors.accent;
          ctx.globalAlpha = ringAlpha;
          ctx.stroke();
        } else if (isActiveNote && nodeAlpha > 0.5) {
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = colors.accent;
          ctx.stroke();
        }

        // Expanding radar pulse ring when locating active note via Fly-To
        if (pulseRef.current && pulseRef.current.nodeId === n.id) {
          const pp = pulseRef.current.progress;
          const ringR = drawR + 4 + pp * 28;
          ctx.beginPath();
          ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
          ctx.lineWidth = 2 * (1 - pp * 0.6);
          ctx.strokeStyle = colors.accent;
          ctx.globalAlpha = Math.max(0, (1 - pp) * 0.9);
          ctx.stroke();
        }

        ctx.restore();
      }

      // 3. True Obsidian text-fade threshold (UNCHANGED)
      const fadeShift = Math.pow(1.42, cfg.textFadeMultiplier || 0);
      const baseStartZoom = 1.85 * fadeShift;
      const fadeSpan = 1.15 * fadeShift;

      const labelCandidates = [];
      for (const n of nodesRef.current) {
        if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
        const sx = toScreenX(n.x);
        const sy = toScreenY(n.y);
        if (sx < -120 || sx > rect.width + 120 || sy < -50 || sy > rect.height + 50) {
          continue;
        }

        const isActiveNote = activePath && n.id === activePath;
        const isHovered = hovered && hovered.id === n.id;

        let alpha = 0;
        if (mode === 'local') {
          alpha = 0.92;
        } else {
          const roleFactor =
            n.role === 'hub'
              ? 0.72
              : n.role === 'trivia'
                ? 0.86
                : n.role === 'chapter'
                  ? 1.02
                  : 1.24;
          const nodeStart = baseStartZoom * roleFactor;
          const rawT = (relZoom - nodeStart) / Math.max(0.35, fadeSpan);
          const clamped = Math.min(1, Math.max(0, rawT));
          alpha = clamped * clamped * (3 - 2 * clamped);
        }

        let isFocal = false;
        let isBoostedNeighbor = false;

        if (hasPath) {
          if (pathNodesRef.current.has(n.id)) {
            alpha = 1;
            isFocal = true;
          } else {
            alpha *= 0.08;
          }
        } else if (locked) {
          const isPrimary = n.id === locked.id;
          const isDeg1 = lockDeg1.has(n.id);
          if (isPrimary) {
            alpha = 1;
            isFocal = true;
          } else if (isDeg1) {
            alpha = isHovered ? 1 : Math.max(alpha, relZoom > 1.25 ? 0.85 : 0.55);
            isFocal = isHovered;
            isBoostedNeighbor = true;
          } else {
            alpha *= 0.1;
          }
        } else if (soloGroup !== null) {
          if (n.groupIndex === soloGroup) {
            alpha = isHovered ? 1 : Math.max(alpha, 0.72);
            isFocal = isHovered;
          } else {
            alpha *= 0.08;
          }
        } else if (hoverSpotlight) {
          const isSpot = hoverSpotlight.id === n.id;
          const isNb = hoverNeighbors?.has(n.id);
          if (isSpot) {
            alpha = Math.max(alpha, blend);
            isFocal = true;
          } else if (isNb) {
            alpha = Math.max(alpha, blend * (relZoom > 1.25 ? 0.85 : 0.55));
            isBoostedNeighbor = true;
          } else {
            alpha *= 1 - 0.9 * blend;
          }
        }

        if (isActiveNote && !hasPath && !locked && soloGroup === null) {
          alpha = Math.max(alpha, 0.95);
        }

        if (alpha <= 0.03) continue;

        const priority = isFocal
          ? 10000
          : isActiveNote
            ? 5000
            : isBoostedNeighbor
              ? 2000 + (n.degree || 0)
              : (n.role === 'hub' ? 1000 : n.role === 'trivia' ? 500 : 100) +
                (n.degree || 0);

        labelCandidates.push({
          node: n,
          sx,
          sy,
          alpha,
          priority,
          isFocal,
          isActiveNote,
        });
      }

      labelCandidates.sort((a, b) => b.priority - a.priority);

      const placedBoxes = [];
      const baseFontSize =
        mode === 'local'
          ? 11.5
          : Math.min(12.2, Math.max(10.2, 9.8 + Math.log2(Math.max(1, relZoom)) * 1.05));
      const baseWrapWidth = Math.round(
        Math.min(185, Math.max(135, 130 + Math.log2(Math.max(1, relZoom)) * 22))
      );

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      for (const item of labelCandidates) {
        const { node, sx, sy, alpha, isFocal, isActiveNote } = item;
        const fontSize = isFocal ? 12.8 : node.role === 'hub' ? baseFontSize + 0.7 : baseFontSize;
        const fontWeight = isFocal || node.role === 'hub' ? '500' : '400';
        const wrapW = isFocal ? 220 : baseWrapWidth;

        ctx.font = `${fontWeight} ${fontSize.toFixed(1)}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        const lines = wrapLabelLines(ctx, node.title, wrapW, isFocal ? 3 : 2);
        if (lines.length === 0) continue;

        let maxLineW = 0;
        for (const line of lines) {
          const w = ctx.measureText(line).width;
          if (w > maxLineW) maxLineW = w;
        }

        const r = getScreenRadius(node, cam.k);
        const lineHeight = fontSize * 1.28;
        const startY = sy + (isFocal ? r * 1.3 : r) + 5;
        const boxPadX = 6;
        const boxPadY = 3;
        const x1 = sx - maxLineW / 2 - boxPadX;
        const x2 = sx + maxLineW / 2 + boxPadX;
        const y1 = startY - boxPadY;
        const y2 = startY + lines.length * lineHeight + boxPadY;

        if (!isFocal && !isActiveNote) {
          let overlaps = false;
          for (let i = 0; i < placedBoxes.length; i++) {
            const b = placedBoxes[i];
            if (x1 < b[2] && x2 > b[0] && y1 < b[3] && y2 > b[1]) {
              overlaps = true;
              break;
            }
          }
          if (overlaps) continue;
        }

        placedBoxes.push([x1, y1, x2, y2]);

        ctx.save();
        ctx.globalAlpha = isFocal ? Math.min(1, alpha) : alpha * 0.9;
        ctx.fillStyle = isFocal
          ? colors.isLight
            ? '#111111'
            : '#f3f3f3'
          : colors.text;

        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], sx, startY + i * lineHeight);
        }
        ctx.restore();
      }

      ctx.restore();
    };

    drawRef.current = draw;
    draw();

    const resizeObs = new ResizeObserver(() => {
      if (!isVisibleRef.current) return;
      if (!hasFittedRef.current && nodesRef.current.length > 0) {
        fitViewToNodes();
      } else {
        draw();
      }
    });
    resizeObs.observe(wrap);

    const hitTestNode = (clientX, clientY, isTouch = false) => {
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const cam = cameraRef.current;
      const hitPad = isTouch ? 15 : 6;

      let best = null;
      let bestDistSq = Infinity;

      for (let i = nodesRef.current.length - 1; i >= 0; i--) {
        const n = nodesRef.current[i];
        const sx = n.x * cam.k + cam.x;
        const sy = n.y * cam.k + cam.y;
        const r = getScreenRadius(n, cam.k) + hitPad;
        const dx = px - sx;
        const dy = py - sy;
        const distSq = dx * dx + dy * dy;
        if (distSq <= r * r && distSq < bestDistSq) {
          best = n;
          bestDistSq = distSq;
        }
      }
      return best;
    };

    const activePointers = new Map();
    let isPanning = false;
    let startClient = { x: 0, y: 0 };
    let startCam = { x: 0, y: 0 };
    let movedDist = 0;
    let lastPinchDist = null;
    let longPressTimer = null;
    let isLongPress = false;
    let touchTargetNode = null;
    let pendingDismissAction = null; // 'peek' | 'unlock' | 'path' | null

    const clearLongPressTimer = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const handleShiftPathClick = (hit) => {
      pinnedPeekRef.current = null;
      setPinnedPeek(null);
      lockedNodeRef.current = null;
      lockDeg1Ref.current = new Set();
      setSoloGroupIdx(null);

      if (!pathStartRef.current || pathNodesRef.current.size > 1) {
        pathStartRef.current = hit;
        pathNodesRef.current = new Set([hit.id]);
        pathEdgesRef.current = new Set();
        setStatusPill({
          kind: 'path',
          text: `Synapse Tracer: "${hit.title}" → Shift+Click any second note`,
        });
        draw();
        return;
      }

      if (pathStartRef.current.id === hit.id) {
        clearPath();
        return;
      }

      const startNode = pathStartRef.current;
      const chain = findShortestPath(startNode.id, hit.id, neighborMapRef.current);
      if (!chain) {
        pathNodesRef.current = new Set([startNode.id, hit.id]);
        pathEdgesRef.current = new Set();
        setStatusPill({
          kind: 'path',
          text: `No connecting path between "${startNode.title}" and "${hit.title}"`,
        });
        draw();
        return;
      }

      const edgeSet = new Set();
      for (let i = 0; i < chain.length - 1; i++) {
        edgeSet.add(makeEdgePairKey(chain[i], chain[i + 1]));
      }
      pathNodesRef.current = new Set(chain);
      pathEdgesRef.current = edgeSet;

      const nodeMap = new Map(nodesRef.current.map((n) => [n.id, n]));
      const chainItems = chain.map((id) => {
        const n = nodeMap.get(id);
        return {
          path: n?.path || id,
          title: n?.title || id,
          unresolved: Boolean(n?.unresolved),
        };
      });

      setStatusPill({
        kind: 'path-chain',
        hops: chain.length - 1,
        chain: chainItems,
      });
      draw();
    };

    const onPointerDown = (e) => {
      if (flyRafRef.current) {
        cancelAnimationFrame(flyRafRef.current);
        flyRafRef.current = null;
      }

      // Desktop Right-Click / Two-Finger Trackpad Tap:
      // 1st tap on node -> Lock 1st-degree connections
      // 2nd tap on SAME locked node -> Open interactive Quick Peek Card
      // Tap on empty space -> 2-step rewind (Peek -> Lock -> Normal)
      if (e.pointerType === 'mouse' && e.button === 2 && mode === 'global') {
        e.preventDefault();
        const hit = hitTestNode(e.clientX, e.clientY, false);
        if (hit) {
          if (lockedNodeRef.current && lockedNodeRef.current.id === hit.id) {
            if (pinnedPeekRef.current && pinnedPeekRef.current.id === hit.id) {
              closePinnedPeekOnly(false);
            } else {
              openPinnedPeek(hit, false);
            }
          } else {
            engageLock(hit, false);
          }
        } else {
          if (pinnedPeekRef.current) {
            closePinnedPeekOnly(false);
          } else if (lockedNodeRef.current) {
            releaseLock();
          } else if (pathNodesRef.current.size > 0) {
            clearPath();
          }
        }
        return;
      }

      if (e.button !== 0 && e.button !== 1 && e.pointerType === 'mouse') return;

      const isTouch = e.pointerType === 'touch';
      const hit = hitTestNode(e.clientX, e.clientY, isTouch);

      // Shift + Click Shortest-Path Synapse Tracer
      if (mode === 'global' && !isTouch && e.shiftKey && e.button === 0) {
        if (hit && !hit.unresolved) {
          handleShiftPathClick(hit);
        } else if (pathNodesRef.current.size > 0) {
          clearPath();
        }
        return;
      }

      canvas.setPointerCapture(e.pointerId);
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 2) {
        clearLongPressTimer();
        isLongPress = false;
        touchTargetNode = null;
        draggedNodeRef.current = null;
        pendingDismissAction = null;
        if (!lockedNodeRef.current) startHoverTransition(null);
        isPanning = false;
        const pts = [...activePointers.values()];
        lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        return;
      }

      startClient = { x: e.clientX, y: e.clientY };
      startCam = { x: cameraRef.current.x, y: cameraRef.current.y };
      movedDist = 0;
      isLongPress = false;
      touchTargetNode = null;
      pendingDismissAction = null;

      if (isTouch) {
        if (hit) {
          // If locked or path active and user taps a non-glowing node: step back on tap
          if (lockedNodeRef.current && !isNodeGlowingInLock(hit.id)) {
            pendingDismissAction = pinnedPeekRef.current ? 'peek' : 'unlock';
            isPanning = true;
            return;
          }
          if (pathNodesRef.current.size > 0 && !pathNodesRef.current.has(hit.id)) {
            pendingDismissAction = 'path';
            isPanning = true;
            return;
          }
          touchTargetNode = hit;
          clearLongPressTimer();
          longPressTimer = setTimeout(() => {
            isLongPress = true;
            if (mode === 'global') {
              if (lockedNodeRef.current && lockedNodeRef.current.id === hit.id) {
                if (pinnedPeekRef.current && pinnedPeekRef.current.id === hit.id) {
                  closePinnedPeekOnly(true);
                } else {
                  openPinnedPeek(hit, true);
                }
              } else {
                engageLock(hit, true);
              }
            } else {
              startHoverTransition(hit);
            }
          }, 260);
        } else {
          if (pinnedPeekRef.current) {
            pendingDismissAction = 'peek';
          } else if (lockedNodeRef.current) {
            pendingDismissAction = 'unlock';
          } else if (pathNodesRef.current.size > 0) {
            pendingDismissAction = 'path';
          } else {
            startHoverTransition(null);
          }
          isPanning = true;
        }
        return;
      }

      // Desktop left/middle click when a Lock or Shortest-Path is active
      if (lockedNodeRef.current) {
        if (hit && isNodeGlowingInLock(hit.id)) {
          draggedNodeRef.current = hit;
          hit.fx = hit.x;
          hit.fy = hit.y;
          simRef.current?.alphaTarget(0.25).restart();
        } else {
          // 2-step empty/dimmed-space dismiss: first closes Peek Card, next unlocks Lock
          pendingDismissAction = pinnedPeekRef.current ? 'peek' : 'unlock';
          isPanning = true;
        }
        return;
      }

      if (pathNodesRef.current.size > 0) {
        if (hit && pathNodesRef.current.has(hit.id)) {
          draggedNodeRef.current = hit;
          hit.fx = hit.x;
          hit.fy = hit.y;
          simRef.current?.alphaTarget(0.25).restart();
        } else {
          pendingDismissAction = 'path';
          isPanning = true;
        }
        return;
      }

      if (hit) {
        draggedNodeRef.current = hit;
        startHoverTransition(hit);
        hit.fx = hit.x;
        hit.fy = hit.y;
        simRef.current?.alphaTarget(0.25).restart();
      } else {
        isPanning = true;
      }
    };

    const onPointerMove = (e) => {
      lastCursorRef.current = { x: e.clientX, y: e.clientY };

      if (activePointers.has(e.pointerId)) {
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      if (activePointers.size === 2) {
        const pts = [...activePointers.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        if (lastPinchDist && dist > 0) {
          const rect = canvas.getBoundingClientRect();
          const midX = (pts[0].x + pts[1].x) / 2 - rect.left;
          const midY = (pts[0].y + pts[1].y) / 2 - rect.top;
          const cam = cameraRef.current;
          const nextK = Math.min(8, Math.max(0.03, cam.k * (dist / lastPinchDist)));
          const ratio = nextK / cam.k;
          cam.x = midX - (midX - cam.x) * ratio;
          cam.y = midY - (midY - cam.y) * ratio;
          cam.k = nextK;
          draw();
        }
        lastPinchDist = dist;
        return;
      }

      const distFromStart = Math.hypot(e.clientX - startClient.x, e.clientY - startClient.y);

      if (e.pointerType === 'touch' && touchTargetNode && !draggedNodeRef.current && distFromStart > 7) {
        clearLongPressTimer();
        isLongPress = true;
        if (!lockedNodeRef.current) startHoverTransition(touchTargetNode);
        draggedNodeRef.current = touchTargetNode;
        touchTargetNode.fx = touchTargetNode.x;
        touchTargetNode.fy = touchTargetNode.y;
        simRef.current?.alphaTarget(0.2).restart();
      }

      if (draggedNodeRef.current) {
        const rect = canvas.getBoundingClientRect();
        const cam = cameraRef.current;
        movedDist = distFromStart;
        draggedNodeRef.current.fx = (e.clientX - rect.left - cam.x) / cam.k;
        draggedNodeRef.current.fy = (e.clientY - rect.top - cam.y) / cam.k;
        draw();
        return;
      }

      if (isPanning) {
        const dx = e.clientX - startClient.x;
        const dy = e.clientY - startClient.y;
        movedDist = Math.hypot(dx, dy);
        cameraRef.current.x = startCam.x + dx;
        cameraRef.current.y = startCam.y + dy;
        draw();
        return;
      }

      if (e.pointerType !== 'touch') {
        const hit = hitTestNode(e.clientX, e.clientY, false);

        // Passive Alt+Hover Quick Peek Card (only when no pinned peek card is open)
        if (
          mode === 'global' &&
          !pinnedPeekRef.current &&
          (e.altKey || altKeyRef.current) &&
          hit &&
          !hit.unresolved
        ) {
          const meta = notesByPathRef.current.get(hit.path);
          if (meta) {
            setHoverPeek({
              title: meta.title,
              folder: meta.folder,
              wordCount: meta.wordCount,
              degree: hit.degree,
              excerpt: meta.excerpt,
              x: Math.min(window.innerWidth - 340, Math.max(12, e.clientX + 16)),
              y: Math.min(window.innerHeight - 210, Math.max(12, e.clientY + 16)),
            });
          }
        } else {
          setHoverPeek((prev) => (prev ? null : prev));
        }

        if (hit !== hoveredNodeRef.current) {
          let clickable = Boolean(hit && !hit.unresolved);
          if (clickable && lockedNodeRef.current && !isNodeGlowingInLock(hit.id)) {
            clickable = false;
          }
          if (clickable && pathNodesRef.current.size > 0 && !pathNodesRef.current.has(hit.id)) {
            clickable = false;
          }
          canvas.style.cursor = clickable ? 'pointer' : 'grab';
          startHoverTransition(hit);
        }
      }
    };

    const onPointerUp = (e) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) lastPinchDist = null;
      clearLongPressTimer();

      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      if (e.pointerType === 'touch') {
        const dragged = draggedNodeRef.current;
        if (dragged) {
          dragged.fx = null;
          dragged.fy = null;
          draggedNodeRef.current = null;
          simRef.current?.alphaTarget(0);
        }

        if (pendingDismissAction && movedDist < 7) {
          if (pendingDismissAction === 'peek') closePinnedPeekOnly(true);
          else if (pendingDismissAction === 'unlock') releaseLock();
          else if (pendingDismissAction === 'path') clearPath();
        } else if (
          !isLongPress &&
          touchTargetNode &&
          movedDist < 7 &&
          !touchTargetNode.unresolved &&
          onSelectNoteRef.current
        ) {
          const target = touchTargetNode;
          touchTargetNode = null;
          pinnedPeekRef.current = null;
          setPinnedPeek(null);
          onSelectNoteRef.current(target.path, false);
        } else if (!touchTargetNode && !pendingDismissAction && movedDist < 7) {
          handleEmptySpaceTapForDoubleTap(e.clientX, e.clientY);
        }

        pendingDismissAction = null;
        isLongPress = false;
        touchTargetNode = null;
        isPanning = false;
        return;
      }

      const dragged = draggedNodeRef.current;
      if (dragged) {
        dragged.fx = null;
        dragged.fy = null;
        draggedNodeRef.current = null;
        simRef.current?.alphaTarget(0);

        if (movedDist < 5 && !dragged.unresolved && onSelectNoteRef.current) {
          pinnedPeekRef.current = null;
          setPinnedPeek(null);
          onSelectNoteRef.current(dragged.path, e.ctrlKey || e.metaKey || e.button === 1);
        }
      } else if (pendingDismissAction && movedDist < 5) {
        if (pendingDismissAction === 'peek') closePinnedPeekOnly(false);
        else if (pendingDismissAction === 'unlock') releaseLock();
        else if (pendingDismissAction === 'path') clearPath();
      } else if (!pendingDismissAction && movedDist < 5 && e.button === 0) {
        handleEmptySpaceTapForDoubleTap(e.clientX, e.clientY);
      }

      pendingDismissAction = null;
      isPanning = false;
    };

    const onPointerLeave = () => {
      setHoverPeek(null);
      if (!draggedNodeRef.current && hoveredNodeRef.current) {
        canvas.style.cursor = 'grab';
        startHoverTransition(null);
      }
    };

    const onWheel = (e) => {
      e.preventDefault();
      if (flyRafRef.current) {
        cancelAnimationFrame(flyRafRef.current);
        flyRafRef.current = null;
      }
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 28;
      else if (e.deltaMode === 2) dy *= 240;
      dy = Math.max(-180, Math.min(180, dy));

      const cam = cameraRef.current;
      const factor = Math.exp(-dy * 0.0018);
      const nextK = Math.min(8, Math.max(0.03, cam.k * factor));
      const scaleRatio = nextK / cam.k;

      cam.x = sx - (sx - cam.x) * scaleRatio;
      cam.y = sy - (sy - cam.y) * scaleRatio;
      cam.k = nextK;
      draw();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      clearLongPressTimer();
      if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current);
      if (flyRafRef.current) cancelAnimationFrame(flyRafRef.current);
      if (pulseRafRef.current) cancelAnimationFrame(pulseRafRef.current);
      resizeObs.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [mode, fitViewToNodes]);

  const toggleGroupVisibility = (idx, e) => {
    e.stopPropagation();
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
    if (soloGroupIdx === idx) setSoloGroupIdx(null);
  };

  const toggleGroupSolo = (idx) => {
    if (hiddenGroups.has(idx)) return;
    if (lockedNodeRef.current) {
      lockedNodeRef.current = null;
      lockDeg1Ref.current = new Set();
    }
    pinnedPeekRef.current = null;
    setPinnedPeek(null);
    pathStartRef.current = null;
    pathNodesRef.current = new Set();
    pathEdgesRef.current = new Set();
    setStatusPill(null);
    setSoloGroupIdx((prev) => (prev === idx ? null : idx));
  };

  return (
    <div className="obs-graph-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="obs-graph-canvas"
        onContextMenu={(e) => e.preventDefault()}
        style={{
          WebkitTouchCallout: 'none',
          WebkitUserSelect: 'none',
          userSelect: 'none',
        }}
      />

      {/* Top-right Obsidian Graph Controls */}
      <div className="obs-graph-controls-bar">
        <button
          className={`obs-icon-btn ${panelOpen ? 'is-active' : ''}`}
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}
          onClick={() => setPanelOpen((p) => !p)}
          title="Graph settings"
        >
          <Settings size={15} />
        </button>
        <button
          className="obs-icon-btn"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}
          onClick={fitViewToNodes}
          title="Fit graph to view"
        >
          <Maximize2 size={14} />
        </button>
        {mode === 'global' && locateTargetPath && (
          <button
            className="obs-icon-btn"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}
            onClick={() => flyToNote(locateTargetPath)}
            title="Locate last-opened note in graph (F)"
          >
            <Crosshair size={14} />
          </button>
        )}
        <button
          className="obs-icon-btn"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}
          onClick={() => simRef.current?.alpha(0.8).restart()}
          title="Animate / Re-layout graph"
        >
          <Sparkles size={14} />
        </button>
      </div>

      {/* Subtle Bottom Status Pill (Lock status or Clickable Shortest-Path Hop Trail) */}
      {mode === 'global' && statusPill && (
        <div className="obs-graph-pill">
          {statusPill.kind === 'path-chain' ? (
            <div className="obs-graph-pill-content">
              <span style={{ color: 'var(--text-muted)', fontWeight: 500, flexShrink: 0 }}>
                {statusPill.hops} {statusPill.hops === 1 ? 'hop' : 'hops'}:
              </span>
              {statusPill.chain.map((step, i) => (
                <React.Fragment key={`${step.path}-${i}`}>
                  <button
                    type="button"
                    className="obs-hop-btn"
                    title={step.title}
                    onClick={(e) => {
                      if (!step.unresolved && onSelectNoteRef.current) {
                        onSelectNoteRef.current(step.path, e.ctrlKey || e.metaKey);
                      }
                    }}
                    onAuxClick={(e) => {
                      if (e.button === 1 && !step.unresolved && onSelectNoteRef.current) {
                        onSelectNoteRef.current(step.path, true);
                      }
                    }}
                  >
                    {step.title}
                  </button>
                  {i < statusPill.chain.length - 1 && (
                    <span className="obs-hop-sep">→</span>
                  )}
                </React.Fragment>
              ))}
            </div>
          ) : (
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {statusPill.text}
              {statusPill.hint && (
                <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
                  · {statusPill.hint}
                </span>
              )}
            </span>
          )}
          <button
            className="obs-icon-btn"
            style={{ width: 20, height: 20 }}
            onClick={clearAllModes}
            title="Clear (Esc)"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Pinned Interactive Quick Peek Card (2nd two-finger tap / 2nd long-press) */}
      {mode === 'global' && pinnedPeek && (
        <div
          className="obs-graph-peek"
          style={{ left: pinnedPeek.left, top: pinnedPeek.top }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="obs-graph-peek-head">
            <div style={{ minWidth: 0 }}>
              <div className="obs-hover-preview-title" style={{ marginBottom: 2 }}>
                {pinnedPeek.title}
              </div>
              <div className="obs-hover-preview-folder" style={{ marginBottom: 0 }}>
                {pinnedPeek.folder || 'Vault root'} · {pinnedPeek.degree} links ·{' '}
                {pinnedPeek.wordCount.toLocaleString()} words
              </div>
            </div>
            <button
              className="obs-icon-btn"
              style={{ width: 22, height: 22 }}
              onClick={() => {
                pinnedPeekRef.current = null;
                setPinnedPeek(null);
                if (lockedNodeRef.current) {
                  setStatusPill({
                    kind: 'lock',
                    text: `Locked: ${lockedNodeRef.current.title} · ${lockDeg1Ref.current.size} connected`,
                    hint: 'Right-click again to preview',
                  });
                }
              }}
              title="Close preview (keeps nodes highlighted)"
            >
              <X size={13} />
            </button>
          </div>

          {(pinnedPeek.paper || pinnedPeek.tags.length > 0) && (
            <div className="obs-graph-peek-tags">
              {pinnedPeek.paper && (
                <span className="obs-props-chip">{pinnedPeek.paper}</span>
              )}
              {pinnedPeek.tags.map((t) => (
                <span key={t} className="obs-tag-pill" style={{ cursor: 'default' }}>
                  #{t}
                </span>
              ))}
            </div>
          )}

          {pinnedPeek.excerpt && (
            <div className="obs-hover-preview-body">{pinnedPeek.excerpt}</div>
          )}

          <div className="obs-graph-peek-actions">
            <button
              type="button"
              className="obs-graph-peek-open"
              onClick={(e) => {
                const targetPath = pinnedPeek.path;
                pinnedPeekRef.current = null;
                setPinnedPeek(null);
                if (onSelectNoteRef.current) {
                  onSelectNoteRef.current(targetPath, e.ctrlKey || e.metaKey);
                }
              }}
              onAuxClick={(e) => {
                if (e.button === 1 && onSelectNoteRef.current) {
                  onSelectNoteRef.current(pinnedPeek.path, true);
                }
              }}
            >
              <ExternalLink size={12} />
              <span>Open note</span>
            </button>
          </div>
        </div>
      )}

      {/* Passive Alt + Hover Quick Peek Card (desktop) */}
      {mode === 'global' && hoverPeek && !pinnedPeek && (
        <div
          className="obs-hover-preview"
          style={{
            left: hoverPeek.x,
            top: hoverPeek.y,
            width: 320,
            maxHeight: 195,
            pointerEvents: 'none',
          }}
        >
          <div className="obs-hover-preview-title">{hoverPeek.title}</div>
          <div className="obs-hover-preview-folder">
            {hoverPeek.folder || 'Vault root'} · {hoverPeek.degree} links ·{' '}
            {(hoverPeek.wordCount || 0).toLocaleString()} words
          </div>
          {hoverPeek.excerpt && (
            <div className="obs-hover-preview-body">{hoverPeek.excerpt}</div>
          )}
        </div>
      )}

      {/* Collapsible Graph Settings Panel */}
      {panelOpen && (
        <div className="obs-graph-panel">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 10,
            }}
          >
            <strong style={{ color: 'var(--text-bright)', fontSize: 12.5 }}>
              Graph Settings
            </strong>
            <button
              className="obs-icon-btn"
              style={{ width: 22, height: 22 }}
              onClick={() => setPanelOpen(false)}
            >
              <X size={13} />
            </button>
          </div>

          <div className="obs-graph-section">
            <div className="obs-graph-section-title">Filters</div>
            {mode === 'global' && (
              <div className="obs-search-box" style={{ margin: '0 0 8px' }}>
                <input
                  className="obs-search-input"
                  placeholder="Filter (path:, tag:#...)"
                  value={settings.search}
                  onChange={(e) => setSettings((s) => ({ ...s, search: e.target.value }))}
                />
              </div>
            )}

            {mode === 'local' && (
              <div className="obs-slider-row">
                <div className="obs-slider-head">
                  <span>Depth</span>
                  <strong>{settings.localDepth}</strong>
                </div>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={1}
                  value={settings.localDepth}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, localDepth: Number(e.target.value) }))
                  }
                />
              </div>
            )}

            <label className="obs-toggle-row">
              <span>Existing files only</span>
              <input
                type="checkbox"
                checked={settings.hideUnresolved}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, hideUnresolved: e.target.checked }))
                }
              />
            </label>
            <label className="obs-toggle-row">
              <span>Orphans</span>
              <input
                type="checkbox"
                checked={settings.showOrphans}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, showOrphans: e.target.checked }))
                }
              />
            </label>
          </div>

          {colorGroups.length > 0 && (
            <div className="obs-graph-section">
              <div className="obs-graph-section-title">
                Groups {soloGroupIdx !== null && '(Solo active)'}
              </div>
              {colorGroups.map((g, i) => {
                const isHidden = hiddenGroups.has(i);
                const isSolo = soloGroupIdx === i;
                return (
                  <div
                    key={i}
                    className={`obs-graph-legend-item ${isSolo ? 'is-solo' : ''} ${isHidden ? 'is-hidden' : ''}`}
                    style={{
                      justifyContent: 'space-between',
                      cursor: mode === 'global' ? 'pointer' : 'default',
                      padding: '3px 5px',
                      borderRadius: 4,
                      background: isSolo ? 'var(--bg-modifier-selected)' : 'transparent',
                      opacity: isHidden ? 0.42 : 1,
                    }}
                    onClick={() => mode === 'global' && toggleGroupSolo(i)}
                    title={
                      mode === 'global'
                        ? 'Click to solo-highlight group; click eye to hide/show layer'
                        : g.query
                    }
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                      <span
                        className="obs-graph-color-dot"
                        style={{ background: g.color }}
                      />
                      <span className="obs-tree-label">{g.query}</span>
                    </span>
                    {mode === 'global' && (
                      <button
                        className="obs-icon-btn"
                        style={{ width: 20, height: 20 }}
                        onClick={(e) => toggleGroupVisibility(i, e)}
                        title={isHidden ? 'Show this layer' : 'Hide this layer'}
                      >
                        {isHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="obs-graph-section">
            <div className="obs-graph-section-title">Display</div>
            <label className="obs-toggle-row">
              <span>Arrows</span>
              <input
                type="checkbox"
                checked={settings.showArrow}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, showArrow: e.target.checked }))
                }
              />
            </label>
            <div className="obs-slider-row">
              <div className="obs-slider-head">
                <span>Text fade threshold</span>
                <span>{settings.textFadeMultiplier.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={-3}
                max={3}
                step={0.1}
                value={settings.textFadeMultiplier}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    textFadeMultiplier: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div className="obs-slider-row">
              <div className="obs-slider-head">
                <span>Node size</span>
                <span>{settings.nodeSizeMultiplier.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.4}
                max={3}
                step={0.05}
                value={settings.nodeSizeMultiplier}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    nodeSizeMultiplier: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div className="obs-slider-row">
              <div className="obs-slider-head">
                <span>Link thickness</span>
                <span>{settings.lineSizeMultiplier.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.2}
                max={3}
                step={0.05}
                value={settings.lineSizeMultiplier}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    lineSizeMultiplier: Number(e.target.value),
                  }))
                }
              />
            </div>
          </div>

          <div className="obs-graph-section">
            <div className="obs-graph-section-title">Forces</div>
            <div className="obs-slider-row">
              <div className="obs-slider-head">
                <span>Center force</span>
                <span>{settings.centerStrength.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.centerStrength}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    centerStrength: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div className="obs-slider-row">
              <div className="obs-slider-head">
                <span>Repel force</span>
                <span>{settings.repelStrength.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={1}
                max={25}
                step={0.5}
                value={settings.repelStrength}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    repelStrength: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div className="obs-slider-row">
              <div className="obs-slider-head">
                <span>Link force</span>
                <span>{settings.linkStrength.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={settings.linkStrength}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    linkStrength: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div className="obs-slider-row" style={{ marginBottom: 0 }}>
              <div className="obs-slider-head">
                <span>Link distance</span>
                <span>{settings.linkDistance}</span>
              </div>
              <input
                type="range"
                min={40}
                max={400}
                step={5}
                value={settings.linkDistance}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    linkDistance: Number(e.target.value),
                  }))
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}