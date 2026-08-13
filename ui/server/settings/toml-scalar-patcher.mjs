// Conservative orchestration for one-line TOML scalar updates.
//
// Parsing stays in toml-scalar-parser.mjs. This module validates the call,
// locates one safe target, and changes only that scalar or inserts a missing
// allowlisted table/key pair.

import {
  existingTomlTableInsertionIndex,
  inspectTomlTarget,
  joinTomlLines,
  parseTomlScalar,
  preferredTomlLineEnding,
  splitTomlLines,
  tomlKeyPath,
  trailingTomlInsertionIndex,
} from './toml-scalar-parser.mjs';

function insertLine(lines, index, text, newline) {
  const before = lines[index - 1];
  const after = lines[index];
  const ending = before?.ending || after?.ending || newline;
  if (index === lines.length) {
    if (before && before.ending === '') before.ending = ending;
    lines.push({ text, ending: '' });
    return;
  }
  lines.splice(index, 0, { text, ending });
}

// Patch one dotted scalar key. `literal` must already be a single TOML scalar
// (quoted string, boolean, number, or another one-line scalar token).
export function patchTomlScalar({ toml, key, literal }) {
  if (typeof toml !== 'string') throw new Error('toml must be a string');
  if (typeof key !== 'string' || key.length === 0) throw new Error('key must be a non-empty string');
  if (typeof literal !== 'string' || literal.length === 0) {
    throw new Error('literal must be a non-empty string');
  }
  const parts = tomlKeyPath(key);
  if (!parts) throw new Error(`invalid setting key: ${key}`);
  const serialized = parseTomlScalar(literal);
  if (!serialized.simple || serialized.tail !== '') {
    throw new Error('literal must be a single simple TOML scalar');
  }

  const lines = splitTomlLines(toml);
  const target = inspectTomlTarget(lines, parts);
  if (target.occurrences.length === 1) {
    const { index, parsed } = target.occurrences[0];
    lines[index].text = parsed.leading + literal + parsed.tail;
    return joinTomlLines(lines);
  }

  const newline = preferredTomlLineEnding(lines);
  if (target.tableExists) {
    const index = existingTomlTableInsertionIndex(lines, target.tableParts);
    insertLine(lines, index, `${parts.at(-1)} = ${literal}`, newline);
    return joinTomlLines(lines);
  }

  let index = trailingTomlInsertionIndex(lines);
  if (target.tableParts.length > 0) {
    insertLine(lines, index, `[${target.tableParts.join('.')}]`, newline);
    index += 1;
  }
  insertLine(lines, index, `${parts.at(-1)} = ${literal}`, newline);
  return joinTomlLines(lines);
}
