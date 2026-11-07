/**
 * Makes the built CSS usable on Chromium 94 (Samsung Tizen 7 TVs, 2023).
 *
 * - Tailwind v4 wraps everything in @layer, which Chrome only understands from 99. Layers are
 *   unwrapped in place: Tailwind already emits them in layer order with unlayered rules last,
 *   so the cascade stays the same.
 * - The individual translate/scale properties (Chrome 104) get a transform fallback that only
 *   applies where they are unsupported, so modern browsers never move twice.
 * - dvh/svh/lvh units (Chrome 108) get a vh copy under the same kind of @supports guard.
 *
 * - Unlayered rules keep beating layered ones: they get an id's worth of specificity.
 *
 * Runs after @tailwindcss/postcss. src/legacy-css.test.ts guards the result.
 */
const TRANSFORM =
  "translate(var(--tw-translate-x, 0), var(--tw-translate-y, 0)) scale(var(--tw-scale-x, 1), var(--tw-scale-y, 1))";
const BOOST = ":not(#\\#)";
const DYNAMIC_VIEWPORT = /(\d)[dsl]vh\b/g;

/** @type {import('postcss').PluginCreator} */
const legacyBrowsers = () => ({
  postcssPlugin: "moonroom-legacy-browsers",
  OnceExit(root, { AtRule, Rule }) {
    // 0. Unlayered rules (globals.css) always beat layered ones, utilities included. Once the
    // layers are gone only specificity and order decide, so a bare-element rule (select, button)
    // would lose to a utility class. Give every unlayered rule one id's worth of specificity
    // (:not(#\\#) matches everything) to keep the old precedence. Must run before unwrapping.
    const inLayerOrKeyframes = (node) => {
      for (let p = node.parent; p && p.type !== "root"; p = p.parent) {
        if (
          p.type === "atrule" &&
          /^(layer|(-\w+-)?keyframes|font-face|property)$/.test(p.name)
        )
          return true;
      }
      return false;
    };
    root.walkRules((rule) => {
      if (inLayerOrKeyframes(rule)) return;
      rule.selectors = rule.selectors.map((sel) => {
        const at = sel.search(/::|:(before|after|first-line|first-letter)\b/);
        return at === -1
          ? `${sel}${BOOST}`
          : `${sel.slice(0, at)}${BOOST}${sel.slice(at)}`;
      });
    });

    // 1. Unwrap @layer (statement-only `@layer a, b;` lines are dropped).
    root.walkAtRules("layer", (at) => {
      if (at.nodes) at.replaceWith(at.nodes);
      else at.remove();
    });

    // Puts `decls` in a copy of `rule` under `@supports not (<feature>)`, right after the rule (or
    // after its enclosing @media etc.) so source order holds. @supports survives minification,
    // whereas a plain duplicate declaration is dropped when the build targets know the feature.
    const addFallback = (rule, feature, decls) => {
      const copy = new Rule({ selector: rule.selector });
      for (const d of decls) copy.append(d);
      let inner = new AtRule({ name: "supports", params: `not (${feature})` });
      inner.append(copy);
      let anchor = rule;
      for (let p = rule.parent; p && p.type === "atrule"; p = p.parent) {
        const clone = new AtRule({ name: p.name, params: p.params });
        clone.append(inner);
        inner = clone;
        anchor = p;
      }
      anchor.after(inner);
    };

    // 2. translate / scale -> transform, only where they are unsupported. Utilities with a literal
    // value (scale-[1.06]) carry no --tw-* variables, so the fallback sets them from the value.
    // Percent scales become plain numbers, which `scale` and scale() both accept.
    root.walkDecls(/^--tw-scale-[xy]$/, (decl) => {
      const m = /^(-?[\d.]+)%$/.exec(decl.value.trim());
      if (m) decl.value = String(parseFloat(m[1]) / 100);
    });
    const transformRules = new Map();
    root.walkDecls(/^(translate|scale)$/, (decl) => {
      if (decl.parent.type !== "rule") return;
      const decls = transformRules.get(decl.parent) ?? [];
      const [first, second = first] = decl.value.trim().split(/\s+/);
      if (!decl.value.includes("var(--tw-")) {
        const axis = decl.prop === "scale" ? "scale" : "translate";
        decls.push(
          { prop: `--tw-${axis}-x`, value: first },
          { prop: `--tw-${axis}-y`, value: second },
        );
      }
      transformRules.set(decl.parent, decls);
    });
    for (const [rule, vars] of transformRules) {
      addFallback(rule, "translate: 0", [
        ...vars,
        { prop: "transform", value: TRANSFORM },
      ]);
    }

    // 3. dvh/svh/lvh -> vh, only where they are unsupported.
    const viewportRules = new Map();
    root.walkDecls((decl) => {
      if (decl.parent.type !== "rule" || !DYNAMIC_VIEWPORT.test(decl.value))
        return;
      DYNAMIC_VIEWPORT.lastIndex = 0;
      const list = viewportRules.get(decl.parent) ?? [];
      list.push({
        prop: decl.prop,
        value: decl.value.replace(DYNAMIC_VIEWPORT, "$1vh"),
      });
      viewportRules.set(decl.parent, list);
    });
    for (const [rule, decls] of viewportRules)
      addFallback(rule, "height: 1dvh", decls);
  },
});
legacyBrowsers.postcss = true;

module.exports = legacyBrowsers;
