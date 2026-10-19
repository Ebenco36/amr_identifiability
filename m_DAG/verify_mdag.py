#!/usr/bin/env python3
"""Reproduce the two checks reported on the m-DAGs in this folder.

Part 1  Graph checks. Reads the DAGitty files as they are, counts their arrows so the
        reading can be compared with the files, and checks by d-separation
        (networkx.is_d_separator) the independences that recovery with Z = (S, W, T) needs:
            Yk independent of (R_Yk, R_Yj) given Yj, S, W, T
            Yj independent of R_Yj given S, W, T

Part 2  Data check. The multiple-upstream M1 implies that the release of one upstream
        drug does not depend on another upstream drug's result, given S, W, T:
            R_Yj2 independent of Yj1 given S, W, T
        This is tested in the raw ARMD culture tables for ceftriaxone and cefepime in E. coli.

How Part 2 is built, so each choice can be questioned:
  * isolate        = one culture order and organism label (order_proc_id_coded, organism),
                     every label containing "ESCHERICHIA COLI"
  * result         = Resistant or Intermediate -> 1, Susceptible -> 0; anything else, or no
                     row for the drug, -> no result (released = 0)
  * S              = culture_description (URINE / BLOOD / RESPIRATORY)
  * W              = ordering_mode (Inpatient / Outpatient / Null). This is the only setting
                     field in the culture table; ICU and ED are in a separate table.
  * T              = calendar year of the (date-shifted) order time
  * test           = exact stratified test (exact Mantel-Haenszel) of release against the other
                     drug's result, within strata of S x W x year, among isolates where the other
                     drug has a result. The large-sample chi-square version was used first and is
                     not valid here: some groups have only a few dozen isolates.
  * periods        = three-year blocks, reported separately

Run:  python3 m_DAG/verify_mdag.py [--raw ~/Desktop/amr_cascade_platform/data/raw]
"""
import argparse
import re
from pathlib import Path

import duckdb
import networkx as nx
import numpy as np
import pandas as pd
from scipy.stats import hypergeom

HERE = Path(__file__).resolve().parent
Z = {"S", "W", "T"}


def read_dagitty(path: Path) -> nx.DiGraph:
    text = path.read_text()
    name = r'("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)'
    edges = re.findall(name + r"\s*->\s*" + name, text)
    short = lambda s: s.strip('"').split(":")[0].strip()          # noqa: E731  "Yj: Upstream resistance" -> "Yj"
    g = nx.DiGraph([(short(a), short(b)) for a, b in edges])
    assert g.number_of_edges() == text.count("->"), f"{path.name}: read {g.number_of_edges()} arrows, file has {text.count('->')}"
    return g


def dsep(g, x, y, z):
    x, y = set(x), set(y)
    return nx.is_d_separator(g, x, y, set(z) - x - y)


def part1():
    print("== Part 1. Graph checks ==")
    for path in sorted(HERE.glob("M*.txt")):
        g = read_dagitty(path)
        if "multiple" in path.name:
            up = [n for n in g if re.fullmatch(r"Yj\d", n)]
            a = dsep(g, ["Yk"], ["R_Yk"] + [f"R_{u}" for u in up], Z | set(up))
            b = dsep(g, up, [f"R_{u}" for u in up], Z)
        else:
            a = dsep(g, ["Yk"], ["R_Yk", "R_Yj"], Z | {"Yj"})
            b = dsep(g, ["Yj"], ["R_Yj"], Z)
        print(f"  {path.name:52s} arrows {g.number_of_edges():3d} | Yk indep. of its R given upstream and Z: {a!s:5} | upstream indep. of its R given Z: {b}")
        if path.name.startswith("M1") and "multiple" in path.name:
            print(f"  {'':52s} implied, testable: R_Yj2 indep. of Yj1 given S, W, T: {dsep(g, ['R_Yj2'], ['Yj1'], Z)}")


def exact_stratified_p(df, x, r, strata):
    """Exact stratified test of independence (the exact form of the Mantel-Haenszel test).

    Within each stratum, with both margins fixed, the count of (x = 1, r = 1) follows a
    hypergeometric distribution. The total over strata is their convolution. The two-sided
    p-value sums every total at least as improbable as the one observed. Unlike the
    large-sample chi-square, it stays valid when a group has only a handful of isolates.
    """
    pmf, observed = np.array([1.0]), 0
    for _, g in df.groupby(strata):
        x1 = int(g[x].sum()); r1 = int(g[r].sum()); n = len(g)
        if x1 in (0, n) or r1 in (0, n):
            continue                                              # stratum carries no information
        observed += int((g[x] & g[r]).sum())
        lo, hi = max(0, x1 + r1 - n), min(x1, r1)
        stratum = hypergeom.pmf(np.arange(lo, hi + 1), n, r1, x1)
        pmf = np.convolve(np.concatenate([np.zeros(lo), stratum]), pmf)[: len(pmf) + hi]
    if len(pmf) == 1:
        return np.nan
    return float(min(1.0, pmf[pmf <= pmf[observed] * (1 + 1e-7)].sum()))


def part2(raw: Path):
    print("\n== Part 2. Data check in raw ARMD (E. coli) ==")
    files = {"Stanford": ("armd/microbiology_cultures_cohort.csv", "order_time_jittered_utc"),
             "UTSW": ("armd_utsw/microbiology_cultures_cohort.csv", "order_time_jittered"),
             "ECUH": ("armd_ecuh/00_microbiology_cultures_cohort.csv", "order_time_jittered")}
    read = "read_csv('{}', all_varchar=true, header=true, delim=',', quote='\"', escape='\"')"
    con = duckdb.connect()
    rows, example = [], None
    for site, (f, tc) in files.items():
        ep = con.execute(f"""
            SELECT order_proc_id_coded, organism, any_value(substr({tc}, 1, 4))::INT AS year,
                   any_value(culture_description) AS S, any_value(ordering_mode) AS W,
                   max(CASE WHEN lower(antibiotic) = 'ceftriaxone' AND susceptibility IN ('Resistant', 'Intermediate') THEN 1
                            WHEN lower(antibiotic) = 'ceftriaxone' AND susceptibility = 'Susceptible' THEN 0 END) AS ceftriaxone,
                   max(CASE WHEN lower(antibiotic) = 'cefepime' AND susceptibility IN ('Resistant', 'Intermediate') THEN 1
                            WHEN lower(antibiotic) = 'cefepime' AND susceptibility = 'Susceptible' THEN 0 END) AS cefepime
            FROM {read.format(raw / f)}
            WHERE upper(organism) LIKE '%ESCHERICHIA COLI%'
            GROUP BY 1, 2""").df()
        for lo, hi in [(2010, 2012), (2013, 2015), (2016, 2018), (2019, 2021), (2022, 2024)]:
            g = ep[ep.year.between(lo, hi)]
            for released, given in (("cefepime", "ceftriaxone"), ("ceftriaxone", "cefepime")):
                h = g[g[given].notna()].assign(released=lambda d: d[released].notna().astype(int), result=lambda d: d[given].astype(int))
                if len(h) < 200 or h.result.nunique() < 2 or h.released.nunique() < 2:
                    continue
                counts = pd.crosstab(h.result, h.released)
                rows.append({"site": site, "years": f"{lo}-{hi}", "released": released, "given result of": given,
                             "isolates": len(h),
                             "released | S": f"{counts.loc[0, 1]}/{counts.loc[0].sum()}",
                             "released | NS": f"{counts.loc[1, 1]}/{counts.loc[1].sum()}",
                             "p (exact)": exact_stratified_p(h.assign(r=1 - h.released), "result", "r", ["S", "W", "year"])})
                if site == "UTSW" and (lo, released) == (2013, "cefepime"):
                    example = h
    t = pd.DataFrame(rows)
    t["p (exact)"] = t["p (exact)"].map(lambda v: f"{v:.0e}")
    pd.set_option("display.width", 220)
    print(t.to_string(index=False))
    print(f"\n  rejected at p < 0.001: {int((t['p (exact)'].astype(float) < 1e-3).sum())} of {len(t)}")
    if example is not None:
        print("\n  Worked example to check by hand: UTSW 2013-2015, cefepime released, by ceftriaxone result")
        print(pd.crosstab(example.result.map({0: "ceftriaxone S", 1: "ceftriaxone NS"}),
                          example.released.map({0: "cefepime absent", 1: "cefepime present"}), margins=True).to_string())
        print("\n  same, within urine outpatients only:")
        u = example[(example.S == "URINE") & (example.W == "Outpatient")]
        print(pd.crosstab(u.result.map({0: "ceftriaxone S", 1: "ceftriaxone NS"}),
                          u.released.map({0: "cefepime absent", 1: "cefepime present"}), margins=True).to_string())


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", type=Path, default=Path.home() / "Desktop/amr_cascade_platform/data/raw")
    args = ap.parse_args()
    part1()
    part2(args.raw)
