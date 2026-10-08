import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse, type Rule } from "postcss";

const declarations = (rule: Rule): Map<string, string> => {
  const result = new Map<string, string>();
  rule.walkDecls((declaration) => { result.set(declaration.prop, declaration.value); });
  return result;
};

function resolve(value: string, variables: Map<string, string>, depth = 0): string {
  assert.ok(depth < 12, "Theme variables must not form a cycle");
  return value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/gu, (_, name: string, fallback: string) => {
    const next = variables.get(name) ?? fallback;
    assert.ok(next, `Missing theme variable: ${name}`);
    return resolve(next, variables, depth + 1);
  });
}

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    assert.match(hex, /^#[\da-f]{6}$/iu);
    const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const pair = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (pair[0] + 0.05) / (pair[1] + 0.05);
}

/** CSS contract checks; these do not replace native rendering or interaction acceptance. */
export async function runFinanceThemeIntegrationTests(): Promise<void> {
  const css = await readFile("styles.css", "utf8");
  const stylesheet = parse(css);
  const financeText = css.split("/* ECHOINK_FINANCE_INTEGRATION_START */")[1]
    ?.split("/* ECHOINK_FINANCE_INTEGRATION_END */")[0];
  assert.ok(financeText, "Finance stylesheet must be present");
  assert.doesNotMatch(financeText, /echoink-(?:map-|health-|wordsea-|trip-|home-shortnav|calendar-photo)/u,
    "Finance integration must not carry the other worktree features");
  const finance = parse(financeText);
  const palettes: Rule[] = [];
  stylesheet.walkRules((rule) => {
    if (declarations(rule).has("--echoink-theme-scheme")) palettes.push(rule);
  });
  assert.equal(palettes.length, 4, "Finance reuses the two existing themes in light and dark modes");
  for (const palette of palettes) {
    for (const surface of [".echoink-home-workspace", ".echoink-settings-host", ".echoink-settings-demo",
      ".echoink-lifestyle-view", ".echoink-finance-dialog"]) {
      assert.ok(palette.selector.includes(surface), `Theme scope must include ${surface}`);
    }
  }

  let mapping: Rule | undefined;
  finance.walkRules((rule) => {
    const values = declarations(rule);
    if (values.has("--background-primary") && values.has("--finance-line")) mapping = rule;
  });
  assert.ok(mapping, "Finance surfaces need the host-to-theme token mapping");
  for (const surface of [".echoink-lifestyle-view", ".echoink-finance-dialog", ".echoink-life-plugin-section", ".echoink-life-settings-page"])
    assert.ok(mapping.selector.includes(surface), `Missing finance mapping for ${surface}`);
  assert.ok(mapping.selector.startsWith("body[data-echoink-theme] "), "Theme variables stay scoped to finance surfaces");
  const mapped = declarations(mapping);
  assert.ok(!mapped.has("--finance-category-color") && !mapped.has("--finance-chart-color"),
    "Theme mapping must preserve category and series colors supplied by the ledger");
  assert.ok(!mapped.has("--text-error") && !mapped.has("--text-warning") && !mapped.has("--color-green"),
    "Theme mapping must preserve the existing report heading and status colors");

  for (const theme of ["green", "violet"]) {
    for (const mode of ["light", "dark"]) {
      const variables = new Map<string, string>();
      for (const palette of palettes) {
        if (!palette.selector.includes(`[data-echoink-theme="${theme}"]`)) continue;
        if (mode === "light" && palette.selector.includes(".theme-dark")) continue;
        for (const [property, value] of declarations(palette)) variables.set(property, value);
      }
      for (const [property, value] of mapped) if (property.startsWith("--")) variables.set(property, value);
      const color = (name: string) => resolve(`var(${name})`, variables);
      const context = `${theme}/${mode}`;
      assert.equal(color("--echoink-theme-scheme"), mode, context);
      assert.equal(color("--finance-accent"), color("--echoink-theme-accent"), context);
      assert.equal(color("--finance-line"), color("--echoink-theme-line"), context);
      assert.equal(color("--background-primary"), color("--echoink-theme-card"), context);
      assert.equal(color("--background-modifier-hover"), color("--echoink-theme-raised"), context);
      assert.notEqual(color("--background-modifier-hover"), color("--background-primary"), `${context}: visible neutral feedback`);
      for (const foreground of ["--text-normal", "--text-muted"])
        assert.ok(contrast(color(foreground), color("--background-primary")) >= 4.5, `${context}: ${foreground} remains readable on cards and dialogs`);
      assert.ok(contrast(color("--text-on-accent"), color("--interactive-accent")) >= 4.5,
        `${context}: primary button label remains readable`);
    }
  }

  const rules = new Map<string, Map<string, string>>();
  finance.walkRules((rule) => {
    const values = rules.get(rule.selector) ?? new Map<string, string>();
    for (const [property, value] of declarations(rule)) values.set(property, value);
    rules.set(rule.selector, values);
  });
  assert.equal(rules.get(".echoink-finance-ai-section>h4")?.get("color"), "var(--text-error,#b74747)",
    "The approved red report headings remain red when the interaction theme changes");
  assert.equal(rules.get(".echoink-finance-category-dot")?.get("background"), "var(--finance-category-color)",
    "Category legends retain the actual category color");
  assert.match(rules.get(".echoink-life-body .echoink-finance-chart-row")?.get("border-left") ?? "", /var\(--finance-chart-color\)/u,
    "Spending chart rows retain their individual series colors");
  console.log("Finance theme CSS passed: green/violet × light/dark scopes, token resolution, text contrast and category colors.");
}
