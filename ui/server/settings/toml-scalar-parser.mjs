// Narrow TOML parser helpers for the conservative scalar patcher.
//
// This is intentionally not a general TOML parser. It recognizes only the
// table headers, bare keys, and one-line scalar forms needed to locate an
// allowlisted setting without interpreting or rewriting unrelated config.

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

export function splitTomlLines(source) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '\n' && source[i] !== '\r') continue;
    const ending = source[i] === '\r' && source[i + 1] === '\n' ? '\r\n' : source[i];
    lines.push({ text: source.slice(start, i), ending });
    i += ending.length - 1;
    start = i + 1;
  }
  if (start < source.length || lines.length === 0 || lines.at(-1).ending !== '') {
    lines.push({ text: source.slice(start), ending: '' });
  }
  return lines;
}

export function joinTomlLines(lines) {
  return lines.map(({ text, ending }) => text + ending).join('');
}

export function preferredTomlLineEnding(lines) {
  return lines.find(({ ending }) => ending !== '')?.ending ?? '\n';
}

function samePath(left, right) {
  return left.length === right.length && left.every((part, i) => part === right[i]);
}

// Return the bare table path written by a `[x]` or `[[x]]` header, or null for
// ordinary lines. Unsupported/invalid headers are left for final TOML
// validation instead of being rewritten by this conservative parser.
export function parseTomlTableHeader(line) {
  const match = /^\s*(\[\[|\[)(.*?)(\]\]|\])\s*(?:#.*)?$/.exec(line);
  if (!match || (match[1] === '[[') !== (match[3] === ']]')) return null;
  const parts = match[2].trim().split('.').map((part) => part.trim());
  if (!parts.length || !parts.every((part) => BARE_KEY_RE.test(part))) return null;
  return parts;
}

// Parse a `key = value` line. `simple` is false for multiline/array/inline-
// table/malformed values. A single-quoted scalar is supported because it is
// still a one-line TOML string.
export function parseTomlKeyValueLine(line) {
  const match = /^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)(.*)$/.exec(line);
  if (!match) return null;
  const scalar = parseTomlScalar(match[4]);
  return {
    key: match[2],
    leading: match[1] + match[2] + match[3],
    value: scalar.value,
    tail: scalar.tail,
    simple: scalar.simple,
  };
}

export function parseTomlScalar(source) {
  let start = 0;
  while (start < source.length && (source[start] === ' ' || source[start] === '\t')) start += 1;
  if (start >= source.length) return { value: null, tail: '', simple: false };
  if (source.startsWith('"""', start) || source.startsWith("'''", start)) {
    return { value: null, tail: '', simple: false };
  }

  const quote = source[start];
  if (quote === '"' || quote === "'") {
    let end = start + 1;
    while (end < source.length) {
      if (source[end] === '\n' || source[end] === '\r') {
        return { value: null, tail: '', simple: false };
      }
      if (quote === '"' && source[end] === '\\') {
        end += 2;
        continue;
      }
      if (source[end] === quote) break;
      end += 1;
    }
    if (end >= source.length) return { value: null, tail: '', simple: false };
    const tail = source.slice(end + 1);
    if (!/^[ \t]*(?:#.*)?$/.test(tail)) return { value: null, tail: '', simple: false };
    return { value: source.slice(start, end + 1), tail, simple: true };
  }

  if (quote === '[' || quote === '{') return { value: null, tail: '', simple: false };
  const match = /^([^\s#]+)([ \t]*(?:#.*)?)?$/.exec(source.slice(start));
  if (!match || /[\[\]{}"']/.test(match[1])) {
    return { value: null, tail: '', simple: false };
  }
  return { value: match[1], tail: match[2] ?? '', simple: true };
}

export function tomlKeyPath(key) {
  const parts = key.split('.');
  return parts.length > 0 && parts.every((part) => BARE_KEY_RE.test(part)) ? parts : null;
}

export function inspectTomlTarget(lines, parts) {
  const tableParts = parts.slice(0, -1);
  let current = [];
  let tableCount = tableParts.length === 0 ? 1 : 0;
  const occurrences = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = parseTomlTableHeader(lines[index].text);
    if (header) {
      current = header;
      if (samePath(current, tableParts)) tableCount += 1;
      continue;
    }
    const parsed = parseTomlKeyValueLine(lines[index].text);
    if (!parsed) continue;
    const parsedPath = tomlKeyPath(parsed.key);
    if (!parsedPath || !samePath(current.concat(parsedPath), parts)) continue;
    if (!parsed.simple) {
      throw new Error(`target value is complex or multiline, refusing to patch: ${parts.join('.')}`);
    }
    occurrences.push({ index, parsed });
  }

  if (tableCount > 1) {
    throw new Error(`duplicate target table in config: ${parts.slice(0, -1).join('.')}`);
  }
  if (occurrences.length > 1) {
    throw new Error(`duplicate target key in table: ${parts.join('.')}`);
  }
  return { tableParts, occurrences, tableExists: tableCount === 1 };
}

function isBlank(line) {
  return line.text.trim() === '';
}

// Find the end of a target table section, moving before trailing blank lines
// so an inserted key stays with the table while existing whitespace remains.
export function existingTomlTableInsertionIndex(lines, tableParts) {
  let current = [];
  let start = tableParts.length === 0 ? 0 : -1;
  for (let index = 0; index < lines.length; index += 1) {
    const header = parseTomlTableHeader(lines[index].text);
    if (!header) continue;
    if (start !== -1 && samePath(current, tableParts)) {
      let end = index;
      while (end > start && isBlank(lines[end - 1])) end -= 1;
      return end;
    }
    current = header;
    if (samePath(current, tableParts)) start = index;
  }
  if (start === -1) return -1;
  let end = lines.length;
  while (end > start && isBlank(lines[end - 1])) end -= 1;
  return end;
}

export function trailingTomlInsertionIndex(lines) {
  let index = lines.length;
  while (index > 0 && isBlank(lines[index - 1])) index -= 1;
  return index;
}
