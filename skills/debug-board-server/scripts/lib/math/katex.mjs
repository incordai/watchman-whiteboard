// Watchman Whiteboard: KaTeX with mhchem (\ce, \pu), for checking each math step's LaTeX (lib/board-math.js) and as
// the renderer when MathJax cannot load. Loaded by lib/math-libs.js; scripts/stage-whiteboard.mjs bundles this file.
import katex from "katex";
import "katex/contrib/mhchem";

export { katex };
export default katex;
