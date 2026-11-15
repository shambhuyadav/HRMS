// Generates docs/api-error-codes.md, the catalogue of API error codes (improvement plan L2). Plain Node ESM, no dependencies.
//
// Scans apps/api/src/**/*.ts (not *.test.ts) for `new HttpError(status, code, message)` and resolves:
//   - literal codes and statuses; template codes become patterns (`SESSION_*`); constant codes are looked up;
//   - parameterised helpers (a function whose HttpError takes its code, or status, from a parameter, e.g. requireDate(value, code)
//     or refuse(code, message)): each call site with a literal code is a row, a default parameter covers the calls that omit it;
//   - a code read from a lookup table (`new HttpError(409, block, TABLE[block])`) or from a checker's result object
//     (`const r = check(...); new HttpError(422, r.code, ...)` where check returns `{ code: 'X', ... }`);
//   - the zero-argument helpers of http/errors.ts (notFound(), forbidden()), attributed to the modules that call them;
//   - the codes the central error handler (http/errors.ts) answers for validation, database and availability failures.
// Constructions whose code is only known at run time are listed at the end of the document, not guessed.
// Run: npm run docs:errors
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps', 'api', 'src');
const OUT = join(ROOT, 'docs', 'api-error-codes.md');
const ERRORS_FILE = join(SRC, 'http', 'errors.ts');

// ---------------------------------------------------------------------------------------------------------------- source files
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}
const posix = (p) => p.split('\\').join('/');
const rel = (file) => posix(relative(ROOT, file));
/** Module name of a source file: modules/<name>/..., else its top-level folder under src, else the file name. */
function moduleOf(file) {
  const parts = posix(relative(SRC, file)).split('/');
  if (parts[0] === 'modules' && parts.length > 2) return parts[1];
  return parts.length > 1 ? parts[0] : parts[0].replace(/\.ts$/, '');
}

// ------------------------------------------------------------------------------------------------------------------ scanning
/** The source with comments blanked (offsets kept), so commented-out code and prose are never read as code. */
function maskComments(text) {
  const out = text.split('');
  let i = 0;
  let prev = ''; // last significant character outside strings and comments (to tell a regex literal from a division)
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' ';
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== '\n') out[i] = ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i);
      prev = c;
    } else if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) {
      i = skipRegex(text, i);
      prev = '/';
    } else {
      if (!/\s/.test(c)) prev = /[\w$)\]]/.test(c) ? 'a' : c;
      i++;
    }
  }
  return out.join('');
}

function skipRegex(text, i) {
  let inClass = false;
  for (i++; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) break;
    else if (c === '\n') return i; // not a regex after all
  }
  i++;
  while (/[a-z]/.test(text[i] ?? '')) i++;
  return i;
}

/** Index just past the string, character or template literal starting at i (template substitutions are skipped whole). */
function skipString(text, i) {
  const q = text[i];
  for (i++; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++;
    else if (c === q) return i + 1;
    else if (q === '`' && c === '$' && text[i + 1] === '{') i = skipBalanced(text, i + 1) - 1;
  }
  return i;
}

/** Index just past the bracket group opening at i: ( [ { or <, counting nested groups and skipping strings. */
function skipBalanced(text, i) {
  const open = text[i];
  const close = { '(': ')', '[': ']', '{': '}', '<': '>' }[open];
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i) - 1;
    } else if (c === open) depth++;
    else if (c === close && !(close === '>' && text[i - 1] === '=')) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return i;
}

/** The top-level comma-separated parts of the group opening at `open` (an index of '('), trimmed; and where the group ends. */
function splitArgs(text, open) {
  const end = skipBalanced(text, open);
  const args = [];
  let start = open + 1;
  for (let i = open + 1; i < end - 1; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') i = skipString(text, i) - 1;
    else if (c === '(' || c === '[' || c === '{') i = skipBalanced(text, i) - 1;
    else if (c === '<' && /[\w$]/.test(text[i - 1] ?? '') && /[A-Z{[(a-z]/.test(text[i + 1] ?? '')) i = skipBalanced(text, i) - 1; // a type argument
    else if (c === ',') {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start, end - 1).trim();
  if (last !== '') args.push(last);
  return { args, end };
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

// -------------------------------------------------------------------------------------------------------------- expressions
const IDENT = /^[A-Za-z_$][\w$]*$/;
const MEMBER = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/;
const CODE = /^[A-Z][A-Z0-9_]*$/;

/** The value of a string literal, a template (substitutions as `sub`) or a concatenation of those; null for anything else. */
function literal(expr, sub = '…') {
  if (expr === undefined) return null;
  const e = expr.trim();
  const parts = [];
  let i = 0;
  while (i < e.length) {
    const q = e[i];
    if (q !== "'" && q !== '"' && q !== '`') return null;
    const end = skipString(e, i);
    let body = e.slice(i + 1, end - 1);
    if (q === '`') body = body.replace(/\$\{[^}]*\}/g, sub);
    parts.push(body.replace(/\\(.)/g, (_, ch) => ({ n: ' ', t: ' ' })[ch] ?? ch));
    i = end;
    const rest = e.slice(i).match(/^\s*\+\s*/);
    if (!rest) break;
    i += rest[0].length;
  }
  return i >= e.length ? parts.join('') : null;
}

/** A code from an expression: a literal, or a template as a pattern with '*' for each substitution. */
function codeLiteral(expr) {
  const v = literal(expr, '*');
  return v !== null && /^[A-Z*][A-Z0-9_*]*$/.test(v) ? v : null;
}

// ------------------------------------------------------------------------------------------------------------------- files
const files = walk(SRC).sort();
const sources = new Map(); // file -> { text, masked }
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  sources.set(f, { text, masked: maskComments(text) });
}

/** `const NAME = 'VALUE'` string constants per file, and imports per file (local name -> { from: file, name }). */
const constants = new Map();
const imports = new Map();
for (const [file, { masked }] of sources) {
  const consts = new Map();
  for (const m of masked.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*('[^'\n]*'|"[^"\n]*")\s*(?:as\s+const\s*)?;/g)) consts.set(m[1], literal(m[2]));
  constants.set(file, consts);
  const imp = new Map();
  for (const m of masked.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    if (!m[2].startsWith('.')) continue;
    const target = resolve(dirname(file), m[2].replace(/\.js$/, '.ts'));
    for (const spec of m[1].split(',')) {
      const [name, alias] = spec.replace(/^\s*type\s+/, '').trim().split(/\s+as\s+/);
      if (name) imp.set((alias ?? name).trim(), { from: target, name: name.trim() });
    }
  }
  imports.set(file, imp);
}

/** A string constant visible in `file` under `name` (declared there or imported from another source file). */
function constantValue(file, name, seen = new Set()) {
  if (seen.has(`${file}:${name}`)) return null;
  seen.add(`${file}:${name}`);
  const local = constants.get(file)?.get(name);
  if (local !== undefined) return local;
  const imp = imports.get(file)?.get(name);
  return imp && sources.has(imp.from) ? constantValue(imp.from, imp.name, seen) : null;
}

/** Named function headers of a file: function declarations and `const name = (...) =>` arrows, with their parameters. */
function functionHeaders(masked) {
  const headers = [];
  const add = (name, at, open) => {
    const { args, end } = splitArgs(masked, open);
    const params = args.map((a) => {
      const m = a.replace(/^\.\.\./, '').match(/^([A-Za-z_$][\w$]*)\??\s*(?::[^=]*)?(?:=\s*([\s\S]+))?$/);
      return { name: m ? m[1] : null, def: m && m[2] ? m[2].trim() : null };
    });
    headers.push({ name, at, params, end });
  };
  for (const m of masked.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*(<[^>(]*>)?\s*\(/g)) add(m[1], m.index, m.index + m[0].length - 1);
  for (const m of masked.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) {
    const open = m.index + m[0].length - 1;
    const after = masked.slice(skipBalanced(masked, open), skipBalanced(masked, open) + 200);
    if (/^\s*(?::[^=;]*?)?=>/.test(after)) add(m[1], m.index, open);
  }
  return headers.sort((a, b) => a.at - b.at);
}
const headersOf = new Map([...sources].map(([f, s]) => [f, functionHeaders(s.masked)]));
const enclosing = (file, index) => headersOf.get(file).filter((h) => h.at < index && h.end <= index).at(-1) ?? null;

/** The value expression of `key` among an object literal's members (as split by splitArgs), if it has one. */
const member = (members, key) => members.map((p) => p.match(new RegExp(`^${key}\\s*:\\s*([\\s\\S]+)$`))).find(Boolean)?.[1];

/**
 * Object literals returned by function `fn` of `file` that give `prop` a code: [{ code, message }]. The function's text runs
 * from its parameters to the next top-level declaration (a line starting with a declaration keyword).
 */
function returnedCodes(file, fn, prop) {
  const { masked } = sources.get(file);
  const h = headersOf.get(file).find((x) => x.name === fn);
  if (!h) return [];
  const next = masked.slice(h.end).search(/\n(?:export\s+)?(?:async\s+)?(?:function|const|let|class|interface|type)\b/);
  const body = masked.slice(h.end, next < 0 ? masked.length : h.end + next);
  const found = [];
  for (const m of body.matchAll(/return\s*\{/g)) {
    const members = splitArgs(body, m.index + m[0].length - 1).args;
    const code = codeLiteral(member(members, prop));
    if (code) found.push({ code, message: literal(member(members, 'message')) ?? '' });
  }
  // A local builder of the result: const fail = (code, message) => ({ ok: false, code, message }); return fail('X', '...').
  for (const b of body.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\(/g)) {
    const open = b.index + b[0].length - 1;
    const params = splitArgs(body, open).args.map((p) => p.match(/^([A-Za-z_$][\w$]*)/)?.[1]);
    const shape = body.slice(skipBalanced(body, open)).match(/^\s*=>\s*\(\s*\{/);
    if (!shape) continue;
    const members = splitArgs(body, skipBalanced(body, open) + shape[0].length - 1).args;
    const valueOf = (key) => member(members, key) ?? members.find((p) => p === key); // `code: code` or shorthand `code`
    const codeAt = params.indexOf(valueOf(prop));
    const messageAt = params.indexOf(valueOf('message'));
    if (codeAt < 0) continue;
    for (const call of body.matchAll(new RegExp(`return\\s+${b[1]}\\s*\\(`, 'g'))) {
      const args = splitArgs(body, call.index + call[0].length - 1).args;
      const code = codeLiteral(args[codeAt]);
      if (code) found.push({ code, message: messageAt >= 0 ? (literal(args[messageAt]) ?? '') : '' });
    }
  }
  return found;
}

// ------------------------------------------------------------------------------------------------------------- collecting
const rows = new Map(); // `${status}|${code}` -> { status, code, message, where: Set }
const unresolved = [];
/** `preferMessage`: the central error handler's wording is the generic one, so it replaces an example found elsewhere. */
function addRow(status, code, message, file, preferMessage = false) {
  const key = `${status}|${code}`;
  const row = rows.get(key) ?? { status, code, message: '', where: new Set() };
  if (message && (!row.message || preferMessage)) row.message = message;
  row.where.add(moduleOf(file));
  rows.set(key, row);
}

const helpers = []; // { file, name, statusSpec, codeSpec, messageSpec, defaultCode }
const errorsHelpers = []; // zero-argument helpers of http/errors.ts: { name, status, code, message }

for (const [file, { masked }] of sources) {
  for (const m of masked.matchAll(/\bnew\s+HttpError\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const { args } = splitArgs(masked, open);
    const [statusExpr, codeExpr, messageExpr] = args;
    const status = /^\d{3}$/.test(statusExpr ?? '') ? Number(statusExpr) : null;
    let code = codeLiteral(codeExpr);
    const message = literal(messageExpr) ?? '';
    const where = `${rel(file)}:${lineAt(masked, m.index)}`;
    const header = enclosing(file, m.index);
    const paramIndex = (name) => (header ? header.params.findIndex((p) => p.name === name) : -1);

    if (code === null && IDENT.test(codeExpr ?? '') && paramIndex(codeExpr) < 0) code = constantValue(file, codeExpr);
    if (code !== null && status !== null) {
      // A zero-argument helper of http/errors.ts is attributed to its callers (below), not to its definition.
      if (file === ERRORS_FILE && header && header.params.length === 0) errorsHelpers.push({ name: header.name, status, code, message });
      else addRow(status, code, message, file);
      continue;
    }

    // A parameterised helper: the code (and perhaps the status or message) comes from a parameter of the enclosing function.
    const codeMember = (codeExpr ?? '').match(MEMBER);
    const codeParam = IDENT.test(codeExpr ?? '') ? paramIndex(codeExpr) : codeMember ? paramIndex(codeMember[1]) : -1;
    if (header && codeParam >= 0) {
      const messageMember = (messageExpr ?? '').match(MEMBER);
      const messageParam = IDENT.test(messageExpr ?? '') ? paramIndex(messageExpr) : messageMember ? paramIndex(messageMember[1]) : -1;
      const statusParam = status === null && IDENT.test(statusExpr ?? '') ? paramIndex(statusExpr) : -1;
      if (status === null && statusParam < 0) {
        unresolved.push(where);
        continue;
      }
      const helper = {
        file,
        name: header.name,
        status,
        statusParam,
        codeParam,
        codeProp: codeMember ? codeMember[2] : null,
        message,
        messageParam,
        messageProp: messageMember ? messageMember[2] : null,
        defaultCode: codeLiteral(header.params[codeParam].def ?? undefined),
        defaultMessage: messageParam >= 0 ? literal(header.params[messageParam].def ?? undefined) : null,
        messageTemplate: (messageExpr ?? '').trim().startsWith('`') ? messageExpr.trim() : null,
        params: header.params,
      };
      helpers.push(helper);
      continue;
    }

    // A code looked up in a table whose values are the messages: new HttpError(409, block, TABLE[block]).
    const table = (messageExpr ?? '').match(/^([A-Za-z_$][\w$]*)\[([A-Za-z_$][\w$]*)\]$/);
    if (status !== null && table && table[2] === codeExpr) {
      const decl = masked.match(new RegExp(`\\bconst\\s+${table[1]}\\b[^=]*=\\s*\\{`));
      if (decl) {
        for (const p of splitArgs(masked, decl.index + decl[0].length - 1).args) {
          const kv = p.match(/^([A-Z][A-Z0-9_]*)\s*:\s*([\s\S]+)$/);
          if (kv) addRow(status, kv[1], literal(kv[2]) ?? '', file);
        }
        continue;
      }
    }

    // A code from a checker's result: const r = check(...); new HttpError(422, r.code, r.message).
    if (status !== null && codeMember) {
      const assigned = masked.slice(0, m.index).match(new RegExp(`\\bconst\\s+${codeMember[1]}\\s*=\\s*(?:await\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'));
      const fn = assigned?.at(-1)?.match(/([A-Za-z_$][\w$]*)\s*\($/)?.[1];
      const found = fn ? returnedCodes(file, fn, codeMember[2]) : [];
      if (found.length) {
        for (const f of found) addRow(status, f.code, f.message || message, file);
        continue;
      }
    }
    unresolved.push(where);
  }
}

// Call sites of the helpers: in the defining file and in every file importing the helper from it.
function callSites(helperFile, name) {
  const sites = [];
  for (const [file, { masked }] of sources) {
    const local = [];
    if (file === helperFile) local.push(name);
    for (const [alias, imp] of imports.get(file)) if (imp.from === helperFile && imp.name === name) local.push(alias);
    for (const n of local) {
      for (const m of masked.matchAll(new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}\\s*\\(`, 'g'))) {
        const before = masked.slice(Math.max(0, m.index - 20), m.index);
        if (/(function|const|let)\s+$/.test(before)) continue; // the definition
        sites.push({ file, index: m.index, open: m.index + m[0].length - 1 });
      }
    }
  }
  return sites;
}

for (const h of helpers) {
  let used = false;
  for (const site of callSites(h.file, h.name)) {
    const { masked } = sources.get(site.file);
    const { args } = splitArgs(masked, site.open);
    const pick = (index, prop) => {
      const a = args[index];
      if (a === undefined || !prop) return a;
      return a.startsWith('{') ? member(splitArgs(a, 0).args, prop) : undefined;
    };
    const codeArg = pick(h.codeParam, h.codeProp);
    let code = codeArg === undefined ? h.defaultCode : codeLiteral(codeArg) ?? (IDENT.test(codeArg) ? constantValue(site.file, codeArg) : null);
    const status = h.status ?? (/^\d{3}$/.test(args[h.statusParam] ?? '') ? Number(args[h.statusParam]) : null);
    if (code === null || status === null) {
      // a helper passing its own parameter on (a chain) or a computed code
      if (!headersOf.get(site.file).some((x) => x.at < site.index && x.params.some((p) => p.name === codeArg))) {
        unresolved.push(`${rel(site.file)}:${lineAt(masked, site.index)}`);
      }
      continue;
    }
    // A template message takes the call's own values for the helper's parameters: `The ${field} is required` -> 'The reason is required'.
    const filled = (template) =>
      literal(
        template.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (all, name) => {
          const i = h.params.findIndex((p) => p.name === name);
          const expr = i < 0 ? undefined : (args[i] ?? h.params[i].def ?? undefined);
          const value = expr === undefined ? null : (literal(expr) ?? (/^-?\d+(\.\d+)?$/.test(expr) ? expr : null));
          return value === null ? all : value.replace(/[`$\\]/g, '\\$&');
        }),
      ) ?? '';
    const message =
      h.messageParam >= 0 ? (literal(pick(h.messageParam, h.messageProp)) ?? h.defaultMessage ?? '') : h.messageTemplate ? filled(h.messageTemplate) : h.message;
    addRow(status, code, message, site.file);
    used = true;
  }
  if (!used && h.defaultCode && h.status !== null) addRow(h.status, h.defaultCode, h.message, h.file);
}

// The zero-argument helpers of http/errors.ts (notFound(), forbidden()) are thrown wherever they are called.
for (const eh of errorsHelpers) {
  for (const site of callSites(ERRORS_FILE, eh.name)) addRow(eh.status, eh.code, eh.message, site.file);
}

// The central error handler: database integrity errors, request validation, framework client errors, availability.
{
  const { masked } = sources.get(ERRORS_FILE);
  for (const m of masked.matchAll(/\{\s*status:\s*(\d{3}),\s*code:\s*'([A-Z0-9_]+)',\s*message:\s*('[^']*')\s*\}/g)) addRow(Number(m[1]), m[2], literal(m[3]), ERRORS_FILE, true);
  for (const m of masked.matchAll(/status\((\d{3})\)[^;]*?send\(\{\s*error:\s*'([A-Z0-9_]+)',\s*message:\s*([^}]*?)\s*\}\)/g)) {
    addRow(Number(m[1]), m[2], literal(m[3]) ?? '', ERRORS_FILE, true);
  }
  // Framework client errors choose code and message by status: `statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : ...`.
  const byStatus = new Map();
  for (const m of masked.matchAll(/===\s*(\d{3})\s*\?\s*('[^']*')/g)) {
    const v = literal(m[2]);
    const entry = byStatus.get(m[1]) ?? {};
    if (CODE.test(v)) entry.code ??= v;
    else entry.message ??= v;
    byStatus.set(m[1], entry);
  }
  for (const [status, e] of byStatus) if (e.code) addRow(Number(status), e.code, e.message ?? '', ERRORS_FILE, true);
}

// ------------------------------------------------------------------------------------------------------------------ output
const STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};
const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const all = [...rows.values()].sort((a, b) => a.status - b.status || a.code.localeCompare(b.code));
const statuses = [...new Set(all.map((r) => r.status))];
const codes = new Set(all.map((r) => r.code));

const lines = [
  '# API error codes',
  '',
  '<!-- Generated by scripts/api-error-codes.mjs (`npm run docs:errors`) from apps/api/src. Do not edit by hand: change the code and run it again. -->',
  '',
  `The HRMS API refuses a request with an HTTP status and a JSON body naming a stable error code. This catalogue lists ${codes.size} codes in ${all.length} code/status pairs, found in the API source.`,
  '',
  '## The error body',
  '',
  '```json',
  '{ "error": "INSUFFICIENT_BALANCE", "message": "Not enough leave balance; request unpaid leave or ask HR", "details": { } }',
  '```',
  '',
  '- `error`: the machine-readable code listed below. Clients branch on this value, never on the message text.',
  '- `message`: an English sentence for people. Its wording may change at any time.',
  '- `details` (optional): structured data that some codes add, for example the offending `field`, `line`, `lines`, or a date such as `lastWorkingDate`.',
  '',
  'Every response carries an `x-request-id` header. Quote it when you report a problem.',
  '',
  '## How clients should treat each status',
  '',
  '| HTTP | Meaning | What the client should do |',
  '| --- | --- | --- |',
  '| 400 | The request is malformed: schema validation (`INVALID_REQUEST`), a bad value format (`INVALID_VALUE`), or missing context headers. | This is a client bug. Fix the request. Retrying it unchanged fails again. |',
  '| 401 | No valid sign-in: the token is missing or invalid, or the session has expired, gone idle or been revoked (`SESSION_*`). | Sign in again to get a new token, then retry. |',
  '| 403 | Signed in but not permitted: the role, duty, row scope or a separation-of-duties rule refuses the action. Permission denials are recorded in the audit trail. | Do not retry. Hide or disable the action for this user, or ask an administrator for access. |',
  '| 404 | The record does not exist, or it lies outside the caller\'s company or scope. The API does not say which, so that records outside the scope stay hidden. | Treat the record as gone and refresh the view. |',
  '| 409 | A conflict with the current state: a stale `expectedVersion` (`STALE_VERSION`), a duplicate, a state that no longer allows the action, or a concurrent change (`RETRY`). | Reload the record, then reapply the change or show the new state. `RETRY` can be retried as is. A write that takes an `idempotencyKey` can be sent again with the same key safely. |',
  '| 410 | A download or link has expired. | Request the export or report again. |',
  '| 413 / 415 | The body is too large, or its media type is not accepted. | Send a smaller file or a supported type. |',
  '| 422 | The request is well-formed, but a business rule refuses it, for example a policy, a balance, a date rule or a missing reason. | Show the message to the user so they can correct the input. `details` often names the field or line. Do not retry unchanged. |',
  '| 429 | A limit is reached, such as a concurrent export or a daily sending limit. | Wait and retry later. The message gives the limit. |',
  '| 500 | An unexpected error (`INTERNAL`). Nothing about the cause is returned. | Report it with the `x-request-id`. |',
  '| 503 | Temporarily unavailable. `UNAVAILABLE` means the database is busy or unreachable, or the request deadline has passed; the request was not carried out, and the response has a `Retry-After` header. Other 503 codes name a dependency that cannot be reached or is not set up (the file scanner, the sign-in provider, identity matching). | Retry later with backoff, after `Retry-After` seconds when it is given. If the code names a missing setup, tell an administrator. |',
  '',
  '## Codes by HTTP status',
  '',
  'Codes that are thrown with more than one status have one row for each status. A `*` in a code stands for a part filled in at run time, and `…` in a message stands for a value. "Where" names the API modules that can return the code (http is the central error handler and request context).',
  '',
];
for (const status of statuses) {
  const group = all.filter((r) => r.status === status);
  lines.push(`### ${status} ${STATUS_TEXT[status] ?? ''}`.trimEnd(), '', `${group.length} code${group.length === 1 ? '' : 's'}.`, '', '| Code | HTTP | Example message | Where |', '| --- | --- | --- | --- |');
  for (const r of group) lines.push(`| \`${r.code}\` | ${r.status} | ${cell(r.message)} | ${[...r.where].sort().join(', ')} |`);
  lines.push('');
}
if (unresolved.length) {
  lines.push(
    '## Codes computed at run time',
    '',
    'These places throw an `HttpError` whose code is only known at run time (for example a code passed through from another check), so the generator cannot list it above:',
    '',
    ...[...new Set(unresolved)].sort().map((w) => `- \`${w}\``),
    '',
  );
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join('\n'));
console.log(`Wrote ${rel(OUT)}: ${codes.size} codes, ${all.length} code/status rows, ${new Set(unresolved).size} run-time constructions listed separately.`);
