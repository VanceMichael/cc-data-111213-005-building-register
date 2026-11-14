// STEP (ISO 10303-21) reader.
//
// The reader deliberately keeps the STEP representation separate from the
// IFC meaning: an entity id is a location in one file, while typed values,
// enum literals and references are kept as typed values.  Callers that need
// IFC semantics build indexes on top of this layer.

const NUMBER = /^[-+]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[Ee][-+]?\d+)?/;
const TYPED = /^([A-Za-z][A-Za-z0-9_]*)\s*\(/;
const ENTITY = /^#(\d+)\s*=\s*([A-Za-z][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/;
const ENUM = /^\.([A-Za-z0-9_]+)\./;

export function splitStepArguments(text) {
  const result = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      if (quoted && text[index + 1] === "'") { index += 1; continue; }
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      result.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted) throw new Error('STEP 参数中的字符串未闭合');
  if (depth !== 0) throw new Error('STEP 参数未闭合');
  result.push(text.slice(start).trim());
  return result;
}

export function decodeStepString(text) {
  return String(text)
    .replace(/''/g, "'")
    .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) => {
      const points = [];
      for (let index = 0; index + 4 <= hex.length; index += 4) {
        points.push(parseInt(hex.slice(index, index + 4), 16));
      }
      return String.fromCodePoint(...points);
    })
    .replace(/\\X4\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) => {
      const points = [];
      for (let index = 0; index + 8 <= hex.length; index += 8) {
        points.push(parseInt(hex.slice(index, index + 8), 16));
      }
      return String.fromCodePoint(...points);
    })
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\S\\(.)/g, (_, char) => String.fromCharCode(char.charCodeAt(0) + 128))
    .replace(/\\\\/g, '\\');
}

class ValueReader {
  constructor(text) { this.text = text; this.index = 0; }

  skip() {
    while (this.index < this.text.length && /\s/.test(this.text[this.index])) this.index += 1;
  }

  readString() {
    // Current character is the opening quote.
    this.index += 1;
    let value = '';
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === "'") {
        if (this.text[this.index + 1] === "'") {
          value += "'";
          this.index += 2;
          continue;
        }
        this.index += 1;
        return { kind: 'string', value: decodeStepString(value) };
      }
      value += char;
      this.index += 1;
    }
    throw new Error('STEP 字符串未闭合');
  }

  readList() {
    this.index += 1; // (
    const items = [];
    this.skip();
    if (this.text[this.index] === ')') { this.index += 1; return { kind: 'list', items }; }
    for (;;) {
      items.push(this.readValue());
      this.skip();
      const char = this.text[this.index];
      if (char === ',') { this.index += 1; continue; }
      if (char === ')') { this.index += 1; return { kind: 'list', items }; }
      throw new Error('STEP 列表未闭合');
    }
  }

  readTyped() {
    const match = TYPED.exec(this.text.slice(this.index));
    if (!match) throw new Error('STEP 类型值格式不正确');
    const valueType = match[1].toUpperCase();
    this.index += match[0].length;
    this.skip();
    const values = [];
    if (this.text[this.index] !== ')' && !this.atEnd()) {
      for (;;) {
        values.push(this.readValue());
        this.skip();
        if (this.text[this.index] === ',') { this.index += 1; continue; }
        break;
      }
    }
    if (this.text[this.index] !== ')') throw new Error('STEP 类型值未闭合');
    this.index += 1;
    return { kind: 'typed', valueType, values };
  }

  atEnd() { this.skip(); return this.index >= this.text.length; }

  readValue() {
    this.skip();
    const rest = this.text.slice(this.index);
    if (!rest) throw new Error('STEP 参数为空');
    const char = rest[0];
    if (char === "'") return this.readString();
    if (char === '(') return this.readList();
    if (char === '$') { this.index += 1; return { kind: 'unset' }; }
    if (char === '*') { this.index += 1; return { kind: 'derived' }; }
    if (char === '#') {
      const match = /^#(\d+)/.exec(rest);
      if (!match) throw new Error('STEP 引用格式不正确');
      this.index += match[0].length;
      return { kind: 'ref', id: Number(match[1]) };
    }
    const enumMatch = ENUM.exec(rest);
    if (enumMatch) {
      this.index += enumMatch[0].length;
      const literal = enumMatch[1].toUpperCase();
      if (literal === 'T') return { kind: 'boolean', value: true, literal: 'T' };
      if (literal === 'F') return { kind: 'boolean', value: false, literal: 'F' };
      if (literal === 'U') return { kind: 'boolean', value: 'unknown', literal: 'U' };
      return { kind: 'enum', value: literal, literal: `.${literal}.` };
    }
    if (TYPED.test(rest)) return this.readTyped();
    const numberMatch = NUMBER.exec(rest);
    if (numberMatch) {
      this.index += numberMatch[0].length;
      return {
        kind: 'number',
        value: Number(numberMatch[0]),
        raw: numberMatch[0],
        integer: !/[.Ee]/.test(numberMatch[0]),
      };
    }
    // STEP also permits unquoted keywords in a few positions.  Keep them
    // distinguishable instead of silently turning them into text.
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (identifier) {
      this.index += identifier[0].length;
      return { kind: 'identifier', value: identifier[0] };
    }
    throw new Error(`无法解析 STEP 值: ${rest.slice(0, 24)}`);
  }
}

export function parseStepValue(text) {
  const reader = new ValueReader(text);
  const value = reader.readValue();
  if (!reader.atEnd()) throw new Error(`STEP 值后存在多余内容: ${text.slice(reader.index, reader.index + 24)}`);
  return value;
}

export function parseStepArguments(text) {
  if (text.trim() === '') return [];
  return splitStepArguments(text).map(parseStepValue);
}

function stripComments(text) {
  let output = '';
  let index = 0;
  let quoted = false;
  let comment = false;
  let line = 1;
  let issue = null;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (comment) {
      if (char === '*' && next === '/') { comment = false; output += '  '; index += 2; continue; }
      output += char === '\n' ? '\n' : ' ';
      if (char === '\n') line += 1;
      index += 1;
      continue;
    }
    if (!quoted && char === '/' && next === '*') { comment = true; output += '  '; index += 2; continue; }
    if (char === "'") {
      if (quoted && next === "'") { output += "''"; index += 2; continue; }
      quoted = !quoted;
    }
    output += char;
    if (char === '\n') line += 1;
    index += 1;
  }
  if (comment) issue = { code: 'unterminated-comment', line };
  return { text: output, issue };
}

function scanSegments(text) {
  const segments = [];
  let start = 0;
  let line = 1;
  let startLine = 1;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      if (quoted && text[index + 1] === "'") { index += 1; continue; }
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      if (char === '\n') line += 1;
      continue;
    }
    if (char === ';') {
      segments.push({ text: text.slice(start, index).trim(), line: startLine });
      start = index + 1;
      startLine = line;
      continue;
    }
    if (char === '\n') line += 1;
  }
  if (text.slice(start).trim()) segments.push({ text: text.slice(start).trim(), line: startLine });
  return { segments, unterminatedString: quoted };
}

// Parse the exchange structure.  No IFC-specific inference is done here.
export function parseStep(text) {
  if (!/^\s*ISO-10303-21\s*;/.test(text)) throw new Error('不是 STEP 交换文件');
  const stripped = stripComments(text);
  const issues = [];
  if (stripped.issue) issues.push(stripped.issue);
  const source = stripped.text;
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(source)?.[1] || 'IFC4';
  const dataMatch = /\bDATA\s*;/i.exec(source);
  if (!dataMatch) throw new Error('STEP 文件中缺少 DATA 段');
  const dataStart = dataMatch.index + dataMatch[0].length;
  // Segment lines are relative to DATA; add the offset so every reported
  // line is the real line in the delivered file.
  const dataLineOffset = source.slice(0, dataMatch.index).split('\n').length;
  const endMatch = /\bENDSEC\s*;/i.exec(source.slice(dataStart));
  const dataEnd = endMatch ? dataStart + endMatch.index : source.length;
  const dataText = source.slice(dataStart, dataEnd);
  const scanned = scanSegments(dataText);
  if (scanned.unterminatedString) issues.push({ code: 'unterminated-string', message: 'DATA 段字符串未闭合' });
  const entities = [];
  const byId = new Map();
  for (const segment of scanned.segments) {
    if (!segment.text) continue;
    const match = ENTITY.exec(segment.text);
    if (!match) {
      issues.push({
        code: 'unparsed-statement',
        stepLine: segment.line + dataLineOffset,
        text: segment.text.slice(0, 80),
      });
      continue;
    }
    const id = Number(match[1]);
    const type = match[2].toUpperCase();
    const argumentText = match[3];
    let arguments_;
    let values;
    try {
      arguments_ = splitStepArguments(argumentText);
      values = arguments_.map(parseStepValue);
    } catch (error) {
      issues.push({
        code: 'unparsed-arguments',
        stepId: id,
        ifcType: type,
        stepLine: segment.line + dataLineOffset,
        message: error.message,
      });
      arguments_ = argumentText ? [argumentText] : [];
      values = [{ kind: 'unparsed', raw: argumentText }];
    }
    const entity = {
      id,
      type,
      arguments: arguments_,
      values,
      stepLine: segment.line + dataLineOffset,
    };
    if (byId.has(id)) {
      issues.push({
        code: 'duplicate-step-id',
        stepId: id,
        ifcType: type,
        stepLine: segment.line + dataLineOffset,
      });
      continue;
    }
    byId.set(id, entity);
    entities.push(entity);
  }
  return { schema, entities, byId, issues, header: parseHeader(source.slice(0, dataMatch.index)) };
}

function parseHeader(text) {
  const header = {};
  const description = /FILE_DESCRIPTION\s*\(([\s\S]*?)\)\s*;/i.exec(text);
  if (description) header.description = description[1];
  const name = /FILE_NAME\s*\(([\s\S]*?)\)\s*;/i.exec(text);
  if (name) header.name = name[1];
  const schema = /FILE_SCHEMA\s*\(([\s\S]*?)\)\s*;/i.exec(text);
  if (schema) header.schema = schema[1];
  return header;
}

// Small helpers shared by the IFC layer.  They never deserialize an
// aggregate into plain text; the kind and declared type stay available.
export function unwrapScalar(value) {
  let current = value;
  while (current?.kind === 'typed' && current.values.length === 1) current = current.values[0];
  return current;
}

export function scalarNumber(value) {
  const scalar = unwrapScalar(value);
  return scalar?.kind === 'number' ? scalar.value : null;
}

export function stringValue(value) {
  const scalar = unwrapScalar(value);
  return scalar?.kind === 'string' ? scalar.value : null;
}

export function refId(value) {
  const scalar = unwrapScalar(value);
  return scalar?.kind === 'ref' ? scalar.id : null;
}

export function refIds(value) {
  if (!value) return [];
  if (value.kind === 'ref') return [value.id];
  if (value.kind === 'list') return value.items.flatMap(refIds);
  if (value.kind === 'typed') return value.values.flatMap(refIds);
  return [];
}

export function encodeValue(value) {
  if (!value) return null;
  switch (value.kind) {
    case 'string': return { kind: 'string', value: value.value };
    case 'number': return { kind: 'number', value: value.value, ...(value.integer ? { integer: true } : {}) };
    case 'enum': return { kind: 'enum', literal: value.literal, value: value.value };
    case 'boolean': return { kind: 'boolean', value: value.value, literal: value.literal };
    case 'ref': return { kind: 'ref', stepId: value.id };
    case 'list': return { kind: 'list', items: value.items.map(encodeValue) };
    case 'typed': return {
      kind: 'typed',
      valueType: value.valueType,
      ...(value.values.length === 1
        ? { value: encodeValue(value.values[0]) }
        : { items: value.values.map(encodeValue) }),
    };
    case 'unset': return { kind: 'unset' };
    case 'derived': return { kind: 'derived' };
    case 'unparsed': return { kind: 'unparsed', raw: value.raw };
    default: return { kind: value.kind, ...value };
  }
}
