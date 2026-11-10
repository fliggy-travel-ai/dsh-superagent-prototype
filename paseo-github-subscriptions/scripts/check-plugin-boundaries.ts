/**
 * 插件打包边界检查：按 Paseo 0.15 插件编译器（@getpaseo/server dist/server/server/plugins/compiler-build.js、
 * compiler-imports.js、plugin-sdk-specifiers.js）的规则，检查 index.client.tsx 和 index.server.ts 能到达的源码。
 *
 * - 文件位置按第一级目录：client/、server/、shared/；index.client.* 属于 client，index.server.* 属于 server；其他位置无效。
 * - shared/ 文件的依赖按 shared 检查：只能依赖 shared/ 或包，不能依赖 server/、client/、Node 内置模块、只给服务端或客户端的 SDK。
 * - client 包不能到达 server/；server 包不能到达 client/。
 * - 类型导入（import type、import('x').T、/// <reference>）同样检查，和 Paseo 一致。
 * - Paseo 把 server 包作为 `eval` 出的 CommonJS 工厂函数执行（bundle-evaluator.js），没有 import.meta、__dirname、__filename；
 *   esbuild 把 import.meta.url 编成 undefined，`new URL('..', import.meta.url)` 在加载时抛 “Invalid URL”。打包的源码不能用它们。
 *
 * Paseo 的编译器打包在桌面程序里，不能作为依赖安装，所以这里按同样的规则静态检查；真实构建另用
 * `paseo plugin install` 验证（#1737）。用法：node --experimental-strip-types scripts/check-plugin-boundaries.ts [插件目录]
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

type Target = 'client' | 'server' | 'shared';
type Location = Target | 'invalid' | null;

const CLIENT_ONLY_SDK = ['@getpaseo/plugin/client', '@getpaseo/plugin/client/ui', '@getpaseo/plugin/client/react-native'];
const SERVER_ONLY_SDK = ['@getpaseo/plugin/server', '@getpaseo/plugin/server/provider', '@getpaseo/plugin/server/usage', '@getpaseo/plugin/server/acp'];
const SDK = ['@getpaseo/plugin', ...SERVER_ONLY_SDK, ...CLIENT_ONLY_SDK];

const contains = (directory: string, file: string) => { const relative = path.relative(directory, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };

export function locationOf(file: string, root: string): Location {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return 'invalid';
  const segments = relative.split(path.sep);
  if (segments.includes('node_modules')) return null;
  if (segments[0] === 'client' || segments[0] === 'server' || segments[0] === 'shared') return segments[0];
  if (/^index\.client\.tsx?$/.test(relative)) return 'client';
  if (/^index\.server\.tsx?$/.test(relative)) return 'server';
  return 'invalid';
}

function boundaryError(location: Location, owner: Target, file: string): string | null {
  if (location === 'invalid') return `Plugin modules belong in client/, server/, or shared/: ${file}`;
  if (location === null || location === 'shared' || location === owner) return null;
  return `${location}-only module cannot be imported into the plugin ${owner} bundle: ${file}`;
}

function specifierError(specifier: string, owner: Target, importer: string): string | null {
  let kind: string | null = null;
  if (specifier === '@getpaseo/plugin/client/host') kind = 'host-private';
  else if ((specifier === '@getpaseo/plugin' || specifier.startsWith('@getpaseo/plugin/') || specifier === '@paseo/plugin' || specifier.startsWith('@paseo/plugin/')) && !SDK.includes(specifier)) kind = 'Unknown SDK';
  else if (owner !== 'server' && (isBuiltin(specifier) || specifier === '@types/node')) kind = 'Node';
  else if (owner !== 'server' && SERVER_ONLY_SDK.includes(specifier)) kind = 'server-only';
  else if (owner !== 'client' && (CLIENT_ONLY_SDK.includes(specifier) || /^((?:@types\/)?react(?:-dom|-native)?|use-sync-external-store|@tanstack\/react-query)(\/|$)/.test(specifier))) kind = 'client-only';
  return kind ? `${kind} module cannot be imported into the plugin ${owner} bundle: ${specifier} imported by ${importer}` : null;
}

// 打包后不存在的模块级变量：import.meta、未在本文件声明的 __dirname、__filename。
function runtimeGlobals(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'meta') found.add('import.meta');
    else if (ts.isIdentifier(node) && (node.text === '__dirname' || node.text === '__filename')) {
      const parent = node.parent;
      const declared = (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node;
      const property = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!declared && !property) found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found];
}

type Edge = { specifier: string; kind: 'import' | 'require' | 'type-reference'; typeOnly: boolean };

function readImports(file: string): Edge[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const edges: Edge[] = [];
  const add = (node: ts.Node | undefined, typeOnly: boolean, kind: Edge['kind'] = 'import') => { if (node && ts.isStringLiteralLike(node)) edges.push({ specifier: node.text, kind, typeOnly: source.isDeclarationFile || typeOnly }); };
  const onlyTypes = (bindings: ts.NamedImportBindings | ts.NamedExportBindings | undefined) => !!bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, !!node.importClause?.isTypeOnly || (!node.importClause?.name && onlyTypes(node.importClause?.namedBindings)));
    else if (ts.isExportDeclaration(node)) add(node.moduleSpecifier, node.isTypeOnly || onlyTypes(node.exportClause));
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, true);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression, node.isTypeOnly, 'require');
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], false);
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node.arguments[0], false, 'require');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const reference of source.referencedFiles) edges.push({ specifier: path.resolve(path.dirname(file), reference.fileName), kind: 'import', typeOnly: true });
  for (const reference of source.typeReferenceDirectives) edges.push({ specifier: reference.fileName, kind: 'type-reference', typeOnly: true });
  return edges;
}

/** 返回全部越界错误（空数组表示通过）。 */
export function checkPluginBoundaries(directory: string): string[] {
  const root = realpathSync.native(directory);
  const configFile = ts.findConfigFile(root, ts.sys.fileExists);
  const parsed = configFile ? ts.getParsedCommandLineOfConfigFile(configFile, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }) : undefined;
  const options: ts.CompilerOptions = { ...parsed?.options, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
  const resolve = (specifier: string, importer: string, kind: Edge['kind']) => {
    const resolved = kind === 'type-reference'
      ? ts.resolveTypeReferenceDirective(specifier, importer, options, ts.sys).resolvedTypeReferenceDirective?.resolvedFileName
      : ts.resolveModuleName(specifier, importer, options, ts.sys).resolvedModule?.resolvedFileName;
    return resolved && existsSync(resolved) ? realpathSync.native(resolved) : undefined;
  };
  const errors = new Set<string>();
  const checked = new Set<string>();
  const visit = (file: string, inherited: Target) => {
    const owner: Target = locationOf(file, root) === 'shared' ? 'shared' : inherited;
    const key = `${owner}:${file}`;
    if (checked.has(key) || !/\.[cm]?[jt]sx?$/.test(file)) return;
    checked.add(key);
    for (const name of runtimeGlobals(file)) errors.add(`Paseo runs plugin bundles without ${name}: ${path.relative(root, file)}`);
    for (const edge of readImports(file)) {
      const packageSpecifier = edge.kind === 'type-reference' ? `@types/${edge.specifier.replace(/^@/, '').replace('/', '__')}` : edge.specifier;
      const relativeError = edge.specifier.startsWith('.') || path.isAbsolute(edge.specifier)
        ? boundaryError(locationOf(path.resolve(path.dirname(file), edge.specifier), root), owner, path.relative(root, path.resolve(path.dirname(file), edge.specifier)))
        : null;
      const error = specifierError(edge.specifier, owner, path.relative(root, file)) ?? specifierError(packageSpecifier, owner, path.relative(root, file)) ?? relativeError;
      if (error) { errors.add(error); continue; }
      if (edge.typeOnly && edge.specifier.startsWith('@getpaseo/protocol/')) continue;
      if (SDK.includes(edge.specifier) || /^(zod|react|react-native|@tanstack\/react-query)(\/|$)/.test(edge.specifier) || isBuiltin(edge.specifier) || packageSpecifier === '@types/node') continue;
      const target = resolve(edge.specifier, file, edge.kind);
      if (!target || !contains(root, target) || locationOf(target, root) === null) continue;
      const resolvedError = boundaryError(locationOf(target, root), owner, path.relative(root, target));
      if (resolvedError) { errors.add(resolvedError); continue; }
      visit(target, owner);
    }
  };
  for (const [names, target] of [[['index.client.ts', 'index.client.tsx'], 'client'], [['index.server.ts', 'index.server.tsx'], 'server']] as const) {
    const entry = names.map(name => path.join(root, name)).find(existsSync);
    if (entry) visit(realpathSync.native(entry), target);
  }
  return [...errors].sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.argv[2] ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const errors = checkPluginBoundaries(directory);
  if (errors.length) {
    console.error(`插件打包边界检查失败（Paseo 0.15 构建或加载插件会失败），共 ${errors.length} 处：`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log('插件打包边界检查通过：client、server、shared 之间没有越界引用。');
}
