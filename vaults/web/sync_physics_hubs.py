import re
import sys
from datetime import date
from pathlib import Path

sys.dont_write_bytecode = True

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT_DIR = Path(__file__).resolve().parent
MARKER_START = "<!-- OBSIDIAN-WEB-START -->"
SKIP_H2_EXACT = {
    "upsc interrogation lens",
    "interrogation lens",
}

FM_RE = re.compile(r"^---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|$)", re.DOTALL)
FOLDER_RE = re.compile(r"^(\d+)\.\s+(.*)$")
UNIT_RE = re.compile(r"^(\d+)\.\s+(.*)$")
HEADING_RE = re.compile(r"^(#{2,3})\s+(.+?)\s*#*\s*$")
FENCE_RE = re.compile(r"^\s*(?:```|~~~)")

PAPER_DESCRIPTIONS = {
    "Paper 1": "Classical Mechanics, Special Relativity, Waves & Optics, Electrodynamics, and Thermal & Statistical Physics (250 Marks).",
    "Paper 2": "Quantum Mechanics, Atomic & Molecular Spectra, Nuclear & Particle Physics, Solid State & Superconductivity, and Semiconductor Devices & Electronics (250 Marks).",
}


def locate_physics_dir() -> Path | None:
    for cand in (ROOT_DIR / "Physics", ROOT_DIR / "vaults" / "web" / "Physics"):
        if cand.is_dir():
            return cand
    return None


def split_frontmatter(text: str) -> tuple[str | None, str]:
    cleaned = text.lstrip("\ufeff")
    m = FM_RE.match(cleaned)
    if not m:
        return None, cleaned
    return m.group(1), cleaned[m.end():]


def parse_yaml_fields(fm_text: str | None) -> dict[str, object]:
    data: dict[str, object] = {}
    if not fm_text:
        return data
    for line in fm_text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or ":" not in line or line[0].isspace():
            continue
        key, raw_val = line.split(":", 1)
        key = key.strip().lower()
        val = raw_val.strip()
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            data[key] = [
                p.strip().strip('"').strip("'").replace('\\"', '"')
                for p in inner.split(",")
                if p.strip()
            ]
        else:
            if (val.startswith('"') and val.endswith('"')) or (
                val.startswith("'") and val.endswith("'")
            ):
                val = val[1:-1]
            data[key] = val.replace('\\"', '"').strip()
    return data


def format_date_clean(raw_val: object) -> str:
    s = str(raw_val or "").strip()
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", s)
    return m.group(1) if m else s


def clean_heading_text(raw: str) -> str:
    text = raw.strip()
    text = re.sub(r"\[\[([^\]|]+?)\\?\|([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace('\\"', '"')
    text = re.sub(r"^\d+(?:\.\d+)?\.\s+", "", text)
    return re.sub(r"\s+", " ", text).strip()


def sanitize_alias(text: str) -> str:
    return (
        text.replace('\\"', '"')
        .replace("|", " - ")
        .replace("[", "(")
        .replace("]", ")")
        .strip()
    )


def extract_chapter_metadata(md_path: Path, ch_num: int) -> dict:
    raw = md_path.read_text(encoding="utf-8", errors="replace")
    marker_idx = raw.find(MARKER_START)
    body_all = raw[:marker_idx] if marker_idx != -1 else raw

    fm_text, after_fm = split_frontmatter(body_all)
    kv = parse_yaml_fields(fm_text)

    default_title = re.sub(r"^\d+\.\s*", "", md_path.stem).strip()
    title = str(kv.get("title") or default_title).strip()
    title = re.sub(
        rf"^(?:Chapter|Part)\s+0*{ch_num}\s*[:\-–—\.]\s*",
        "",
        title,
        flags=re.IGNORECASE,
    ).strip()

    rubric = str(kv.get("depth_rubric") or "").strip()
    verified = format_date_clean(kv.get("last_verified"))

    h2_list: list[str] = []
    h3_list: list[str] = []
    in_fence = False

    for line in after_fm.splitlines():
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        hm = HEADING_RE.match(line)
        if not hm:
            continue
        lvl = len(hm.group(1))
        cleaned = clean_heading_text(hm.group(2))
        if not cleaned or cleaned.lower() in SKIP_H2_EXACT:
            continue
        if lvl == 2:
            h2_list.append(cleaned)
        elif lvl == 3:
            h3_list.append(cleaned)

    return {
        "ch_num": ch_num,
        "stem": md_path.stem,
        "title": title,
        "rubric": rubric,
        "verified": verified,
        "sections": h2_list if h2_list else h3_list[:12],
    }


def extract_existing_footer(path: Path) -> str:
    if not path.exists():
        return ""
    raw = path.read_text(encoding="utf-8", errors="replace")
    idx = raw.find(MARKER_START)
    return raw[idx:].lstrip("\r\n") if idx != -1 else ""


def build_subject_hub_markdown(
    hub_path: Path,
    paper_name: str,
    sub_num: int,
    subject_name: str,
    chapters: list[dict],
    today_str: str,
) -> str:
    footer_part = extract_existing_footer(hub_path)
    paper_tag = "physics-paper1" if paper_name == "Paper 1" else "physics-paper2"
    paper_id = "p1" if paper_name == "Paper 1" else "p2"

    # Intentionally uses physics-subject-hub (NOT subject-hub) so ONLY Paper 1 & Paper 2 glow Gold
    lines = [
        "---",
        f"id: phy-{paper_id}-hub-{sub_num:02d}",
        f'title: "{subject_name}"',
        f"paper: [{paper_name.replace(' ', '_')}]",
        f"chapters: {len(chapters)}",
        "status: synced",
        f"last_synced: {today_str}",
        f"tags: [upsc-2027, physics-optional, {paper_tag}, physics-subject-hub]",
        "---",
        "",
        f"# ⚛️ {subject_name} ({paper_name})",
        "",
        "> [!abstract] Live Auto-Synced Physics Subject Map",
        f"> **{len(chapters)} Chapters** · Parent Core: [[{paper_name}]] · Synced directly from audited chapters on **{today_str}**.",
        "",
        "---",
        "",
    ]

    for idx, ch in enumerate(chapters):
        alias = sanitize_alias(f"Chapter {ch['ch_num']}: {ch['title']}")
        lines.append(f"### [[{ch['stem']}|{alias}]]")

        meta_bits = []
        if ch["rubric"]:
            meta_bits.append(f"**Rubric:** {ch['rubric']}")
        if ch["verified"]:
            meta_bits.append(f"**Verified:** {ch['verified']}")
        if meta_bits:
            lines.append("> " + " · ".join(meta_bits))
            lines.append("")

        if ch["sections"]:
            for sec in ch["sections"]:
                lines.append(f"- {sec}")
        else:
            lines.append("- *(No section headings found)*")

        if idx < len(chapters) - 1:
            lines.extend(["", "---", ""])
        else:
            lines.append("")

    content = "\n".join(lines).rstrip() + "\n"
    if footer_part:
        content += "\n" + footer_part.rstrip() + "\n"
    return content


def build_paper_hub_markdown(
    paper_hub_path: Path,
    paper_name: str,
    subject_entries: list[dict],
    today_str: str,
) -> str:
    footer_part = extract_existing_footer(paper_hub_path)
    paper_tag = "physics-paper1" if paper_name == "Paper 1" else "physics-paper2"
    total_ch = sum(s["chapter_count"] for s in subject_entries)
    desc = PAPER_DESCRIPTIONS.get(paper_name, "UPSC CSE Physics Optional Paper.")

    lines = [
        "---",
        f"id: phy-{paper_name.lower().replace(' ', '-')}-core",
        f'title: "Physics Optional — {paper_name}"',
        f"paper: [{paper_name.replace(' ', '_')}]",
        f"subjects: {len(subject_entries)}",
        f"chapters: {total_ch}",
        "status: synced",
        f"last_synced: {today_str}",
        f"tags: [upsc-2027, physics-optional, {paper_tag}, subject-hub]",
        "---",
        "",
        f"# ⚛️ Physics Optional — {paper_name}",
        "",
        f"> [!abstract] {paper_name} Constellation Core",
        f"> **{len(subject_entries)} Subjects · {total_ch} Chapters** · {desc}",
        "",
        "## Subject Branches",
        "",
    ]

    for s in subject_entries:
        lines.append(
            f"- **Unit {s['sub_num']}:** [[{s['hub_stem']}]] *({s['chapter_count']} chapters)*"
        )

    content = "\n".join(lines).rstrip() + "\n"
    if footer_part:
        content += "\n" + footer_part.rstrip() + "\n"
    return content


def main() -> None:
    physics_dir = locate_physics_dir()
    if not physics_dir:
        print(f"[ERROR] Could not find 'Physics' folder near: {ROOT_DIR}")
        sys.exit(1)

    today_str = date.today().isoformat()
    write_plans: list[tuple[str, Path, str, str]] = []

    for paper_name in ("Paper 1", "Paper 2"):
        paper_dir = physics_dir / paper_name
        if not paper_dir.is_dir():
            print(f"[WARN] Missing folder: {paper_dir}")
            continue

        sub_dirs = []
        for entry in paper_dir.iterdir():
            if not entry.is_dir():
                continue
            m = FOLDER_RE.match(entry.name)
            if m:
                sub_dirs.append((int(m.group(1)), m.group(2).strip(), entry))
        sub_dirs.sort(key=lambda x: x[0])

        paper_subjects = []
        for sub_num, sub_name, folder_path in sub_dirs:
            hub_path = folder_path / f"{sub_name}.md"
            ch_files = []
            for md in sorted(folder_path.iterdir(), key=lambda p: p.name.lower()):
                if not md.is_file() or md.suffix.lower() != ".md":
                    continue
                if md.stem.lower() == sub_name.lower():
                    hub_path = md
                    continue
                um = UNIT_RE.match(md.stem)
                if um:
                    ch_files.append((int(um.group(1)), md))
            ch_files.sort(key=lambda x: x[0])

            chapters = [extract_chapter_metadata(md, c_num) for c_num, md in ch_files]
            sub_md = build_subject_hub_markdown(
                hub_path, paper_name, sub_num, sub_name, chapters, today_str
            )
            sec_count = sum(len(c["sections"]) for c in chapters)
            write_plans.append(
                (
                    "SUBJECT_HUB",
                    hub_path,
                    sub_md,
                    f"{paper_name} / {hub_path.name:<48} | {len(chapters)} chs | {sec_count:>2} sections",
                )
            )
            paper_subjects.append(
                {
                    "sub_num": sub_num,
                    "subject": sub_name,
                    "hub_stem": hub_path.stem,
                    "chapter_count": len(chapters),
                }
            )

        paper_hub_path = paper_dir / f"{paper_name}.md"
        paper_md = build_paper_hub_markdown(
            paper_hub_path, paper_name, paper_subjects, today_str
        )
        action = "UPDATE" if paper_hub_path.exists() else "CREATE"
        write_plans.append(
            (
                f"PAPER_HUB ({action})",
                paper_hub_path,
                paper_md,
                f"{paper_name} / {paper_hub_path.name:<48} | {len(paper_subjects)} subjects ({action})",
            )
        )

    print("=" * 84)
    print("  PHYSICS HUB AUTO-SYNC & PAPER CORE BUILDER (PREVIEW — NO FILES MODIFIED YET)")
    print("=" * 84)
    print(f"Target Folder: {physics_dir}\n")
    for kind, _path, _content, label in write_plans:
        print(f"  [{kind:<18}] {label}")
    print("-" * 84)
    print(f"  TOTAL: {len(write_plans)} Hub files (2 Paper Cores + 9 Subject Hubs) | 0 Chapters Modified")
    print("=" * 84)

    try:
        ans = input("Write all synced Physics Paper & Subject Hubs? (y/n): ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print("\n[ABORTED] No files were modified.")
        return

    if ans not in ("y", "yes"):
        print("[ABORTED] No files were modified.")
        return

    for _kind, path, content, _label in write_plans:
        path.write_text(content, encoding="utf-8")

    print(f"\n[DONE] Wrote {len(write_plans)} Physics hub files! Next: run `python new_build.py`.")


if __name__ == "__main__":
    main()