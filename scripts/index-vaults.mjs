import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const ROOT_DIR = process.cwd();
const VAULTS_DIR = path.join(ROOT_DIR, 'vaults');
const OUT_DIR = path.join(ROOT_DIR, 'public', 'vault-data');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
const ASSET_EXTS = new Set([
  ...IMAGE_EXTS,
  '.pdf',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.mp4',
  '.webm',
  '.mov',
]);

const DEFAULT_GRAPH_CONFIG = {
  hideUnresolved: true,
  showOrphans: true,
  showTags: false,
  showAttachments: false,
  showArrow: false,
  textFadeMultiplier: 0,
  nodeSizeMultiplier: 1,
  lineSizeMultiplier: 1,
  centerStrength: 0.5,
  repelStrength: 10,
  linkStrength: 1,
  linkDistance: 250,
  scale: 1,
  colorGroups: [],
};

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[warn] Could not parse JSON at ${filePath}: ${err.message}`);
    return fallback;
  }
}

function rgbIntToHex(rgbInt) {
  if (typeof rgbInt !== 'number' || Number.isNaN(rgbInt)) return '#888888';
  return '#' + (rgbInt >>> 0).toString(16).padStart(6, '0').slice(-6);
}

function slugifyHeading(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
}

function stripCodeBlocksAndInlineCode(md) {
  return md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]+`/g, '');
}

function stripMarkdownForSearch(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[\[([^\]]+)\]\]/g, ' ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~`>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTagList(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,\s]+/)
      : [];
  return list
    .map((t) => String(t).trim().replace(/^#/, ''))
    .filter(Boolean);
}

function normalizeAliases(data) {
  const raw = data?.aliases ?? data?.alias;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((a) => String(a).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    return raw.split(',').map((a) => a.trim()).filter(Boolean);
  }
  return [];
}

function extractHeadings(mdBody) {
  const headings = [];
  const counts = new Map();
  let inFence = false;
  const lines = mdBody.split(/\r?\n/);

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (!match) continue;

    const level = match[1].length;
    const rawText = match[2].trim();
    const cleanText = rawText
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`~]/g, '');

    const baseSlug = slugifyHeading(cleanText);
    const seen = counts.get(baseSlug) || 0;
    counts.set(baseSlug, seen + 1);
    const slug = seen === 0 ? baseSlug : `${baseSlug}-${seen}`;

    headings.push({ level, text: cleanText, slug });
  }
  return headings;
}

function extractInlineTags(mdBody) {
  const clean = stripCodeBlocksAndInlineCode(mdBody);
  const tags = new Set();
  const tagRegex = /(?:^|[\s(])#([\p{L}\p{N}_/-]+)/gu;
  let match;
  while ((match = tagRegex.exec(clean)) !== null) {
    const tag = match[1];
    // Obsidian ignores purely numeric tags like #123
    if (/^\d+$/.test(tag)) continue;
    tags.add(tag);
  }
  return [...tags];
}

function extractLinks(mdBody) {
  const clean = stripCodeBlocksAndInlineCode(mdBody);
  const links = [];

  // Wikilinks & embeds: [[target#heading|alias]] or ![[target]]
  const wikiRegex = /(!?)\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = wikiRegex.exec(clean)) !== null) {
    const isEmbed = match[1] === '!';
    const inner = match[2].trim();
    if (!inner) continue;

    const [targetPart, aliasPart] = inner.split('|');
    const [notePartRaw, headingPart] = targetPart.split('#');
    const target = notePartRaw.trim();
    const heading = headingPart ? headingPart.trim() : null;
    const alias = aliasPart ? aliasPart.trim() : null;

    if (!target && heading) continue; // Same-note #heading jump
    links.push({
      kind: 'wiki',
      isEmbed,
      raw: inner,
      target,
      heading,
      alias,
      index: match.index,
    });
  }

  // Standard markdown links: [label](url)
  const mdLinkRegex = /(!?)\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g;
  while ((match = mdLinkRegex.exec(clean)) !== null) {
    const isEmbed = match[1] === '!';
    let href = match[3].replace(/\s+"[^"]*"$/, '').trim();
    if (!href || /^(https?:|mailto:|tel:|data:|file:|#)/i.test(href)) continue;
    href = href.replace(/^<|>$/g, '');
    const [pathPart, headingPart] = href.split('#');
    let decoded;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      decoded = pathPart;
    }
    if (!decoded) continue;

    links.push({
      kind: 'markdown',
      isEmbed,
      raw: href,
      target: decoded,
      heading: headingPart ? headingPart.trim() : null,
      alias: match[2] || null,
      index: match.index,
    });
  }

  return links;
}

function extractContextSnippet(cleanText, targetRaw) {
  const idx = cleanText.indexOf(targetRaw);
  if (idx === -1) return '';
  const start = Math.max(0, idx - 80);
  const end = Math.min(cleanText.length, idx + targetRaw.length + 100);
  let snippet = cleanText.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < cleanText.length) snippet = snippet + '...';
  return snippet;
}

function walkVaultFiles(vaultDir) {
  const mdFiles = [];
  const assetFiles = [];
  let latestMtime = 0;

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.obsidian' || entry.name === '.git' || entry.name === '.trash') {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;

        const relPath = toPosix(path.relative(vaultDir, fullPath));
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.md') {
          mdFiles.push({ fullPath, relPath, mtimeMs: stat.mtimeMs });
        } else if (ASSET_EXTS.has(ext)) {
          assetFiles.push({ fullPath, relPath, ext });
        }
      }
    }
  }

  walk(vaultDir);
  return { mdFiles, assetFiles, latestMtime };
}

function buildFolderTree(notes) {
  const root = { name: '', path: '', type: 'folder', children: [] };

  for (const note of notes) {
    const parts = note.path.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      if (isFile) {
        current.children.push({
          name: note.title,
          path: note.path,
          type: 'file',
        });
      } else {
        let folder = current.children.find(
          (c) => c.type === 'folder' && c.name === part
        );
        if (!folder) {
          folder = {
            name: part,
            path: currentPath,
            type: 'folder',
            children: [],
          };
          current.children.push(folder);
        }
        current = folder;
      }
    }
  }

  function sortNode(node) {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
    node.children.forEach(sortNode);
  }

  sortNode(root);
  return root.children;
}

function buildTargetResolver(notes, assetFiles) {
  const byExactPath = new Map();
  const byBasename = new Map();
  const byAlias = new Map();
  const assetsByPath = new Map();
  const assetsByBasename = new Map();

  for (const note of notes) {
    const noExt = note.path.replace(/\.md$/i, '');
    byExactPath.set(note.path.toLowerCase(), note);
    byExactPath.set(noExt.toLowerCase(), note);

    const baseKey = note.title.toLowerCase();
    if (!byBasename.has(baseKey)) byBasename.set(baseKey, []);
    byBasename.get(baseKey).push(note);

    for (const alias of note.aliases) {
      const aKey = alias.toLowerCase();
      if (!byAlias.has(aKey)) byAlias.set(aKey, []);
      byAlias.get(aKey).push(note);
    }
  }

  for (const asset of assetFiles) {
    assetsByPath.set(asset.relPath.toLowerCase(), asset);
    const base = path.posix.basename(asset.relPath).toLowerCase();
    if (!assetsByBasename.has(base)) assetsByBasename.set(base, []);
    assetsByBasename.get(base).push(asset);
  }

  function pickClosest(candidates, sourceDir) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const sameFolder = candidates.find(
      (c) => path.posix.dirname(c.path || c.relPath) === sourceDir
    );
    if (sameFolder) return sameFolder;
    return [...candidates].sort((a, b) => {
      const pa = a.path || a.relPath;
      const pb = b.path || b.relPath;
      return pa.length - pb.length;
    })[0];
  }

  return function resolve(rawTarget, sourceNotePath) {
    const cleaned = rawTarget.replace(/^\.\//, '').replace(/\\/g, '/').trim();
    const sourceDir = path.posix.dirname(sourceNotePath);

    // 1. Check relative to source folder
    if (sourceDir !== '.') {
      const relCandidate = path.posix.normalize(`${sourceDir}/${cleaned}`).toLowerCase();
      if (byExactPath.has(relCandidate)) {
        return { type: 'note', note: byExactPath.get(relCandidate) };
      }
      if (assetsByPath.has(relCandidate)) {
        return { type: 'asset', asset: assetsByPath.get(relCandidate) };
      }
    }

    // 2. Check exact vault path
    const exactKey = cleaned.toLowerCase();
    if (byExactPath.has(exactKey)) {
      return { type: 'note', note: byExactPath.get(exactKey) };
    }
    if (assetsByPath.has(exactKey)) {
      return { type: 'asset', asset: assetsByPath.get(exactKey) };
    }

    // 3. Check basename / filename
    const baseKey = path.posix.basename(cleaned).replace(/\.md$/i, '').toLowerCase();
    const noteMatch = pickClosest(byBasename.get(baseKey), sourceDir);
    if (noteMatch) return { type: 'note', note: noteMatch };

    const assetBaseKey = path.posix.basename(cleaned).toLowerCase();
    const assetMatch = pickClosest(assetsByBasename.get(assetBaseKey), sourceDir);
    if (assetMatch) return { type: 'asset', asset: assetMatch };

    // 4. Check aliases
    const aliasMatch = pickClosest(byAlias.get(exactKey), sourceDir);
    if (aliasMatch) return { type: 'note', note: aliasMatch };

    return null;
  };
}

function processVault(vaultName, vaultDir) {
  const vaultOutDir = path.join(OUT_DIR, vaultName);
  const notesOutDir = path.join(vaultOutDir, 'notes');
  const assetsOutDir = path.join(vaultOutDir, 'assets');
  ensureDir(notesOutDir);
  ensureDir(assetsOutDir);

  const obsidianDir = path.join(vaultDir, '.obsidian');
  const appearance = readJsonSafe(path.join(obsidianDir, 'appearance.json'), {
    showRibbon: false,
  });
  const rawGraph = readJsonSafe(path.join(obsidianDir, 'graph.json'), {});
  const graphConfig = {
    ...DEFAULT_GRAPH_CONFIG,
    ...rawGraph,
    colorGroups: Array.isArray(rawGraph.colorGroups)
      ? rawGraph.colorGroups.map((g) => ({
          query: g.query || '',
          color: rgbIntToHex(g.color?.rgb),
          alpha: g.color?.a ?? 1,
        }))
      : [],
  };

  const { mdFiles, assetFiles, latestMtime } = walkVaultFiles(vaultDir);

  // Copy attachments/assets
  const assetMap = {};
  for (const asset of assetFiles) {
    const destPath = path.join(assetsOutDir, asset.relPath);
    ensureDir(path.dirname(destPath));
    fs.copyFileSync(asset.fullPath, destPath);
    assetMap[asset.relPath] = `./vault-data/${encodeURIComponent(vaultName)}/assets/${asset.relPath
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
  }

  // Parse all markdown notes
  const parsedNotes = [];
  for (const file of mdFiles) {
    const raw = fs.readFileSync(file.fullPath, 'utf8');
    let frontmatter = {};
    let body = raw;

    try {
      const parsed = matter(raw);
      frontmatter = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
      body = parsed.content ?? raw;
    } catch (err) {
      console.warn(`[warn] Frontmatter fallback for ${file.relPath}: ${err.message}`);
    }

    const title = path.posix.basename(file.relPath, '.md');
    const folder = path.posix.dirname(file.relPath) === '.' ? '' : path.posix.dirname(file.relPath);
    const aliases = normalizeAliases(frontmatter);

    const fmTags = [
      ...normalizeTagList(frontmatter.tags),
      ...normalizeTagList(frontmatter.tag),
    ];
    const inlineTags = extractInlineTags(body);
    const tags = [...new Set([...fmTags, ...inlineTags])];

    const headings = extractHeadings(body);
    const plainText = stripMarkdownForSearch(body);
    const wordCount = plainText ? plainText.split(/\s+/).filter(Boolean).length : 0;
    const charCount = body.length;
    const excerpt = plainText.slice(0, 260);
    const links = extractLinks(body);

    parsedNotes.push({
      path: file.relPath,
      title,
      folder,
      aliases,
      tags,
      properties: frontmatter,
      headings,
      wordCount,
      charCount,
      excerpt,
      plainText,
      body,
      links,
      mtimeMs: file.mtimeMs,
    });
  }

  const resolveTarget = buildTargetResolver(parsedNotes, assetFiles);

  // Build links, backlinks, tags, graph
  const outlinks = {};
  const backlinksMap = new Map();
  const tagMap = {};
  const resolvedLinksByNote = {};
  const edgeSet = new Set();
  const graphEdges = [];
  const unresolvedNodesMap = new Map();

  for (const note of parsedNotes) {
    outlinks[note.path] = [];
    resolvedLinksByNote[note.path] = {};

    for (const tag of note.tags) {
      if (!tagMap[tag]) tagMap[tag] = [];
      tagMap[tag].push(note.path);
    }

    const seenOutTargets = new Set();

    for (const link of note.links) {
      const resolved = resolveTarget(link.target, note.path);

      if (resolved?.type === 'asset') {
        resolvedLinksByNote[note.path][link.raw] = {
          type: 'asset',
          url: assetMap[resolved.asset.relPath],
          ext: resolved.asset.ext,
          isImage: IMAGE_EXTS.has(resolved.asset.ext),
        };
        continue;
      }

      if (resolved?.type === 'note') {
        const targetNote = resolved.note;
        resolvedLinksByNote[note.path][link.raw] = {
          type: 'note',
          path: targetNote.path,
          title: targetNote.title,
          heading: link.heading ? slugifyHeading(link.heading) : null,
        };

        if (targetNote.path !== note.path) {
          // Outlinks
          if (!seenOutTargets.has(targetNote.path)) {
            seenOutTargets.add(targetNote.path);
            outlinks[note.path].push({
              path: targetNote.path,
              title: targetNote.title,
              unresolved: false,
            });
          }

          // Graph edge (undirected unique pair for clean physics, keeps direction metadata)
          const edgeKey = `${note.path}-->${targetNote.path}`;
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            graphEdges.push({
              source: note.path,
              target: targetNote.path,
              unresolved: false,
            });
          }

          // Backlinks
          if (!backlinksMap.has(targetNote.path)) {
            backlinksMap.set(targetNote.path, new Map());
          }
          const targetBacklinks = backlinksMap.get(targetNote.path);
          if (!targetBacklinks.has(note.path)) {
            targetBacklinks.set(note.path, {
              path: note.path,
              title: note.title,
              count: 0,
              snippets: [],
            });
          }
          const entry = targetBacklinks.get(note.path);
          entry.count += 1;
          if (entry.snippets.length < 3) {
            const snippet = extractContextSnippet(note.body, link.raw);
            if (snippet) entry.snippets.push(snippet);
          }
        }
      } else {
        // Unresolved link
        const unresolvedId = `__unresolved__:${link.target}`;
        if (!seenOutTargets.has(link.target)) {
          seenOutTargets.add(link.target);
          outlinks[note.path].push({
            path: link.target,
            title: link.target,
            unresolved: true,
          });
        }
        if (!unresolvedNodesMap.has(unresolvedId)) {
          unresolvedNodesMap.set(unresolvedId, {
            id: unresolvedId,
            title: link.target,
            path: link.target,
            folder: '',
            tags: [],
            unresolved: true,
            degree: 0,
          });
        }
        const edgeKey = `${note.path}-->${unresolvedId}`;
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          graphEdges.push({
            source: note.path,
            target: unresolvedId,
            unresolved: true,
          });
        }
      }
    }
  }

  // Format backlinks object
  const backlinks = {};
  for (const [targetPath, sourcesMap] of backlinksMap.entries()) {
    backlinks[targetPath] = [...sourcesMap.values()].sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })
    );
  }

  // Compute degrees for graph nodes
  const degreeCounts = new Map();
  for (const edge of graphEdges) {
    degreeCounts.set(edge.source, (degreeCounts.get(edge.source) || 0) + 1);
    degreeCounts.set(edge.target, (degreeCounts.get(edge.target) || 0) + 1);
  }

  const graphNodes = [
    ...parsedNotes.map((n) => ({
      id: n.path,
      title: n.title,
      path: n.path,
      folder: n.folder,
      tags: n.tags,
      unresolved: false,
      degree: degreeCounts.get(n.path) || 0,
    })),
    ...[...unresolvedNodesMap.values()].map((u) => ({
      ...u,
      degree: degreeCounts.get(u.id) || 0,
    })),
  ];

  // Write individual note JSON payloads + build lightweight search index
  const searchRecords = [];
  const noteSummaries = [];

  for (const note of parsedNotes) {
    const noteJsonPath = path.join(notesOutDir, `${note.path}.json`);
    ensureDir(path.dirname(noteJsonPath));
    fs.writeFileSync(
      noteJsonPath,
      JSON.stringify({
        path: note.path,
        title: note.title,
        folder: note.folder,
        aliases: note.aliases,
        tags: note.tags,
        properties: note.properties,
        headings: note.headings,
        wordCount: note.wordCount,
        charCount: note.charCount,
        body: note.body,
        resolvedLinks: resolvedLinksByNote[note.path],
      })
    );

    searchRecords.push({
      path: note.path,
      title: note.title,
      tags: note.tags,
      text: note.plainText,
    });

    noteSummaries.push({
      path: note.path,
      title: note.title,
      folder: note.folder,
      aliases: note.aliases,
      tags: note.tags,
      properties: note.properties,
      headings: note.headings,
      wordCount: note.wordCount,
      charCount: note.charCount,
      excerpt: note.excerpt,
      backlinkCount: (backlinks[note.path] || []).reduce((sum, b) => sum + b.count, 0),
    });
  }

  const tree = buildFolderTree(noteSummaries);

  fs.writeFileSync(
    path.join(vaultOutDir, 'index.json'),
    JSON.stringify({
      id: vaultName,
      name: vaultName,
      appearance,
      graphConfig,
      tree,
      notes: noteSummaries,
      backlinks,
      outlinks,
      tags: tagMap,
      graph: {
        nodes: graphNodes,
        links: graphEdges,
      },
    })
  );

  fs.writeFileSync(path.join(vaultOutDir, 'search.json'), JSON.stringify(searchRecords));

  console.log(
    `[indexed] "${vaultName}": ${parsedNotes.length} notes, ${assetFiles.length} assets, ${graphEdges.length} links`
  );

  return {
    id: vaultName,
    name: vaultName,
    noteCount: parsedNotes.length,
    assetCount: assetFiles.length,
    lastUpdated: latestMtime ? new Date(latestMtime).toISOString() : null,
    appearance,
  };
}

function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  ensureDir(OUT_DIR);

  if (!fs.existsSync(VAULTS_DIR)) {
    console.warn('[warn] No "vaults/" directory found yet. Writing empty manifest.');
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({ vaults: [] }));
    return;
  }

  const entries = fs.readdirSync(VAULTS_DIR, { withFileTypes: true });
  const vaultDirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  const vaults = [];
  for (const dir of vaultDirs) {
    const fullPath = path.join(VAULTS_DIR, dir.name);
    vaults.push(processVault(dir.name, fullPath));
  }

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({ vaults }, null, 2));
  console.log(`[done] Manifest written with ${vaults.length} vault(s).`);
}

main();