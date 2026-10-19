/* Built-in graphs: every m-graph in Mohan & Pearl (2021) and classic causal-inference examples.
 *
 * Each entry is DAGitty text plus what the paper (or the textbook) states about it. The tests
 * check the engine against `expect`; where the printed paper and its own derivation disagree,
 * the entry says so in `note` and `expect` follows the graph, not the printed claim.
 *
 * Positions follow the paper's figures (DAGitty units, y down). Proxies X_star are left out,
 * as in the paper's figures, and added on loading.
 */
(function (MG) {
  "use strict";

  const MP = "Mohan & Pearl (2021)";

  const ENTRIES = [
    // ------------------------------------------------------------------ Mohan & Pearl 2021
    {
      key: "mp-fig1b", group: MP, name: "Fig. 1(b): MCAR",
      description: "Obesity O is missing completely at random: R_O has no parents.",
      text: `dag { G [pos="0,0"] A [pos="2,0"] O [pos="1,1"] R_O [pos="2.2,1"] G -> O A -> O }`,
      expect: { mechanism: "MCAR", recover: [{ target: "G, O, A", recoverable: true }] },
    },
    {
      key: "mp-fig1c", group: MP, name: "Fig. 1(c): v-MAR (Example 1)",
      description: "Age A, which is fully observed, causes the missingness of obesity O. Example 1 recovers the joint as P(G, O* | A, R_O = 0) P(A).",
      text: `dag { G [pos="0,0"] A [pos="2,0"] O [pos="1,1"] R_O [pos="2.2,1"] G -> O A -> O A -> R_O }`,
      expect: { mechanism: "v-MAR", recover: [{ target: "G, O, A", recoverable: true }] },
    },
    {
      key: "mp-fig1d", group: MP, name: "Fig. 1(d): MNAR, self-masking",
      description: "Obesity causes its own missingness (O -> R_O). The joint distribution is not recoverable.",
      text: `dag { G [pos="0,0"] A [pos="2,0"] O [pos="1,1"] R_O [pos="2.2,1"] G -> O A -> O O -> R_O }`,
      expect: { mechanism: "MNAR", recover: [{ target: "G, O, A", recoverable: false, by: "Theorem 2" }, { target: "O", recoverable: false, by: "Theorem 3" }] },
    },
    {
      key: "mp-fig3", group: MP, name: "Fig. 3: MNAR with recoverable regression (Example 2)",
      description: "All variables can be missing and X causes its own missingness, yet P(Y | X, Z1, Z2) is recoverable from complete cases and P(Z1) from available cases.",
      text: `dag {
        Z1 [pos="1,0"] R_Z1 [pos="2,0"] Z2 [pos="0,1"] X [pos="1,1"] Y [pos="2,1"] R_Z2 [pos="0,2"] R_X [pos="1.2,2"] R_Y [pos="2.2,2"]
        Z1 -> Z2 Z1 -> X Z1 -> Y Z1 -> R_Z2 Z1 -> R_X Z1 -> R_Y
        Z2 -> X Z2 -> Y Z2 -> R_Z2 X -> Y X -> R_X X -> R_Y }`,
      expect: {
        mechanism: "MNAR",
        recover: [
          { target: "Y | X, Z1, Z2", recoverable: true, completeCases: true },
          { target: "Z1", recoverable: true, availableCases: true, completeCases: false },
          { target: "Z1, Z2, X, Y", recoverable: false, by: "Theorem 2" },
        ],
      },
    },
    {
      key: "mp-fig4a", group: MP, name: "Fig. 4(a): sequential factorisation (Example 3)",
      description: "X causes the missingness of Y. P(X, Y) = P(Y* | X*, R_X = 0, R_Y = 0) P(X* | R_X = 0).",
      text: `dag { Y [pos="0,0"] X [pos="1,0"] R_X [pos="0,1"] R_Y [pos="1,1"] Y -> X X -> R_Y }`,
      expect: { mechanism: "MNAR", recover: [{ target: "X, Y", recoverable: true, by: "Theorem 1" }] },
    },
    {
      key: "mp-fig4b", group: MP, name: "Fig. 4(b): R-factorisation (Example 5)",
      description: "No ordered factorisation works, but the R-factorisation of Theorem 2 recovers P(X, Y), Equation (3).",
      text: `dag { Y [pos="0,0"] X [pos="1,0"] R_X [pos="0,1"] R_Y [pos="1,1"] Y -> X Y -> R_X X -> R_Y }`,
      expect: { mechanism: "MNAR", recover: [{ target: "X, Y", recoverable: true, by: "Theorem 2", notBy: "Theorem 1" }] },
    },
    {
      key: "mp-fig4c", group: MP, name: "Fig. 4(c): R-factorisation of P(X, Y, Z)",
      description: "The joint distribution is recovered in one step by Equation (4).",
      text: `dag { Y [pos="0,0"] X [pos="1,0"] Z [pos="2,0"] R_Z [pos="0,1"] R_Y [pos="1,1"] R_X [pos="2,1"]
        Y -> X X -> Z Y -> R_Z X -> R_Z Y -> R_X X -> R_Y Z -> R_Y Z -> R_X }`,
      expect: { mechanism: "MNAR", recover: [{ target: "X, Y, Z", recoverable: true, by: "Theorem 2" }] },
    },
    {
      key: "mp-ex4-g1-printed", group: MP, name: "Example 4, G1 as printed: Y → X → R_X → R_Y",
      description: "Edges between missingness indicators change how a distribution is recovered.",
      note: "The paper prints G1 as Y → X → R_X → R_Y, but its derivation uses X ⊥⊥ R_X, R_Y | Y, which fails here: X → R_X makes X self-masking, so P(X | Y), and hence P(X, Y), is not recoverable (Theorem 3). The derivation does hold in Y → X, Y → R_X → R_Y; see the next entry.",
      text: `dag { Y [pos="0,0"] X [pos="1,0"] R_X [pos="1,1"] R_Y [pos="0,1"] Y -> X X -> R_X R_X -> R_Y }`,
      expect: { mechanism: "MNAR", recover: [{ target: "X, Y", recoverable: false, by: "Theorem 3" }] },
    },
    {
      key: "mp-ex4-g1", group: MP, name: "Example 4, G1 as derived: Y → X, Y → R_X → R_Y",
      description: "The graph in which the paper's derivation for G1 holds: P(X, Y) = P(X* | Y*, R_X = 0, R_Y = 0) Σ P(Y* | R_X, R_Y = 0) P(R_X).",
      text: `dag { Y [pos="0,0"] X [pos="1,0"] R_X [pos="1,1"] R_Y [pos="0,1"] Y -> X Y -> R_X R_X -> R_Y }`,
      expect: { mechanism: "MNAR", recover: [{ target: "X, Y", recoverable: true }] },
    },
    {
      key: "mp-ex4-g2", group: MP, name: "Example 4, G2: R_Y causes R_X",
      description: "Reversing the edge between the indicators: P(X, Y) = P(X* | Y*, R_X = 0, R_Y = 0) P(Y* | R_Y = 0).",
      note: "Printed as Y → X → R_X ← R_Y; as for G1, the printed derivation needs X ⊥⊥ R_X, R_Y | Y, which fails when X → R_X. The version here is Y → X, Y → R_X ← R_Y, in which the derivation holds.",
      text: `dag { Y [pos="0,0"] X [pos="1,0"] R_X [pos="1,1"] R_Y [pos="0,1"] Y -> X Y -> R_X R_Y -> R_X }`,
      expect: { mechanism: "MNAR", recover: [{ target: "X, Y", recoverable: true }] },
    },
    {
      key: "mp-fig5a", group: MP, name: "Fig. 5(a): recovery through intervention (Example 6)",
      description: "No set separates X from R_X, yet P(X) is recoverable by intervening on R_Z (Verma constraint), Equation (6).",
      text: `dag { X [pos="0,0"] R_Y [pos="1,0"] R_Z [pos="2,0"] R_X [pos="3,0"] Y [pos="1,1"] Z [pos="2,1"]
        X -> R_Y R_Y -> R_Z R_Z -> R_X R_Y <-> R_X }`,
      expect: { mechanism: "MNAR", recover: [{ target: "X", recoverable: true, by: "intervention" }], noSeparator: [["X", "R_X"]] },
    },
    {
      key: "mp-fig5c", group: MP, name: "Fig. 5(c): a complex recovery (Appendix A.2)",
      description: "The joint distribution is recoverable by combining R-factorisation with the do-calculus (Example 15, Appendix A.2): the factor P(R_X = 0 | Y, W) is turned into a causal query and identified with some variables hidden behind their proxies.",
      text: `dag { Y [pos="0,0"] Z [pos="1,0.3"] X [pos="2,0"] R_Z [pos="-0.3,0.7"] W [pos="1,1"] R_W [pos="2.4,0.7"] R_X [pos="0,1.6"] R_Y [pos="2,1.6"]
        Y -> Z X -> Z Z -> W Z -> R_W Y -> R_X X -> R_Y W -> R_X W -> R_Y R_X -> R_Y }`,
      expect: { mechanism: "MNAR", recover: [{ target: "W, X, Y, Z", recoverable: true }, { target: "X", recoverable: true }] },
    },
    {
      key: "mp-fig6a", group: MP, name: "Fig. 6(a): attrition, v-MAR (Example 9)",
      description: "Two sequential treatments; drop-out depends on fully observed side effects. P(O_t1 | do(T_t, T_t1)) is recoverable.",
      text: `dag {
        Tt [exposure,pos="1,0"] Tt1 [exposure,pos="4,0"] St [pos="0,1"] Ot [pos="1.6,1"] St1 [pos="3,1"] Ot1 [outcome,pos="4.5,1"] R_Ot [pos="1,2"] R_Ot1 [pos="4,2"]
        Tt -> St Tt -> Ot Tt -> St1 Tt -> Ot1 Tt -> Tt1 Tt1 -> St1 Tt1 -> Ot1 Ot -> St1 Ot -> Ot1
        St <-> Ot St1 <-> Ot1 St -> R_Ot St1 -> R_Ot1 R_Ot -> R_Ot1 }`,
      expect: { mechanism: "v-MAR", causal: [{ x: ["Tt", "Tt1"], y: ["Ot1"], recoverable: true }] },
    },
    {
      key: "mp-fig6b", group: MP, name: "Fig. 6(b): attrition, MNAR (Example 9)",
      description: "Side effects are partially observed and cause their own missingness, yet the causal effect is still recoverable by Theorem 1.",
      text: `dag {
        Tt [exposure,pos="1,0"] Tt1 [exposure,pos="4,0"] St [pos="0,1"] Ot [pos="1.6,1"] St1 [pos="3,1"] Ot1 [outcome,pos="4.5,1"]
        R_St [pos="-0.3,2"] R_Ot [pos="1,2"] R_St1 [pos="2.8,1.8"] R_Ot1 [pos="4,2"]
        Tt -> St Tt -> Ot Tt -> St1 Tt -> Ot1 Tt -> Tt1 Tt1 -> St1 Tt1 -> Ot1 Ot -> St1 Ot -> Ot1
        St -> R_St St -> R_Ot St1 -> R_St1 St1 -> R_Ot1 R_Ot -> R_Ot1 }`,
      expect: { mechanism: "MNAR", causal: [{ x: ["Tt", "Tt1"], y: ["Ot1"], recoverable: true }] },
    },
    {
      key: "mp-fig7a", group: MP, name: "Fig. 7(a): causal effect under MNAR (Example 10)",
      description: "P(y | do(z)) is recoverable although Y and R_Y cannot be d-separated: Σ_w P(Y* | z, w, R_Y = 0) P(w | R_Y = 0), Equation (12).",
      text: `dag { R_Y [pos="0,0"] W [pos="1,0"] Z [exposure,pos="2,0"] Y [outcome,pos="3,0"] W -> Z Z -> Y R_Y <-> W W <-> Y }`,
      expect: { mechanism: "MNAR", causal: [{ x: ["Z"], y: ["Y"], recoverable: true }], noSeparator: [["Y", "R_Y"]] },
    },
    {
      key: "mp-fig7c", group: MP, name: "Fig. 7(c): bow-arc, not identifiable",
      description: "X and Y share an unmeasured cause; P(Y | do(X)) is not identifiable, so it cannot be recovered under any missingness.",
      text: `dag { X [exposure,pos="0,0"] Y [outcome,pos="2,0"] X -> Y X <-> Y }`,
      expect: { causal: [{ x: ["X"], y: ["Y"], identifiable: false }] },
    },
    {
      key: "mp-fig8a", group: MP, name: "Fig. 8(a): an untestable claim (Example 11)",
      description: "The only independence, X ⊥⊥ R_X, can never be refuted by data (Theorem 4).",
      text: `dag { X [pos="0,0"] R_X [pos="1,0"] }`,
      expect: { mechanism: "MCAR", untestable: ["X _||_ R_X"] },
    },
    {
      key: "mp-fig8b", group: MP, name: "Fig. 8(b): indistinguishable from 8(c), recoverable",
      description: "X ⊥⊥ R_X | Y is untestable; P(X, Y) is recoverable here but not in Fig. 8(c), although no data can tell the two apart (Section 4.3).",
      text: `dag { X [pos="0,0"] Y [pos="1,0"] R_X [pos="2,0"] X -> Y Y -> R_X }`,
      expect: { mechanism: "v-MAR", untestable: ["X _||_ R_X | Y"], recover: [{ target: "X, Y", recoverable: true }] },
    },
    {
      key: "mp-fig8c", group: MP, name: "Fig. 8(c): indistinguishable from 8(b), not recoverable",
      description: "X ⊥⊥ R_X is untestable; P(X) is recoverable as P(X* | R_X = 0) but P(X, Y) is not.",
      text: `dag { X [pos="0,0"] Y [pos="1,0"] R_X [pos="2,0"] X -> Y Y <-> R_X }`,
      expect: { mechanism: "MNAR", untestable: ["X _||_ R_X"], recover: [{ target: "X", recoverable: true }, { target: "X, Y", recoverable: false, by: "Theorem 3" }] },
    },
    {
      key: "mp-fig8d", group: MP, name: "Fig. 8(d): testable and untestable claims (Example 12)",
      description: "Z ⊥⊥ R_Z | X, Y is untestable (Theorem 4); X ⊥⊥ R_Z | Y is testable (form 14 of Theorem 5).",
      note: "The figure caption calls this graph MCAR, but R_Z has the parent Y, so the data are v-MAR.",
      text: `dag { Z [exposure,pos="1,0"] X [pos="0,1"] Y [outcome,pos="2,1"] R_Z [pos="2,2"] Z -> X Z -> Y X -> Y Y -> R_Z }`,
      expect: { mechanism: "v-MAR", untestable: ["Z _||_ R_Z | X, Y"], testable: ["X _||_ R_Z | Y"] },
    },

    // ------------------------------------------------------------------ causal-inference classics
    {
      key: "c-confounding", group: "Causal effects", name: "Confounding",
      description: "Z causes both treatment X and outcome Y; adjusting for Z identifies the effect of X on Y.",
      text: `dag { Z [pos="1,0"] X [exposure,pos="0,1"] Y [outcome,pos="2,1"] Z -> X Z -> Y X -> Y }`,
      expect: { causal: [{ x: ["X"], y: ["Y"], identifiable: true, adjustment: [["Z"]] }] },
    },
    {
      key: "c-mbias", group: "Causal effects", name: "M-bias",
      description: "M is a collider of two unmeasured causes; adjusting for M creates bias, adjusting for nothing is valid.",
      text: `dag { U1 [latent,pos="0,0"] U2 [latent,pos="2,0"] M [pos="1,1"] X [exposure,pos="0,2"] Y [outcome,pos="2,2"] U1 -> X U1 -> M U2 -> M U2 -> Y X -> Y }`,
      expect: { causal: [{ x: ["X"], y: ["Y"], identifiable: true, adjustment: [[]] }] },
    },
    {
      key: "c-butterfly", group: "Causal effects", name: "Butterfly bias",
      description: "M is both a confounder and a collider: adjust for M together with A or B.",
      text: `dag { A [pos="0,0"] B [pos="2,0"] M [pos="1,1"] X [exposure,pos="0,2"] Y [outcome,pos="2,2"] A -> X A -> M B -> M B -> Y M -> X M -> Y X -> Y }`,
      expect: { causal: [{ x: ["X"], y: ["Y"], identifiable: true, adjustment: [["A", "M"], ["B", "M"]] }] },
    },
    {
      key: "c-frontdoor", group: "Causal effects", name: "Front-door",
      description: "X and Y share an unmeasured cause, but the whole effect passes through M: Σ_m P(m | x) Σ_x' P(y | m, x') P(x').",
      text: `dag { X [exposure,pos="0,1"] M [pos="1,1"] Y [outcome,pos="2,1"] X -> M M -> Y X <-> Y }`,
      expect: { causal: [{ x: ["X"], y: ["Y"], identifiable: true, adjustment: null, frontdoor: [["M"]] }] },
    },
    {
      key: "c-iv", group: "Causal effects", name: "Instrumental variable",
      description: "Z affects Y only through X; X and Y share an unmeasured cause. The effect is not identifiable nonparametrically, but Z is a valid instrument.",
      text: `dag { Z [pos="0,1"] X [exposure,pos="1,1"] Y [outcome,pos="2,1"] Z -> X X -> Y X <-> Y }`,
      expect: { causal: [{ x: ["X"], y: ["Y"], identifiable: false, instruments: ["Z"] }] },
    },
    {
      key: "c-napkin", group: "Causal effects", name: "Napkin",
      description: "Identifiable, but not by adjustment or the front-door: the ID algorithm finds a ratio formula.",
      text: `dag { W [pos="0,0"] Z [pos="1,0.6"] X [exposure,pos="2,1.2"] Y [outcome,pos="3,1.8"] W -> Z Z -> X X -> Y W <-> X W <-> Y }`,
      expect: { causal: [{ x: ["X"], y: ["Y"], identifiable: true, adjustment: null }] },
    },
    {
      key: "c-mediation", group: "Causal effects", name: "Mediation",
      description: "X affects Y directly and through M; C confounds M and Y.",
      text: `dag { X [exposure,pos="0,1"] M [pos="1,0"] C [pos="2,-0.6"] Y [outcome,pos="2,1"] X -> M M -> Y X -> Y C -> M C -> Y }`,
      expect: { causal: [{ x: ["X"], y: ["Y"], identifiable: true, adjustment: [[]] }] },
    },
  ];

  /** The gallery entry as a model spec, ready for the store. */
  function load(key) {
    const e = ENTRIES.find((x) => x.key === key);
    if (!e) throw new Error(`no gallery entry ${key}`);
    const { spec, warnings } = MG.parse.graphText(e.text, { name: e.name });
    for (const n of spec.nodes) if (n.added) n.description = n.description.replace(/ \(added:.*\)$/, "");
    return { ...spec, key: e.key, group: e.group, description: e.description, note: e.note || null, source: "gallery", warnings };
  }

  MG.gallery = { ENTRIES, load };
})(globalThis.MG);
