"""Command line: amr-mdag <command> [options]

    amr-mdag show                                       roles, structural problems, self-masking
    amr-mdag query "Yk _||_ R_Yk | Yj1, Yj2, Yj3, Yj4, S, W, T" [--explain]
    amr-mdag compare "Yk _||_ R_Yk | Yj1, Yj2, Yj3, Yj4, S, W, T"   the same query in M1, M2, M3
    amr-mdag paths Yk R_Yk --given S W T [--open]
    amr-mdag implications [--recorded]                  testable implications of the graph
    amr-mdag recover --target Yk [--order Yj1 ... Yk] [--covariates S W T]
    amr-mdag conditions [--node Yk] [--testable] [--csv out.csv]   every minimal independence
    amr-mdag viz [--out explorer.html] [--open] [--statement "..."]  interactive explorer
    amr-mdag figure out.pdf --statement "..."           figure as .svg or .pdf (needs Node.js)
    amr-mdag export                                     DAGitty text

Choose the graph with --model M1|M2|M3 and --upstream N (default 4), or --file path.txt.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from amr_identifiability.dagitty import load_dagitty, to_dagitty
from amr_identifiability.mgraph import Independence, MGraph
from amr_identifiability.models import MODEL_NAMES, build_model
from amr_identifiability.recovery import find_recovery, ordered_factorisation, r_factorisation_problems
from amr_identifiability.catalogue import ConditionCatalogue


def _graph(args: argparse.Namespace) -> MGraph:
    if args.file:
        return load_dagitty(args.file)
    return build_model(args.model, args.upstream)


def _show(args) -> int:
    g = _graph(args)
    print(repr(g))
    for role in ("fully observed", "partially observed", "missingness indicator", "recorded proxy", "latent"):
        members = sorted(n for n in g.nodes if g.role(n) == role)
        print(f"  {role:22s} {', '.join(members)}")
    problems = g.validate()
    print("structure:", "no problems found" if not problems else "")
    for p in problems:
        print("  -", p)
    masking = g.self_masking()
    print("self-masking:", "none" if not masking else "")
    for v, reason in masking.items():
        print(f"  - {v}: {reason}")
    return 0


def _query(args) -> int:
    g = _graph(args)
    ind = Independence.parse(args.statement)
    if args.explain:
        print(g.explain(ind))
    else:
        print(f"{ind}: {'implied' if g.implies(ind) else 'NOT implied'}")
    if g.is_testable(ind):
        print(f"testable in recorded data as: {g.recorded_form(ind)}")
    return 0


def _compare(args) -> int:
    ind = Independence.parse(args.statement)
    for name in MODEL_NAMES:
        g = build_model(name, args.upstream)
        print(f"{g.name:24s} {'implied' if g.implies(ind) else 'NOT implied'}")
    return 0


def _paths(args) -> int:
    g = _graph(args)
    reports = g.paths(args.x, args.y, args.given, only_open=args.open, max_paths=args.max)
    for r in reports:
        print(r)
    print(f"{len(reports)} path(s) listed" + (" (open only)" if args.open else ""))
    return 0


def _implications(args) -> int:
    g = _graph(args)
    found = g.testable_implications()
    for ind in found:
        print(g.recorded_form(ind) if args.recorded else ind)
    print(f"{len(found)} testable implication(s)")
    return 0


def _recover(args) -> int:
    g = _graph(args)
    if args.order:
        print(ordered_factorisation(g, args.order, args.covariates or ()).report())
        return 0
    found = find_recovery(g, args.target, covariates=args.covariates, max_helpers=args.max_helpers,
                          max_covariates=args.max_covariates, limit=args.limit)
    if not found:
        print(f"no ordered factorisation recovers {args.target} within the size limits")
        problems = r_factorisation_problems(g)
        print("R-factorisation conditions:", "hold" if not problems else "fail")
        for p in problems:
            print("  -", p)
        return 1
    for rec in found:
        print(rec.report())
        print()
    return 0


def _conditions(args) -> int:
    cat = ConditionCatalogue(_graph(args))
    if args.csv:
        path = cat.to_csv(args.csv, testable_only=args.testable)
        print(f"{len(cat.rows(args.testable))} statements written to {path}")
        return 0
    print(cat.report(args.node, testable_only=args.testable))
    return 0


def _explorer(args):
    from amr_identifiability.viz import Explorer

    graphs = [_graph(args)] if args.file else None
    select = None if args.file else f"{args.model}-{args.upstream}"
    if not args.file and args.upstream not in (1, 4):
        graphs = [build_model(name, args.upstream) for name in MODEL_NAMES]
        select = None
    return Explorer(graphs, select=select, statement=args.statement, node=args.node)


def _viz(args) -> int:
    ex = _explorer(args)
    if args.open and not args.out:
        print(f"opened {ex.open()}")
        return 0
    path = ex.save(args.out or "m_graph_explorer.html")
    print(f"saved {path}")
    if args.open:
        import webbrowser

        webbrowser.open(Path(path).resolve().as_uri())
    return 0


def _figure(args) -> int:
    from amr_identifiability.viz import FigureExportError

    ex = _explorer(args)
    spacing = "auto" if args.spacing == "auto" else float(args.spacing)
    try:
        path = ex.save(args.out, title=args.title, legend=not args.no_legend, caption=not args.no_caption, spacing=spacing)
    except FigureExportError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"saved {path}")
    return 0


def _export(args) -> int:
    sys.stdout.write(to_dagitty(_graph(args)))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="amr-mdag", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--model", choices=MODEL_NAMES, default="M1")
    common.add_argument("--upstream", type=int, default=4, help="number of upstream antibiotics (default 4)")
    common.add_argument("--file", type=Path, help="read the graph from a DAGitty file instead")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("show", parents=[common], help="roles, structure and self-masking").set_defaults(run=_show)

    p = sub.add_parser("query", parents=[common], help="is an independence implied?")
    p.add_argument("statement")
    p.add_argument("--explain", action="store_true", help="list the open paths when it is not implied")
    p.set_defaults(run=_query)

    p = sub.add_parser("compare", help="the same query in M1, M2 and M3")
    p.add_argument("statement")
    p.add_argument("--upstream", type=int, default=4)
    p.set_defaults(run=_compare)

    p = sub.add_parser("paths", parents=[common], help="paths between two nodes and whether they are open")
    p.add_argument("x")
    p.add_argument("y")
    p.add_argument("--given", nargs="*", default=[])
    p.add_argument("--open", action="store_true", help="only open paths")
    p.add_argument("--max", type=int, default=50)
    p.set_defaults(run=_paths)

    p = sub.add_parser("implications", parents=[common], help="testable implications")
    p.add_argument("--recorded", action="store_true", help="write them in recorded variables")
    p.set_defaults(run=_implications)

    p = sub.add_parser("recover", parents=[common], help="check or search for a recovery formula")
    p.add_argument("--target", default="Yk")
    p.add_argument("--order", nargs="*", help="check this ordering (target last) instead of searching")
    p.add_argument("--covariates", nargs="*", default=None)
    p.add_argument("--max-helpers", type=int, default=4)
    p.add_argument("--max-covariates", type=int, default=3)
    p.add_argument("--limit", type=int, default=5)
    p.set_defaults(run=_recover)

    p = sub.add_parser("conditions", parents=[common], help="every minimal conditional independence")
    p.add_argument("--node", help="only the conditions that involve this node")
    p.add_argument("--testable", action="store_true", help="only the forms that can be checked in recorded data")
    p.add_argument("--csv", type=Path, help="write a table instead of the report")
    p.set_defaults(run=_conditions)

    p = sub.add_parser("viz", parents=[common], help="interactive explorer as one offline HTML file")
    p.add_argument("--out", type=Path, help="where to save it (default m_graph_explorer.html)")
    p.add_argument("--open", action="store_true", help="open it in the browser")
    p.add_argument("--statement", help="an independence to show on opening")
    p.add_argument("--node", help="a node to select on opening")
    p.set_defaults(run=_viz)

    p = sub.add_parser("figure", parents=[common], help="figure of the graph or a statement (.svg or .pdf)")
    p.add_argument("out", type=Path)
    p.add_argument("--statement", help="the independence to highlight")
    p.add_argument("--node", help=argparse.SUPPRESS)
    p.add_argument("--title")
    p.add_argument("--spacing", default="auto", help="layout scale, or auto for the tightest without overlaps")
    p.add_argument("--no-legend", action="store_true")
    p.add_argument("--no-caption", action="store_true")
    p.set_defaults(run=_figure)

    sub.add_parser("export", parents=[common], help="DAGitty text").set_defaults(run=_export)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.run(args)
    except (KeyError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
