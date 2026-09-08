// A byte-preserving XML tree for Cubase track archives.
//
// Cubase reads its own archives back, so anything we do not understand
// must come out exactly as it went in: plugin state blobs, hex <bin>
// chunks, attribute order, whitespace, the numeric IDs. This parser keeps
// every element's original opening tag as raw text and only regenerates a
// tag when one of its attributes was changed, so an untouched document
// serialises to the identical bytes (test/run.js proves it on real
// exports). No DOM library - they normalise whitespace and re-quote
// attributes, which is exactly what must not happen.
//
// Node shapes:
//   { type: "elem", tag, attrs: [[name, value]], raw, dirty, children: [], selfClosing, indent }
//   { type: "text", raw }          text between elements (usually whitespace)
//   { type: "other", raw }         prolog, comments, CDATA - copied verbatim

"use strict";

function decode(s) {
  return String(s).replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, function (m, e) {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return "\"";
    if (e === "apos") return "'";
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return m;
  });
}
function encodeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseAttrs(s) {
  const attrs = [];
  const re = /([^\s=\/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) attrs.push([m[1], decode(m[3] != null ? m[3] : m[4])]);
  return attrs;
}

function parse(text) {
  const root = { type: "root", children: [] };
  const stack = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) { root.children.push({ type: "text", raw: text.slice(i) }); break; }
    if (lt > i) stack[stack.length - 1].children.push({ type: "text", raw: text.slice(i, lt) });
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt) + 3;
      stack[stack.length - 1].children.push({ type: "other", raw: text.slice(lt, end) });
      i = end;
    } else if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt) + 3;
      stack[stack.length - 1].children.push({ type: "other", raw: text.slice(lt, end) });
      i = end;
    } else if (text[lt + 1] === "?" || text[lt + 1] === "!") {
      const end = text.indexOf(">", lt) + 1;
      stack[stack.length - 1].children.push({ type: "other", raw: text.slice(lt, end) });
      i = end;
    } else if (text[lt + 1] === "/") {
      const end = text.indexOf(">", lt) + 1;
      const tag = text.slice(lt + 2, end - 1).trim();
      const open = stack.pop();
      if (!open || open.tag !== tag) throw new Error("XML: unexpected </" + tag + ">" + (open ? " (open: " + open.tag + ")" : ""));
      open.closeRaw = text.slice(lt, end);
      i = end;
    } else {
      // opening tag - attribute values may hold '>' so walk quotes
      let j = lt + 1, q = null;
      while (j < n) {
        const ch = text[j];
        if (q) { if (ch === q) q = null; }
        else if (ch === "\"" || ch === "'") q = ch;
        else if (ch === ">") break;
        j++;
      }
      const end = j + 1;
      const raw = text.slice(lt, end);
      const selfClosing = /\/\s*>$/.test(raw);
      const inner = raw.slice(1, selfClosing ? raw.lastIndexOf("/") : raw.length - 1);
      const tagM = inner.match(/^([^\s\/>]+)/);
      const el = { type: "elem", tag: tagM ? tagM[1] : "", attrs: parseAttrs(inner.slice(tagM ? tagM[1].length : 0)), raw, dirty: false, children: [], selfClosing, closeRaw: "" };
      stack[stack.length - 1].children.push(el);
      if (!selfClosing) stack.push(el);
      i = end;
    }
  }
  if (stack.length !== 1) throw new Error("XML: unclosed <" + stack[stack.length - 1].tag + ">");
  return root;
}

function openTag(el) {
  if (!el.dirty && el.raw) return el.raw;
  return "<" + el.tag + el.attrs.map(function (a) { return " " + a[0] + "=\"" + encodeAttr(a[1]) + "\""; }).join("") + (el.selfClosing ? "/>" : ">");
}

function serialize(node) {
  if (node.type === "root") return node.children.map(serialize).join("");
  if (node.type === "text" || node.type === "other") return node.raw;
  let s = openTag(node);
  if (!node.selfClosing) {
    s += node.children.map(serialize).join("");
    s += node.closeRaw || ("</" + node.tag + ">");
  }
  return s;
}

// ----- accessors -----

function attr(el, name) {
  if (!el || el.type !== "elem") return undefined;
  for (let i = 0; i < el.attrs.length; i++) if (el.attrs[i][0] === name) return el.attrs[i][1];
  return undefined;
}
function setAttr(el, name, value) {
  value = String(value);
  for (let i = 0; i < el.attrs.length; i++) {
    if (el.attrs[i][0] === name) {
      if (el.attrs[i][1] === value) return;
      el.attrs[i][1] = value; el.dirty = true; return;
    }
  }
  el.attrs.push([name, value]); el.dirty = true;
}
function elems(el) { return (el && el.children || []).filter(function (c) { return c.type === "elem"; }); }
function child(el, pred) { return elems(el).find(pred) || null; }
function byName(el, name, tag) { return child(el, function (c) { return attr(c, "name") === name && (!tag || c.tag === tag); }); }
function byClass(el, cls) { return child(el, function (c) { return attr(c, "class") === cls; }); }
function value(el, name) { const c = byName(el, name); return c ? attr(c, "value") : undefined; }
function num(el, name, fallback) { const v = value(el, name); const x = Number(v); return v != null && isFinite(x) ? x : fallback; }
function setValue(el, name, v) { const c = byName(el, name); if (!c) return false; setAttr(c, "value", v); return true; }

// Walk every element (depth first).
function walk(el, fn) {
  (el.children || []).forEach(function (c) { if (c.type === "elem") { fn(c); walk(c, fn); } });
}

// Deep copy of a subtree; the copy keeps raw tags so it serialises like
// the original until an attribute changes.
function clone(node) {
  if (node.type !== "elem") return { type: node.type, raw: node.raw };
  return { type: "elem", tag: node.tag, attrs: node.attrs.map(function (a) { return [a[0], a[1]]; }), raw: node.raw, dirty: node.dirty, selfClosing: node.selfClosing, closeRaw: node.closeRaw, children: node.children.map(clone) };
}

// Indentation of an element = the whitespace text node right before it.
function indentOf(parent, el) {
  const i = parent.children.indexOf(el);
  const prev = i > 0 ? parent.children[i - 1] : null;
  if (prev && prev.type === "text") { const m = prev.raw.match(/\n([ \t]*)$/); if (m) return m[1]; }
  return "";
}

// Insert `node` after `after` inside `parent`, copying the sibling's
// leading whitespace so the file stays Cubase-pretty.
function insertAfter(parent, after, node) {
  const i = parent.children.indexOf(after);
  const ws = { type: "text", raw: "\n" + indentOf(parent, after) };
  parent.children.splice(i + 1, 0, ws, node);
}
function remove(parent, node) {
  const i = parent.children.indexOf(node);
  if (i < 0) return;
  const prev = parent.children[i - 1];
  parent.children.splice(i, 1);
  if (prev && prev.type === "text" && /^\s*$/.test(prev.raw)) parent.children.splice(i - 1, 1);
}

// Build a fresh element with Cubase's own attribute style.
function make(tag, attrs, children, indent) {
  const el = { type: "elem", tag, attrs: attrs.map(function (a) { return [a[0], String(a[1])]; }), raw: "", dirty: true, selfClosing: !children, closeRaw: "", children: [] };
  if (children) {
    children.forEach(function (c) { el.children.push({ type: "text", raw: "\n" + indent + "    " }); el.children.push(c); });
    el.children.push({ type: "text", raw: "\n" + indent });
  }
  return el;
}

module.exports = { parse, serialize, attr, setAttr, elems, child, byName, byClass, value, num, setValue, walk, clone, indentOf, insertAfter, remove, make, decode };
