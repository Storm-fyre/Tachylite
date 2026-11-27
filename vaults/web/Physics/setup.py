from pathlib import Path
import re

# Always build inside the exact folder where this script is placed
BASE_DIR = Path(__file__).resolve().parent

FORBIDDEN_WIN_CHARS = re.compile(r'[<>:"/\\|?*#^\[\]]')

VAULT_STRUCTURE = {
    "Paper 1": [
        (
            "1. Mechanics and Special Relativity",
            "Mechanics and Special Relativity",
            [
                "1. Inertial & Non-Inertial Dynamics, Conservation Laws & Gravitational Potentials.md",
                "2. Central Force Motion, Keplerian Mechanics, Collisions & Rutherford Scattering.md",
                "3. Rigid Body Dynamics, Molecular Rotations & Gyroscopic Precession.md",
                "4. Mechanics of Continuous Media — Isotropic Elasticity & Viscous Fluid Dynamics.md",
                "5. Special Relativity, Minkowski Geometry, Four-Momentum & Relativistic Covariance.md",
            ],
        ),
        (
            "2. Waves and Optics",
            "Waves and Optics",
            [
                "1. Oscillations, Resonance, Coupled Modes, String Waves & Dispersion.md",
                "2. Geometrical Optics (Fermat & Paraxial Matrix Methods) & Interferometry.md",
                "3. Fraunhofer & Fresnel Diffraction and Optical Polarization.md",
                "4. Lasers, Holography & Optical Fiber Waveguide Physics.md",
            ],
        ),
        (
            "3. Electricity, Magnetism and Electrodynamics",
            "Electricity, Magnetism and Electrodynamics",
            [
                "1. Electrostatics, Boundary-Value Problems, Multipoles & Dielectric Media.md",
                "2. Magnetostatics, Vector Potential, Magnetic Shells & Magnetic Matter.md",
                "3. Electromagnetic Induction, DC Transients, AC Networks & Transformers.md",
                "4. Maxwell's Equations, Gauge Invariance, Relativistic Field Tensor & EM Waves.md",
                "5. EM Waves in Matter, Fresnel Optics, Dispersion, Scattering & Blackbody Radiation.md",
            ],
        ),
        (
            "4. Thermal and Statistical Physics",
            "Thermal and Statistical Physics",
            [
                "1. Thermodynamic Laws, Entropy, Heat Engines, Maxwell Relations & Phase Equilibria.md",
                "2. Real Gases, Liquefaction, Kinetic Theory, Transport Phenomena & Specific Heat of Solids.md",
                "3. Foundations of Statistical Physics, Classical Ensembles & Brownian Motion.md",
                "4. Quantum Statistical Mechanics (BE & FD), Degenerate Matter & Negative Absolute Temperatures.md",
            ],
        ),
    ],
    "Paper 2": [
        (
            "1. Quantum Mechanics",
            "Quantum Mechanics",
            [
                "1. Quantum Foundations, Wave-Particle Duality, Wave Packets, Uncertainty & Dirac Formalism.md",
                "2. One-Dimensional Quantum Mechanics — Wells, Tunneling Barriers & the Linear Harmonic Oscillator.md",
                "3. Three-Dimensional Quantum Systems, Angular Momentum Algebra & the Hydrogen Atom.md",
                "4. Intrinsic Spin-Half, Pauli Matrices, Identical Particles & Compact Perturbative Tools.md",
            ],
        ),
        (
            "2. Atomic and Molecular Physics",
            "Atomic and Molecular Physics",
            [
                "1. Atomic Architecture, Stern–Gerlach, Fine Structure, Lamb Shift & Multi-Electron Coupling.md",
                "2. Atoms in External Fields (Zeeman, Paschen–Back & Stark), Hyperfine Structure & Magnetic Resonance (NMR & EPR).md",
                "3. Diatomic Rotational, Vibrational & Laser Raman Spectroscopy.md",
                "4. Molecular Electronic Spectra, Franck–Condon, Luminescence & Astrophysical Hydrogen.md",
            ],
        ),
        (
            "3. Nuclear and Particle Physics",
            "Nuclear and Particle Physics",
            [
                "1. Nuclear Static Properties, the Deuteron Problem & Nucleon–Nucleon Forces.md",
                "2. Nuclear Models — Liquid Drop, SEMF Mass Parabolas, Shell Model & Collective Modes.md",
                "3. Radioactive Decays (Alpha, Beta Parity Violation, Gamma & Mössbauer), Reactions, Fission, Fusion & Reactors.md",
                "4. Elementary Particles, Conservation Laws, Quark Standard Model, Neutrino Physics & Force Unification.md",
            ],
        ),
        (
            "4. Solid State Physics and Superconductivity",
            "Solid State Physics and Superconductivity",
            [
                "1. Crystal Structure, Space Groups, X-Ray Diffraction & Electron Microscopy (SEM & TEM).md",
                "2. Lattice Vibrations (Phonons), Thermal Properties & Electronic Band Theory of Solids.md",
                "3. Magnetic Properties of Solids — Quantum Dia-, Para- & Ferromagnetism.md",
                "4. Superconductivity, Meissner–London–BCS Theory, Josephson Junctions & High-Tc Superconductors.md",
            ],
        ),
        (
            "5. Semiconductor Devices, Analog and Digital Electronics",
            "Semiconductor Devices, Analog and Digital Electronics",
            [
                "1. Semiconductor Physics, p-n Junctions, Thermistors, Solar Cells & Transistors (BJT, JFET & MOSFET).md",
                "2. Power Supplies, Feedback Amplifiers, Oscillators & Operational Amplifiers.md",
                "3. Digital Electronics — Boolean Algebra, Logic Gates, K-Maps, Combinational & Sequential Circuits.md",
                "4. Fundamentals of Microprocessors (Intel 8085) & Digital Computers.md",
            ],
        ),
    ],
}


def validate_name(name: str) -> None:
    if FORBIDDEN_WIN_CHARS.search(name):
        raise ValueError(f"Illegal Windows/Obsidian character detected in: {name!r}")
    if name.endswith((" ", ".")):
        raise ValueError(f"Windows forbids trailing space/dot in: {name!r}")


def build_hub_markdown(paper_name: str, subject_title: str, chapters: list[str]) -> str:
    paper_tag = "physics-paper1" if paper_name == "Paper 1" else "physics-paper2"
    lines = [
        "---",
        f'title: "{subject_title}"',
        f"paper: [{paper_name.replace(' ', '_')}]",
        f"chapters: {len(chapters)}",
        "status: active",
        f"tags: [upsc-2027, physics-optional, {paper_tag}, subject-hub]",
        "---",
        "",
        f"# ⚛️ {subject_title} ({paper_name}) `#subject-hub`",
        "",
        "## Chapters",
    ]
    for ch in chapters:
        stem = ch[:-3]  # strip .md for clean Obsidian wikilink
        lines.append(f"- [ ] [[{stem}]]")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    folders_created = 0
    files_created = 0
    files_skipped = 0
    long_paths = []

    for paper_name, subjects in VAULT_STRUCTURE.items():
        validate_name(paper_name)
        paper_dir = BASE_DIR / paper_name
        if not paper_dir.exists():
            paper_dir.mkdir(parents=True, exist_ok=True)
            folders_created += 1

        for folder_name, subject_title, chapters in subjects:
            validate_name(folder_name)
            subject_dir = paper_dir / folder_name
            if not subject_dir.exists():
                subject_dir.mkdir(parents=True, exist_ok=True)
                folders_created += 1

            # Create empty chapter .md files (never overwrite existing files)
            for ch_filename in chapters:
                validate_name(ch_filename)
                ch_path = subject_dir / ch_filename
                if len(str(ch_path)) >= 250:
                    long_paths.append(str(ch_path))
                if ch_path.exists():
                    files_skipped += 1
                else:
                    ch_path.write_text("", encoding="utf-8")
                    files_created += 1

            # Create Subject Hub .md file (never overwrite existing hub)
            hub_filename = f"{subject_title}.md"
            validate_name(hub_filename)
            hub_path = subject_dir / hub_filename
            if hub_path.exists():
                files_skipped += 1
            else:
                hub_content = build_hub_markdown(paper_name, subject_title, chapters)
                hub_path.write_text(hub_content, encoding="utf-8")
                files_created += 1

    print("=" * 52)
    print(f"Physics Vault initialized in: {BASE_DIR}")
    print(f"Folders created : {folders_created} (expected 11 on fresh run)")
    print(f"Files created   : {files_created} (38 chapters + 9 hubs = 47)")
    print(f"Files skipped   : {files_skipped} (existing files preserved)")
    if long_paths:
        print("\n[WARNING] Paths approaching Windows 260-char limit:")
        for p in long_paths:
            print(f"  - ({len(p)} chars) {p}")
    print("=" * 52)


if __name__ == "__main__":
    main()