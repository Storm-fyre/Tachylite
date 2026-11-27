import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT_DIR = Path(__file__).resolve().parent
PHYSICS_DIR = ROOT_DIR / "Physics"

MARKER_START = "<!-- OBSIDIAN-WEB-START -->"
MARKER_END = "<!-- OBSIDIAN-WEB-END -->"
BT3 = "`" * 3

EXPECTED_PHYSICS = {
    ("Paper 1", 1): ("phy-p1-mech", 5),
    ("Paper 1", 2): ("phy-p1-opt", 4),
    ("Paper 1", 3): ("phy-p1-em", 5),
    ("Paper 1", 4): ("phy-p1-stat", 4),
    ("Paper 2", 1): ("phy-p2-qm", 4),
    ("Paper 2", 2): ("phy-p2-amp", 4),
    ("Paper 2", 3): ("phy-p2-nuc", 4),
    ("Paper 2", 4): ("phy-p2-ssp", 4),
    ("Paper 2", 5): ("phy-p2-elec", 4),
}

FM_RE = re.compile(r"^---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|$)", re.DOTALL)
WIKILINK_RE = re.compile(r"(?<!!)\[\[([^\]]+)\]\]")
MERMAID_BLOCK_RE = re.compile(
    r"^" + BT3 + r"mermaid\s*\r?\n(.*?)^" + BT3 + r"\s*$",
    re.MULTILINE | re.DOTALL,
)
UNQUOTED_NODE_RE = re.compile(r"\b[A-Za-z0-9_]+\s*(\[[^\"\]]+\]|\([^\"\)]+\)|\{[^\"\}]+})")
GROUNDING_LEAK_RE = re.compile(r"\[\d+\.\d+(?:\.\d+)?(?:\s*,\s*\d+\.\d+(?:\.\d+)?)*\]")
COLLAPSED_EXAMPLE_RE = re.compile(r"^>\s*\[!example\]-", re.MULTILINE | re.IGNORECASE)


def split_body_footer(text: str) -> tuple[str, str, int]:
    cnt = text.count(MARKER_START)
    idx = text.find(MARKER_START)
    if idx == -1:
        return text, "", 0
    return text[:idx], text[idx:], cnt


def parse_yaml_kv(body: str) -> tuple[dict | None, str | None, str]:
    cleaned = body.lstrip("\ufeff")
    if not cleaned.startswith("---"):
        first = cleaned.splitlines()[0][:70] if cleaned.splitlines() else "<EMPTY>"
        return None, f"Line 1 does not start with '---' (found: {first!r})", cleaned
    m = FM_RE.match(cleaned)
    if not m:
        return None, "Opening '---' found without closing '---'", cleaned
    kv = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.lstrip().startswith("-"):
            k, v = line.split(":", 1)
            kv[k.strip().lower()] = v.strip().strip('"').strip("'")
    return kv, None, cleaned[m.end():]


def strip_fenced_code(text: str) -> str:
    out = []
    in_code = False
    for line in text.splitlines():
        if line.strip().startswith(BT3):
            in_code = not in_code
            continue
        if not in_code:
            out.append(line)
    return "\n".join(out)


def check_mermaid_blocks(body_no_fm: str) -> list[str]:
    issues = []
    bad_chars = set("():/&<>;,")
    for b_idx, block in enumerate(MERMAID_BLOCK_RE.findall(body_no_fm), start=1):
        for l_no, line in enumerate(block.splitlines(), start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith((
                "%%", "flowchart", "graph", "subgraph", "end",
                "style", "classDef", "class ", "linkStyle", "direction",
            )):
                continue
            masked = re.sub(r'"[^"]*"', '""', stripped)
            for nm in UNQUOTED_NODE_RE.finditer(masked):
                inner = nm.group(1)[1:-1].strip()
                if inner.startswith(("[", "(", "{")) and inner.endswith(("]", ")", "}")):
                    inner = inner[1:-1].strip()
                if not inner or inner == '""':
                    continue
                found_bad = sorted(ch for ch in bad_chars if ch in inner)
                if found_bad:
                    issues.append(
                        f"Mermaid #{b_idx} L{l_no}: unquoted {''.join(found_bad)} in `{stripped[:75]}`"
                    )
    return issues


def main() -> None:
    print("=" * 80)
    print("  PHYSICS OPTIONAL VAULT VALIDATOR  |  READ-ONLY AUDIT (0 FILES MODIFIED)")
    print("=" * 80)
    if not PHYSICS_DIR.is_dir():
        print(f"[FATAL] Missing 'Physics' folder at: {PHYSICS_DIR}")
        sys.exit(1)

    paper_hubs = []
    subject_hubs = []
    chapters = []

    yaml_errors = []
    hub_tag_errors = []
    trunc_flags = []
    latex_flags = []
    mermaid_flags = []
    artifact_flags = []
    isolation_flags = []
    footer_flags = []

    total_words = 0
    total_examples = 0

    for paper_name in ("Paper 1", "Paper 2"):
        p_dir = PHYSICS_DIR / paper_name
        if not p_dir.is_dir():
            yaml_errors.append(f"Missing folder: Physics/{paper_name}")
            continue

        # 1. Check Paper Core Hub
        p_hub = p_dir / f"{paper_name}.md"
        if p_hub.is_file():
            paper_hubs.append(p_hub)
            txt = p_hub.read_text(encoding="utf-8", errors="replace")
            body, footer, m_cnt = split_body_footer(txt)
            kv, yerr, _ = parse_yaml_kv(body)
            if yerr:
                yaml_errors.append(f"[{paper_name}.md] {yerr}")
            elif "subject-hub" not in kv.get("tags", "").lower():
                hub_tag_errors.append(f"[{paper_name}.md] Missing 'subject-hub' tag in YAML")
            if m_cnt != 1 or MARKER_END not in footer:
                footer_flags.append(f"[{paper_name}.md] OBSIDIAN-WEB markers count={m_cnt}")
        else:
            yaml_errors.append(f"Missing Paper Core: Physics/{paper_name}/{paper_name}.md")

        # 2. Check Subject Hubs & Chapters
        for sub_dir in sorted(p_dir.iterdir(), key=lambda p: p.name.lower()):
            if not sub_dir.is_dir():
                continue
            ms = re.match(r"^(\d+)\.\s+(.*)$", sub_dir.name)
            if not ms:
                continue
            s_num = int(ms.group(1))
            s_name = ms.group(2).strip()
            exp_pfx, exp_cnt = EXPECTED_PHYSICS.get((paper_name, s_num), ("", 0))

            found_ch_nums = set()
            found_shub = False

            for md in sorted(sub_dir.iterdir(), key=lambda p: p.name.lower()):
                if not md.is_file() or md.suffix.lower() != ".md":
                    continue
                txt = md.read_text(encoding="utf-8", errors="replace")
                body, footer, m_cnt = split_body_footer(txt)
                kv, yerr, after_fm = parse_yaml_kv(body)

                # Subject Hub
                if md.stem.lower() == s_name.lower():
                    found_shub = True
                    subject_hubs.append(md)
                    if yerr:
                        yaml_errors.append(f"[{paper_name}/{md.name}] {yerr}")
                    else:
                        tags_str = kv.get("tags", "").lower()
                        if "physics-subject-hub" not in tags_str:
                            hub_tag_errors.append(f"[{md.name}] Missing 'physics-subject-hub' tag")
                        # Ensure bare 'subject-hub' isn't present (which would color it Gold instead of Silver)
                        tag_tokens = [t.strip() for t in re.split(r"[\[\],\s]+", tags_str) if t.strip()]
                        if "subject-hub" in tag_tokens:
                            hub_tag_errors.append(f"[{md.name}] Still carries bare 'subject-hub' (will glow Gold!)")
                    if m_cnt != 1 or MARKER_END not in footer:
                        footer_flags.append(f"[{md.name}] OBSIDIAN-WEB markers count={m_cnt}")
                    continue

                # Chapter File
                mc = re.match(r"^(\d+)\.\s+(.*)$", md.stem)
                if not mc:
                    continue
                ch_num = int(mc.group(1))
                found_ch_nums.add(ch_num)
                chapters.append(md)

                tag = f"[{paper_name} {s_num}.{ch_num}] {md.stem}.md"

                # Check 2: YAML & Mis-paste
                if yerr:
                    yaml_errors.append(f"{tag} -> {yerr}")
                else:
                    y_id = kv.get("id", "").lower()
                    y_num = kv.get("unit_num", "")
                    if y_num and y_num.isdigit() and int(y_num) != ch_num:
                        yaml_errors.append(f"{tag} -> YAML unit_num={y_num} != {ch_num}")
                    if exp_pfx and y_id and not y_id.startswith(exp_pfx):
                        yaml_errors.append(f"{tag} -> YAML id='{y_id}' expected prefix '{exp_pfx}'")

                # Check 3: Completeness & Footers
                size_kb = md.stat().st_size / 1024.0
                words = len(after_fm.split())
                total_words += words
                if size_kb < 12.0 or words < 1500:
                    trunc_flags.append(f"{tag} -> {size_kb:.1f} KB / {words} words")
                if "upsc interrogation lens" not in after_fm.lower():
                    trunc_flags.append(f"{tag} -> Missing '## UPSC Interrogation Lens'")
                if m_cnt != 1 or MARKER_END not in footer:
                    footer_flags.append(f"{tag} -> OBSIDIAN-WEB markers count={m_cnt}")

                # Check 4: Balanced $$ Display LaTeX & Collapsed Worked Numericals
                no_code = strip_fenced_code(after_fm)
                dd_count = no_code.count("$$")
                if dd_count % 2 != 0:
                    latex_flags.append(f"{tag} -> UNBALANCED '$$' count ({dd_count}) outside code blocks")
                ex_cnt = len(COLLAPSED_EXAMPLE_RE.findall(after_fm))
                total_examples += ex_cnt
                if ex_cnt == 0:
                    latex_flags.append(f"{tag} -> 0 collapsed '> [!example]-' worked numericals found")

                # Check 5: Mermaid Safety
                for merr in check_mermaid_blocks(after_fm):
                    mermaid_flags.append(f"{tag} -> {merr}")

                # Check 6: Stray Artifacts & Grounding Bracket Leaks
                low_body = body.lower()
                for needle, label in (
                    ("vertexaisearch.cloud.google.com", "leaked vertexaisearch URL"),
                    ("grounding-api-redirect", "leaked grounding redirect URL"),
                    ("[clean — no edits needed]", "accidentally pasted CLEAN card"),
                    ("\ncitations\n", "trailing Citations block"),
                ):
                    if needle in low_body:
                        artifact_flags.append(f"{tag} -> {label}")
                leaks = GROUNDING_LEAK_RE.findall(no_code)
                if leaks:
                    artifact_flags.append(
                        f"{tag} -> {len(leaks)} stray grounding bracket(s): {', '.join(leaks[:4])}"
                    )

                # Check 7: Strict Isolation (No accidental inline wikilinks in Physics chapter bodies)
                body_links = WIKILINK_RE.findall(no_code)
                if body_links:
                    isolation_flags.append(
                        f"{tag} -> {len(body_links)} inline wikilink(s): {body_links[:3]}"
                    )

            if not found_shub:
                yaml_errors.append(f"Missing Subject Hub inside {paper_name}/{sub_dir.name}")
            for expected_c in range(1, exp_cnt + 1):
                if expected_c not in found_ch_nums:
                    trunc_flags.append(f"Missing Chapter {expected_c} in {paper_name}/{sub_dir.name}")

    print(
        f"\n[INVENTORY] Paper Cores: {len(paper_hubs)}/2 | Subject Branches: {len(subject_hubs)}/9 | "
        f"Chapters: {len(chapters)}/38 | Total: {len(paper_hubs)+len(subject_hubs)+len(chapters)}/49"
    )
    print(f"[METRICS]   Total Physics Words: {total_words:,} | Collapsed Worked Numericals ('> [!example]-'): {total_examples}")

    def report(title: str, items: list[str], limit: int = 25) -> None:
        print("-" * 80)
        print(f"{title:<46} Flags = {len(items)}")
        for it in items[:limit]:
            print(f"  [FLAG] {it}")
        if len(items) > limit:
            print(f"  ... and {len(items) - limit} more.")

    report("CHECK 1 — YAML & MIS-PASTE AUDIT", yaml_errors)
    report("CHECK 2 — HUB TAG ISOLATION (GOLD vs SILVER)", hub_tag_errors)
    report("CHECK 3 — COMPLETENESS & ZERO TRUNCATION", trunc_flags)
    report("CHECK 4 — LATEX '$$' & COLLAPSED NUMERICALS", latex_flags)
    report("CHECK 5 — MERMAID SYNTAX SAFETY", mermaid_flags)
    report("CHECK 6 — STRAY CITATIONS & ARTIFACTS", artifact_flags)
    report("CHECK 7 — GRAPH FOOTERS & BODY ISOLATION", footer_flags + isolation_flags)
    print("=" * 80)


if __name__ == "__main__":
    main()