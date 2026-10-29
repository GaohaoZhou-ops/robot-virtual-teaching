import { readFile, readdir, stat } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { parse } from '@babel/parser';

const moduleFile = (file) => /\.(?:js|jsx|mjs)$/.test(file);
const slash = (value) => value.split(path.sep).join('/');

async function modules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? modules(file) : moduleFile(file) ? [file] : [];
  }));
  return nested.flat().sort();
}

function references(source) {
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'], createImportExpressions: true });
  const found = [];
  const add = (node, asset = false) => {
    if (node?.type === 'StringLiteral') found.push({ value: node.value, line: node.loc.start.line, asset });
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)) add(node.source);
    if (node.type === 'NewExpression' && node.callee.name === 'URL'
      && node.arguments[1]?.type === 'MemberExpression' && node.arguments[1].object?.type === 'MetaProperty') add(node.arguments[0], true);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'comments', 'tokens', 'extra'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(ast);
  return found;
}

// Imports form one module graph. Worker URLs are checked for existence, but do
// not form import edges: a worker executes in a separate JavaScript context.
export async function inspectArchitecture(root) {
  const files = await modules(path.join(root, 'src'));
  const known = new Set(files), graph = new Map(), errors = [];
  const label = (file) => slash(path.relative(root, file));
  for (const file of files) {
    const name = label(file), dependencies = [];
    if (/^src\/(?:lib|components|hooks|workers)\//.test(name)) errors.push(`${name}: place modules in their owning feature or shared layer`);
    let imports;
    try { imports = references(await readFile(file, 'utf8')); }
    catch (error) { errors.push(`${name}: ${error.message}`); graph.set(file, []); continue; }
    for (const ref of imports) {
      const at = `${name}:${ref.line}`;
      if (!ref.value.startsWith('.')) {
        if (!name.startsWith('src/server/') && isBuiltin(ref.value)) errors.push(`${at}: browser/shared modules cannot import ${ref.value}`);
        continue;
      }
      const target = path.resolve(path.dirname(file), ref.value.split(/[?#]/)[0]);
      const info = await stat(target).catch(() => null);
      if (!info || (!ref.asset && !info.isFile())) { errors.push(`${at}: missing ${ref.asset ? 'asset/worker' : 'import'} ${ref.value}`); continue; }
      if (ref.asset) continue;
      const destination = label(target);
      if (known.has(target)) dependencies.push(target);
      if (name.startsWith('src/shared/') && !destination.startsWith('src/shared/')) errors.push(`${at}: shared modules cannot depend on ${destination}`);
      if (name.startsWith('src/server/') && !/^src\/(server|shared)\//.test(destination)) errors.push(`${at}: server modules must use shared contracts, not ${destination}`);
      if (!name.startsWith('src/server/') && destination.startsWith('src/server/')) errors.push(`${at}: frontend cannot import server implementation ${destination}`);
      if (name.startsWith('src/features/') && destination.startsWith('src/app/')) errors.push(`${at}: features cannot depend on application composition ${destination}`);
      if (name.includes('/model/') && /\/(ui|hooks)\//.test(destination)) errors.push(`${at}: model code cannot depend on UI/hooks ${destination}`);
    }
    graph.set(file, [...new Set(dependencies)]);
  }

  const visited = new Set(), active = new Set(), stack = [];
  const visit = (file) => {
    if (active.has(file)) {
      errors.push(`Import cycle: ${[...stack.slice(stack.indexOf(file)), file].map(label).join(' -> ')}`);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file); active.add(file); stack.push(file);
    for (const dependency of graph.get(file) || []) visit(dependency);
    stack.pop(); active.delete(file);
  };
  for (const file of files) visit(file);

  for (const entry of files.filter((file) => file.endsWith('.worker.js'))) {
    const seen = new Set();
    const check = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const name = label(file);
      if (/\/(ui|hooks)\//.test(name) || name.startsWith('src/app/')) errors.push(`${label(entry)}: worker reaches UI module ${name}`);
      for (const dependency of graph.get(file) || []) check(dependency);
    };
    check(entry);
  }
  return { moduleCount: files.length, dependencyCount: [...graph.values()].reduce((sum, deps) => sum + deps.length, 0), errors: [...new Set(errors)] };
}
