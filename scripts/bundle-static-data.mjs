import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import ts from "typescript";

const require = createRequire(import.meta.url);

// The Node build otherwise selects this package's CommonJS barrel, retaining
// every icon. Resolve only this package to its own official, tree-shakable ESM.
export const radixIconsEsmPlugin = {
  name: "echoink-radix-icons-esm",
  setup(build) {
    build.onResolve({ filter: /^@radix-ui\/react-icons$/ }, async () => {
      const packagePath = require.resolve("@radix-ui/react-icons/package.json");
      const metadata = JSON.parse(await fs.readFile(packagePath, "utf8"));
      if (metadata.version !== "1.3.2" || metadata.module !== "dist/react-icons.esm.js") {
        throw new Error("Radix icons package changed; re-audit the official ESM entry.");
      }
      return { path: path.join(path.dirname(packagePath), metadata.module), sideEffects: false };
    });
  }
};

const PINYIN_DICTIONARIES = Object.freeze({
  "dict1.mjs": "map",
  "dict2.mjs": "DICT2",
  "dict3.mjs": "DICT3",
  "dict4.mjs": "DICT4",
  "dict5.mjs": "DICT5",
  "surname.mjs": "Surnames"
});

// Read only the fixed dictionary shape: string keys with string/string[]
// values. No imported code, expressions, getters or computed keys execute.
function readDictionaryLiteral(node) {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((value) => {
      if (!ts.isStringLiteral(value)) throw new Error("Expected dictionary string array");
      return value.text;
    });
  }
  if (!ts.isObjectLiteralExpression(node)) throw new Error("Expected dictionary object literal");
  const result = {};
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)
      || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      throw new Error("Unexpected dictionary property shape");
    }
    const key = property.name.text;
    if (key === "__proto__" || Object.hasOwn(result, key)) {
      throw new Error(`Unexpected duplicate/prototype dictionary key: ${key}`);
    }
    if (!ts.isStringLiteral(property.initializer) && !ts.isArrayLiteralExpression(property.initializer)) {
      throw new Error("Expected dictionary string or string array");
    }
    result[key] = readDictionaryLiteral(property.initializer);
  }
  return result;
}

export function compressPinyinDictionary(source, fileName) {
  const variableName = PINYIN_DICTIONARIES[fileName];
  if (!variableName) throw new Error(`Unsupported pinyin dictionary: ${fileName}`);
  const syntax = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (syntax.parseDiagnostics.length) throw new Error(`Cannot parse pinyin dictionary: ${fileName}`);
  const declarations = syntax.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === variableName);
  if (declarations.length !== 1 || !declarations[0].initializer
    || !ts.isObjectLiteralExpression(declarations[0].initializer)) {
    throw new Error(`pinyin-pro dictionary shape changed: ${fileName}/${variableName}`);
  }
  const literal = declarations[0].initializer;
  const data = readDictionaryLiteral(literal);
  const json = JSON.stringify(data);
  const compressed = brotliCompressSync(Buffer.from(json), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 }
  });
  const replacement = `JSON.parse(__echoinkBrotliDecompressSync(Buffer.from(${JSON.stringify(compressed.toString("base64"))}, "base64")).toString("utf8"))`;
  return {
    data,
    compressed,
    contents: 'import { brotliDecompressSync as __echoinkBrotliDecompressSync } from "node:zlib";\n'
      + source.slice(0, literal.getStart(syntax)) + replacement + source.slice(literal.end)
  };
}

// Only replace data initializers. All upstream lookup/segmentation/custom-dict
// code, exports and their original module initialization order remain intact.
export const pinyinDictionaryCompressionPlugin = {
  name: "echoink-pinyin-dictionary-storage",
  setup(build) {
    build.onLoad({ filter: /[\\/]pinyin-pro[\\/]dist[\\/]esm[\\/]data[\\/](?:dict[1-5]|surname)\.mjs$/ }, async (args) => {
      const metadata = JSON.parse(await fs.readFile(path.resolve(path.dirname(args.path), "../../../package.json"), "utf8"));
      if (metadata.version !== "3.29.3") {
        throw new Error("pinyin-pro version changed; re-audit dictionary storage.");
      }
      const source = await fs.readFile(args.path, "utf8");
      const { contents } = compressPinyinDictionary(source, path.basename(args.path));
      return { loader: "js", contents, resolveDir: path.dirname(args.path) };
    });
  }
};
