import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Marked } from 'marked';
import {
  Archive,
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  FileText,
  GitFork,
  List,
  PanelRight,
  Tag,
} from 'lucide-react';
import GraphView from './GraphView.jsx';

const CALLOUT_COLORS = {
  note: '#448aff',
  info: '#00b8d4',
  tip: '#00bfa5',
  hint: '#00bfa5',
  important: '#00bfa5',
  success: '#00c853',
  check: '#00c853',
  done: '#00c853',
  question: '#ffab00',
  help: '#ffab00',
  faq: '#ffab00',
  warning: '#ff9100',
  caution: '#ff9100',
  attention: '#ff9100',
  failure: '#ff5252',
  fail: '#ff5252',
  missing: '#ff5252',
  danger: '#ff1744',
  error: '#ff1744',
  bug: '#f50057',
  example: '#7c4dff',
  quote: '#9e9e9e',
  cite: '#9e9e9e',
  abstract: '#00b0ff',
  summary: '#00b0ff',
  tldr: '#00b0ff',
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugifyHeading(text) {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[`*_~[\]()]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}

function stripTagsFromHtml(html) {
  return html.replace(/<[^>]+>/g, '');
}

function preprocessObsidianMarkdown(body, resolvedLinks = {}, vaultNotesMap) {
  const codeStore = [];
  const protect = (str) => {
    const token = `@@CODE_BLOCK_${codeStore.length}@@`;
    codeStore.push(str);
    return token;
  };

  // Protect fenced code blocks and inline code
  let text = body
    .replace(/```[\s\S]*?```/g, (m) => protect(m))
    .replace(/~~~[\s\S]*?~~~/g, (m) => protect(m))
    .replace(/`[^`\n]+`/g, (m) => protect(m));

  // Highlight ==text==
  text = text.replace(/==([^=\n]+)==/g, '<mark class="obs-highlight">$1</mark>');

  // Embeds: ![[target|option]]
  text = text.replace(/!\[\[([^\]]+)\]\]/g, (full, rawInner) => {
    const inner = rawInner.trim();
    const [targetPart, optionPart] = inner.split('|');
    const resolved = resolvedLinks[inner];

    if (resolved?.type === 'asset') {
      if (resolved.isImage) {
        const widthAttr =
          optionPart && /^\d+$/.test(optionPart.trim())
            ? ` style="width:${optionPart.trim()}px"`
            : '';
        return `<img src="${escapeHtml(resolved.url)}" alt="${escapeHtml(
          targetPart
        )}" loading="lazy"${widthAttr} />`;
      }
      if (resolved.ext === '.pdf') {
        return `<iframe src="${escapeHtml(
          resolved.url
        )}" title="${escapeHtml(
          targetPart
        )}" style="width:100%;height:520px;border:1px solid var(--border-color);border-radius:6px;margin:0.8em 0;"></iframe>`;
      }
      return `<a href="${escapeHtml(resolved.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        targetPart
      )}</a>`;
    }

    if (resolved?.type === 'note') {
      const meta = vaultNotesMap.get(resolved.path);
      const excerpt = meta?.excerpt ? escapeHtml(meta.excerpt) : 'Click to open embedded note';
      return `<div class="obs-inline-embed"><div class="obs-inline-embed-title internal-link" data-note-path="${escapeHtml(
        resolved.path
      )}" data-heading="${escapeHtml(resolved.heading || '')}">${escapeHtml(
        resolved.title
      )}</div><div style="font-size:0.9em;color:var(--text-muted);">${excerpt}</div></div>`;
    }

    return `<span class="internal-link is-unresolved">${escapeHtml(inner)}</span>`;
  });

  // Wikilinks: [[target#heading|alias]]
  text = text.replace(/\[\[([^\]]+)\]\]/g, (full, rawInner) => {
    const inner = rawInner.trim();
    const [targetPart, aliasPart] = inner.split('|');
    const [notePartRaw, headingPart] = targetPart.split('#');
    const notePart = notePartRaw.trim();
    const displayLabel = aliasPart
      ? aliasPart.trim()
      : headingPart && !notePart
        ? headingPart.trim()
        : targetPart.trim();

    // Same-note heading link [[#Heading]]
    if (!notePart && headingPart) {
      const slug = slugifyHeading(headingPart);
      return `<a href="#${escapeHtml(
        slug
      )}" class="internal-link" data-note-path="" data-heading="${escapeHtml(slug)}">${escapeHtml(
        displayLabel
      )}</a>`;
    }

    const resolved = resolvedLinks[inner];
    if (resolved?.type === 'note') {
      return `<a href="#" class="internal-link" data-note-path="${escapeHtml(
        resolved.path
      )}" data-heading="${escapeHtml(resolved.heading || '')}">${escapeHtml(displayLabel)}</a>`;
    }

    if (resolved?.type === 'asset') {
      return `<a href="${escapeHtml(resolved.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        displayLabel
      )}</a>`;
    }

    return `<a href="#" class="internal-link is-unresolved" data-unresolved="true">${escapeHtml(
      displayLabel
    )}</a>`;
  });

  // Inline #tags (outside headings, links, HTML attributes)
  text = text.replace(/(^|[\s(])#([\p{L}\p{N}_/-]+)/gu, (full, prefix, tag) => {
    if (/^\d+$/.test(tag)) return full;
    return `${prefix}<button type="button" class="obs-tag-pill" data-tag="${escapeHtml(
      tag
    )}">#${escapeHtml(tag)}</button>`;
  });

  // Restore code blocks
  text = text.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, idx) => codeStore[Number(idx)] ?? '');
  return text;
}

function renderObsidianMarkdown(noteData, vaultNotesMap) {
  if (!noteData) return '';

  const preprocessed = preprocessObsidianMarkdown(
    noteData.body || '',
    noteData.resolvedLinks || {},
    vaultNotesMap
  );

  const headingCounts = new Map();

  const md = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      heading({ tokens, depth }) {
        const innerHtml = this.parser.parseInline(tokens);
        const plain = stripTagsFromHtml(innerHtml).trim();
        const baseSlug = slugifyHeading(plain);
        const seen = headingCounts.get(baseSlug) || 0;
        headingCounts.set(baseSlug, seen + 1);
        const slug = seen === 0 ? baseSlug : `${baseSlug}-${seen}`;
        return `<h${depth} id="${escapeHtml(slug)}">${innerHtml}</h${depth}>\n`;
      },

      blockquote({ tokens }) {
        const innerHtml = this.parser.parse(tokens);
        const calloutMatch = innerHtml.match(
          /^<p>\s*\[!([a-zA-Z0-9_-]+)\][+-]?(?:[ \t]+([^\n<]*))?(?:<br\s*\/?>|\n)?([\s\S]*?)<\/p>([\s\S]*)$/
        );
        if (calloutMatch) {
          const type = calloutMatch[1].toLowerCase();
          const customTitle = calloutMatch[2]?.trim();
          const firstParaRest = calloutMatch[3]?.trim();
          const restBlocks = calloutMatch[4] || '';
          const color = CALLOUT_COLORS[type] || CALLOUT_COLORS.note;
          const title = customTitle || type;
          const bodyHtml = `${firstParaRest ? `<p>${firstParaRest}</p>` : ''}${restBlocks}`;
          return `<div class="obs-callout" style="--callout-color:${color}"><div class="obs-callout-title">${escapeHtml(
            title
          )}</div><div class="obs-callout-body">${bodyHtml}</div></div>\n`;
        }
        return `<blockquote>${innerHtml}</blockquote>\n`;
      },

      link({ href, title, tokens }) {
        const labelHtml = this.parser.parseInline(tokens);
        const safeHref = href || '#';
        if (/^(https?:|mailto:|tel:)/i.test(safeHref)) {
          const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
          return `<a href="${escapeHtml(
            safeHref
          )}" target="_blank" rel="noopener noreferrer"${titleAttr}>${labelHtml}</a>`;
        }
        let decoded = safeHref;
        try {
          decoded = decodeURIComponent(safeHref);
        } catch {
          // ignore
        }
        const resolved = noteData.resolvedLinks?.[safeHref] || noteData.resolvedLinks?.[decoded];
        if (resolved?.type === 'note') {
          return `<a href="#" class="internal-link" data-note-path="${escapeHtml(
            resolved.path
          )}" data-heading="${escapeHtml(resolved.heading || '')}">${labelHtml}</a>`;
        }
        if (resolved?.type === 'asset') {
          return `<a href="${escapeHtml(resolved.url)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
        }
        return `<a href="${escapeHtml(safeHref)}">${labelHtml}</a>`;
      },

      image({ href, title, text }) {
        let src = href || '';
        const resolved = noteData.resolvedLinks?.[src];
        if (resolved?.type === 'asset') {
          src = resolved.url;
        }
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(
          text || ''
        )}" loading="lazy"${titleAttr} />`;
      },
    },
  });

  const html = md.parse(preprocessed);
  // Strip unsafe script tags or inline event attributes
  return String(html)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son\w+=(?:"[^"]*"|'[^']*')/gi, '');
}

function PropertiesBox({ properties, onSearchTag }) {
  const [collapsed, setCollapsed] = useState(false);

  const entries = useMemo(() => {
    if (!properties || typeof properties !== 'object') return [];
    return Object.entries(properties).filter(
      ([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)
    );
  }, [properties]);

  if (entries.length === 0) return null;

  return (
    <div className="obs-props-box">
      <button className="obs-props-header" onClick={() => setCollapsed((c) => !c)}>
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <span>Properties</span>
      </button>
      {!collapsed && (
        <div className="obs-props-grid">
          {entries.map(([key, val]) => {
            const isTagField = key === 'tags' || key === 'tag';
            const values = Array.isArray(val) ? val : [val];
            return (
              <div key={key} className="obs-prop-row">
                <span className="obs-prop-key">{key}</span>
                <div className="obs-prop-val">
                  {isTagField
                    ? values.map((t, i) => {
                        const clean = String(t).replace(/^#/, '');
                        return (
                          <button
                            key={i}
                            type="button"
                            className="obs-tag-pill"
                            onClick={() => onSearchTag(clean)}
                          >
                            #{clean}
                          </button>
                        );
                      })
                    : values.map((v, i) => (
                        <span key={i}>
                          {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                          {i < values.length - 1 ? ', ' : ''}
                        </span>
                      ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Reader({
  vaultIndex,
  noteData,
  loading,
  readableWidth,
  targetHeading,
  fetchNote,
  onNavigateNote,
  onSearchTag,
}) {
  const scrollRef = useRef(null);
  const hoverTimerRef = useRef(null);
  const hideTimerRef = useRef(null);

  const [hoverPreview, setHoverPreview] = useState(null);

  const vaultNotesMap = useMemo(() => {
    const map = new Map();
    if (vaultIndex?.notes) {
      for (const n of vaultIndex.notes) map.set(n.path, n);
    }
    return map;
  }, [vaultIndex]);

  const renderedHtml = useMemo(
    () => renderObsidianMarkdown(noteData, vaultNotesMap),
    [noteData, vaultNotesMap]
  );

  // Scroll to top on note change or jump to target heading
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !noteData) return;

    if (!targetHeading) {
      container.scrollTop = 0;
      return;
    }

    const slug = targetHeading.split('::')[0];
    if (!slug) return;

    const timer = setTimeout(() => {
      const targetEl = container.querySelector(`[id="${CSS.escape(slug)}"]`);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        targetEl.classList.remove('obs-heading-flash');
        void targetEl.offsetWidth;
        targetEl.classList.add('obs-heading-flash');
      }
    }, 30);

    return () => clearTimeout(timer);
  }, [noteData?.path, targetHeading]);

  useEffect(() => {
    return () => {
      clearTimeout(hoverTimerRef.current);
      clearTimeout(hideTimerRef.current);
    };
  }, []);

  const handleContentClick = (e) => {
    const tagBtn = e.target.closest('[data-tag]');
    if (tagBtn) {
      e.preventDefault();
      onSearchTag(tagBtn.getAttribute('data-tag'));
      return;
    }

    const link = e.target.closest('.internal-link');
    if (!link) return;
    e.preventDefault();

    if (link.getAttribute('data-unresolved') === 'true') return;

    const path = link.getAttribute('data-note-path');
    const heading = link.getAttribute('data-heading') || null;

    if (!path && heading) {
      const targetEl = scrollRef.current?.querySelector(`[id="${CSS.escape(heading)}"]`);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        targetEl.classList.remove('obs-heading-flash');
        void targetEl.offsetWidth;
        targetEl.classList.add('obs-heading-flash');
      }
      return;
    }

    if (path) {
      setHoverPreview(null);
      onNavigateNote(path, heading, e.ctrlKey || e.metaKey);
    }
  };

  const handleMouseOver = (e) => {
    const link = e.target.closest('.internal-link');
    if (!link || link.getAttribute('data-unresolved') === 'true') return;
    const path = link.getAttribute('data-note-path');
    if (!path) return;

    clearTimeout(hideTimerRef.current);
    clearTimeout(hoverTimerRef.current);

    const rect = link.getBoundingClientRect();
    hoverTimerRef.current = setTimeout(async () => {
      const meta = vaultNotesMap.get(path);
      if (!meta) return;

      const left = Math.min(rect.left, window.innerWidth - 380);
      const top =
        rect.bottom + 270 > window.innerHeight
          ? Math.max(12, rect.top - 265)
          : rect.bottom + 8;

      setHoverPreview({
        path,
        title: meta.title,
        folder: meta.folder,
        body: meta.excerpt || 'Loading...',
        x: Math.max(12, left),
        y: top,
      });

      try {
        const full = await fetchNote(path);
        if (full) {
          setHoverPreview((prev) =>
            prev && prev.path === path
              ? { ...prev, body: full.body.slice(0, 900) }
              : prev
          );
        }
      } catch {
        // keep excerpt fallback
      }
    }, 240);
  };

  const handleMouseOut = (e) => {
    const link = e.target.closest('.internal-link');
    if (!link) return;
    clearTimeout(hoverTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setHoverPreview(null);
    }, 180);
  };

  if (loading) {
    return (
      <div className="obs-reader-scroll">
        <div className={`obs-reader-container ${readableWidth ? 'is-readable-width' : ''}`}>
          <p style={{ color: 'var(--text-muted)' }}>Loading note...</p>
        </div>
      </div>
    );
  }

  if (!noteData) {
    return (
      <div className="obs-reader-scroll">
        <div className={`obs-reader-container ${readableWidth ? 'is-readable-width' : ''}`}>
          <p style={{ color: 'var(--text-muted)' }}>Select a note from the sidebar or graph.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="obs-reader-scroll" ref={scrollRef}>
        <article className={`obs-reader-container ${readableWidth ? 'is-readable-width' : ''}`}>
          <h1 className="obs-note-title">{noteData.title}</h1>
          <PropertiesBox properties={noteData.properties} onSearchTag={onSearchTag} />
          <div
            className="obs-markdown"
            onClick={handleContentClick}
            onMouseOver={handleMouseOver}
            onMouseOut={handleMouseOut}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        </article>
      </div>

      {hoverPreview && (
        <div
          className="obs-hover-preview"
          style={{ left: hoverPreview.x, top: hoverPreview.y }}
          onMouseEnter={() => clearTimeout(hideTimerRef.current)}
          onMouseLeave={() => setHoverPreview(null)}
        >
          <div
            className="obs-hover-preview-title"
            style={{ cursor: 'pointer' }}
            onClick={() => {
              const p = hoverPreview.path;
              setHoverPreview(null);
              onNavigateNote(p);
            }}
          >
            {hoverPreview.title}
          </div>
          {hoverPreview.folder && (
            <div className="obs-hover-preview-folder">{hoverPreview.folder}</div>
          )}
          <div className="obs-hover-preview-body" style={{ whiteSpace: 'pre-wrap' }}>
            {hoverPreview.body}
          </div>
        </div>
      )}
    </>
  );
}

export function RightInspector({
  vaultIndex,
  activeNotePath,
  noteData,
  rightTab,
  setRightTab,
  onClose,
  onNavigateNote,
  onSearchTag,
}) {
  const backlinks = activeNotePath ? vaultIndex.backlinks?.[activeNotePath] || [] : [];
  const outlinks = activeNotePath ? vaultIndex.outlinks?.[activeNotePath] || [] : [];

  const sortedTags = useMemo(() => {
    const entries = Object.entries(vaultIndex.tags || {});
    return entries.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [vaultIndex.tags]);

  const headings = noteData?.headings || [];
  const minHeadingLevel = useMemo(
    () => (headings.length ? Math.min(...headings.map((h) => h.level)) : 1),
    [headings]
  );

  const jumpToHeading = (slug) => {
    const el = document.querySelector(`.obs-reader-scroll [id="${CSS.escape(slug)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.remove('obs-heading-flash');
      void el.offsetWidth;
      el.classList.add('obs-heading-flash');
    }
  };

  return (
    <aside className="obs-sidebar obs-sidebar--right">
      <div className="obs-sidebar-tabs">
        <div className="obs-sidebar-tab-group">
          <button
            className={`obs-icon-btn ${rightTab === 'outline' ? 'is-active' : ''}`}
            onClick={() => setRightTab('outline')}
            title="Outline"
          >
            <List size={15} />
          </button>
          <button
            className={`obs-icon-btn ${rightTab === 'backlinks' ? 'is-active' : ''}`}
            onClick={() => setRightTab('backlinks')}
            title="Backlinks"
          >
            <ArrowDownLeft size={15} />
          </button>
          <button
            className={`obs-icon-btn ${rightTab === 'outlinks' ? 'is-active' : ''}`}
            onClick={() => setRightTab('outlinks')}
            title="Outgoing links"
          >
            <ArrowUpRight size={15} />
          </button>
          <button
            className={`obs-icon-btn ${rightTab === 'tags' ? 'is-active' : ''}`}
            onClick={() => setRightTab('tags')}
            title="Tags"
          >
            <Tag size={15} />
          </button>
          <button
            className={`obs-icon-btn ${rightTab === 'properties' ? 'is-active' : ''}`}
            onClick={() => setRightTab('properties')}
            title="Note info & properties"
          >
            <Archive size={15} />
          </button>
          <button
            className={`obs-icon-btn ${rightTab === 'local-graph' ? 'is-active' : ''}`}
            onClick={() => setRightTab('local-graph')}
            title="Local graph"
          >
            <GitFork size={15} />
          </button>
        </div>

        <button className="obs-icon-btn" onClick={onClose} title="Collapse right sidebar">
          <PanelRight size={15} />
        </button>
      </div>

      <div className="obs-sidebar-body">
        {rightTab === 'outline' && (
          <>
            <div className="obs-sidebar-heading">Outline</div>
            {!activeNotePath ? (
              <div className="obs-empty-hint">Open a note to view its outline.</div>
            ) : headings.length === 0 ? (
              <div className="obs-empty-hint">No headings in this note.</div>
            ) : (
              <div className="obs-outline-list">
                {headings.map((h, i) => (
                  <button
                    key={`${h.slug}-${i}`}
                    className="obs-outline-item"
                    style={{ paddingLeft: `${8 + (h.level - minHeadingLevel) * 13}px` }}
                    onClick={() => jumpToHeading(h.slug)}
                  >
                    {h.text}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {rightTab === 'backlinks' && (
          <>
            <div className="obs-sidebar-heading">Backlinks ({backlinks.length})</div>
            {!activeNotePath ? (
              <div className="obs-empty-hint">Open a note to view backlinks.</div>
            ) : backlinks.length === 0 ? (
              <div className="obs-empty-hint">No backlinks found.</div>
            ) : (
              backlinks.map((bl) => (
                <div key={bl.path} className="obs-backlink-group">
                  <div
                    className="obs-backlink-header"
                    onClick={(e) => onNavigateNote(bl.path, null, e.ctrlKey || e.metaKey)}
                  >
                    <span className="obs-tree-label">{bl.title}</span>
                    <span className="obs-backlink-badge">{bl.count}</span>
                  </div>
                  {bl.snippets?.map((snip, idx) => (
                    <div
                      key={idx}
                      className="obs-backlink-snippet"
                      onClick={(e) => onNavigateNote(bl.path, null, e.ctrlKey || e.metaKey)}
                    >
                      {snip}
                    </div>
                  ))}
                </div>
              ))
            )}
          </>
        )}

        {rightTab === 'outlinks' && (
          <>
            <div className="obs-sidebar-heading">Outgoing links ({outlinks.length})</div>
            {!activeNotePath ? (
              <div className="obs-empty-hint">Open a note to view outgoing links.</div>
            ) : outlinks.length === 0 ? (
              <div className="obs-empty-hint">No outgoing links in this note.</div>
            ) : (
              outlinks.map((ol, i) => (
                <div
                  key={`${ol.path}-${i}`}
                  className="obs-tree-row"
                  style={{ opacity: ol.unresolved ? 0.55 : 1 }}
                  onClick={(e) => {
                    if (!ol.unresolved) onNavigateNote(ol.path, null, e.ctrlKey || e.metaKey);
                  }}
                >
                  <FileText size={13} style={{ flexShrink: 0 }} />
                  <span className="obs-tree-label">{ol.title}</span>
                </div>
              ))
            )}
          </>
        )}

        {rightTab === 'tags' && (
          <>
            <div className="obs-sidebar-heading">Vault Tags ({sortedTags.length})</div>
            {sortedTags.length === 0 ? (
              <div className="obs-empty-hint">No tags found in this vault.</div>
            ) : (
              sortedTags.map(([tag, paths]) => (
                <div
                  key={tag}
                  className="obs-tree-row"
                  style={{ justifyContent: 'space-between' }}
                  onClick={() => onSearchTag(tag)}
                >
                  <span className="obs-tree-label" style={{ color: 'var(--text-accent)' }}>
                    #{tag}
                  </span>
                  <span className="obs-backlink-badge">{paths.length}</span>
                </div>
              ))
            )}
          </>
        )}

        {rightTab === 'properties' && (
          <>
            <div className="obs-sidebar-heading">Properties</div>
            {!noteData ? (
              <div className="obs-empty-hint">Open a note to inspect its properties.</div>
            ) : Object.keys(noteData.properties || {}).length === 0 ? (
              <div className="obs-empty-hint">No frontmatter properties on this note.</div>
            ) : (
              <PropertiesBox properties={noteData.properties} onSearchTag={onSearchTag} />
            )}
          </>
        )}

        {rightTab === 'local-graph' && (
          <>
            <div className="obs-sidebar-heading">Local Graph</div>
            {!activeNotePath ? (
              <div className="obs-empty-hint">Open a note to see its local connections.</div>
            ) : (
              <div className="obs-local-graph-box">
                <GraphView
                  vaultIndex={vaultIndex}
                  mode="local"
                  activeNotePath={activeNotePath}
                  onSelectNote={(path, newTab) => onNavigateNote(path, null, newTab)}
                />
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}