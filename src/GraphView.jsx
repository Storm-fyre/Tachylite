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
    line: get('--graph-line', 'rgba(150, 150, 150, 0.26)'),
    lineActive: get('--graph-line-active', 'rgba(168, 139, 250, 0.85)'),
    accent: get('--text-accent', '#a88bfa'),
    text: get('--graph-text', '#d4d4d4'),
  };
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

  // Sync theme color changes (Dark <-> Light)
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

  // Re-sync defaults if vault switches
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

  // Build filtered graph dataset
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

    // Local graph BFS neighborhood
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

    // Recompute degrees within the filtered graph for accurate orphan filtering & sizing
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

  // Mutable simulation & camera state refs for smooth 60fps Canvas rendering
  const simRef = useRef(null);
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const neighborMapRef = useRef(new Map());
  const cameraRef = useRef({ x: 0, y: 0, k: 0.6 });
  const hoveredNodeRef = useRef(null);
  const draggedNodeRef = useRef(null);
  const drawRef = useRef(() => {});
  const settingsRef = useRef(settings);
  const themeRef = useRef(themeColors);
  const activeNoteRef = useRef(activeNotePath);

  settingsRef.current = settings;
  themeRef.current = themeColors;
  activeNoteRef.current = activeNotePath;

  const getNodeRadius = (node) => {
    const mult = settingsRef.current.nodeSizeMultiplier || 1;
    if (node.unresolved) return 3 * mult;
    const base = 3.2 + Math.sqrt(node.degree || 0) * 1.45;
    return Math.min(16, base) * mult;
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

    const spanX = Math.max(120, maxX - minX);
    const spanY = Math.max(120, maxY - minY);
    const pad = mode === 'local' ? 0.68 : 0.82;
    const k = Math.min(
      mode === 'local' ? 1.5 : 1.2,
      Math.max(0.12, Math.min((rect.width * pad) / spanX, (rect.height * pad) / spanY))
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

  // Initialize / update simulation when graphData changes
  useEffect(() => {
    const nodes = graphData.nodes;
    const links = graphData.links;

    // Preserve previous positions if nodes already existed
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
          .distance(settings.linkDistance * 0.65)
          .strength(settings.linkStrength * 0.7)
      )
      .force('charge', forceManyBody().strength(-settings.repelStrength * 28))
      .force('x', forceX(0).strength(settings.centerStrength * 0.16))
      .force('y', forceY(0).strength(settings.centerStrength * 0.16))
      .force(
        'collide',
        forceCollide((d) => getNodeRadius(d) + 3.5)
      )
      .alphaDecay(0.028);

    // Pre-settle slightly so graph opens neatly arranged
    sim.tick(prevPos.size === 0 ? 110 : 35);
    simRef.current = sim;

    fitViewToNodes();

    sim.on('tick', () => {
      drawRef.current();
    });

    return () => {
      sim.stop();
    };
  }, [graphData]);

  // Live-update physics parameters without recreating the simulation
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;

    const linkForce = sim.force('link');
    if (linkForce) {
      linkForce
        .distance(settings.linkDistance * 0.65)
        .strength(settings.linkStrength * 0.7);
    }
    const chargeForce = sim.force('charge');
    if (chargeForce) {
      chargeForce.strength(-settings.repelStrength * 28);
    }
    const xForce = sim.force('x');
    const yForce = sim.force('y');
    if (xForce) xForce.strength(settings.centerStrength * 0.16);
    if (yForce) yForce.strength(settings.centerStrength * 0.16);

    sim.alpha(0.35).restart();
  }, [
    settings.linkDistance,
    settings.linkStrength,
    settings.repelStrength,
    settings.centerStrength,
  ]);

  // Redraw when visual-only settings or theme change
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

  // Canvas draw loop + ResizeObserver + pointer/wheel interactions
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

      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.k, cam.k);

      const baseLineWidth = (0.85 * cfg.lineSizeMultiplier) / Math.max(0.35, Math.sqrt(cam.k));

      // Draw edges
      for (const l of linksRef.current) {
        const s = l.source;
        const t = l.target;
        if (typeof s !== 'object' || typeof t !== 'object') continue;

        const isConnectedToHover =
          hovered && (s.id === hovered.id || t.id === hovered.id);

        ctx.save();
        if (hovered) {
          ctx.globalAlpha = isConnectedToHover ? 0.9 : 0.08;
        } else {
          ctx.globalAlpha = l.unresolved ? 0.25 : 0.7;
        }
        ctx.strokeStyle = isConnectedToHover ? colors.lineActive : colors.line;
        ctx.lineWidth = isConnectedToHover ? baseLineWidth * 1.65 : baseLineWidth;

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();

        if (cfg.showArrow) {
          const angle = Math.atan2(t.y - s.y, t.x - s.x);
          const tr = getNodeRadius(t) + 2;
          const ax = t.x - Math.cos(angle) * tr;
          const ay = t.y - Math.sin(angle) * tr;
          const arrowLen = 6 / Math.max(0.4, Math.sqrt(cam.k));
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

      // Draw nodes
      for (const n of nodesRef.current) {
        if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
        const r = getNodeRadius(n);
        const isHovered = hovered && hovered.id === n.id;
        const isNeighbor = hovered && hoveredNeighbors?.has(n.id);
        const isActiveNote = activePath && n.id === activePath;

        ctx.save();
        if (hovered && !isHovered && !isNeighbor) {
          ctx.globalAlpha = 0.16;
        }

        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.unresolved
          ? colors.nodeUnresolved
          : n.groupColor || colors.nodeDefault;
        ctx.fill();

        if (isHovered || isActiveNote) {
          ctx.lineWidth = 2 / Math.max(0.4, Math.sqrt(cam.k));
          ctx.strokeStyle = colors.accent;
          ctx.stroke();
        }
        ctx.restore();
      }

      // Draw node labels with Obsidian zoom-fade behavior
      const fadeThreshold = cam.k * Math.pow(2, cfg.textFadeMultiplier || 0);
      const baseAlpha = Math.min(1, Math.max(0, (fadeThreshold - 0.35) / 0.45));

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const fontSize = Math.max(9.5, 11.5 / Math.pow(cam.k, 0.72));
      ctx.font = `500 ${fontSize}px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;

      for (const n of nodesRef.current) {
        if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
        const isHovered = hovered && hovered.id === n.id;
        const isNeighbor = hovered && hoveredNeighbors?.has(n.id);
        const isActiveNote = activePath && n.id === activePath;

        let alpha = baseAlpha;
        if (isHovered || isNeighbor || isActiveNote) {
          alpha = 1;
        } else if (hovered) {
          alpha = Math.min(alpha, 0.12);
        }

        if (alpha <= 0.04) continue;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = isHovered ? colors.accent : colors.text;
        const r = getNodeRadius(n);
        ctx.fillText(n.title, n.x, n.y + r + 3.5 / Math.max(0.4, cam.k));
        ctx.restore();
      }

      ctx.restore();
    };

    drawRef.current = draw;
    draw();

    const resizeObs = new ResizeObserver(() => draw());
    resizeObs.observe(wrap);

    // Coordinate helpers
    const toWorld = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const cam = cameraRef.current;
      return {
        sx: clientX - rect.left,
        sy: clientY - rect.top,
        wx: (clientX - rect.left - cam.x) / cam.k,
        wy: (clientY - rect.top - cam.y) / cam.k,
      };
    };

    const hitTestNode = (wx, wy) => {
      const hitPad = 4 / Math.max(0.35, cameraRef.current.k);
      for (let i = nodesRef.current.length - 1; i >= 0; i--) {
        const n = nodesRef.current[i];
        const dx = wx - n.x;
        const dy = wy - n.y;
        const r = getNodeRadius(n) + hitPad;
        if (dx * dx + dy * dy <= r * r) return n;
      }
      return null;
    };

    let isPanning = false;
    let startClient = { x: 0, y: 0 };
    let startCam = { x: 0, y: 0 };
    let movedDist = 0;

    const onPointerDown = (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      canvas.setPointerCapture(e.pointerId);
      const { wx, wy } = toWorld(e.clientX, e.clientY);
      const hit = hitTestNode(wx, wy);

      startClient = { x: e.clientX, y: e.clientY };
      startCam = { x: cameraRef.current.x, y: cameraRef.current.y };
      movedDist = 0;

      if (hit) {
        draggedNodeRef.current = hit;
        hit.fx = hit.x;
        hit.fy = hit.y;
        simRef.current?.alphaTarget(0.25).restart();
      } else {
        isPanning = true;
      }
    };

    const onPointerMove = (e) => {
      const { wx, wy } = toWorld(e.clientX, e.clientY);

      if (draggedNodeRef.current) {
        movedDist = Math.hypot(e.clientX - startClient.x, e.clientY - startClient.y);
        draggedNodeRef.current.fx = wx;
        draggedNodeRef.current.fy = wy;
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

      const hit = hitTestNode(wx, wy);
      if (hit !== hoveredNodeRef.current) {
        hoveredNodeRef.current = hit;
        canvas.style.cursor = hit && !hit.unresolved ? 'pointer' : 'grab';
        draw();
      }
    };

    const onPointerUp = (e) => {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
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
      const { sx, sy } = toWorld(e.clientX, e.clientY);
      const cam = cameraRef.current;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nextK = Math.min(6, Math.max(0.06, cam.k * factor));
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
      <canvas ref={canvasRef} className="obs-graph-canvas" />

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