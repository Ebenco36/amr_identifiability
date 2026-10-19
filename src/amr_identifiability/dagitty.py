"""Read and write DAGitty files (https://www.dagitty.net).

Supported: node declarations with the `latent` and `pos` attributes, `->` edges, and `<->`
edges (a latent common cause, added as a latent node named `L_<a>_<b>`). Quoted names such
as "A: Recorded prior antibiotic exposure" are reduced to the identifier before the colon.
"""

from __future__ import annotations

import re
from pathlib import Path

from amr_identifiability.mgraph import MGraph

_NAME = r'(?:"[^"]*"|[A-Za-z_][\w.]*)'
_NODE = re.compile(rf"^\s*({_NAME})\s*\[([^\]]*)\]", re.M)
_EDGE = re.compile(rf"({_NAME})\s*(<->|->|--)\s*({_NAME})")
_POS = re.compile(r'pos\s*=\s*"\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*"')


def _identifier(raw: str) -> str:
    name = raw.strip().strip('"')
    return name.split(":", 1)[0].strip()


def parse_dagitty(text: str, name: str = "") -> MGraph:
    """Parse DAGitty text into an MGraph."""
    body = text.strip()
    if not re.match(r"^(dag|pdag|mag|pag)\s*\{", body):
        raise ValueError("expected DAGitty text starting with 'dag {'")

    nodes, latent, positions = set(), set(), {}
    for raw, attrs in _NODE.findall(body):
        node = _identifier(raw)
        nodes.add(node)
        if re.search(r"(^|,)\s*latent\s*(,|$)", attrs):
            latent.add(node)
        pos = _POS.search(attrs)
        if pos:
            positions[node] = (float(pos.group(1)), float(pos.group(2)))

    edges = []
    for a, kind, b in _EDGE.findall(body):
        a, b = _identifier(a), _identifier(b)
        if kind == "->":
            edges.append((a, b))
        elif kind == "<->":
            hidden = f"L_{a}_{b}"
            edges += [(hidden, a), (hidden, b)]
            latent.add(hidden)
        else:
            raise ValueError(f"undirected edge {a} -- {b} is not allowed in an m-DAG")

    declared = body.count("->") - body.count("<->")
    directed = sum(1 for _, kind, _ in _EDGE.findall(body) if kind == "->")
    if declared != directed:
        raise ValueError(f"read {directed} directed edges but the text has {declared} '->' tokens")
    return MGraph(edges, latent=latent, nodes=nodes, name=name, positions=positions)


def load_dagitty(path: str | Path, name: str | None = None) -> MGraph:
    path = Path(path)
    return parse_dagitty(path.read_text(encoding="utf-8"), name=name or path.stem)


def to_dagitty(graph: MGraph) -> str:
    """DAGitty text for the graph. Node order and edge order are sorted, so output is stable."""
    lines = ["dag {"]
    for node in sorted(graph.nodes):
        attrs = []
        if node in graph.latent:
            attrs.append("latent")
        if node in graph.positions:
            x, y = graph.positions[node]
            attrs.append(f'pos="{x:.3f},{y:.3f}"')
        lines.append(f"{node} [{','.join(attrs)}]" if attrs else node)
    lines.append("")
    lines += [f"{a} -> {b}" for a, b in sorted(graph.edges)]
    lines.append("}")
    return "\n".join(lines) + "\n"
