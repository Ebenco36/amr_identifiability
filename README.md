# m-graph explorer

Draw or import a DAG and explore it in the browser: d-separation and every implied
independence, Mohan & Pearl's missing-data results (recoverability, testability, the MCAR /
v-MAR / MNAR classes), and causal effects (adjustment, front-door, instruments, do-calculus, the
ID algorithm). Every answer shows its derivation and the theorem it rests on.

Reference: Mohan, K. and Pearl, J. (2021). Graphical models for processing missing data.
*Journal of the American Statistical Association* 116:1023–1037. Coverage of the paper, and how
correctness is checked, is in [docs/ROADMAP.md](docs/ROADMAP.md).

The page is one self-contained HTML file. It works offline and sends nothing anywhere.

## Building a graph

The **Build** panel on the left:

| Part | What it does |
|---|---|
| Tools | **Select** (V), **Arrow** (A) for X → Y, **Common cause** (B) for X ↔ Y, **Erase** (X). With Arrow or Common cause, drag from one node onto another. With Select, drag a node's **+** handle. |
| Add | Drag a variable, a partially observed variable (its indicator R_X and proxy X_star come with it), or a latent variable onto the canvas. Drop **Missingness R**, **Exposure** or **Outcome** onto a node. A click instead of a drag adds mid-view or applies to the selected node. |
| Link | Type links, for example `W -> R_Y`, `Y -> R_Y`, `R_X -> R_Y`, `U <-> Y`, `X -> {Y W}`. Enter adds them all as one undoable step. New names become nodes; naming an indicator `R_Y` makes Y partially observed. |
| Nodes | Every node by role. Drag one onto another, in the list or on the canvas, to join them. |
| Check | Recomputed after every edit: the m-graph rules, the missingness class, self-masking. |

Links that would break an m-graph are refused with the reason before you drop them: a
missingness indicator may point only at another indicator or its own proxy, a proxy has exactly
the parents X and R_X and no children, and the graph must stay acyclic.

Undo and redo with ⌘Z / ⇧⌘Z. Press ? in the page for every shortcut.

## Reading what the graph claims (Conditions tab)

Every line is a claim the graph makes, written as `A ⊥⊥ B | C` ("A is independent of B once C is
known") and then in plain words. Each line says whether recorded data can check it and, if so,
the form to test. Two views:

- **Minimal sets**: for each pair, the smallest sets that make it independent.
- **Every set**: every set that makes the pair independent, minimal or not. Each set is checked
  on its own, because adding a node can break an independence. On graphs with more than 16
  recorded nodes, pick a node first; at most 200 sets per pair are listed, smallest first.

Open "New here? How to read and use this list" in the tab for a short guide, and use
"Checkable only" with the CSV button to get a checklist to run on your data.

## Long searches

Some questions need a long search for a formula (a causal effect whose treatment is partially
observed can take tens of seconds on the four-upstream AMR model). Tabs always open at once:

- the Causal tab runs that search in a background worker, shows the elapsed time and a Cancel
  button, keeps going if you switch tabs, and remembers the answer;
- the Missing data and Compare tabs search for up to 4 s, then offer to keep searching for up to 30 s.

A search that runs out of time is reported as "no verdict yet", never as "not recoverable".

## Running it locally

```bash
python3 -m pip install -e ".[dev]"
amr-mdag viz --out m_graph_explorer.html --open
```

Tests (Node.js needed for the parity and Build-panel tests):

```bash
python3 -m pytest -q
```

## Publishing with GitHub Pages

`.github/workflows/pages.yml` runs the tests, builds the page as `index.html` and publishes
it. In the repository on GitHub: **Settings → Pages → Source: GitHub Actions**. Every push to
`main` then republishes the page at `https://<user>.github.io/<repository>/`.

`.gitignore` keeps patient-level and derived ARMD data (`data/`, `*.csv`), notebooks, slides
and the paper PDF out of the repository. Check `git status` before the first commit anyway.
