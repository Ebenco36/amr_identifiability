/* Colours for figures. The live view takes the same values from CSS tokens (app.css); figures
 * are always drawn on white so they drop into a paper or slide unchanged.
 *
 * Role hues are from the Okabe-Ito colour-blind-safe set; every role also has its own shape.
 */
(function (MG) {
  "use strict";

  MG.palette = {
    figure: {
      ground: "#FFFFFF",
      ink: "#1B2322",
      muted: "#5B6763",
      faint: "#8E9894",
      edge: "#5F6B70",
      open: "#C8510A",
      focus: "#1F5FA8",
      conditionedFill: "#1B2322",
      conditionedText: "#FFFFFF",
      implied: "#1E7A4C",
      notImplied: "#B23A0E",
      roles: {
        "fully observed": { fill: "#E2EDF7", stroke: "#0072B2" },
        "partially observed": { fill: "#FBEBCB", stroke: "#A86F00" },
        "missingness indicator": { fill: "#F5E1EC", stroke: "#A24C7C" },
        "recorded proxy": { fill: "#DAF0E8", stroke: "#007A57" },
        latent: { fill: "#FFFFFF", stroke: "#7D8783", dash: [4, 3] },
      },
    },
  };
})(globalThis.MG);
