/* Keyboard shortcuts. Ignored while typing in a field, except Escape. */
(function (MG) {
  "use strict";

  const SHORTCUTS = [
    ["/", "Find a node or type a statement"],
    ["1 – 7", "Node, Conditions, Query, Missing data, Causal, do-calculus, Compare tabs"],
    ["F", "Fit the graph to the window"],
    ["+  −", "Zoom in, zoom out"],
    ["V", "Select tool: click to select, drag to move; drag a node's + handle onto another node to join them"],
    ["A", "Arrow tool: drag from one node onto another for X → Y, or click two nodes"],
    ["B", "Common cause tool: drag between two nodes for X ↔ Y (a latent common cause)"],
    ["X", "Erase tool: click a node or an arrow to delete it"],
    ["E", "Switch between Select and Arrow"],
    ["Delete", "While a tool other than Select is on, delete the selected node"],
    ["⌘Z  ⇧⌘Z", "Undo, redo an edit"],
    ["⌘S", "Export"],
    ["Shift + click", "Add a node to, or remove it from, the conditioning set Z"],
    ["Esc", "Clear the selection, picking or edit mode"],
    ["?", "This help"],
  ];

  function bindKeyboard(app) {
    document.addEventListener("keydown", (e) => {
      const typing = e.target.closest && e.target.closest("input, textarea, select, [contenteditable]");
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        if (document.querySelector("dialog[open]")) return;
        if (typing) return e.target.blur();
        return app.escape();
      }
      if (mod && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        return e.shiftKey ? app.store.redo() : app.store.undo();
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        return app.exporter.open("svg");
      }
      if (typing || mod || e.altKey) return;
      const k = e.key;
      if (k === "/") {
        e.preventDefault();
        document.getElementById("command-input").focus();
      } else if (k === "f" || k === "F") app.view.fit(true);
      else if (k === "+" || k === "=") app.view.zoomBy(1.25);
      else if (k === "-" || k === "_") app.view.zoomBy(0.8);
      else if (k === "e" || k === "E") app.toggleEdit();
      else if (k === "v" || k === "V") app.setTool("select");
      else if (k === "a" || k === "A") app.setTool("arrow");
      else if (k === "x" || k === "X") app.setTool("erase");
      else if (k === "?") app.showHelp();
      else if (["1", "2", "3", "4", "5", "6", "7"].includes(k)) app.showTab(["node", "conditions", "query", "missing", "causal", "docalc", "compare"][+k - 1]);
      else if ((k === "Delete" || k === "Backspace") && app.store.transient.editMode && app.store.state.node) app.store.deleteNode(app.store.state.node);
      else if (k === "b" || k === "B") app.setTool(app.store.transient.tool === "bidirected" ? "arrow" : "bidirected");
    });
  }

  MG.ui.bindKeyboard = bindKeyboard;
  MG.ui.SHORTCUTS = SHORTCUTS;
})(globalThis.MG);
