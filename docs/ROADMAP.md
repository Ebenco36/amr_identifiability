# m-graph explorer: roadmap

Goal: anyone can bring their own DAG, explore it interactively, and get **correct** answers to
the questions in Mohan & Pearl (2021, JASA 116:1023–1037, "Graphical Models for Processing
Missing Data") and to the standard causal-effect questions (adjustment, front-door, instruments,
do-calculus, the ID algorithm). The tool is for learning as much as for research, so every
answer shows its derivation and the theorem it rests on.

Reference: `m_DAG/01621459.2021.1874961.pdf` (JASA version). Theorem numbers below are the
JASA numbers (the arXiv v2 numbers differ: JASA Corollary 1 = arXiv Corollary 2 and the
reverse; JASA says "v-MAR" where arXiv says "MAR").

## How correctness is guaranteed

1. **One implementation per algorithm.** The graph engine is the JavaScript core
   (`viz/assets/js/core/`). It runs in the page and, through Node, behind the Python API.
   Existing Python pieces (d-separation, catalogue, ordered factorisation) stay, and a parity
   test keeps them equal to the engine.
2. **Numerical verification of every formula.** For each graph in the test gallery and for
   random graphs, the tests build random discrete models (binary variables, latent variables,
   missingness indicators, proxies defined by Equation (1)), compute the true target from the
   full joint distribution, then evaluate the engine's formula on the observed-data
   distribution P(V*, Vo, R) only. They must agree to 1e-12. Causal targets are checked
   against the truncated-factorisation (surgery) distribution.
3. **The paper's examples as fixtures.** Every figure and example in the paper is in the
   gallery with the paper's stated result (recoverable or not, MCAR / v-MAR / MNAR,
   testable or not). Where the paper's written derivation has a typo (Example 4, G1), the test
   checks our derived formula numerically, not the paper's text.
4. **Never over-claim.** Sufficient conditions are reported as such ("no admissible ordered
   factorisation was found", not "not recoverable"). A non-recoverability verdict is given
   only when a theorem that proves it applies, with that theorem's preconditions checked.

## Coverage of the paper

| Paper | Feature | Verified by |
|---|---|---|
| §2.1 m-graphs, Eq. (1) proxies | roles (Vo, Vm, U, V*, R); auto-add R_X and X* for a variable marked partially observed | structure tests |
| §2.2 MCAR / v-MAR / MNAR (graphical definitions) | classification with the d-separation that decides it | Fig. 1(b–d), 6(a), 6(b), 8(d) |
| Def. 1 recoverability; Remark 1 estimand vs estimator | every result is an estimand (expression over P(V*, Vo, R)); closed-form estimator shown | numeric |
| Ex. 1, Corollary 1 (v-MAR joint) | formula P(V*\|Vo, R=0) P(Vo) | numeric, Fig. 1(c) |
| Corollary 2 (complete / available cases) | checks for P(X\|Y) | Fig. 3 (Z1 available, not complete) |
| Def. 2, Theorem 1 (ordered factorisation, minimal X_i, sums of factorisations) | search for an admissible factorisation of any P(Y\|Z), with each factor's independence | numeric; Ex. 2, Ex. 3, Fig. 4(a), Fig. 6(b) |
| Ex. 4 (R→R edges change the formula) | handled by the general search | numeric, G1 and G2 |
| Theorem 2 (joint, R-factorisation, Eq. 4) | precondition check (no edges between R variables); conditions 1–2 on the latent projection; R-factorisation formula derived factor by factor with its independences | numeric; Ex. 5, Fig. 4(b), 4(c) |
| §3.3 constraint-based recovery, Ex. 6, Eq. (5)–(6) | recovery through do(R = 0) with the ID algorithm in the graph where Vm are latent | numeric; Fig. 5(a) |
| Theorem 3 (non-recoverability of P(X\|Y)) | proof of non-recoverability when it applies | Fig. 1(d), Ex. 7, Ex. 10 factor |
| Ex. 8 (data-dependent recovery) | explained, flagged as needing assumptions beyond the graph | — |
| §3.5 causal effects under missingness, Ex. 9, Ex. 10, Eq. (8)–(12) | identify in the substantive model, then recover; or IDC on P(Y*\|do(X), R_Y=0) | numeric; Fig. 6(a), 6(b), 7(a); bow-arc 7(c) not identifiable |
| §4 Theorem 4 (untestable forms) | flags X ⊥⊥ R_X \| Z, W, R_Z as untestable | Fig. 8(a), 8(d) |
| Theorem 5 (testable forms 13–15), §4.1.1 tests | every testable implication with its observed-data test | Fig. 8(d), Ex. 12 |
| Theorem 6, Corollary 3 (v-MAR, MCAR testable) | testability of the whole missingness assumption and its implied tests | Ex. 13, Ex. 14 |
| §4.3 indistinguishable models | side-by-side comparison of two graphs: same testable implications, different recoverability | Fig. 8(b) vs 8(c) |
| Appendix A.2, Ex. 15 (Fig. 5(c)) | stretch goal: the combined R-factorisation + do-calculus route | numeric if implemented |

## Causal effects (graphs with or without missingness)

- d-separation, all minimal separating sets, local Markov (done)
- causal / non-causal (back-door) paths between treatment and outcome, mediators
- adjustment: back-door criterion check; generalised adjustment criterion; every minimal
  adjustment set; the optimal set (O-set) when there are no latent variables
- front-door criterion; conditional instruments
- do-calculus: check Rules 1–3 for any expression, showing the mutilated graph
- ID and IDC algorithms (Shpitser & Pearl 2006) with the full derivation, and the hedge when
  the effect is not identifiable

## Bring your own DAG

- paste or open DAGitty text (incl. `<->`, `[latent]`, `[exposure]`, `[outcome]`, `pos`),
  plain edge lists (`A -> B`, CSV `from,to`), JSON, or simple Graphviz `digraph`
- draw from scratch: add, rename and delete nodes; directed and bidirected edges
- mark a variable partially observed and its R_X and X* are added for you
- automatic layered layout for graphs without coordinates
- gallery: the paper's figures, classic causal examples (confounding, M-bias, front-door,
  instruments, napkin, bow-arc), and the AMR models M1–M3

## Status (2026-10-15)

| Phase | State |
|---|---|
| 1. Bring your own DAG | done: DAGitty, edge list, JSON, Graphviz; editor with nodes, ↔, roles; auto-layout; gallery (paper + causal classics) |
| 2. Engine foundations | done: latent projection, estimand trees (text, LaTeX, counts), simplifier, numeric verification harness |
| 3. Missing data | done: classification, Corollaries 1–2, Theorem 1 (minimal X_i, helpers incl. indicators, recursive factors), R-factorisation with causal factors, Theorem 2, Theorem 3, recovery by intervention, Theorems 4–6, Corollary 3 |
| 4. Causal effects | done: ID / IDC with trace and hedge, adjustment (all minimal sets, optimal set), front-door, instruments, paths, do-calculus rule check (engine only), §3.5 |
| 5. Learning UI | done: Missing data and Causal effect tabs with derivations; do-calculus practice tab (Rules 1–3 with the mutilated graph); Compare tab for §4.3 (same testable claims, different recoverability) |
| 6. Build panel (2026-10-19) | done: left panel with tools (Select, Arrow, Common cause, Erase), drag-to-add palette, typed links (one undo step; `R_Y` makes Y partially observed), drag-to-link node list, live m-graph check (rules, MCAR / v-MAR / MNAR, self-masking). Every new edge goes through `Graph.edgeProblem`, the m-graph rules of Sec. 2.1, and a refused link shows its reason before the drop. Tests: `tests/test_build_tools.py` |
| 8. Conditions for novices (2026-10-19) | done: Minimal sets / Every set views (`separators.allDSeparators`, checked against Python d-separation on every subset of four paper graphs), each claim in plain words with how to check it in data, a reading guide, wrapped rows with measured heights |
| 7. Publishing | done: `.github/workflows/pages.yml` tests, builds `index.html` and deploys to GitHub Pages; `.gitignore` keeps ARMD data, notebooks and the paper PDF out |

Verification: 152 tests; random m-graphs (450 graphs, 2,649 recovered formulas) and random DAGs with
latent confounders (3,512 ID estimands, 2,445 adjustment and 67 front-door formulas) all match the
truth to 1e-9; no recovery method ever succeeds where Theorem 3 proves non-recoverability.

Fig. 5(c) (Appendix A.2): the engine now recovers every marginal and conditional query on this graph
by R-factorisation (23 formulas, each checked against the truth to 1e-9; 2026-10-19), and P(W | do(X))
by do-calculus with a partially observed treatment (checked to 3e-16).

## Phases

1. **Bring your own DAG**: parsers, editor (nodes, bidirected edges, roles), auto-layout,
   gallery, saved in the exported HTML.
2. **Engine foundations**: latent projection (ADMG), districts, probability-expression trees
   (render as text and maths, evaluate numerically), numeric verification harness.
3. **Missing data (the paper)**: classification, Corollaries 1–2, Theorems 1–3, recovery
   through do(R = 0), testability (Theorems 4–6, Corollary 3), and the fixes listed below.
4. **Causal effects**: paths, adjustment sets, front-door, instruments, do-calculus, ID / IDC,
   causal effects under missingness (§3.5).
5. **Learning UI**: tabs for Missing data, Causal effect and Testability; each result explains
   itself step by step, links each independence to the graph, and cites the theorem.

## Fixes to the current tool found while reading the paper

- `r_factorisation_problems` reports latent common causes of indicators as a failure. Theorem
  2 does not apply when there are edges between R variables (a bidirected edge is an edge), so
  this must be reported as "Theorem 2 does not apply", not as a failure.
- Neighbours and collider paths in Theorems 2 and 3 must be read on the latent projection,
  not on the DAG with explicit latent nodes.
- Ordered factorisation currently conditions each factor on all earlier variables. Theorem 1
  allows a minimal X_i, which can need fewer indicators; the search must use it.
