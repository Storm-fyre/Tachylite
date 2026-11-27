import json
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ==============================================================================
# CONFIGURATION & MARKERS (ZERO HARDCODED PATHS)
# ==============================================================================
ROOT_DIR = Path(__file__).resolve().parent
CIVIL_DIR = ROOT_DIR / "Civil Service"
GTK_DIR = ROOT_DIR / "Good to Know"
PHYSICS_DIR = ROOT_DIR / "Physics"
OBSIDIAN_DIR = ROOT_DIR / ".obsidian"

MARKER_START = b"<!-- OBSIDIAN-WEB-START -->"
MARKER_END = b"<!-- OBSIDIAN-WEB-END -->"

# Set True to preview report without modifying any files
DRY_RUN = False

# False = Full GS-Paper + Physics Binary-Star Palette (Recommended)
# True  = Minimal Palette (Gold Hubs, Silver Physics Branches, Blue GS, Lime/Magenta Physics, Cyan Support, Orange GTK)
USE_FOUR_COLOR_MINIMAL = False

SUBJECT_BADGES = {
    1: "Indian History",
    2: "Modern History",
    3: "World History",
    4: "Geography",
    5: "Sociology",
    6: "Polity",
    7: "Governance",
    8: "IR",
    9: "Economy",
    10: "Agrarian Systems",
    11: "Ecology & DM",
    12: "Sci-Tech",
    13: "National Security",
    14: "Ethics",
    15: "Support Layer",
}

# ==============================================================================
# 15. SUPPORT LAYER MATRICES -> PARENT YELLOW SUBJECT HUBS (8 CLEAN HUB LINKS)
# ==============================================================================
SUPPORT_TO_HUBS = {
    (15, 1): [12, 11],  # Prelims Applied Bio & Chem -> Sci-Tech, Ecology & DM
    (15, 2): [6, 7],    # Constitutional/Statutory Bodies & Schedules -> Polity, Governance
    (15, 3): [11, 4],   # India Spatial Atlas (UNESCO/Ramsar/Tiger) -> Ecology & DM, Geography
    (15, 4): [6],       # Landmark 2023-2026 SC Judgments -> Polity
    (15, 5): [8],       # International Orgs, Treaties & Indices -> IR
}

# ==============================================================================
# GOOD TO KNOW COMPENDIUMS -> 2-3 SHARPEST CHAPTERS EACH (28 LINKS TOTAL)
# ==============================================================================
GOOD_TO_KNOW_TO_CHAPTERS = {
    "23 MSP Crops": [
        (10, 2),  # Agro-Ecological Zones & Diversification
        (10, 5),  # Agrarian Pricing (MSP-CACP) & PDS
        (10, 6),  # Agricultural Marketing & e-NAM
    ],
    "Cattle and Buffaloes": [
        (10, 9),  # Livestock Economics & Allied Sectors
        (1, 3),   # Vedic Society & Pastoral Economy
    ],
    "Hydrocarbon Fuels - Chemistry & Engineering": [
        (4, 16),  # Mineral & Energy Cartography
        (11, 10), # Subcontinental Decarbonization Pathways
        (12, 15), # Next-Gen Energy Tech
    ],
    "Heuristics and Razors": [
        (14, 1),  # Foundational Moral Philosophy & Epistemology
        (14, 4),  # Attitude & Cognitive Biases
        (1, 15),  # Indian Philosophical Systems
    ],
    "Human Genetics and Blood Groups": [
        (12, 9),  # Molecular Biology & Gene Therapies
        (12, 10), # Stem Cells & Population Genomics
        (15, 1),  # Prelims Applied Biology Shield
    ],
    "Modified Zellers Congruence": [
        (1, 16),  # Indigenous Knowledge Systems (Math & Astronomy)
        (12, 7),  # Supercomputing & Algorithms
    ],
    "Sovereignty of Serbia and Bosnia": [
        (3, 3),   # 19th-C Nationalism & Balkan Powder Keg
        (3, 4),   # The Great War & Imperial Collapse
        (8, 1),   # Strategic Mental Models
    ],
    "Anatomy of Political Belief": [
        (6, 2),   # Preamble & Citizenship
        (3, 2),   # Industrial Capitalism & Socialist Ideologies
        (14, 4),  # Attitude, Persuasion & Cognitive Biases
    ],
    "Global Flag Color Families": [
        (3, 7),   # Decolonization in Asia & Africa
        (8, 12),  # West Asia
        (8, 13),  # Africa & Global South
    ],
    "Geopolitics of Imperial Capital Shifts": [
        (1, 18),  # Delhi Sultanate II (Tughlaq Daulatabad)
        (2, 10),  # Swadeshi & 1911 Calcutta-Delhi Shift
        (8, 1),   # Classical Geopolitical Doctrines
    ],
}

GOOD_TO_KNOW_PEER_PAIRS = [
    ("23 MSP Crops", "Cattle and Buffaloes"),
    ("Heuristics and Razors", "Anatomy of Political Belief"),
    ("Sovereignty of Serbia and Bosnia", "Global Flag Color Families"),
    ("Global Flag Color Families", "Geopolitics of Imperial Capital Shifts"),
    ("Sovereignty of Serbia and Bosnia", "Geopolitics of Imperial Capital Shifts"),
]


# ==============================================================================
# HELPER FUNCTIONS
# ==============================================================================
INLINE_WIKILINK_RE = re.compile(r"(?<!!)\[\[([^\]]+)\]\]")


def count_inline_links(file_path: Path) -> int:
    raw = file_path.read_bytes()
    idx = raw.find(MARKER_START)
    body_bytes = raw[:idx] if idx != -1 else raw
    body_text = body_bytes.decode("utf-8", errors="ignore")
    return len(INLINE_WIKILINK_RE.findall(body_text))


def update_file_with_footer(file_path: Path, footer_markdown: str):
    """Idempotently replaces only the fenced OBSIDIAN-WEB footer block."""
    raw = file_path.read_bytes()
    idx = raw.find(MARKER_START)
    if idx != -1:
        raw = raw[:idx].rstrip()
    else:
        raw = raw.rstrip()

    block = (
        "\n\n<!-- OBSIDIAN-WEB-START -->\n---\n"
        + footer_markdown.strip()
        + "\n<!-- OBSIDIAN-WEB-END -->\n"
    ).encode("utf-8")

    if not DRY_RUN:
        file_path.write_bytes(raw + block)


def format_hub_link(hub: dict) -> str:
    if hub["stem"] == hub["subject"]:
        return f"[[{hub['stem']}]]"
    return f"[[{hub['stem']}|{hub['subject']}]]"


def scan_civil_service_tree(base_dir: Path):
    folders = {}
    hubs = {}
    chapters = {}
    unrenamed_hub_warnings = []

    for folder in sorted(base_dir.iterdir(), key=lambda p: p.name.lower()):
        if not folder.is_dir():
            continue
        m_f = re.match(r"^(\d+)\.\s+(.*)$", folder.name)
        if not m_f:
            continue

        f_num = int(m_f.group(1))
        subject_pure = m_f.group(2).strip()
        folders[f_num] = {
            "name": folder.name,
            "subject": subject_pure,
            "path": folder,
        }

        fallback_zero_hub = None

        for md_file in sorted(folder.iterdir(), key=lambda p: p.name.lower()):
            if not md_file.is_file() or md_file.suffix.lower() != ".md":
                continue

            if md_file.stem.lower() == subject_pure.lower():
                hubs[f_num] = {
                    "path": md_file,
                    "stem": md_file.stem,
                    "subject": subject_pure,
                }
                continue

            m_c = re.match(r"^(\d+)\.\s+(.*)$", md_file.stem)
            if not m_c:
                continue

            ch_num = int(m_c.group(1))
            if ch_num == 0:
                fallback_zero_hub = {
                    "path": md_file,
                    "stem": md_file.stem,
                    "subject": subject_pure,
                }
            else:
                chapters[(f_num, ch_num)] = {
                    "path": md_file,
                    "stem": md_file.stem,
                    "subject": subject_pure,
                }

        if f_num not in hubs and fallback_zero_hub is not None:
            hubs[f_num] = fallback_zero_hub
            unrenamed_hub_warnings.append(
                f"{folder.name}/{fallback_zero_hub['stem']}.md"
            )

    return folders, hubs, chapters, unrenamed_hub_warnings


def scan_good_to_know(gtk_dir: Path):
    gtk_files = {}
    if not gtk_dir.is_dir():
        return gtk_files

    for md_file in sorted(gtk_dir.iterdir(), key=lambda p: p.name.lower()):
        if md_file.is_file() and md_file.suffix.lower() == ".md":
            gtk_files[md_file.stem] = md_file
    return gtk_files


def scan_physics_tree(physics_dir: Path):
    """Discovers Paper 1 & Paper 2 cores, 9 Subject Branch Hubs, and 38 Chapters."""
    papers = {}
    if not physics_dir.is_dir():
        return papers

    for paper_name in ("Paper 1", "Paper 2"):
        p_dir = physics_dir / paper_name
        if not p_dir.is_dir():
            continue

        paper_hub = p_dir / f"{paper_name}.md"
        subjects = {}

        for sub_dir in sorted(p_dir.iterdir(), key=lambda p: p.name.lower()):
            if not sub_dir.is_dir():
                continue
            m_s = re.match(r"^(\d+)\.\s+(.*)$", sub_dir.name)
            if not m_s:
                continue

            s_num = int(m_s.group(1))
            s_title = m_s.group(2).strip()
            sub_hub = None
            sub_chapters = {}

            for md_file in sorted(sub_dir.iterdir(), key=lambda p: p.name.lower()):
                if not md_file.is_file() or md_file.suffix.lower() != ".md":
                    continue
                if md_file.stem.lower() == s_title.lower():
                    sub_hub = {"path": md_file, "stem": md_file.stem, "subject": s_title}
                    continue
                m_c = re.match(r"^(\d+)\.\s+(.*)$", md_file.stem)
                if m_c:
                    c_num = int(m_c.group(1))
                    sub_chapters[c_num] = {
                        "path": md_file,
                        "stem": md_file.stem,
                        "subject": s_title,
                    }

            subjects[s_num] = {
                "num": s_num,
                "folder": sub_dir.name,
                "subject": s_title,
                "hub": sub_hub,
                "chapters": sub_chapters,
            }

        papers[paper_name] = {
            "name": paper_name,
            "dir": p_dir,
            "hub_path": paper_hub if paper_hub.is_file() else None,
            "subjects": subjects,
        }

    return papers


def badge_for(f_num: int, fallback_subject: str) -> str:
    return SUBJECT_BADGES.get(f_num, fallback_subject)


def build_gs_path_query(folders: dict, subject_nums: list[int]) -> str:
    parts = []
    for n in subject_nums:
        if n in folders:
            parts.append(f'path:"Civil Service/{folders[n]["name"]}"')
    return " OR ".join(parts)


def configure_obsidian_graph(folders: dict, has_physics: bool):
    """Writes .obsidian/graph.json with unified GS Lotus + Physics Binary-Star colors."""
    if not DRY_RUN:
        OBSIDIAN_DIR.mkdir(parents=True, exist_ok=True)
    graph_json_path = OBSIDIAN_DIR / "graph.json"

    physics_groups = []
    if has_physics:
        physics_groups = [
            # Starlight Silver (#F1F5F9) — 9 Physics Subject Branch Hubs
            {"query": "tag:#physics-subject-hub", "color": {"a": 1, "rgb": 15857145}},
            # Electric Lime (#A3E635) — Physics Paper 1 Chapters (Classical)
            {"query": 'path:"Physics/Paper 1"', "color": {"a": 1, "rgb": 10741301}},
            # Neon Magenta (#E879F9) — Physics Paper 2 Chapters (Quantum & Electronics)
            {"query": 'path:"Physics/Paper 2"', "color": {"a": 1, "rgb": 15235577}},
        ]

    if USE_FOUR_COLOR_MINIMAL:
        color_groups = [
            # 1. Bright Gold (#FFB800) — 15 GS Hubs + 2 Physics Paper Cores
            {"query": "tag:#subject-hub", "color": {"a": 1, "rgb": 16758784}},
            *physics_groups,
            # Warm Orange (#F97316) — Good to Know Compendiums
            {"query": 'path:"Good to Know"', "color": {"a": 1, "rgb": 16347926}},
            # Neon Cyan (#22D3EE) — 15. Support Layer Matrices
            {"query": build_gs_path_query(folders, [15]), "color": {"a": 1, "rgb": 2282478}},
            # Electric Blue (#3B82F6) — All Core Civil Service Chapters
            {"query": 'path:"Civil Service"', "color": {"a": 1, "rgb": 3899894}},
        ]
    else:
        color_groups = [
            # 1. Bright Gold (#FFB800) — 15 GS Hubs + 2 Physics Paper Cores (highest priority)
            {"query": "tag:#subject-hub", "color": {"a": 1, "rgb": 16758784}},
            # 2-4. Physics Binary-Star Palette (Silver Branches, Electric Lime P1, Neon Magenta P2)
            *physics_groups,
            # 5. Warm Orange (#F97316) — Good to Know Compendiums
            {"query": 'path:"Good to Know"', "color": {"a": 1, "rgb": 16347926}},
            # 6. Neon Cyan (#22D3EE) — 15. Support Layer Master Matrices
            {"query": build_gs_path_query(folders, [15]), "color": {"a": 1, "rgb": 2282478}},
            # 7. Coral Rose (#EF476F) — GS1 (History, Geography, Sociology)
            {"query": build_gs_path_query(folders, [1, 2, 3, 4, 5]), "color": {"a": 1, "rgb": 15681391}},
            # 8. Electric Blue (#3B82F6) — GS2 (Polity, Governance, IR)
            {"query": build_gs_path_query(folders, [6, 7, 8]), "color": {"a": 1, "rgb": 3899894}},
            # 9. Emerald Green (#10B981) — GS3 (Economy, Agri, Ecology, Sci-Tech, NatSec)
            {"query": build_gs_path_query(folders, [9, 10, 11, 12, 13]), "color": {"a": 1, "rgb": 1096065}},
            # 10. Amethyst Violet (#A855F7) — GS4 (Ethics & Moral Philosophy)
            {"query": build_gs_path_query(folders, [14]), "color": {"a": 1, "rgb": 11032055}},
        ]

    color_groups = [g for g in color_groups if g["query"]]

    graph_config = {
        "collapse-filter": False,
        "search": "",
        "showTags": False,
        "showAttachments": False,
        "hideUnresolved": True,
        "showOrphans": True,
        "collapse-color-groups": False,
        "colorGroups": color_groups,
        "collapse-display": False,
        "showArrow": False,
        "textFadeMultiplier": -0.45,
        "nodeSizeMultiplier": 1.15,
        "lineSizeMultiplier": 0.85,
        "collapse-forces": False,
        "centerStrength": 0.32,
        "repelStrength": 13.5,
        "linkStrength": 0.92,
        "linkDistance": 155,
    }

    if not DRY_RUN:
        graph_json_path.write_text(
            json.dumps(graph_config, indent=2), encoding="utf-8"
        )


# ==============================================================================
# MAIN ORCHESTRATION
# ==============================================================================
def main():
    if not CIVIL_DIR.is_dir():
        print(f"ERROR: Could not find 'Civil Service' folder inside: {ROOT_DIR}")
        print("Place this script directly inside your root vault folder (vaults/web) and run again.")
        sys.exit(1)

    print(f"Target Vault Root: {ROOT_DIR}")
    if DRY_RUN:
        print("MODE: DRY RUN (no files will be modified)")

    folders, hubs, chapters, unrenamed_hubs = scan_civil_service_tree(CIVIL_DIR)
    gtk_files = scan_good_to_know(GTK_DIR)
    physics_papers = scan_physics_tree(PHYSICS_DIR)

    # Audit existing organic default inline links across Civil Service
    inline_link_total = 0
    inline_link_files = 0
    for ch in chapters.values():
        c = count_inline_links(ch["path"])
        if c > 0:
            inline_link_total += c
            inline_link_files += 1
    for hub in hubs.values():
        c = count_inline_links(hub["path"])
        if c > 0:
            inline_link_total += c
            inline_link_files += 1

    missing_refs = []

    # 1. Support Layer Matrices <-> Parent Yellow Subject Hubs
    hub_support_reverse = {}
    support_hub_edges = 0
    for sup_key, hub_nums in SUPPORT_TO_HUBS.items():
        if sup_key not in chapters:
            missing_refs.append(f"Support matrix missing: {sup_key}")
            continue
        for h_num in hub_nums:
            if h_num not in hubs:
                missing_refs.append(f"Support target hub missing: {h_num}")
                continue
            hub_support_reverse.setdefault(h_num, []).append(sup_key)
            support_hub_edges += 1

    # 2. Good to Know <-> Chapters + subtle Hub anchor
    gtk_chapter_reverse = {}
    hub_gtk_links = {}
    gtk_chapter_edges = 0

    for gtk_stem, targets in GOOD_TO_KNOW_TO_CHAPTERS.items():
        if gtk_stem not in gtk_files:
            missing_refs.append(f"Good to Know file missing: {gtk_stem}.md")
            continue
        for tgt in targets:
            if tgt not in chapters:
                missing_refs.append(f"Good to Know target missing ({gtk_stem}): {tgt}")
                continue
            gtk_chapter_reverse.setdefault(tgt, []).append(gtk_stem)
            hub_gtk_links.setdefault(tgt[0], set()).add(gtk_stem)
            gtk_chapter_edges += 1

    # 3. Light Good to Know Peer Links (symmetric)
    gtk_peers = {}
    seen_peer_pairs = set()
    for a, b in GOOD_TO_KNOW_PEER_PAIRS:
        if a == b:
            continue
        pair = tuple(sorted((a, b)))
        if pair in seen_peer_pairs:
            continue
        seen_peer_pairs.add(pair)
        if a in gtk_files and b in gtk_files:
            gtk_peers.setdefault(a, []).append(b)
            gtk_peers.setdefault(b, []).append(a)

    # --------------------------------------------------------------------------
    # WEB 1 — LAYER 1: Wire the 15 Yellow GS Subject Hubs (<Subject>.md)
    # --------------------------------------------------------------------------
    updated_hubs = 0
    core_hub_nums = [n for n in sorted(hubs.keys()) if n != 15]

    for idx, f_num in enumerate(core_hub_nums):
        hub = hubs[f_num]
        prev_f = core_hub_nums[idx - 1]
        next_f = core_hub_nums[(idx + 1) % len(core_hub_nums)]

        lines = [f"### 🧭 Subject Core: {hub['subject']}  #subject-hub"]
        lines.append(
            f"← {format_hub_link(hubs[prev_f])} | {format_hub_link(hubs[next_f])} →\n"
        )
        lines.append("#### 📚 Chapters in this Constellation")
        f_ch_nums = sorted([c for (fn, c) in chapters.keys() if fn == f_num])
        for c_num in f_ch_nums:
            ch = chapters[(f_num, c_num)]
            lines.append(f"- [[{ch['stem']}]]")

        sup_list = sorted(hub_support_reverse.get(f_num, []))
        if sup_list:
            lines.append("\n#### 🗂️ Connected Support Matrices")
            for sup_key in sup_list:
                lines.append(f"- [[{chapters[sup_key]['stem']}]]")

        gtk_list = sorted(hub_gtk_links.get(f_num, set()))
        if gtk_list:
            lines.append("\n#### 🔗 Connected Good to Know Compendiums")
            for gtk_stem in gtk_list:
                lines.append(f"- [[{gtk_stem}]]")

        update_file_with_footer(hub["path"], "\n".join(lines))
        updated_hubs += 1

    if 15 in hubs:
        sup_hub = hubs[15]
        lines = [f"### 🧭 Cross-Vault Reference Core: {sup_hub['subject']}  #subject-hub"]
        lines.append("\n#### 🗂️ Master Matrices & Atlases")
        sup_ch_nums = sorted([c for (fn, c) in chapters.keys() if fn == 15])
        for c_num in sup_ch_nums:
            ch = chapters[(15, c_num)]
            lines.append(f"- [[{ch['stem']}]]")

        gtk_list = sorted(hub_gtk_links.get(15, set()))
        if gtk_list:
            lines.append("\n#### 🔗 Connected Good to Know Compendiums")
            for gtk_stem in gtk_list:
                lines.append(f"- [[{gtk_stem}]]")

        update_file_with_footer(sup_hub["path"], "\n".join(lines))
        updated_hubs += 1

    # --------------------------------------------------------------------------
    # WEB 1 — LAYER 2: Wire Core GS Chapters (Subjects 1-14)
    # --------------------------------------------------------------------------
    updated_core = 0
    for (f_num, ch_num), ch in sorted(chapters.items()):
        if f_num == 15:
            continue

        lines = ["### 🕸️ Neural Graph Connections"]

        nav = []
        if (f_num, ch_num - 1) in chapters:
            nav.append(f"← [[{chapters[(f_num, ch_num - 1)]['stem']}|Ch {ch_num - 1}]]")
        if f_num in hubs:
            nav.append(f"🧭 {format_hub_link(hubs[f_num])}")
        if (f_num, ch_num + 1) in chapters:
            nav.append(f"[[{chapters[(f_num, ch_num + 1)]['stem']}|Ch {ch_num + 1}]] →")
        lines.append(" | ".join(nav))

        gtk_links = sorted(gtk_chapter_reverse.get((f_num, ch_num), []))
        if gtk_links:
            lines.append("\n**Good to Know**")
            for gtk_stem in gtk_links:
                lines.append(f"- [[{gtk_stem}]]")

        update_file_with_footer(ch["path"], "\n".join(lines))
        updated_core += 1

    # --------------------------------------------------------------------------
    # WEB 1 — LAYER 3: Wire 15. Support Layer Matrices
    # --------------------------------------------------------------------------
    updated_support = 0
    for (f_num, ch_num), ch in sorted(chapters.items()):
        if f_num != 15:
            continue

        lines = ["### 🗂️ Support Layer Connections"]

        nav = []
        if (15, ch_num - 1) in chapters:
            nav.append(f"← [[{chapters[(15, ch_num - 1)]['stem']}|Matrix {ch_num - 1}]]")
        if 15 in hubs:
            nav.append(f"🧭 {format_hub_link(hubs[15])}")
        if (15, ch_num + 1) in chapters:
            nav.append(f"[[{chapters[(15, ch_num + 1)]['stem']}|Matrix {ch_num + 1}]] →")
        lines.append(" | ".join(nav))

        target_hubs = [h for h in SUPPORT_TO_HUBS.get((15, ch_num), []) if h in hubs]
        if target_hubs:
            lines.append("\n**Primary Subject Hubs**")
            for h_num in sorted(target_hubs):
                lines.append(f"- 🧭 {format_hub_link(hubs[h_num])}")

        gtk_links = sorted(gtk_chapter_reverse.get((15, ch_num), []))
        if gtk_links:
            lines.append("\n**Good to Know**")
            for gtk_stem in gtk_links:
                lines.append(f"- [[{gtk_stem}]]")

        update_file_with_footer(ch["path"], "\n".join(lines))
        updated_support += 1

    # --------------------------------------------------------------------------
    # WEB 1 — LAYER 4: Wire 'Good to Know' Compendiums
    # --------------------------------------------------------------------------
    updated_gtk = 0
    unmapped_gtk = []
    for gtk_stem, gtk_path in sorted(gtk_files.items()):
        targets = GOOD_TO_KNOW_TO_CHAPTERS.get(gtk_stem)
        if targets is None:
            unmapped_gtk.append(gtk_stem)
            continue

        lines = ["### 🕸️ Neural Graph Connections"]

        valid_targets = [t for t in targets if t in chapters]
        if valid_targets:
            lines.append("#### 📘 Connected Civil Service Chapters")
            for tgt_key in sorted(valid_targets):
                tgt = chapters[tgt_key]
                badge = badge_for(tgt_key[0], tgt["subject"])
                lines.append(f"- **{badge}:** [[{tgt['stem']}]]")

        peers = sorted(gtk_peers.get(gtk_stem, []))
        if peers:
            lines.append("\n#### 🔗 Related Good to Know Compendiums")
            for peer_stem in peers:
                lines.append(f"- [[{peer_stem}]]")

        update_file_with_footer(gtk_path, "\n".join(lines))
        updated_gtk += 1

    # --------------------------------------------------------------------------
    # WEB 2 — LAYER 5: Wire Physics Optional Binary-Star Radial Constellation
    # (Strictly isolated from Civil Service & Good to Know!)
    # --------------------------------------------------------------------------
    phy_paper_hubs_wired = 0
    phy_subject_hubs_wired = 0
    phy_chapters_wired = 0

    for paper_name in ("Paper 1", "Paper 2"):
        pdata = physics_papers.get(paper_name)
        if not pdata:
            continue

        sibling_paper = "Paper 2" if paper_name == "Paper 1" else "Paper 1"
        has_sibling = sibling_paper in physics_papers and physics_papers[sibling_paper]["hub_path"] is not None

        # 5A. Paper Core Hub (Gold #subject-hub) -> Sibling Paper Core + 4 or 5 Subject Branches
        if pdata["hub_path"] is not None:
            lines = [f"### ⚛️ Physics Optional Core: {paper_name}  #subject-hub"]
            if has_sibling:
                arrow = f"[[{sibling_paper}]] →" if paper_name == "Paper 1" else f"← [[{sibling_paper}]]"
                lines.append(f"Companion Core: {arrow}\n")
            lines.append("#### 🌌 Subject Branches")
            for s_num in sorted(pdata["subjects"].keys()):
                sdata = pdata["subjects"][s_num]
                if sdata["hub"]:
                    lines.append(f"- [[{sdata['hub']['stem']}]]")
            update_file_with_footer(pdata["hub_path"], "\n".join(lines))
            phy_paper_hubs_wired += 1
        else:
            missing_refs.append(
                f"Physics/{paper_name}/{paper_name}.md missing (run sync_physics_hubs.py first!)"
            )

        # 5B. Subject Branch Hubs (Silver #physics-subject-hub) -> Parent Paper Core + 4-5 Chapters
        for s_num in sorted(pdata["subjects"].keys()):
            sdata = pdata["subjects"][s_num]
            shub = sdata["hub"]
            if shub:
                lines = [f"### ⚛️ Physics Subject Branch: {sdata['subject']}  #physics-subject-hub"]
                if pdata["hub_path"] is not None:
                    lines.append(f"Parent Core: 🧭 [[{paper_name}]]\n")
                lines.append("#### 📚 Chapters in this Branch")
                for c_num in sorted(sdata["chapters"].keys()):
                    ch = sdata["chapters"][c_num]
                    lines.append(f"- [[{ch['stem']}]]")
                update_file_with_footer(shub["path"], "\n".join(lines))
                phy_subject_hubs_wired += 1

            # 5C. Chapters -> Pure Radial Spoke to Subject Branch ONLY (zero rim edges)
            for c_num in sorted(sdata["chapters"].keys()):
                ch = sdata["chapters"][c_num]
                lines = ["### ⚛️ Physics Constellation"]
                if shub:
                    lines.append(f"🧭 [[{shub['stem']}]]")
                update_file_with_footer(ch["path"], "\n".join(lines))
                phy_chapters_wired += 1

    # --------------------------------------------------------------------------
    # STEP 6: Write Unified .obsidian/graph.json
    # --------------------------------------------------------------------------
    has_physics = bool(physics_papers)
    configure_obsidian_graph(folders, has_physics=has_physics)

    # --------------------------------------------------------------------------
    # FINAL INTEGRITY REPORT
    # --------------------------------------------------------------------------
    total_gs = updated_hubs + updated_core + updated_support + updated_gtk
    total_phy = phy_paper_hubs_wired + phy_subject_hubs_wired + phy_chapters_wired
    total_wired = total_gs + total_phy
    palette_label = (
        "Minimal + Physics Binary-Star"
        if USE_FOUR_COLOR_MINIMAL
        else "7-Color GS Lotus + 3-Tier Physics Binary-Star"
    )

    print("=================================================================")
    print("DONE! Two-Web Knowledge Graph Built Successfully:")
    print("  [WEB 1 — CIVIL SERVICE + GOOD TO KNOW]")
    print(f"    - GS Subject Hubs wired (1-14 Chain + 15 Ref Core): {updated_hubs}")
    print(f"    - Core GS Chapters wired (Subjects 1-14):           {updated_core}")
    print(f"    - Support Layer Matrices wired (Subject 15):        {updated_support}")
    print(f"    - Good to Know compendiums wired:                   {updated_gtk}")
    print("  [WEB 2 — PHYSICS OPTIONAL BINARY-STAR (ISOLATED)]")
    print(f"    - Gold Paper Cores wired (Paper 1 <-> Paper 2):     {phy_paper_hubs_wired}")
    print(f"    - Silver Subject Branches wired (4 + 5):            {phy_subject_hubs_wired}")
    print(f"    - Radial Physics Chapters wired (18 + 20):          {phy_chapters_wired}")
    print("-----------------------------------------------------------------")
    print(f"  - TOTAL UNIQUE NODES WIRED:                           {total_wired}")
    print(f"  - Organic GS inline links preserved:                  {inline_link_total} (across {inline_link_files} notes)")
    print(f"  - Support Layer -> Yellow Hub Links:                  {support_hub_edges}")
    print(f"  - Good to Know -> Chapter Links:                      {gtk_chapter_edges}")
    print(f"  - Cross-Web GS <-> Physics Links:                     0 (strictly isolated)")
    print(f"  - Active Graph Palette:                               {palette_label}")
    print("=================================================================")

    if unrenamed_hubs:
        print("\n[INFO] GS hubs still carrying '0.' prefix:")
        for h in unrenamed_hubs:
            print(f"  - {h}")
    if missing_refs:
        print("\n[WARNING] Unresolved coordinate references:")
        for msg in missing_refs:
            print(f"  - {msg}")
    if unmapped_gtk:
        print("\n[INFO] Unmapped files in 'Good to Know' (left untouched):")
        for stem in unmapped_gtk:
            print(f"  - {stem}.md")


if __name__ == "__main__":
    main()