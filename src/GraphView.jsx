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
  return {
    bg: get('--bg-primary', '#1e1e1e'),
    nodeDefault: get('--graph-node', '#9a9a9a'),
    nodeUnresolved: get('--graph-node-unresolved', '#4e4e4e'),
    line: get('--graph-line', 'rgba(150, 150, 150, 0.24)'),
    lineActive: get('--graph-line-active', 'rgba(168, 139, 250, 0.9)'),
    accent: get('--text-accent', '#a88bfa'),
    text: get('--graph-text', '#cfcfcf'),
  };
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
          const remaining = [current, ...words.slice(i + 1)].join(' ');
          let clipped = remaining;
          while (clipped.length > 3 && ctx.measureText(`${clipped}...`).width > maxWidth) {
            clipped = clipped.slice(0, -1);
          }
          lines.push(clipped.length < remaining.length ? `${clipped}...` : clipped);
          return lines;
        }
      } else {
        let clipped = word;
        while (clipped.length > 3 && ctx.measureText(`${clipped}...`).width > maxWidth) {
          clipped = clipped.slice(0, -1);
        }
        lines.push(`${clipped}...`);
        return lines;
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
    let filteredLinks = rawLinks.filter(
      (l) => validIds.has(l.source) && validIds.has(l.target)
    );

    if (mode === 'local' && activeNotePath && validIds.has(activeNotePath)) {
      const adj = new Map();
      for (const l of filteredLinks) {
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
      filteredLinks = filteredLinks.filter(
        (l) => visited.has(l.source) && visited.has(l.target)
      );
    }

    const degreeMap = new Map();
    for (const l of filteredLinks) {
      degreeMap.set(l.source, (degreeMap.get(l.source) || 0) + 1);
      degreeMap.set(l.target, (degreeMap.get(l.target) || 0) + 1);
    }

    if (!settings.showOrphans && mode === 'global') {
      baseNodes = baseNodes.filter((n) => (degreeMap.get(n.id) || 0) > 0);
      const keepIds = new Set(baseNodes.map((n) => n.id));
      filteredLinks = filteredLinks.filter(
        (l) => keepIds.has(l.source) && keepIds.has(l.target)
      );
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
      const degree = degreeMap.get(n.id) ?? n.degree ?? 0;
      return {
        ...n,
        degree,
        groupColor,
      };
    });

    const links = filteredLinks.map((l) => ({ ...l }));
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
  const cameraRef = useRef({ x: 0, y: 0, k: 0.35 });
  const hoveredNodeRef = useRef(null);
  const draggedNodeRef = useRef(null);
  const labelCacheRef = useRef(new Map());
  const drawRef = useRef(() => {});
  const settingsRef = useRef(settings);
  const themeRef = useRef(themeColors);
  const activeNoteRef = useRef(activeNotePath);

  settingsRef.current = settings;
  themeRef.current = themeColors;
  activeNoteRef.current = activeNotePath;

  // Delicate pinpoint screen-space radius (matches Obsidian desktop & mobile proportions)
  const getScreenRadius = (node, camK) => {
    const mult = settingsRef.current.nodeSizeMultiplier || 1;
    const zoomScale = Math.min(1.35, Math.max(0.72, Math.pow(Math.max(0.18, camK), 0.16)));
    if (node.unresolved) return 1.5 * mult * zoomScale;
    const base = 1.45 + Math.sqrt(node.degree || 0) * 0.48;
    return Math.min(5.8, base) * mult * zoomScale;
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

    const spanX = Math.max(180, maxX - minX);
    const spanY = Math.max(180, maxY - minY);
    const pad = mode === 'local' ? 0.68 : 0.86;
    const k = Math.min(
      mode === 'local' ? 1.35 : 1.05,
      Math.max(0.06, Math.min((rect.width * pad) / spanX, (rect.height * pad) / spanY))
    );

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    cameraRef.current = {
      k,
      x: rect.width / 2 - cx * k,
      y: rect.height / 2 - cy * k,
    };
    drawRef.current();
  };

  // Initialize / update force simulation with airy starburst spacing
  useEffect(() => {
    const nodes = graphData.nodes;
    const links = graphData.links;
    labelCacheRef.current.clear();

    const prevPos = new Map(nodesRef.current.map((n) => [n.id, { x: n.x, y: n.y }]));
    for (const n of nodes) {
      const old = prevPos.get(n.id);
      if (old && Number.isFinite(old.x) && Number.isFinite(old.y)) {
        n.x = old.x;
        n.y = old.y;
      }
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

    const sim = forceSimulation(nodes)
      .force(
        'link',
        forceLink(links)
          .id((d) => d.id)
          .distance(settings.linkDistance * 0.85)
          .strength(settings.linkStrength * 0.65)
      )
      .force('charge', forceManyBody().strength(-settings.repelStrength * 65))
      .force('x', forceX(0).strength(settings.centerStrength * 0.045))
      .force('y', forceY(0).strength(settings.centerStrength * 0.045))
      .force(
        'collide',
        forceCollide((d) => 9 + Math.sqrt(d.degree || 0) * 2.0)
      )
      .alphaDecay(0.026);

    sim.tick(prevPos.size === 0 ? 160 : 45);
    simRef.current = sim;

    fitViewToNodes();

    sim.on('tick', () => {
      drawRef.current();
    });

    return () => {
      sim.stop();
    };
  }, [graphData]);

  // Live-update physics parameters
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;

    const linkForce = sim.force('link');
    if (linkForce) {
      linkForce
        .distance(settings.linkDistance * 0.85)
        .strength(settings.linkStrength * 0.65);
    }
    const chargeForce = sim.force('charge');
    if (chargeForce) {
      chargeForce.strength(-settings.repelStrength * 65);
    }
    const xForce = sim.force('x');
    const yForce = sim.force('y');
    if (xForce) xForce.strength(settings.centerStrength * 0.045);
    if (yForce) yForce.strength(settings.centerStrength * 0.045);

    sim.alpha(0.35).restart();
  }, [
    settings.linkDistance,
    settings.linkStrength,
    settings.repelStrength,
    settings.centerStrength,
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

  // Screen-space Canvas renderer + desktop hover + mobile press-and-hold spotlight
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');

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
      const hovered = hoveredNodeRef.current;
      const activePath = activeNoteRef.current;
      const hoveredNeighbors = hovered ? neighborMapRef.current.get(hovered.id) : null;

      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, rect.width, rect.height);

      const toScreenX = (wx) => wx * cam.k + cam.x;
      const toScreenY = (wy) => wy * cam.k + cam.y;

      const screenLineWidth = Math.max(0.45, 0.65 * cfg.lineSizeMultiplier);

      // 1. Draw hairline edges
      for (const l of linksRef.current) {
        const s = l.source;
        const t = l.target;
        if (typeof s !== 'object' || typeof t !== 'object') continue;

        const sx = toScreenX(s.x);
        const sy = toScreenY(s.y);
        const tx = toScreenX(t.x);
        const ty = toScreenY(t.y);

        if (
          (sx < -50 && tx < -50) ||
          (sx > rect.width + 50 && tx > rect.width + 50) ||
          (sy < -50 && ty < -50) ||
          (sy > rect.height + 50 && ty > rect.height + 50)
        ) {
          continue;
        }

        const isConnectedToHover =
          hovered && (s.id === hovered.id || t.id === hovered.id);

        ctx.save();
        if (hovered) {
          ctx.globalAlpha = isConnectedToHover ? 0.95 : 0.06;
        } else {
          ctx.globalAlpha = l.unresolved ? 0.18 : 0.55;
        }
        ctx.strokeStyle = isConnectedToHover ? colors.lineActive : colors.line;
        ctx.lineWidth = isConnectedToHover ? screenLineWidth * 1.65 : screenLineWidth;

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
        ctx.stroke();

        if (cfg.showArrow) {
          const angle = Math.atan2(ty - sy, tx - sx);
          const tr = getScreenRadius(t, cam.k) + 2;
          const ax = tx - Math.cos(angle) * tr;
          const ay = ty - Math.sin(angle) * tr;
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
          ctx.fillStyle = isConnectedToHover ? colors.lineActive : colors.line;
          ctx.fill();
        }
        ctx.restore();
      }

      // 2. Draw delicate pinpoint nodes
      for (const n of nodesRef.current) {
        if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
        const sx = toScreenX(n.x);
        const sy = toScreenY(n.y);
        if (sx < -30 || sx > rect.width + 30 || sy < -30 || sy > rect.height + 30) {
          continue;
        }

        const r = getScreenRadius(n, cam.k);
        const isHovered = hovered && hovered.id === n.id;
        const isNeighbor = hovered && hoveredNeighbors?.has(n.id);
        const isActiveNote = activePath && n.id === activePath;

        ctx.save();
        if (hovered && !isHovered && !isNeighbor) {
          ctx.globalAlpha = 0.14;
        }

        ctx.beginPath();
        ctx.arc(sx, sy, isHovered ? Math.max(r * 1.3, 4.5) : r, 0, Math.PI * 2);
        ctx.fillStyle = isHovered
          ? colors.accent
          : n.unresolved
            ? colors.nodeUnresolved
            : n.groupColor || colors.nodeDefault;
        ctx.fill();

        if (isActiveNote && !isHovered) {
          ctx.lineWidth = 1.4;
          ctx.strokeStyle = colors.accent;
          ctx.stroke();
        }
        ctx.restore();
      }

      // 3. Draw wrapped screen-space labels
      const fadeMetric = cam.k * Math.pow(2, cfg.textFadeMultiplier || 0);
      const baseLabelAlpha = Math.min(1, Math.max(0, (fadeMetric - 0.52) / 0.42));

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = '500 10.5px Inter, -apple-system, BlinkMacSystemFont, sans-serif';

      for (const n of nodesRef.current) {
        if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
        const sx = toScreenX(n.x);
        const sy = toScreenY(n.y);
        if (sx < -120 || sx > rect.width + 120 || sy < -60 || sy > rect.height + 60) {
          continue;
        }

        const isHovered = hovered && hovered.id === n.id;
        const isActiveNote = activePath && n.id === activePath;

        let alpha = baseLabelAlpha;
        if (isHovered || isActiveNote) {
          alpha = 1;
        } else if (hovered) {
          alpha = baseLabelAlpha * 0.1;
        }

        if (alpha <= 0.04) continue;

        let lines = labelCacheRef.current.get(n.title);
        if (!lines) {
          lines = wrapLabelLines(ctx, n.title, 150, 2);
          labelCacheRef.current.set(n.title, lines);
        }

        const r = getScreenRadius(n, cam.k);
        ctx.save();
        ctx.globalAlpha = isHovered ? 1 : alpha * 0.86;
        ctx.fillStyle = colors.text;
        const startY = sy + (isHovered ? Math.max(r * 1.3, 4.5) : r) + 5;
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], sx, startY + i * 13);
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

      // Two-finger touch pinch start
      if (activePointers.size === 2) {
        clearLongPressTimer();
        isLongPress = false;
        touchTargetNode = null;
        draggedNodeRef.current = null;
        hoveredNodeRef.current = null;
        isPanning = false;
        const pts = [...activePointers.values()];
        lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        draw();
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
          // Press-and-hold (~200ms) lights up connections just like Obsidian Mobile
          longPressTimer = setTimeout(() => {
            isLongPress = true;
            hoveredNodeRef.current = hit;
            draggedNodeRef.current = hit;
            hit.fx = hit.x;
            hit.fy = hit.y;
            simRef.current?.alphaTarget(0.15).restart();
            draw();
          }, 200);
        } else {
          hoveredNodeRef.current = null;
          isPanning = true;
          draw();
        }
        return;
      }

      // Mouse / pen interaction
      if (hit) {
        draggedNodeRef.current = hit;
        hoveredNodeRef.current = hit;
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

      // Two-finger pinch zoom
      if (activePointers.size === 2) {
        const pts = [...activePointers.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        if (lastPinchDist && dist > 0) {
          const rect = canvas.getBoundingClientRect();
          const midX = (pts[0].x + pts[1].x) / 2 - rect.left;
          const midY = (pts[0].y + pts[1].y) / 2 - rect.top;
          const cam = cameraRef.current;
          const nextK = Math.min(8, Math.max(0.05, cam.k * (dist / lastPinchDist)));
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

      // If user starts dragging a touched node before 200ms elapses, switch cleanly into node drag + spotlight
      if (e.pointerType === 'touch' && touchTargetNode && !draggedNodeRef.current && distFromStart > 7) {
        clearLongPressTimer();
        isLongPress = true;
        hoveredNodeRef.current = touchTargetNode;
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
          hoveredNodeRef.current = hit;
          canvas.style.cursor = hit && !hit.unresolved ? 'pointer' : 'grab';
          draw();
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
          // Released after press-and-hold or drag: dismiss spotlight without navigating
          hoveredNodeRef.current = null;
          isLongPress = false;
          touchTargetNode = null;
          draw();
        } else if (touchTargetNode && movedDist < 7 && !touchTargetNode.unresolved && onSelectNote) {
          // Clean quick tap: open the note
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
      const nextK = Math.min(8, Math.max(0.05, cam.k * factor));
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
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      clearLongPressTimer();
      resizeObs.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [onSelectNote]);

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
          onClick={() => simRef.current?.alpha(0.75).restart()}
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