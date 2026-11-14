// Markdown treats <someone@example.com> as markup and drops it; a person must see the exact address.
// Code is left alone, because it shows exactly what was written.
const CODE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))|^(?: {4}|\t)[^\n]*$|(?<!`)(`+)(?!`)(?:(?!\n\n)[\s\S])*?(?<!`)\2(?!`)/gm;
const ADDRESS = /<([^<>\s@]+@[^<>\s]+)>/g;

export function showAddresses(text: string) {
  let out = '';
  let from = 0;
  for (const code of text.matchAll(CODE)) {
    out += text.slice(from, code.index).replace(ADDRESS, '&lt;$1&gt;') + code[0];
    from = code.index + code[0].length;
  }
  return out + text.slice(from).replace(ADDRESS, '&lt;$1&gt;');
}
