/**
 * SPIKE ONLY — NOT production. A tiny well-formed-XML reader/writer used to
 * prove the DAWproject round-trip concept without pulling fast-xml-parser
 * into this branch. Production uses fast-xml-parser (entities disabled) per
 * WAVI_DAWPROJECT_SECURITY_MODEL.md. Do not wire this into the app.
 */

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export class XmlSecurityError extends Error {
  constructor(msg: string) { super(msg); this.name = 'XmlSecurityError'; }
}

/** Reject DTDs/entities BEFORE parsing — the XXE / billion-laughs guard. */
export function assertNoDoctype(xml: string): void {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new XmlSecurityError('DOCTYPE/ENTITY declarations are rejected');
  }
}

const MAX_DEPTH = 64;

export function parseXml(xml: string): XmlNode {
  assertNoDoctype(xml);
  let i = 0;
  const n = xml.length;
  const skipDecl = () => {
    // skip <?xml ... ?> and comments
    while (i < n) {
      const lt = xml.indexOf('<', i);
      if (lt < 0) { i = n; return; }
      if (xml.startsWith('<?', lt)) { i = xml.indexOf('?>', lt) + 2; continue; }
      if (xml.startsWith('<!--', lt)) { i = xml.indexOf('-->', lt) + 3; continue; }
      i = lt; return;
    }
  };
  const parseNode = (depth: number): XmlNode => {
    if (depth > MAX_DEPTH) throw new XmlSecurityError('max element depth exceeded');
    if (xml[i] !== '<') throw new Error(`expected '<' at ${i}`);
    i++; // consume '<'
    const nameEnd = (() => {
      let j = i;
      while (j < n && !/[\s/>]/.test(xml[j])) j++;
      return j;
    })();
    const tag = xml.slice(i, nameEnd);
    i = nameEnd;
    const attrs: Record<string, string> = {};
    // parse attributes
    while (i < n) {
      while (i < n && /\s/.test(xml[i])) i++;
      if (xml[i] === '/' || xml[i] === '>') break;
      const eq = xml.indexOf('=', i);
      const key = xml.slice(i, eq).trim();
      const quote = xml[eq + 1];
      const valEnd = xml.indexOf(quote, eq + 2);
      attrs[key] = xml.slice(eq + 2, valEnd);
      i = valEnd + 1;
    }
    const children: XmlNode[] = [];
    if (xml[i] === '/') { i += 2; return { tag, attrs, children }; } // self-closing
    i++; // consume '>'
    while (i < n) {
      // skip text between elements (this format has none significant)
      while (i < n && xml[i] !== '<') i++;
      if (xml.startsWith('</', i)) { i = xml.indexOf('>', i) + 1; break; }
      if (xml.startsWith('<!--', i)) { i = xml.indexOf('-->', i) + 3; continue; }
      children.push(parseNode(depth + 1));
    }
    return { tag, attrs, children };
  };
  skipDecl();
  return parseNode(0);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function writeXml(node: XmlNode, indent = 0): string {
  const pad = '  '.repeat(indent);
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  if (node.children.length === 0) return `${pad}<${node.tag}${attrs}/>`;
  const inner = node.children.map((c) => writeXml(c, indent + 1)).join('\n');
  return `${pad}<${node.tag}${attrs}>\n${inner}\n${pad}</${node.tag}>`;
}
