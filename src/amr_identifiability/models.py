"""The three candidate m-DAGs, built from one shared edge list.

    M1  primary model
    M2  M1 plus an unmeasured clinical-selection factor U_C -> U_B, U_C -> U_W
    M3  M1 plus downstream self-masking Yk -> R_Yk

Each model exists with one upstream antibiotic (node Yj) or several (Yj1 ... Yjn). The
edges are defined once here, so the three models cannot drift apart; the tests check them
against the DAGitty files in m_DAG/.
"""

from __future__ import annotations

from amr_identifiability.mgraph import MGraph

MODEL_NAMES = ("M1", "M2", "M3")

NODE_DESCRIPTIONS = {
    "A": "recorded prior antibiotic-exposure profile",
    "B": "gender", "B_star": "recorded gender", "R_B": "gender missingness",
    "G": "age group", "G_star": "recorded age group", "R_G": "age missingness",
    "C": "baseline comorbidity",
    "D": "ADI profile",
    "H": "recorded baseline organism history",
    "N": "recorded baseline nursing-facility visit history",
    "S": "recorded specimen category",
    "W": "ward context",
    "T": "calendar period",
    "U_B": "unobserved shared resistance factors",
    "U_W": "unrecorded AST panel assignment",
    "U_L": "reporting configuration",
    "U_C": "unmeasured clinical selection factors (M2 only)",
    "Yk": "resistance to the downstream antibiotic",
    "R_Yk": "downstream result missingness",
    "Yk_star": "recorded downstream resistance",
}

_POSITIONS_MULTIPLE = {
    "A": (-1.458, -4.206), "B": (-4.146, -0.830), "B_star": (-4.340, 1.971), "C": (-1.466, -8.858),
    "D": (-3.417, -8.977), "G": (-3.663, -6.720), "G_star": (-4.384, -4.721), "H": (-2.503, 0.566),
    "N": (-0.816, -7.077), "R_B": (-4.489, -3.038), "R_G": (-4.586, -7.809), "R_Yj1": (-0.675, -0.221),
    "R_Yj2": (7.218, 4.086), "R_Yj3": (8.501, 2.664), "R_Yj4": (9.400, 1.163), "R_Yk": (5.216, -9.516),
    "S": (1.071, 5.918), "T": (3.817, -2.111), "W": (3.034, 6.210), "U_B": (1.507, -9.594),
    "U_C": (7.500, -8.500), "U_L": (5.229, 4.963), "U_W": (-0.752, 4.983), "Yj1": (-1.252, -1.176),
    "Yj1_star": (-1.830, 4.320), "Yj2": (5.665, -2.306), "Yj2_star": (5.999, -0.883), "Yj3": (7.103, -3.027),
    "Yj3_star": (7.629, -1.156), "Yj4": (8.347, -3.690), "Yj4_star": (8.925, -1.760), "Yk": (1.982, -1.293),
    "Yk_star": (3.599, 0.422),
}

_POSITIONS_SINGLE = {
    "A": (-1.458, -4.206), "B": (-4.146, -0.830), "B_star": (-4.340, 1.971), "C": (-1.466, -8.858),
    "D": (-3.417, -8.977), "G": (-3.663, -6.720), "G_star": (-4.384, -4.721), "H": (-2.503, 0.566),
    "N": (-0.816, -7.077), "R_B": (-4.489, -3.038), "R_G": (-4.586, -7.809), "R_Yj": (-0.825, -2.087),
    "R_Yk": (3.859, -7.730), "S": (2.189, 5.515), "T": (5.300, -4.500), "U_B": (1.161, -8.977),
    "U_C": (5.300, -8.500), "U_L": (2.901, 2.189), "U_W": (0.827, 1.833), "W": (4.175, 5.456),
    "Yj": (0.616, -3.295), "Yj_star": (-0.878, 2.447), "Yk": (2.110, -2.780), "Yk_star": (2.971, 0.249),
}


def upstream_names(n_upstream: int) -> list[str]:
    if n_upstream < 1:
        raise ValueError("n_upstream must be at least 1")
    return ["Yj"] if n_upstream == 1 else [f"Yj{i}" for i in range(1, n_upstream + 1)]


def _edges(n_upstream: int) -> list[tuple[str, str]]:
    up = upstream_names(n_upstream)
    edges = [
        # patient history
        ("B", "A"), ("B", "C"), ("C", "A"), ("D", "C"), ("G", "A"), ("G", "C"), ("H", "A"), ("N", "A"),
        # clinical context
        ("C", "S"), ("C", "W"),
        # shared resistance factors
        ("A", "U_B"), ("C", "U_B"), ("T", "U_B"),
        # panel assignment and reporting configuration
        ("S", "U_W"), ("T", "U_W"), ("S", "U_L"), ("T", "U_L"), ("W", "U_L"),
        # demographic proxies
        ("B", "B_star"), ("R_B", "B_star"), ("G", "G_star"), ("R_G", "G_star"),
        # downstream outcome
        ("A", "Yk"), ("U_B", "Yk"), ("U_L", "R_Yk"), ("U_W", "R_Yk"), ("Yk", "Yk_star"), ("R_Yk", "Yk_star"),
    ]
    for y in up:
        edges += [
            ("A", y), ("U_B", y),                       # resistance
            ("U_L", f"R_{y}"), ("U_W", f"R_{y}"),       # its own result's availability
            (y, "R_Yk"),                                # cascade: upstream result drives downstream availability
            (y, f"{y}_star"), (f"R_{y}", f"{y}_star"),  # recorded proxy
        ]
    return edges


def build_model(name: str = "M1", n_upstream: int = 4) -> MGraph:
    """Build M1, M2 or M3 with one or several upstream antibiotics."""
    if name not in MODEL_NAMES:
        raise ValueError(f"unknown model {name!r}; choose from {MODEL_NAMES}")
    edges = _edges(n_upstream)
    latent = {"U_B", "U_L", "U_W"}
    if name == "M2":
        edges += [("U_C", "U_B"), ("U_C", "U_W")]
        latent.add("U_C")
    if name == "M3":
        edges.append(("Yk", "R_Yk"))
    positions = _POSITIONS_SINGLE if n_upstream == 1 else _POSITIONS_MULTIPLE
    label = f"{name} ({n_upstream} upstream)" if n_upstream > 1 else f"{name} (single upstream)"
    graph = MGraph(edges, latent=latent, name=label)
    graph.positions = {n: p for n, p in positions.items() if n in graph.nodes}
    return graph
