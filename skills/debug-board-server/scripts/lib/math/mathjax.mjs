// Watchman Whiteboard: MathJax's TeX input and SVG output, with no DOM (its lite adaptor), so each math step becomes
// an SVG of paths that the page turns into a PNG (lib/board-math.js, page/app.js drawMath). Every TeX package is on
// (mhchem's \ce among them) except those that load more code at run time (require, autoload) and those that hide an
// error by drawing its source (noerrors, noundefined): an error stays an merror node, which board-math.js refuses.
// Loaded by lib/math-libs.js; scripts/stage-whiteboard.mjs bundles this file.
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";

const LEFT_OUT = new Set(["require", "autoload", "noerrors", "noundefined"]);
export const PACKAGES = Object.freeze(AllPackages.filter((name) => !LEFT_OUT.has(name)));

let adaptor = null;
let doc = null;

// The SVG markup of `tex`; width and height are in ex. Throws only for a broken MathJax.
export function texToSvg(tex, { display = true } = {}) {
  if (doc === null) {
    adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    doc = mathjax.document("", {
      InputJax: new TeX({ packages: [...PACKAGES] }),
      // fontCache "none": every glyph is its own path, with no <use> link to a shared definition.
      OutputJax: new SVG({ fontCache: "none" }),
    });
  }
  return adaptor.innerHTML(doc.convert(String(tex), { display }));
}
