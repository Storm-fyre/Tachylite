import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force';
import { Maximize2, Settings, Sparkles, X } from 'lucide-react';

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

  // Leaf summary tether (Mother Chapter <-> Summary Dendrite)
  if (rA === 'summary' || rB === 'summary') return 'summary';
  // Hub-to-hub outer constellation loop
  if (rA === 'hub' && rB === 'hub') return 'hub-loop';
  // Subject Hub <-> Chapter in its own constellation
  if ((rA === 'hub' || rB === 'hub') && sameFolder) return 'hub-spoke';
  // Sequential chapters within the same subject folder
  if (rA === 'chapter' && rB === 'chapter' && sameFolder) return 'sibling';
  // Trivia bridge connections
  if (rA === 'trivia' || rB === 'trivia') return 'trivia';
  // Cross-subject synapses between two different folders
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

function computeLinkDistance(link, baseDistance, isLocal) {
  if (isLocal) return baseDistance * 0.52;
  const kind = classifyLink(link);
  const s = link.source;
  const t = link.target;
  const jitter = (hashString(`${s.id}|${t.id}`) - 0.5) * 0.1;

  switch (kind) {
    case 'summary':
      // Crisp outward halo around each Mother Chapter
      return baseDistance * (0.42 + jitter * 0.5);
    case 'sibling':
      // Smooth sequential arc around the Subject Hub
      return baseDistance * 0.34;
    case 'hub-spoke':
      // Balanced radial starburst radius around each Gold Hub
      return baseDistance * (0.64 + jitter);
    case 'trivia':
      // Lets Orange Trivia nodes float naturally between constellations
      return baseDistance * 1.15;
    case 'hub-loop':
      // Keeps neighboring Subject Hubs comfortably spaced around the galaxy
      return baseDistance * 1.85;
    case 'cross':
    default:
      return baseDistance * 1.3;
  }
}

function computeLinkStrength(link, baseStrength, isLocal) {
  if (isLocal) return Math.min(1, baseStrength * 0.7);
  const kind = classifyLink(link);

  switch (kind) {
    case 'summary':
      return Math.min(1, baseStrength * 0.9);
    case 'hub-spoke':
      return Math.min(1, baseStrength * 0.65);
    case 'sibling':
      return Math.min(1, baseStrength * 0.28);
    case 'trivia':
      return Math.min(1, baseStrength * 0.085);
    case 'hub-loop':
      return Math.min(1, baseStrength * 0.045);
    case 'cross':
    default:
      return Math.min(1, baseStrength * 0.065);
  }
}

function computeNodeCharge(node, baseRepel, isLocal) {
  if (isLocal) return -baseRepel * 26;
  const role = node.role || 'chapter';
  const deg = node.degree || 1;

  if (role === 'hub') {
    return -baseRepel * (44 + Math.min(20, deg * 0.6));
  }
  if (role === 'trivia') {
    return -baseRepel * 30;
  }
  if (role === 'summary') {
    // Gentle outward repulsion so summary leaves fan evenly along the outer rim
    return -baseRepel * 15;
  }
  return -baseRepel * 23;
}

function computeCollideRadius(node, isLocal) {
  if (isLocal) return 18;
  const role = node.role || 'chapter';
  if (role === 'hub') return 20;
  if (role === 'trivia') return 14;
  if (role === 'summary') return 9;
  return 11;
}

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

  // Place Subject Hubs on a balanced circular mandala (outer ring + inner ring if > 10)
  const hubRadius = baseDistance * 2.15;
  const hubPos = new Map();

  hubs.forEach((hub, idx) => {
    const angle = (idx / hubs.length) * Math.PI * 2 - Math.PI / 2;
    const ringScale = hubs.length > 10 && idx % 3 === 0 ? 0.56 : 1.0;
    const r = hubRadius * ringScale;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (!Number.isFinite(hub.x) || !Number.isFinite(hub.y)) {
      hub.x = x;
      hub.y = y;
    }
    hubPos.set(hub.id, { x: hub.x, y: hub.y, angle });
  });

  // Group chapters around their own folder's Subject Hub
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

  const chapterR = baseDistance * 0.64;
  for (const [hubId, chapters] of chaptersByHub.entries()) {
    const hp = hubPos.get(hubId);
    if (!hp) continue;
    chapters.forEach((ch, i) => {
      if (Number.isFinite(ch.x) && Number.isFinite(ch.y)) return;
      const a = hp.angle + (i / Math.max(1, chapters.length)) * Math.PI * 2;
      ch.x = hp.x + Math.cos(a) * chapterR;
      ch.y = hp.y + Math.sin(a) * chapterR;
    });
  }

  // Place Summary leaves radially outward from their parent Mother Chapter
  const summaryR = baseDistance * 0.44;
  for (const n of nodes) {
    if (n.role !== 'summary') continue;
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) continue;
    const nbs = [...(adj.get(n.id) || [])];
    const parent = nbs.length ? nodeById.get(nbs[0]) : null;
    if (parent && Number.isFinite(parent.x) && Number.isFinite(parent.y)) {
      const ownerHub = parent.folder ? hubByFolder.get(parent.folder) : null;
      const ox = ownerHub && Number.isFinite(ownerHub.x) ? ownerHub.x : 0;
      const oy = ownerHub && Number.isFinite(ownerHub.y) ? ownerHub.y : 0;
      const outAngle = Math.atan2(parent.y - oy, parent.x - ox);
      n.x = parent.x + Math.cos(outAngle) * summaryR;
      n.y = parent.y + Math.sin(outAngle) * summaryR;
    }
  }

  // Place Trivia nodes at the centroid of their linked nodes (naturally suspended in the center)
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
      n.x = sx / cnt + Math.cos(jitterA) * 18;
      n.y = sy / cnt + Math.sin(jitterA) * 18;
    } else {
      n.x = (hashString(n.id) - 0.5) * 80;
      n.y = (hashString(`${n.id}!`) - 0.5) * 80;
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

export default function GraphView({
  vaultIndex,
  mode = 'global',
  activeNotePath = null,
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

    // Deduplicate reciprocal directed links (A->B and B->A) into single undirected physics springs,
    // while tracking arrow directions cleanly if the user enables "Arrows".
    const pairMap = new Map();
    const neighborSets = new Map();

    for (const l of filteredDirectedLinks) {
      if (!neighborSets.has(l.source)) neighborSets.set(l.source, new Set());
      if (!neighborSets.has(l.target)) neighborSets.set(l.target, new Set());
      neighborSets.get(l.source).add(l.target);
      neighborSets.get(l.target).add(l.source);

      const key = l.source < l.target ? `${l.source}||${l.target}` : `${l.target}||${l.source}`;
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
      if (!n.unresolved) {
        for (const grp of colorGroups) {
          if (grp.query && matchesGraphQuery(n, grp.query)) {
            groupColor = grp.color;
            break;
          }
        }
      }
      // True unique neighbor count (fixes the 2x inflated degree bug on bidirectional vaults)
      const degree = neighborSets.get(n.id)?.size || 0;
      const enriched = {
        ...n,
        degree,
        groupColor,
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
  ]);

  const simRef = useRef(null);
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const neighborMapRef = useRef(new Map());
  const cameraRef = useRef({ x: 0, y: 0, k: 0.3 });
  const overviewScaleRef = useRef(0.3);
  const hoveredNodeRef = useRef(null);
  const spotlightNodeRef = useRef(null);
  const hoverBlendRef = useRef(0);
  const hoverRafRef = useRef(null);
  const draggedNodeRef = useRef(null);
  const drawRef = useRef(() => {});
  const settingsRef = useRef(settings);
  const themeRef = useRef(themeColors);
  const activeNoteRef = useRef(activeNotePath);

  settingsRef.current = settings;
  themeRef.current = themeColors;
  activeNoteRef.current = activeNotePath;

  // Native Obsidian node proportions: crisp leaves (~2.3px), chapters (~2.9px),
  // Trivia (~3.7px), Gold Hubs (~5.2px) at overview, scaling smoothly on zoom.
  const getScreenRadius = (node, camK) => {
    const mult = settingsRef.current.nodeSizeMultiplier || 1;
    const relZoom =
      mode === 'local'
        ? 1.15
        : camK / Math.max(0.04, overviewScaleRef.current);
    const zoomScale = Math.min(2.35, Math.max(0.75, Math.pow(Math.max(0.4, relZoom), 0.34)));

    if (node.unresolved) return 1.8 * mult * zoomScale;

    const deg = Math.max(1, node.degree || 1);
    const base = 1.95 + Math.pow(deg - 1, 0.56) * 0.52;
    return Math.min(5.4, base) * mult * zoomScale;
  };

  const fitViewToNodes = () => {
    const canvas = canvasRef.current;
    const nodes = nodesRef.current;
    if (!canvas || nodes.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

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

    if (!Number.isFinite(minX)) return;

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

    cameraRef.current = {
      k,
      x: rect.width / 2 - cx * k,
      y: rect.height / 2 - cy * k,
    };
    drawRef.current();
  };

  // Initialize force simulation with untangled radial constellation seeding + native Obsidian balance
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

    if (simRef.current) simRef.current.stop();

    const centerPull = isLocal
      ? settings.centerStrength * 0.08
      : settings.centerStrength * 0.135;

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
      .alphaDecay(0.022);

    sim.tick(prevPos.size === 0 ? 300 : 70);
    simRef.current = sim;

    fitViewToNodes();

    sim.on('tick', () => {
      drawRef.current();
    });

    return () => {
      sim.stop();
    };
  }, [graphData, mode]);

  // Live-update physics sliders
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
      : settings.centerStrength * 0.135;
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
    activeNotePath,
  ]);

  // Smooth 140ms hover spotlight animation + Canvas renderer + desktop/touch interaction
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');

    const startHoverTransition = (nextNode) => {
      if (nextNode) {
        spotlightNodeRef.current = nextNode;
      }
      hoveredNodeRef.current = nextNode;

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
          if (!hoveredNodeRef.current) {
            spotlightNodeRef.current = null;
          }
          draw();
        }
      };

      hoverRafRef.current = requestAnimationFrame(step);
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
      const blend = hoverBlendRef.current;
      const spotlight = blend > 0.005 ? spotlightNodeRef.current : null;
      const spotlightNeighbors = spotlight
        ? neighborMapRef.current.get(spotlight.id)
        : null;
      const activePath = activeNoteRef.current;

      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, rect.width, rect.height);

      const toScreenX = (wx) => wx * cam.k + cam.x;
      const toScreenY = (wy) => wy * cam.k + cam.y;

      const relZoom =
        mode === 'local'
          ? 1.4
          : cam.k / Math.max(0.04, overviewScaleRef.current);

      // Subtle dynamic link width: silky hairline at overview, gently fuller when zoomed in
      const zoomLineScale = Math.min(1.65, Math.max(0.85, Math.pow(Math.max(0.5, relZoom), 0.22)));
      const baseLineWidth = Math.max(0.45, 0.68 * (cfg.lineSizeMultiplier || 1) * zoomLineScale);

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

        const isConnected =
          spotlight && (s.id === spotlight.id || t.id === spotlight.id);

        const baseAlpha = l.unresolved ? 0.18 : 0.62;
        let alpha = baseAlpha;
        let lineWidth = baseLineWidth;
        let stroke = colors.line;

        if (spotlight) {
          if (isConnected) {
            alpha = baseAlpha + (0.94 - baseAlpha) * blend;
            lineWidth = baseLineWidth * (1 + 0.65 * blend);
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

      // 2. Draw crisp proportional nodes
      for (const n of nodesRef.current) {
        if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
        const sx = toScreenX(n.x);
        const sy = toScreenY(n.y);
        if (sx < -30 || sx > rect.width + 30 || sy < -30 || sy > rect.height + 30) {
          continue;
        }

        const r = getScreenRadius(n, cam.k);
        const isSpotlight = spotlight && spotlight.id === n.id;
        const isNeighbor = spotlight && spotlightNeighbors?.has(n.id);
        const isActiveNote = activePath && n.id === activePath;

        ctx.save();
        if (spotlight && !isSpotlight && !isNeighbor) {
          ctx.globalAlpha = 1 - 0.84 * blend;
        }

        const drawR = isSpotlight ? r * (1 + 0.28 * blend) : r;

        ctx.beginPath();
        ctx.arc(sx, sy, drawR, 0, Math.PI * 2);
        ctx.fillStyle = n.unresolved
          ? colors.nodeUnresolved
          : n.groupColor || colors.nodeDefault;
        ctx.fill();

        if (isSpotlight && blend > 0.05) {
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = colors.accent;
          ctx.globalAlpha = blend;
          ctx.stroke();
        } else if (isActiveNote) {
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = colors.accent;
          ctx.stroke();
        }
        ctx.restore();
      }

      // 3. True Obsidian text-fade threshold (negative = earlier, positive = later)
      //    plus Hub-first priority fade and screen-space label overlap avoidance.
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

        const isSpotlight = spotlight && spotlight.id === n.id;
        const isNeighbor = spotlight && spotlightNeighbors?.has(n.id);
        const isActiveNote = activePath && n.id === activePath;

        let alpha = 0;
        if (mode === 'local') {
          alpha = 0.92;
        } else {
          // Importance-tiered reveal: Hubs appear first, then Trivia, then Chapters, then Summaries
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
          alpha = clamped * clamped * (3 - 2 * clamped); // smoothstep
        }

        if (spotlight) {
          if (isSpotlight) {
            alpha = Math.max(alpha, blend);
          } else if (isNeighbor) {
            // Gently reveal connected neighbor titles when hovered
            alpha = Math.max(alpha, blend * (relZoom > 1.25 ? 0.85 : 0.55));
          } else {
            alpha *= 1 - 0.9 * blend;
          }
        }

        if (isActiveNote) {
          alpha = Math.max(alpha, 0.95);
        }

        if (alpha <= 0.03) continue;

        const priority = isSpotlight
          ? 10000
          : isActiveNote
            ? 5000
            : isNeighbor
              ? 2000 + (n.degree || 0)
              : (n.role === 'hub' ? 1000 : n.role === 'trivia' ? 500 : 100) +
                (n.degree || 0);

        labelCandidates.push({
          node: n,
          sx,
          sy,
          alpha,
          priority,
          isSpotlight,
          isActiveNote,
          isNeighbor,
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
        const { node, sx, sy, alpha, isSpotlight, isActiveNote } = item;
        const fontSize = isSpotlight ? 12.8 : node.role === 'hub' ? baseFontSize + 0.7 : baseFontSize;
        const fontWeight = isSpotlight || node.role === 'hub' ? '500' : '400';
        const wrapW = isSpotlight ? 220 : baseWrapWidth;

        ctx.font = `${fontWeight} ${fontSize.toFixed(1)}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        const lines = wrapLabelLines(ctx, node.title, wrapW, isSpotlight ? 3 : 2);
        if (lines.length === 0) continue;

        let maxLineW = 0;
        for (const line of lines) {
          const w = ctx.measureText(line).width;
          if (w > maxLineW) maxLineW = w;
        }

        const r = getScreenRadius(node, cam.k);
        const lineHeight = fontSize * 1.28;
        const startY = sy + (isSpotlight ? r * 1.28 : r) + 5;
        const boxPadX = 6;
        const boxPadY = 3;
        const x1 = sx - maxLineW / 2 - boxPadX;
        const x2 = sx + maxLineW / 2 + boxPadX;
        const y1 = startY - boxPadY;
        const y2 = startY + lines.length * lineHeight + boxPadY;

        // Overlap avoidance: hovered/active notes always draw; others skip if colliding
        if (!isSpotlight && !isActiveNote) {
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
        ctx.globalAlpha = isSpotlight ? Math.min(1, alpha) : alpha * 0.9;
        ctx.fillStyle = isSpotlight
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

    const resizeObs = new ResizeObserver(() => draw());
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

    const clearLongPressTimer = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const onPointerDown = (e) => {
      if (e.button !== 0 && e.button !== 1 && e.pointerType === 'mouse') return;
      canvas.setPointerCapture(e.pointerId);
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 2) {
        clearLongPressTimer();
        isLongPress = false;
        touchTargetNode = null;
        draggedNodeRef.current = null;
        startHoverTransition(null);
        isPanning = false;
        const pts = [...activePointers.values()];
        lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        return;
      }

      const isTouch = e.pointerType === 'touch';
      const hit = hitTestNode(e.clientX, e.clientY, isTouch);
      startClient = { x: e.clientX, y: e.clientY };
      startCam = { x: cameraRef.current.x, y: cameraRef.current.y };
      movedDist = 0;
      isLongPress = false;
      touchTargetNode = null;

      if (isTouch) {
        if (hit) {
          touchTargetNode = hit;
          clearLongPressTimer();
          longPressTimer = setTimeout(() => {
            isLongPress = true;
            startHoverTransition(hit);
            draggedNodeRef.current = hit;
            hit.fx = hit.x;
            hit.fy = hit.y;
            simRef.current?.alphaTarget(0.15).restart();
          }, 200);
        } else {
          startHoverTransition(null);
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
        startHoverTransition(touchTargetNode);
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
        if (hit !== hoveredNodeRef.current) {
          canvas.style.cursor = hit && !hit.unresolved ? 'pointer' : 'grab';
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

        if (isLongPress) {
          startHoverTransition(null);
          isLongPress = false;
          touchTargetNode = null;
        } else if (touchTargetNode && movedDist < 7 && !touchTargetNode.unresolved && onSelectNote) {
          const target = touchTargetNode;
          touchTargetNode = null;
          onSelectNote(target.path, false);
        }

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

        if (movedDist < 5 && !dragged.unresolved && onSelectNote) {
          onSelectNote(dragged.path, e.ctrlKey || e.metaKey || e.button === 1);
        }
      }
      isPanning = false;
    };

    const onPointerLeave = () => {
      if (!draggedNodeRef.current && hoveredNodeRef.current) {
        canvas.style.cursor = 'grab';
        startHoverTransition(null);
      }
    };

    const onWheel = (e) => {
      e.preventDefault();
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
      resizeObs.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [onSelectNote, mode]);

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
        <button
          className="obs-icon-btn"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}
          onClick={() => simRef.current?.alpha(0.8).restart()}
          title="Animate / Re-layout graph"
        >
          <Sparkles size={14} />
        </button>
      </div>

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
              <div className="obs-graph-section-title">Groups</div>
              {colorGroups.map((g, i) => (
                <div key={i} className="obs-graph-legend-item">
                  <span
                    className="obs-graph-color-dot"
                    style={{ background: g.color }}
                  />
                  <span className="obs-tree-label">{g.query}</span>
                </div>
              ))}
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