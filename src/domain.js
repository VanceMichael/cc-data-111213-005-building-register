import { readFile } from 'node:fs/promises';
export const sample = 'fixtures/plant.ifc';
export function splitStepArguments(text) {
  const result = [];
  let start = 0, depth = 0, quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      if (quoted && text[index + 1] === "'") { index += 1; continue; }
      quoted = !quoted;
    }
    if (quoted) continue;
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { result.push(text.slice(start, index).trim()); start = index + 1; }
  }
  if (quoted || depth !== 0) throw new Error('STEP 参数未闭合');
  result.push(text.slice(start).trim());
  return result;
}
export async function inspect(filename) {
  const text = await readFile(filename, 'utf8');
  if (!text.startsWith('ISO-10303-21;')) throw new Error('不是 STEP 交换文件');
  const entities = [];
  for (const match of text.matchAll(/#(\d+)\s*=\s*(IFC\w+)\(([^;]*)\);/g)) {
    entities.push({ id: Number(match[1]), type: match[2], arguments: splitStepArguments(match[3]) });
  }
  return { schema: /FILE_SCHEMA\(\(.'?(IFC\w+)/.exec(text)?.[1] || 'IFC4', entities };
}
