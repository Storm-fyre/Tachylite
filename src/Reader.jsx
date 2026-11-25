import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Marked } from 'marked';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import {
  ArrowDownLeft,
  ArrowUp,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  GitFork,
  List,
  PanelRight,
  Search,
  X,
} from 'lucide-react';
import GraphView from './GraphView.jsx';

const SCROLL_STORAGE_KEY = 'obsidian-web-scroll-v1';
const MAX_SAVED_SCROLL_ENTRIES = 120;

// Private-Use-Area sentinels so Markdown parsing never alters placeholders
const MATH_OPEN = '\uE000M';
const MATH_CLOSE = '\uE001';
const BLOCK_MATH_OPEN = '\uE000D';
const BLOCK_MATH_CLOSE = '\uE001';

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

function loadScrollMap() {
  try {
    const raw = localStorage.getItem(SCROLL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveScrollPosition(storageKey, scrollTop) {
  try {
    const map = loadScrollMap();
    if (scrollTop <= 12) {
      delete map[storageKey];
    } else {
      delete map[storageKey];
      map[storageKey] = Math.round(scrollTop);
      const keys = Object.keys(map);
      if (keys.length > MAX_SAVED_SCROLL_ENTRIES) {
        for (let i = 0; i < keys.length - MAX_SAVED_SCROLL_ENTRIES; i++) {
          delete map[keys[i]];
        }
      }
    }
    localStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage errors
  }
}

function getSavedScrollPosition(storageKey) {
  const map = loadScrollMap();
  const val = map[storageKey];
  return typeof val === 'number' && Number.isFinite(val) ? val : 0;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeHtmlEntities(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
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

function splitWikiPipe(inner) {
  const pipeIdx = inner.indexOf('|');
  if (pipeIdx === -1) return [inner, null];
  const targetPart = inner.slice(0, pipeIdx).replace(/\\$/, '');
  const aliasPart = inner.slice(pipeIdx + 1);
  return [targetPart, aliasPart];
}

// Escape bare unescaped % inside LaTeX math (e.g. $+52%$, $20%\text{–}40%$)
// so KaTeX renders literal percent signs instead of treating % as a comment.
function sanitizeLatex(tex) {
  return String(tex).replace(/\\.|%/g, (m) => (m === '%' ? '\\%' : m));
}

function renderLatexToHtml(tex, displayMode) {
  try {
    return katex.renderToString(sanitizeLatex(tex.trim()), {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
    });
  } catch {
    return escapeHtml(displayMode ? `$$${tex}$$` : `$${tex}$`);
  }
}

// Extract and pre-render block ($$...$$) and inline ($...$) LaTeX math safely
// without breaking normal dollar currency amounts like "$50 billion to $100 billion".
function extractMathPlaceholders(text, mathStore) {
  // 1. Block math: $$ ... $$ (single-line or multi-line)
  let out = text.replace(/(^|[^\\])\$\$([\s\S]+?)\$\$/g, (full, prefix, tex) => {
    if (!tex.trim()) return full;
    const idx = mathStore.length;
    mathStore.push({
      raw: tex.trim(),
      html: renderLatexToHtml(tex, true),
      display: true,
    });
    return `${prefix}${BLOCK_MATH_OPEN}${idx}${BLOCK_MATH_CLOSE}`;
  });

  // 2. Inline math: $...$ (single line, no leading/trailing space, closing $ not followed by digit)
  out = out.replace(
    /(^|[^\\$])\$(?!\s)((?:\\.|[^$\\\r\n])+?)(?<!\s)\$(?!\d)/g,
    (full, prefix, tex) => {
      if (!tex.trim()) return full;
      const idx = mathStore.length;
      mathStore.push({
        raw: tex.trim(),
        html: renderLatexToHtml(tex, false),
        display: false,
      });
      return `${prefix}${MATH_OPEN}${idx}${MATH_CLOSE}`;
    }
  );

  return out;
}

function restoreMathPlaceholders(html, mathStore) {
  if (!mathStore.length) return html;
  let out = html;
  // Unwrap standalone block math from <p>...</p> for valid HTML layout
  out = out.replace(
    new RegExp(`<p>\\s*${BLOCK_MATH_OPEN}(\\d+)${BLOCK_MATH_CLOSE}\\s*<\\/p>`, 'g'),
    (_, idx) => mathStore[Number(idx)]?.html ?? ''
  );
  out = out.replace(
    new RegExp(`${BLOCK_MATH_OPEN}(\\d+)${BLOCK_MATH_CLOSE}`, 'g'),
    (_, idx) => mathStore[Number(idx)]?.html ?? ''
  );
  out = out.replace(
    new RegExp(`${MATH_OPEN}(\\d+)${MATH_CLOSE}`, 'g'),
    (_, idx) => mathStore[Number(idx)]?.html ?? ''
  );
  return out;
}

function restoreRawMathForSlug(str, mathStore) {
  if (!mathStore.length) return str;
  return str
    .replace(
      new RegExp(`${BLOCK_MATH_OPEN}(\\d+)${BLOCK_MATH_CLOSE}`, 'g'),
      (_, idx) => mathStore[Number(idx)]?.raw ?? ''
    )
    .replace(
      new RegExp(`${MATH_OPEN}(\\d+)${MATH_CLOSE}`, 'g'),
      (_, idx) => mathStore[Number(idx)]?.raw ?? ''
    );
}

function preprocessObsidianMarkdown(body, resolvedLinks = {}, vaultNotesMap, mathStore) {
  const codeStore = [];
  const protectCode = (str) => {
    const token = `\uE000C${codeStore.length}\uE001`;
    codeStore.push(str);
    return token;
  };

  // 1. Protect fenced code blocks and inline code FIRST so nothing touches code/Mermaid
  let text = body
    .replace(/```[\s\S]*?```/g, (m) => protectCode(m))
    .replace(/~~~[\s\S]*?~~~/g, (m) => protectCode(m))
    .replace(/`[^`\n]+`/g, (m) => protectCode(m));

  // 2. Extract & pre-render LaTeX math (protected from Markdown emphasis/escaping)
  text = extractMathPlaceholders(text, mathStore);

  // 3. Highlight ==text==
  text = text.replace(/==([^=\n]+)==/g, '<mark class="obs-highlight">$1</mark>');

  // 4. Embeds: ![[target|option]]
  text = text.replace(/!\[\[([^\]]+)\]\]/g, (full, rawInner) => {
    const inner = rawInner.trim();
    const [targetPart, optionPart] = splitWikiPipe(inner);
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

  // 5. Wikilinks: [[target#heading|alias]] and table-escaped [[target\|alias]]
  text = text.replace(/\[\[([^\]]+)\]\]/g, (full, rawInner) => {
    const inner = rawInner.trim();
    const [targetPart, aliasPart] = splitWikiPipe(inner);
    const [notePartRaw, headingPart] = targetPart.split('#');
    const notePart = notePartRaw.trim();
    const displayLabel = aliasPart
      ? aliasPart.trim()
      : headingPart && !notePart
        ? headingPart.trim()
        : targetPart.trim();

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

  // 6. Inline #tags (protects existing HTML tags so attributes/hex colors aren't broken)
  const htmlTagStore = [];
  text = text.replace(/<[^>]+>/g, (tagStr) => {
    const token = `\uE000H${htmlTagStore.length}\uE001`;
    htmlTagStore.push(tagStr);
    return token;
  });

  text = text.replace(/(^|[\s(])#([\p{L}\p{N}_/-]+)/gu, (full, prefix, tag) => {
    if (/^\d+$/.test(tag)) return full;
    return `${prefix}<button type="button" class="obs-tag-pill" data-tag="${escapeHtml(
      tag
    )}">#${escapeHtml(tag)}</button>`;
  });

  text = text.replace(/\uE000H(\d+)\uE001/g, (_, idx) => htmlTagStore[Number(idx)] ?? '');

  // 7. Restore code blocks so marked renders them (including Mermaid detection)
  text = text.replace(/\uE000C(\d+)\uE001/g, (_, idx) => codeStore[Number(idx)] ?? '');
  return text;
}

const FOLD_CHEVRON_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';

function renderObsidianMarkdown(noteData, vaultNotesMap, options = {}) {
  if (!noteData) return '';
  const { isPreview = false } = options;

  const mathStore = [];
  const preprocessed = preprocessObsidianMarkdown(
    noteData.body || '',
    noteData.resolvedLinks || {},
    vaultNotesMap,
    mathStore
  );

  const headingCounts = new Map();

  const md = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      heading({ tokens, depth }) {
        const innerHtml = this.parser.parseInline(tokens);
        const plainRaw = restoreRawMathForSlug(
          decodeHtmlEntities(stripTagsFromHtml(innerHtml)),
          mathStore
        ).trim();
        const baseSlug = slugifyHeading(plainRaw);
        const seen = headingCounts.get(baseSlug) || 0;
        headingCounts.set(baseSlug, seen + 1);
        const slug = seen === 0 ? baseSlug : `${baseSlug}-${seen}`;

        if (isPreview) {
          return `<h${depth}>${innerHtml}</h${depth}>\n`;
        }

        const foldBtn =
          depth >= 2
            ? `<button type="button" class="obs-fold-btn" data-fold-toggle="true" aria-label="Toggle section" title="Fold / unfold section">${FOLD_CHEVRON_SVG}</button>`
            : '';

        return `<h${depth} id="${escapeHtml(slug)}" data-heading-level="${depth}">${foldBtn}${innerHtml}</h${depth}>\n`;
      },

      code({ text, lang }) {
        const cleanLang = (lang || '').trim().split(/\s+/)[0];
        if (!isPreview && cleanLang.toLowerCase() === 'mermaid') {
          return `<div class="obs-mermaid-wrap" data-mermaid-src="${escapeHtml(
            text || ''
          )}"><div class="obs-mermaid-loading">Rendering diagram…</div></div>\n`;
        }
        const langClass = cleanLang ? ` class="language-${escapeHtml(cleanLang)}"` : '';
        if (isPreview) {
          return `<pre><code${langClass}>${escapeHtml(text || '')}</code></pre>\n`;
        }
        return `<div class="obs-pre-wrap"><pre><code${langClass}>${escapeHtml(
          text || ''
        )}</code></pre><button type="button" class="obs-code-copy-btn" data-copy-code="true">Copy</button></div>\n`;
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

  let html = String(md.parse(preprocessed));

  // Restore pre-rendered KaTeX HTML AFTER marked finishes
  html = restoreMathPlaceholders(html, mathStore);

  // Wrap tables in an independent horizontal scroll container
  if (!isPreview) {
    html = html
      .replace(/<table(\s[^>]*)?>/g, '<div class="obs-table-wrap"><table$1>')
      .replace(/<\/table>/g, '</table></div>');
  }

  // Strip unsafe script tags or inline event attributes
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son\w+=(?:"[^"]*"|'[^']*')/gi, '');
}

function buildPreviewHtml(fullNote, vaultNotesMap) {
  if (!fullNote?.body) return '';
  let body = fullNote.body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*#\s+[^\n]+\n+/, '')
    .trim();

  if (body.length > 1100) {
    const cut = body.slice(0, 1100);
    const lastBreak = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '));
    body = (lastBreak > 320 ? cut.slice(0, lastBreak + 1) : cut).trim() + '…';
  }

  return renderObsidianMarkdown(
    { ...fullNote, body },
    vaultNotesMap,
    { isPreview: true }
  );
}

// Detect whether the note body already starts with an H1 repeating the filename title
function bodyStartsWithMatchingH1(noteData) {
  if (!noteData?.body || !noteData?.title) return false;
  const trimmed = noteData.body.replace(/^\s*(?:<!--[\s\S]*?-->\s*)*/, '');
  const match = trimmed.match(/^#\s+([^\n]+)/);
  if (!match) return false;

  const normalizeCore = (s) =>
    s
      .toLowerCase()
      .replace(/^(?:chapter|compendium)\s+0*\d+\s*[-–—:.]\s*/i, '')
      .replace(/^0*\d+\.\s*/, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();

  const fileCore = normalizeCore(noteData.title);
  const h1Core = normalizeCore(match[1]);
  if (!fileCore || !h1Core) return false;
  return h1Core === fileCore || h1Core.includes(fileCore) || fileCore.includes(h1Core);
}

function formatPropertyValue(val) {
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  // Clean ISO midnight UTC dates (e.g. 2026-11-21T00:00:00.000Z -> 2026-11-21)
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/i.test(str)) {
    return str.slice(0, 10);
  }
  return str;
}

// Render simple inline **bold** and *italic* cleanly inside property strings
function renderInlinePropertyText(text) {
  const tokens = String(text).split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return tokens.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={idx}>{part.slice(1, -1)}</em>;
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

function PropertiesBox({ properties, onSearchTag }) {
  // Default collapsed so the chapter prose starts right near the top
  const [collapsed, setCollapsed] = useState(true);

  const entries = useMemo(() => {
    if (!properties || typeof properties !== 'object') return [];
    return Object.entries(properties).filter(
      ([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)
    );
  }, [properties]);

  const summaryPaper = properties?.paper ? String(properties.paper) : null;
  const tagCount = useMemo(() => {
    const raw = properties?.tags ?? properties?.tag;
    if (!raw) return 0;
    if (Array.isArray(raw)) return raw.filter(Boolean).length;
    return String(raw).split(/[,\s]+/).filter(Boolean).length;
  }, [properties]);

  if (entries.length === 0) return null;

  return (
    <div className="obs-props-box">
      <button
        type="button"
        className="obs-props-header"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="obs-props-header-left">
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span>Properties</span>
        </span>
        {collapsed && (
          <span className="obs-props-summary">
            {summaryPaper && <span className="obs-props-chip">{summaryPaper}</span>}
            {tagCount > 0 && (
              <span className="obs-props-chip">
                {tagCount} {tagCount === 1 ? 'tag' : 'tags'}
              </span>
            )}
          </span>
        )}
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
                          {renderInlinePropertyText(formatPropertyValue(v))}
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

// Clear all in-file find highlight <mark> nodes cleanly without disturbing sibling elements
function clearFindHighlights(rootEl) {
  if (!rootEl) return;
  const marks = rootEl.querySelectorAll('mark.obs-find-match');
  if (marks.length === 0) return;
  const parents = new Set();
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parents.add(parent);
    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
  });
  parents.forEach((p) => p.normalize());
}

// Highlight case-insensitive matches inside readable text nodes (skipping KaTeX MathML & Mermaid SVGs)
function applyFindHighlights(rootEl, query) {
  if (!rootEl || !query) return [];
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      if (
        el.closest(
          '.katex-mathml, .obs-mermaid-wrap, .obs-code-copy-btn, .obs-fold-btn, .obs-folded-pill, script, style'
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  let current;
  while ((current = walker.nextNode())) {
    if (current.nodeValue.toLowerCase().includes(needle)) {
      textNodes.push(current);
    }
  }

  const createdMarks = [];
  for (const node of textNodes) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    let hitIdx = lower.indexOf(needle, lastIdx);

    while (hitIdx !== -1) {
      if (hitIdx > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, hitIdx)));
      }
      const mark = document.createElement('mark');
      mark.className = 'obs-find-match';
      mark.textContent = text.slice(hitIdx, hitIdx + query.length);
      frag.appendChild(mark);
      createdMarks.push(mark);
      lastIdx = hitIdx + query.length;
      hitIdx = lower.indexOf(needle, lastIdx);
    }

    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }
    node.parentNode?.replaceChild(frag, node);
  }

  return createdMarks;
}

export default function Reader({
  vaultIndex,
  vaultId = null,
  noteData,
  loading,
  readableWidth,
  targetHeading,
  onConsumeTargetHeading = null,
  findOpen = false,
  onCloseFind = null,
  fetchNote,
  onNavigateNote,
  onSearchTag,
  onActiveHeadingChange = null,
}) {
  const scrollRef = useRef(null);
  const articleRef = useRef(null);
  const markdownRef = useRef(null);
  const findInputRef = useRef(null);
  const findMarksRef = useRef([]);
  const hoverTimerRef = useRef(null);
  const hideTimerRef = useRef(null);
  const saveScrollTimerRef = useRef(null);
  const lastReportedSlugRef = useRef(null);
  const consumedHeadingRef = useRef(null);

  const [hoverPreview, setHoverPreview] = useState(null);
  const [progressPct, setProgressPct] = useState(0);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [foldedHeadings, setFoldedHeadings] = useState(() => new Set());
  const [docTheme, setDocTheme] = useState(
    () => document.documentElement.getAttribute('data-theme') || 'dark'
  );

  // In-File Find state
  const [findQuery, setFindQuery] = useState('');
  const [findCount, setFindCount] = useState(0);
  const [findIdx, setFindIdx] = useState(0);

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

  // Memoize object identity so React never wipes Mermaid SVGs, folded classes, or Find marks on unrelated renders
  const markdownInnerHtml = useMemo(() => ({ __html: renderedHtml }), [renderedHtml]);

  const hideDuplicateTopTitle = useMemo(() => bodyStartsWithMatchingH1(noteData), [noteData]);

  const scrollStorageKey = noteData?.path
    ? `${vaultId || vaultIndex?.id || 'default'}::${noteData.path}`
    : null;

  // Track theme changes for Mermaid re-rendering
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setDocTheme(document.documentElement.getAttribute('data-theme') || 'dark');
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => obs.disconnect();
  }, []);

  // Reset folded sections when switching notes
  useEffect(() => {
    setFoldedHeadings(new Set());
  }, [noteData?.path]);

  // Focus In-File Find input when opened; clean up highlights when closed
  useEffect(() => {
    if (findOpen) {
      requestAnimationFrame(() => {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      });
    } else {
      clearFindHighlights(articleRef.current);
      findMarksRef.current = [];
      setFindCount(0);
      setFindIdx(0);
    }
  }, [findOpen]);

  // Lazy-render Mermaid diagrams whenever note HTML or Dark/Light theme changes
  useEffect(() => {
    const mdEl = markdownRef.current;
    if (!mdEl) return;
    const wrappers = mdEl.querySelectorAll('.obs-mermaid-wrap[data-mermaid-src]');
    if (wrappers.length === 0) return;

    let cancelled = false;

    import('mermaid')
      .then(async (mod) => {
        if (cancelled) return;
        const mermaid = mod.default || mod;
        mermaid.initialize({
          startOnLoad: false,
          theme: docTheme === 'light' ? 'default' : 'dark',
          securityLevel: 'loose',
          flowchart: { useMaxWidth: true, htmlLabels: true },
        });

        for (let i = 0; i < wrappers.length; i++) {
          if (cancelled) return;
          const wrap = wrappers[i];
          const src = wrap.getAttribute('data-mermaid-src') || '';
          if (!src.trim()) continue;
          try {
            const uid = `mmd-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`;
            const { svg } = await mermaid.render(uid, src);
            if (!cancelled) {
              wrap.innerHTML = svg;
            }
          } catch {
            if (!cancelled) {
              wrap.innerHTML = `<pre class="obs-mermaid-fallback"><code>${escapeHtml(
                src
              )}</code></pre>`;
            }
          }
        }
      })
      .catch(() => {
        if (cancelled) return;
        wrappers.forEach((wrap) => {
          const src = wrap.getAttribute('data-mermaid-src') || '';
          wrap.innerHTML = `<pre class="obs-mermaid-fallback"><code>${escapeHtml(
            src
          )}</code></pre>`;
        });
      });

    return () => {
      cancelled = true;
    };
  }, [renderedHtml, docTheme]);

  // Apply section folding classes cleanly to sibling elements in .obs-markdown
  useEffect(() => {
    const mdEl = markdownRef.current;
    if (!mdEl) return;

    let activeFoldLevel = null;
    const children = Array.from(mdEl.children);

    for (const el of children) {
      const lvlAttr = el.getAttribute('data-heading-level');
      if (lvlAttr) {
        const lvl = Number(lvlAttr);
        if (activeFoldLevel !== null && lvl <= activeFoldLevel) {
          activeFoldLevel = null;
        }

        if (activeFoldLevel !== null) {
          el.classList.add('obs-section-folded');
        } else {
          el.classList.remove('obs-section-folded');
          const isFolded = foldedHeadings.has(el.id);
          const btn = el.querySelector('.obs-fold-btn');
          if (btn) btn.classList.toggle('is-folded', isFolded);

          let pill = el.querySelector('.obs-folded-pill');
          if (isFolded) {
            if (!pill) {
              pill = document.createElement('button');
              pill.type = 'button';
              pill.className = 'obs-folded-pill';
              pill.setAttribute('data-fold-toggle', 'true');
              pill.textContent = '…';
              pill.title = 'Click to expand section';
              el.appendChild(pill);
            }
            activeFoldLevel = lvl;
          } else if (pill) {
            pill.remove();
          }
        }
      } else {
        el.classList.toggle('obs-section-folded', activeFoldLevel !== null);
      }
    }
  }, [renderedHtml, foldedHeadings]);

  // Helper to automatically unfold any folded section hiding a target DOM element
  const ensureElementUnfolded = useCallback((el) => {
    const mdEl = markdownRef.current;
    if (!mdEl || !el) return;
    let topChild = el;
    while (topChild && topChild.parentElement && topChild.parentElement !== mdEl) {
      topChild = topChild.parentElement;
    }
    if (!topChild || !topChild.classList.contains('obs-section-folded')) return;

    // Walk backward to collect all folded ancestor headings above topChild
    const toUnfold = [];
    let sibling = topChild.previousElementSibling;
    let minLevelSeen = 99;
    while (sibling) {
      const lvlAttr = sibling.getAttribute('data-heading-level');
      if (lvlAttr) {
        const lvl = Number(lvlAttr);
        if (lvl < minLevelSeen) {
          minLevelSeen = lvl;
          if (sibling.id) toUnfold.push(sibling.id);
        }
      }
      sibling = sibling.previousElementSibling;
    }
    if (toUnfold.length > 0) {
      setFoldedHeadings((prev) => {
        const next = new Set(prev);
        toUnfold.forEach((id) => next.delete(id));
        return next;
      });
    }
  }, []);

  // Run In-File Find highlights whenever query / note changes while Find bar is open
  useEffect(() => {
    if (!findOpen) return;
    const rootEl = articleRef.current;
    if (!rootEl) return;

    const timer = setTimeout(() => {
      clearFindHighlights(rootEl);
      const q = findQuery.trim();
      if (!q) {
        findMarksRef.current = [];
        setFindCount(0);
        setFindIdx(0);
        return;
      }

      const marks = applyFindHighlights(rootEl, q);
      findMarksRef.current = marks;
      setFindCount(marks.length);
      setFindIdx(0);

      if (marks.length > 0) {
        marks[0].classList.add('is-current');
        ensureElementUnfolded(marks[0]);
        requestAnimationFrame(() => {
          marks[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
    }, 75);

    return () => clearTimeout(timer);
  }, [findOpen, findQuery, renderedHtml, ensureElementUnfolded]);

  const jumpToFindIndex = useCallback(
    (nextIdx) => {
      const marks = findMarksRef.current;
      if (!marks || marks.length === 0) return;
      const wrapped = ((nextIdx % marks.length) + marks.length) % marks.length;
      marks.forEach((m) => m.classList.remove('is-current'));
      const activeMark = marks[wrapped];
      if (activeMark) {
        activeMark.classList.add('is-current');
        ensureElementUnfolded(activeMark);
        setFindIdx(wrapped);
        requestAnimationFrame(() => {
          activeMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
    },
    [ensureElementUnfolded]
  );

  const updateScrollIndicators = useCallback(
    (container) => {
      if (!container) return;
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      const pct =
        maxScroll > 0 ? Math.min(100, Math.max(0, (container.scrollTop / maxScroll) * 100)) : 0;
      setProgressPct(pct);
      setShowBackToTop(container.scrollTop > 420);

      // Live Outline Scroll-Spy
      if (onActiveHeadingChange) {
        const headingEls = container.querySelectorAll(
          '.obs-markdown h1[id], .obs-markdown h2[id], .obs-markdown h3[id], .obs-markdown h4[id], .obs-markdown h5[id], .obs-markdown h6[id]'
        );
        if (headingEls.length > 0) {
          const containerTop = container.getBoundingClientRect().top;
          const threshold = containerTop + 96;
          let currentSlug = headingEls[0].id;
          for (let i = 0; i < headingEls.length; i++) {
            const el = headingEls[i];
            if (el.classList.contains('obs-section-folded')) continue;
            const rect = el.getBoundingClientRect();
            if (rect.top <= threshold) {
              currentSlug = el.id;
            } else {
              break;
            }
          }
          if (currentSlug !== lastReportedSlugRef.current) {
            lastReportedSlugRef.current = currentSlug;
            onActiveHeadingChange(currentSlug);
          }
        } else if (lastReportedSlugRef.current !== null) {
          lastReportedSlugRef.current = null;
          onActiveHeadingChange(null);
        }
      }
    },
    [onActiveHeadingChange]
  );

  // Restore saved scroll position OR jump cleanly to a fresh target heading
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !noteData) return;

    lastReportedSlugRef.current = null;

    if (targetHeading && targetHeading !== consumedHeadingRef.current) {
      const slug = targetHeading.split('::')[0];
      consumedHeadingRef.current = targetHeading;
      if (slug) {
        const timer = setTimeout(() => {
          const targetEl = container.querySelector(`[id="${CSS.escape(slug)}"]`);
          if (targetEl) {
            ensureElementUnfolded(targetEl);
            requestAnimationFrame(() => {
              targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
              targetEl.classList.remove('obs-heading-flash');
              void targetEl.offsetWidth;
              targetEl.classList.add('obs-heading-flash');
            });
          }
          updateScrollIndicators(container);
          onConsumeTargetHeading?.();
        }, 35);
        return () => clearTimeout(timer);
      }
    }

    const saved = scrollStorageKey ? getSavedScrollPosition(scrollStorageKey) : 0;
    const rafId = requestAnimationFrame(() => {
      container.scrollTop = saved;
      updateScrollIndicators(container);
    });

    return () => cancelAnimationFrame(rafId);
  }, [
    noteData?.path,
    targetHeading,
    scrollStorageKey,
    ensureElementUnfolded,
    updateScrollIndicators,
    onConsumeTargetHeading,
  ]);

  useEffect(() => {
    return () => {
      clearTimeout(hoverTimerRef.current);
      clearTimeout(hideTimerRef.current);
      clearTimeout(saveScrollTimerRef.current);
    };
  }, []);

  const handleScroll = (e) => {
    const container = e.currentTarget;
    updateScrollIndicators(container);

    if (scrollStorageKey) {
      const top = container.scrollTop;
      clearTimeout(saveScrollTimerRef.current);
      saveScrollTimerRef.current = setTimeout(() => {
        saveScrollPosition(scrollStorageKey, top);
      }, 220);
    }
  };

  const scrollToTop = () => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleContentClick = async (e) => {
    // 1. Fold / Unfold heading toggle
    const foldBtn = e.target.closest('[data-fold-toggle]');
    if (foldBtn) {
      e.preventDefault();
      e.stopPropagation();
      const headingEl = foldBtn.closest('[data-heading-level]');
      if (headingEl?.id) {
        setFoldedHeadings((prev) => {
          const next = new Set(prev);
          if (next.has(headingEl.id)) next.delete(headingEl.id);
          else next.add(headingEl.id);
          return next;
        });
      }
      return;
    }

    // 2. Hover Copy button on code/ASCII blocks
    const copyBtn = e.target.closest('[data-copy-code]');
    if (copyBtn) {
      e.preventDefault();
      const preWrap = copyBtn.closest('.obs-pre-wrap');
      const codeEl = preWrap?.querySelector('pre code') || preWrap?.querySelector('pre');
      const rawText = codeEl?.textContent || '';
      if (rawText) {
        try {
          await navigator.clipboard.writeText(rawText);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = rawText;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        copyBtn.textContent = 'Copied ✓';
        copyBtn.classList.add('is-copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('is-copied');
        }, 1600);
      }
      return;
    }

    // 3. Inline tag click
    const tagBtn = e.target.closest('[data-tag]');
    if (tagBtn) {
      e.preventDefault();
      onSearchTag(tagBtn.getAttribute('data-tag'));
      return;
    }

    // 4. Internal wikilink / heading link
    const link = e.target.closest('.internal-link');
    if (!link) return;
    e.preventDefault();

    if (link.getAttribute('data-unresolved') === 'true') return;

    const path = link.getAttribute('data-note-path');
    const heading = link.getAttribute('data-heading') || null;

    if (!path && heading) {
      const targetEl = scrollRef.current?.querySelector(`[id="${CSS.escape(heading)}"]`);
      if (targetEl) {
        ensureElementUnfolded(targetEl);
        requestAnimationFrame(() => {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          targetEl.classList.remove('obs-heading-flash');
          void targetEl.offsetWidth;
          targetEl.classList.add('obs-heading-flash');
        });
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

      const left = Math.min(rect.left, window.innerWidth - 395);
      const top =
        rect.bottom + 290 > window.innerHeight
          ? Math.max(12, rect.top - 285)
          : rect.bottom + 8;

      setHoverPreview({
        path,
        title: meta.title,
        folder: meta.folder,
        html: `<p>${escapeHtml(meta.excerpt || 'Loading...')}</p>`,
        x: Math.max(12, left),
        y: top,
      });

      try {
        const full = await fetchNote(path);
        if (full) {
          const previewHtml = buildPreviewHtml(full, vaultNotesMap);
          setHoverPreview((prev) =>
            prev && prev.path === path ? { ...prev, html: previewHtml } : prev
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
      {/* 2px Top Reading Progress Bar */}
      <div className="obs-progress-track" aria-hidden="true">
        <div className="obs-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>

      {/* In-File Find Bar */}
      {findOpen && (
        <div className="obs-find-bar">
          <Search size={14} color="var(--text-faint)" style={{ flexShrink: 0 }} />
          <input
            ref={findInputRef}
            className="obs-find-input"
            placeholder="Find in this file..."
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onCloseFind?.();
              } else if (e.key === 'Enter') {
                e.preventDefault();
                jumpToFindIndex(e.shiftKey ? findIdx - 1 : findIdx + 1);
              }
            }}
          />
          {findQuery.trim() && (
            <span className="obs-find-count">
              {findCount > 0 ? `${findIdx + 1} / ${findCount}` : '0 / 0'}
            </span>
          )}
          <button
            type="button"
            className="obs-icon-btn"
            style={{ width: 24, height: 24 }}
            disabled={findCount === 0}
            onClick={() => jumpToFindIndex(findIdx - 1)}
            title="Previous match (Shift+Enter)"
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            className="obs-icon-btn"
            style={{ width: 24, height: 24 }}
            disabled={findCount === 0}
            onClick={() => jumpToFindIndex(findIdx + 1)}
            title="Next match (Enter)"
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            className="obs-icon-btn"
            style={{ width: 24, height: 24 }}
            onClick={() => onCloseFind?.()}
            title="Close find (Esc)"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="obs-reader-scroll" ref={scrollRef} onScroll={handleScroll}>
        <article
          ref={articleRef}
          className={`obs-reader-container ${readableWidth ? 'is-readable-width' : ''}`}
        >
          {!hideDuplicateTopTitle && <h1 className="obs-note-title">{noteData.title}</h1>}
          <PropertiesBox
            key={noteData.path}
            properties={noteData.properties}
            onSearchTag={onSearchTag}
          />
          <div
            ref={markdownRef}
            className="obs-markdown"
            onClick={handleContentClick}
            onMouseOver={handleMouseOver}
            onMouseOut={handleMouseOut}
            dangerouslySetInnerHTML={markdownInnerHtml}
          />
        </article>
      </div>

      {/* Floating Back-to-Top Button */}
      {showBackToTop && (
        <button
          type="button"
          className="obs-back-to-top"
          onClick={scrollToTop}
          title="Back to top"
        >
          <ArrowUp size={15} />
        </button>
      )}

      {/* Formatted Desktop Hover Preview */}
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
          <div
            className="obs-hover-preview-rendered obs-markdown"
            dangerouslySetInnerHTML={{ __html: hoverPreview.html }}
          />
        </div>
      )}
    </>
  );
}

export function RightInspector({
  vaultIndex,
  activeNotePath,
  noteData,
  activeHeadingSlug = null,
  rightTab,
  setRightTab,
  onClose,
  onNavigateNote,
}) {
  const outlineListRef = useRef(null);
  const backlinks = activeNotePath ? vaultIndex.backlinks?.[activeNotePath] || [] : [];
  const outlinks = activeNotePath ? vaultIndex.outlinks?.[activeNotePath] || [] : [];

  const headings = noteData?.headings || [];
  const minHeadingLevel = useMemo(
    () => (headings.length ? Math.min(...headings.map((h) => h.level)) : 1),
    [headings]
  );

  // Keep active outline item softly scrolled into view inside the Right Inspector
  useEffect(() => {
    if (rightTab !== 'outline' || !activeHeadingSlug || !outlineListRef.current) return;
    const activeEl = outlineListRef.current.querySelector(
      `[data-outline-slug="${CSS.escape(activeHeadingSlug)}"]`
    );
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeHeadingSlug, rightTab]);

  const handleLocalNavigate = useCallback(
    (path, newTab) => {
      onNavigateNote(path, null, newTab);
    },
    [onNavigateNote]
  );

  const jumpToHeading = (slug) => {
    const el = document.querySelector(`.obs-reader-scroll [id="${CSS.escape(slug)}"]`);
    if (el) {
      // Unfold any folded parent section if needed
      if (el.classList.contains('obs-section-folded')) {
        let sib = el.previousElementSibling;
        while (sib) {
          const btn = sib.querySelector('.obs-fold-btn.is-folded');
          if (btn) btn.click();
          sib = sib.previousElementSibling;
        }
      }
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.remove('obs-heading-flash');
        void el.offsetWidth;
        el.classList.add('obs-heading-flash');
      });
    }
    if (window.innerWidth <= 768) {
      onClose();
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
              <div className="obs-outline-list" ref={outlineListRef}>
                {headings.map((h, i) => {
                  const isActive = activeHeadingSlug === h.slug;
                  return (
                    <button
                      key={`${h.slug}-${i}`}
                      data-outline-slug={h.slug}
                      className={`obs-outline-item ${isActive ? 'is-active' : ''}`}
                      style={{ paddingLeft: `${8 + (h.level - minHeadingLevel) * 13}px` }}
                      onClick={() => jumpToHeading(h.slug)}
                    >
                      {h.text}
                    </button>
                  );
                })}
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
                  onSelectNote={handleLocalNavigate}
                />
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}