import { readFile } from 'node:fs/promises';
import { parseStep, encodeValue } from './step.js';
import { loadIfcModel } from './ifc.js';

export const sample = 'fixtures/plant.ifc';
export { splitStepArguments } from './step.js';

// Existing view: schema and STEP entities with their raw argument text.  The
// STEP location of every line is added so callers can point at the original
// file without re-parsing it.
export async function inspect(filename) {
  const text = await readFile(filename, 'utf8');
  const parsed = parseStep(text);
  return {
    schema: parsed.schema,
    entities: parsed.entities.map(entity => ({
      id: entity.id,
      type: entity.type,
      stepLine: entity.stepLine,
      arguments: entity.arguments,
    })),
    issues: parsed.issues,
  };
}

// Look up one STEP entity together with the entities that reference it and
// the ones it references.  This keeps a large model out of the caller's
// context: only the neighbourhood is returned.
export async function entityView(filename, stepId) {
  const model = loadIfcModel(await readFile(filename, 'utf8'));
  const entity = model.byId.get(stepId);
  if (!entity) throw new Error(`STEP 实体 #${stepId} 不存在`);
  return {
    entity: {
      stepId: entity.id,
      ifcType: entity.type,
      stepLine: entity.stepLine,
      arguments: entity.arguments,
      values: entity.values.map(encodeValue),
    },
    referencedBy: (model.reverse.get(stepId) ?? []).map((id) => {
      const referrer = model.byId.get(id);
      return { stepId: id, ifcType: referrer.type, stepLine: referrer.stepLine };
    }),
    references: (model.forward.get(stepId) ?? []).map((id) => {
      const target = model.byId.get(id);
      return target
        ? { stepId: id, ifcType: target.type, stepLine: target.stepLine }
        : { stepId: id, ifcType: null, stepLine: null, missing: true };
    }),
  };
}
