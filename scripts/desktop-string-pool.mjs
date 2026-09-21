import fs from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import ts from "typescript";
import { SCRIPT_RESOURCE_DISABLED } from "./react-dom-script-resources.mjs";

function parse(source, name) {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) throw new Error(`Cannot parse desktop string data: ${name}`);
  return file;
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, child => { visit(child, callback); });
}

// Read the gate's actual constants rather than maintain a second, drifting list.
// This does not execute the gate or inspect anything outside the repository.
export function desktopBundleMarkers() {
  const file = parse(fs.readFileSync(new URL("./check-built-bundle.mjs", import.meta.url), "utf8"), "gate.js");
  const strings = node => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(strings);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = strings(node.left), right = strings(node.right);
      if (typeof left === "string" && typeof right === "string") return left + right;
    }
    throw new Error("Bundle marker declaration changed; review string-pool exclusions.");
  };
  const markers = [SCRIPT_RESOURCE_DISABLED];
  visit(file, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && /_MARKERS?$/u.test(node.name.text) && node.initializer) {
      markers.push(...[strings(node.initializer)].flat());
    }
  });
  return [...new Set(markers)];
}

export function assertDesktopMarkersPreserved(before, after, markers = desktopBundleMarkers()) {
  for (const marker of markers) {
    if (before.includes(marker) !== after.includes(marker)) {
      throw new Error(`Desktop string pool changed bundle marker visibility: ${marker}`);
    }
  }
}

// Function source can escape its lexical scope through toString(), String(fn),
// or a template interpolation. Keep statically identified functions/classes and
// their aliases/callback arguments self-contained. Dynamic code arguments are
// also left untouched. No source text is evaluated by this build adaptation.
function serializedRanges(file) {
  const host = {
    getSourceFile: name => name === file.fileName ? file : undefined,
    getDefaultLibFileName: () => "", writeFile() {}, getCurrentDirectory: () => "",
    getDirectories: () => [], fileExists: name => name === file.fileName,
    readFile: name => name === file.fileName ? file.text : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n"
  };
  const program = ts.createProgram([file.fileName], { allowJs: true, noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  const calls = [], callsByName = new Map(), assignments = new Map(), ranges = [], seen = new Map();
  // Lexical identifiers do not require inference across the whole generated
  // bundle. In particular, do not ask the checker to infer arbitrary receivers.
  const symbol = expression => ts.isIdentifier(expression) ? checker.getSymbolAtLocation(expression) : undefined;
  visit(file, node => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      calls.push(node);
      if (ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        callsByName.set(name, [...(callsByName.get(name) ?? []), node]);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const key = symbol(node.left);
      if (key) assignments.set(key, [...(assignments.get(key) ?? []), node.right]);
    }
  });
  const protect = node => { ranges.push([node.getStart(file), node.end]); };
  function resolve(expression, data = false) {
    const mode = data ? 2 : 1;
    if (!expression || ((seen.get(expression) ?? 0) & mode)) return;
    seen.set(expression, (seen.get(expression) ?? 0) | mode);
    if (ts.isParenthesizedExpression(expression)) return resolve(expression.expression, data);
    if (ts.isFunctionLike(expression) || ts.isClassLike(expression)) return protect(expression);
    if (data && (ts.isStringLiteralLike(expression) || ts.isTemplateExpression(expression))) return protect(expression);
    if (ts.isPropertyAccessExpression(expression)) {
      const object = symbol(expression.expression);
      for (const declaration of object?.declarations ?? []) {
        const initializer = declaration.initializer;
        if (!initializer || !ts.isObjectLiteralExpression(initializer)) continue;
        for (const property of initializer.properties) {
          if (property.name?.getText(file).replace(/^['"]|['"]$/gu, "") !== expression.name.text) continue;
          if (ts.isMethodDeclaration(property)) protect(property);
          else resolve(property.initializer, data);
        }
      }
      return;
    }
    const key = symbol(expression);
    if (!key) return;
    for (const value of assignments.get(key) ?? []) resolve(value, data);
    for (const declaration of key.declarations ?? []) {
      if (ts.isFunctionLike(declaration) || ts.isClassLike(declaration)) protect(declaration);
      else if (declaration.initializer) resolve(declaration.initializer, data);
      else if (ts.isParameter(declaration)) {
        const owner = declaration.parent;
        const ownerName = owner.name ?? (ts.isVariableDeclaration(owner.parent) ? owner.parent.name : undefined);
        const ownerSymbol = ownerName && symbol(ownerName);
        if (!ownerSymbol) continue;
        const index = owner.parameters.indexOf(declaration);
        for (const call of callsByName.get(ownerName.text) ?? []) {
          if (symbol(call.expression) === ownerSymbol) resolve(call.arguments?.[index], data);
        }
      }
    }
  }
  for (const call of calls) {
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "toString") resolve(callee.expression);
    if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
      && callee.argumentExpression.text === "toString") resolve(callee.expression);
    const spelling = callee.getText(file);
    if (/^Function\.prototype\.toString\.call$/u.test(spelling)) resolve(call.arguments?.[0]);
    if (/^Function\.prototype\.toString\.apply$/u.test(spelling)) resolve(call.arguments?.[0]);
    if (spelling === "String") resolve(call.arguments?.[0]);
    if (spelling === "eval" || spelling === "Function" || callee.kind === ts.SyntaxKind.ImportKeyword
      || /(?:require|import|resolve|loadModule)/iu.test(spelling)) {
      for (const argument of call.arguments ?? []) { protect(argument); resolve(argument, true); }
    }
  }
  visit(file, node => {
    if (ts.isTemplateSpan(node)) resolve(node.expression);
  });
  return ranges;
}

function isModulePath(node) {
  if (/^(?:node:|@[^/]+\/|\.{1,2}[\/\\])/u.test(node.text)
    || /^[^\s]+\.(?:[cm]?js|tsx?|json|wasm)$/u.test(node.text)) return true;
  const parent = node.parent;
  return (ts.isCallExpression(parent) || ts.isNewExpression(parent))
    && (parent.expression.kind === ts.SyntaxKind.ImportKeyword
      || /(?:require|import|resolve|loadModule)/iu.test(parent.expression.getText()));
}

/** Lossless primitive data storage; the result belongs INSIDE loadDesktop(). */
export function poolDesktopStrings(source, markers = desktopBundleMarkers()) {
  const file = parse(source, "desktop.js");
  const protectedRanges = serializedRanges(file);
  const identifiers = new Set(), candidates = [];
  visit(file, node => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    if (!(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return;
    const start = node.getStart(file), parent = node.parent;
    if (Buffer.byteLength(node.text) < 16 || parent.name === node
      || ts.isExpressionStatement(parent) || ts.isTaggedTemplateExpression(parent) || ts.isComputedPropertyName(parent)
      || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)
      || (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)
      || isModulePath(node) || /^[A-Za-z0-9+/=]{800,}$/u.test(node.text)
      || node.text.startsWith("data:image/")
      || markers.some(marker => node.text.includes(marker) || node.getText(file).includes(marker))
      || protectedRanges.some(([from, to]) => start >= from && node.end <= to)) return;
    candidates.push({ start, end: node.end, value: node.text });
  });
  if (!candidates.length) return { code: source, count: 0, unique: 0 };
  let name = "__echoinkStrings";
  while (identifiers.has(name)) name += "_";
  const values = [...new Set(candidates.map(item => item.value))];
  const indexes = new Map(values.map((value, index) => [value, index]));
  const packed = brotliCompressSync(Buffer.from(JSON.stringify(values)), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
  });
  const restored = JSON.parse(brotliDecompressSync(packed).toString("utf8"));
  if (values.length !== restored.length || values.some((value, index) => value !== restored[index])) {
    throw new Error("Desktop string data did not restore exactly.");
  }
  let cursor = 0, code = "";
  for (const item of candidates) {
    code += source.slice(cursor, item.start) + `(${name}[${indexes.get(item.value)}])`;
    cursor = item.end;
  }
  code += source.slice(cursor);
  // Keep a possible directive prologue at the start of the original module.
  let insertion = 0;
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    insertion = statement.end;
  }
  const initializer = `\nvar ${name}=JSON.parse(require("node:zlib").brotliDecompressSync(Buffer.from(${JSON.stringify(packed.toString("base64"))},"base64")).toString("utf8"));\n`;
  code = code.slice(0, insertion) + initializer + code.slice(insertion);
  parse(code, "pooled-desktop.js");
  assertDesktopMarkersPreserved(source, code, markers);
  return { code, count: candidates.length, unique: values.length };
}
