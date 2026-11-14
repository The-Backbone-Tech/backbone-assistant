import { parse } from '@babel/parser';

export function syntax(text) {
  const options = { sourceType: 'unambiguous', allowReturnOutsideFunction: true };
  try { return parse(text, { ...options, plugins: ['typescript', 'jsx'] }); }
  catch { return parse(text, { ...options, plugins: ['typescript'] }); }
}

export function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object' || !node.type) return;
  visit(node, ancestors);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, visit, [...ancestors, node]);
    else if (value?.type) walk(value, visit, [...ancestors, node]);
  }
}

export const callName = node => node?.type === 'Identifier' ? node.name : node?.type === 'MemberExpression' ? node.property.name : undefined;
export const literal = node => node?.type === 'StringLiteral' ? node.value : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined;

export function testNames(text) {
  const names = [];
  walk(syntax(text), (node, ancestors) => {
    if (node.type !== 'CallExpression') return;
    let callee = node.callee;
    while (callee?.type === 'MemberExpression') callee = callee.object;
    if (!['test', 'it'].includes(callee?.name)) return;
    const title = node.arguments[0];
    if (literal(title) !== undefined) { names.push(literal(title)); return; }
    if (title?.type !== 'TemplateLiteral') return;
    let bindings = [new Map()];
    for (const loop of ancestors.filter(a => a.type === 'ForOfStatement')) {
      const id = loop.left.declarations?.[0]?.id;
      const array = loop.right.type === 'TSAsExpression' ? loop.right.expression : loop.right;
      if (array.type !== 'ArrayExpression') continue;
      let rows;
      if (id?.type === 'Identifier' && array.elements.every(e => literal(e) !== undefined)) {
        rows = array.elements.map(e => [[id.name, literal(e)]]);
      } else if (id?.type === 'ArrayPattern' && id.elements.every(e => e?.type === 'Identifier') &&
          array.elements.every(e => e?.type === 'ArrayExpression' && e.elements.length === id.elements.length && e.elements.every(v => literal(v) !== undefined))) {
        rows = array.elements.map(e => id.elements.map((key, i) => [key.name, literal(e.elements[i])]));
      }
      if (rows) bindings = bindings.flatMap(binding => rows.map(row => new Map([...binding, ...row])));
    }
    for (const binding of bindings) {
      let titleText = title.quasis[0].value.cooked, known = true;
      for (let i = 0; i < title.expressions.length; i++) {
        const expression = title.expressions[i];
        const value = binding.get(expression.name) ?? literal(expression);
        if (value === undefined) { known = false; break; }
        titleText += value + title.quasis[i + 1].value.cooked;
      }
      if (known) names.push(titleText);
    }
  });
  return names;
}
