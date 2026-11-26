#!/usr/bin/env node
/**
 * Build `lib/client.js`, the browser closure-factory bundle for this package's
 * LangGraph panel.
 *
 * The DSH client module loader expects `window.__ModuleLoader__.load({ id,
 * factory })`, where the factory receives the injected `require` and returns
 * its CJS exports. The in-tree tsdown preset cannot build an out-of-tree
 * package, so this script transpiles the one TSX entry with the TypeScript
 * compiler and wraps the output in the same envelope. `react` and
 * `react/jsx-runtime` stay runtime externals: the Web shell seeds both into
 * the frozen module table.
 *
 * Usage:
 *   node scripts/build-client.mjs
 *   DSH_TYPESCRIPT=/path/to/typescript node scripts/build-client.mjs
 * @module @lzn1998/dsh-langgraph/scripts/build-client
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

/** @param {string} message - failure text. @returns {never} */
function fail(message) {
  console.error(`build-client: ${message}`)
  process.exit(1)
}

/** Load a TypeScript package from one directory candidate. */
function loadTypeScript(directory) {
  try {
    const anchor = createRequire(join(directory, 'package.json'))
    const ts = anchor(directory)
    if (typeof ts?.transpileModule !== 'function') return undefined
    return { ts, directory }
  } catch {
    return undefined
  }
}

const candidates = [
  process.env.DSH_TYPESCRIPT,
  process.env.DSH_HARNESS_ROOT === undefined ? undefined : join(process.env.DSH_HARNESS_ROOT, 'node_modules', 'typescript'),
  join(packageRoot, 'node_modules', 'typescript'),
].filter(candidate => typeof candidate === 'string' && candidate.length > 0)

let toolchain
for (const candidate of candidates) {
  toolchain = loadTypeScript(resolve(candidate))
  if (toolchain !== undefined) break
}
if (toolchain === undefined) {
  fail([
    'cannot find the TypeScript compiler.',
    'Set DSH_TYPESCRIPT to a typescript package directory, or DSH_HARNESS_ROOT to a',
    'deepseek-harness checkout that carries one. Tried:',
    ...candidates.map(candidate => `  - ${resolve(candidate)}`),
    'The committed lib/client.js is already built; this script is only for rebuilding it.',
  ].join('\n'))
}

const { ts, directory } = toolchain
const sourceFile = join(packageRoot, 'client/index.tsx')
const result = ts.transpileModule(readFileSync(sourceFile, 'utf8'), {
  fileName: 'client/index.tsx',
  reportDiagnostics: true,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
  },
})
const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
if (errors.length > 0) {
  fail(`${ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => packageRoot,
    getNewLine: () => '\n',
  })}`)
}

/** Indent every line so the wrapped body reads like a generated bundle. */
function indent(text, prefix) {
  return text.replace(/\n$/u, '').split('\n').map(line => (line.length === 0 ? line : prefix + line)).join('\n')
}

const bundle = [
  '/**',
  ` * ${manifest.name} — browser closure-factory bundle.`,
  ' *',
  ' * Generated from client/index.tsx by scripts/build-client.mjs — do not edit by hand.',
  ' * The module loader registers this factory and materializes it on first import;',
  ' * every module-body side effect stays inside the factory closure.',
  ' */',
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(manifest.name)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  indent(result.outputText, '\t\t'),
  '\t\treturn module.exports;',
  '\t},',
  '});',
  '',
].join('\n')

try {
  // Compile once without executing: catches a broken emit before the browser.
  // eslint-disable-next-line no-new-func
  new Function(bundle)
} catch (error) {
  fail(`lib/client.js is not valid JavaScript: ${String(error)}`)
}

mkdirSync(join(packageRoot, 'lib'), { recursive: true })
writeFileSync(join(packageRoot, 'lib/client.js'), bundle)
console.log(`built   lib/client.js (${Buffer.byteLength(bundle)} bytes)`)
console.log(`typescript: ${directory}`)
