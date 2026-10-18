#!/usr/bin/env node

import { parse } from "acorn";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function visit(node, callback, parent, field) {
  if (node === null || typeof node !== "object") return;
  if (typeof node.type === "string" && callback(node, parent, field) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "end" ||
      key === "loc" ||
      key === "range" ||
      key === "start"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child, callback, node, key);
      continue;
    }
    visit(value, callback, node, key);
  }
}

function propertyName(node) {
  if (node?.type !== "MemberExpression") return undefined;
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return undefined;
}

function isFileRead(node) {
  if (node.type !== "CallExpression") return false;
  if (
    node.callee.type === "Identifier" &&
    (node.callee.name === "readFile" ||
      node.callee.name === "readFileSync")
  ) {
    return true;
  }
  const name = propertyName(node.callee);
  return name === "readFile" || name === "readFileSync";
}

function bindingNames(pattern) {
  if (pattern === null || pattern === undefined) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "RestElement") {
    return bindingNames(pattern.argument);
  }
  if (pattern.type === "AssignmentPattern") {
    return bindingNames(pattern.left);
  }
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap(bindingNames);
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) =>
      property.type === "RestElement"
        ? bindingNames(property.argument)
        : bindingNames(property.value)
    );
  }
  return [];
}

/** Resolve identifiers by lexical binding, including closures and shadowing. */
function lexicalBindings(ast) {
  const scopes = new WeakMap();
  const createScope = (parent, functionScope = false) => ({
    parent, functionScope, bindings: new Map(),
  });
  const declare = (scope, pattern) => {
    for (const name of bindingNames(pattern)) {
      if (!scope.bindings.has(name)) scope.bindings.set(name, { name });
    }
  };
  const root = createScope(undefined, true);
  visit(ast, (node, parent) => {
    let scope = scopes.get(parent) ?? root;
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      declare(scope, node.id);
    }
    if (/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/u.test(node.type)) {
      const enclosing = scope;
      scope = createScope(scope, true);
      declare(scope, node.id);
      if (node.type === "FunctionDeclaration" && node.id !== null) {
        scope.bindings.set(node.id.name, enclosing.bindings.get(node.id.name));
      }
      for (const parameter of node.params) declare(scope, parameter);
    } else if (/^(?:BlockStatement|CatchClause|ForStatement|ForInStatement|ForOfStatement|SwitchStatement|ClassDeclaration|ClassExpression|StaticBlock)$/u.test(node.type)) {
      scope = createScope(scope, node.type === "StaticBlock");
      if (node.type === "CatchClause") declare(scope, node.param);
      if (node.type === "ClassExpression") declare(scope, node.id);
    }
    scopes.set(node, scope);
    if (node.type === "VariableDeclaration") {
      let owner = scope;
      if (node.kind === "var") {
        while (!owner.functionScope) owner = owner.parent;
      }
      for (const declaration of node.declarations) declare(owner, declaration.id);
    } else if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) declare(scope, specifier.local);
    }
  });
  return (name, node) => {
    for (let scope = scopes.get(node); scope !== undefined; scope = scope.parent) {
      if (scope.bindings.has(name)) return scope.bindings.get(name);
    }
    return undefined;
  };
}

function isValueReference(node, parent, field) {
  if (node.type !== "Identifier") return false;
  if (parent?.type === "MemberExpression" && field === "property" && !parent.computed) return false;
  if (["Property", "MethodDefinition", "PropertyDefinition"].includes(parent?.type) &&
      field === "key" && !parent.computed) return false;
  return field !== "label";
}

function sourceBindings(ast) {
  const resolveBinding = lexicalBindings(ast);
  const candidates = [];
  const functions = new Map();
  visit(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.init !== null) {
      if (node.id.type === "Identifier" &&
          ["ArrowFunctionExpression", "FunctionExpression"].includes(node.init.type)) {
        functions.set(resolveBinding(node.id.name, node), node.init);
      }
      candidates.push({
        bindings: bindingNames(node.id).map(name => resolveBinding(name, node)),
        value: node.init,
      });
      return;
    }
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "="
    ) {
      candidates.push({
        bindings: bindingNames(node.left).map(name => resolveBinding(name, node)),
        value: node.right,
      });
      return;
    }
    if (
      node.type === "FunctionDeclaration" &&
      node.id !== null
    ) {
      functions.set(resolveBinding(node.id.name, node), node);
      candidates.push({
        bindings: [resolveBinding(node.id.name, node)],
        value: node.body,
      });
    }
  });
  visit(ast, node => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return;
    const fn = functions.get(resolveBinding(node.callee.name, node));
    if (fn === undefined) return;
    fn.params.forEach((parameter, index) => {
      const value = parameter.type === "RestElement"
        ? { type: "ArrayExpression", elements: node.arguments.slice(index) }
        : node.arguments[index];
      if (value === undefined) return;
      candidates.push({
        bindings: bindingNames(parameter).map(name => resolveBinding(name, fn)),
        value,
      });
    });
  });

  const tainted = new Set();
  const containsSource = value => {
    let found = false;
    visit(value, (node, parent, field) => {
      // Assertions on parsed configuration are data contracts, not text checks.
      if (node.type === "CallExpression" && propertyName(node.callee) === "parse" &&
          node.callee.object?.type === "Identifier" && node.callee.object.name === "JSON") return false;
      if (isFileRead(node) || (isValueReference(node, parent, field) &&
          tainted.has(resolveBinding(node.name, node)))) found = true;
    });
    return found;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (!containsSource(candidate.value)) continue;
      for (const binding of candidate.bindings) {
        if (binding === undefined || tainted.has(binding)) continue;
        tainted.add(binding);
        changed = true;
      }
    }
  }
  return containsSource;
}

function isAssertMatch(node) {
  if (node.type !== "CallExpression") return false;
  if (node.callee.type !== "MemberExpression") return false;
  if (
    node.callee.object.type !== "Identifier" ||
    node.callee.object.name !== "assert"
  ) {
    return false;
  }
  const name = propertyName(node.callee);
  return name === "match" || name === "doesNotMatch";
}

export function auditSourceTextAssertions(
  source,
  filename = "<source>",
) {
  const ast = parse(source, {
    allowHashBang: true,
    ecmaVersion: "latest",
    locations: true,
    sourceType: "module",
  });
  const containsSource = sourceBindings(ast);
  const findings = [];
  visit(ast, (node) => {
    if (!isAssertMatch(node)) return;
    const [actual] = node.arguments;
    if (actual === undefined || !containsSource(actual)) {
      return;
    }
    findings.push({
      file: filename,
      line: node.loc?.start.line ?? 0,
      method: propertyName(node.callee),
    });
  });
  return findings;
}

async function collectTestFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, {
    withFileTypes: true,
  })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(target));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(target);
    }
  }
  return files.sort();
}

export function portableRepositoryPath(path) {
  return path.replaceAll("\\", "/");
}

export async function auditRepositorySourceTextAssertions(
  root = projectRoot,
) {
  const counts = {};
  const findings = [];
  for (const file of await collectTestFiles(join(root, "tests"))) {
    const name = portableRepositoryPath(relative(root, file));
    const fileFindings = auditSourceTextAssertions(
      await readFile(file, "utf8"),
      name,
    );
    if (fileFindings.length === 0) continue;
    counts[name] = fileFindings.length;
    findings.push(...fileFindings);
  }
  return {
    counts: Object.fromEntries(
      Object.entries(counts).sort(([left], [right]) =>
        left.localeCompare(right)
      ),
    ),
    findings,
  };
}

export function compareSourceAssertionBaseline(actual, expected) {
  const messages = [];
  const files = new Set([
    ...Object.keys(actual),
    ...Object.keys(expected),
  ]);
  for (const file of [...files].sort()) {
    const actualCount = actual[file] ?? 0;
    const expectedCount = expected[file] ?? 0;
    if (actualCount === expectedCount) continue;
    messages.push(
      `${file}: expected ${String(expectedCount)}, found ${String(actualCount)}`,
    );
  }
  return messages;
}

async function main() {
  const result = await auditRepositorySourceTextAssertions();
  process.stdout.write(`${JSON.stringify(result.counts, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
