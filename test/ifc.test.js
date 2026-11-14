import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildRelationshipIndex, isDeviceCandidate, loadIfcModel, readPropertySet,
} from '../src/ifc.js';
import { buildUnitContext, explainMeasure } from '../src/ifc-units.js';
import { parseStep, parseStepValue } from '../src/step.js';
import { entityView, inspect } from '../src/domain.js';

const fixture = 'fixtures/handover-a.ifc';
const read = () => readFile(fixture, 'utf8');

test('STEP 值保留类型、枚举与嵌套，不压成字符串', async () => {
  const typed = parseStepValue("IFCLENGTHMEASURE(1200.)");
  assert.equal(typed.kind, 'typed');
  assert.equal(typed.valueType, 'IFCLENGTHMEASURE');
  assert.equal(typed.values[0].kind, 'number');

  const enumValue = parseStepValue('.MILLI.');
  assert.equal(enumValue.kind, 'enum');
  assert.equal(enumValue.value, 'MILLI');

  const list = parseStepValue("(IFCLABEL('甲'),IFCLABEL('乙'))");
  assert.equal(list.kind, 'list');
  assert.deepEqual(list.items.map(item => item.valueType), ['IFCLABEL', 'IFCLABEL']);
});

test('关系端点按 IFC4 参数位置解读', async () => {
  const parsed = parseStep(await read());
  // Build the same minimal indexes loadIfcModel uses: byId is needed to
  // verify endpoints and to read type-object property sets.
  const model = { ...parsed };
  const index = buildRelationshipIndex(model);
  const typeRelation = index.relations.find(relation => relation.ifcType === 'IFCRELDEFINESBYTYPE');
  assert.equal(typeRelation.relating, 200);
  assert.deepEqual(typeRelation.related, [500]);
  const containment = index.relations.find(relation =>
    relation.ifcType === 'IFCRELCONTAINEDINSPATIALSTRUCTURE' &&
    relation.related.includes(500));
  assert.equal(containment.relating, 102);
  assert.ok(index.relations.some(relation => relation.partial === false));
});

test('项目单位、换算单位与派生单位都能说明数值来源', async () => {
  const model = loadIfcModel(await read());
  const pressure = explainMeasure({
    declaredType: 'IFCPRESSUREMEASURE',
    rawValue: 0.6,
    explicitUnitId: 6,
    unitContext: model.unitContext,
    propertyStepId: 423,
  });
  const conversion = explainMeasure({
    declaredType: 'IFCLENGTHMEASURE',
    rawValue: 1200,
    explicitUnitId: 16,
    unitContext: model.unitContext,
    propertyStepId: 422,
  });
  assert.equal(conversion.unit.stepId, 16);
  assert.equal(conversion.canonical.value, 1.2);
  assert.equal(pressure.unitSource, 'property');
  assert.equal(pressure.unit.stepId, 6);
  assert.equal(pressure.canonical.value, 60000);
  assert.equal(pressure.canonical.symbol, 'Pa');
  assert.ok(pressure.chain.some(step => step.step === 'conversion-unit'));

  const flow = explainMeasure({
    declaredType: 'IFCVOLUMETRICFLOWRATEMEASURE',
    rawValue: 0.036,
    explicitUnitId: null,
    unitContext: model.unitContext,
  });
  assert.equal(flow.unitSource, 'project');
  assert.equal(flow.canonical.symbol, 'm³/s');
  assert.ok(Math.abs(flow.canonical.value - 0.036) < 1e-12);

  const unknown = explainMeasure({
    declaredType: 'IFCUSERDEFINEDMEASURE',
    rawValue: 1,
    explicitUnitId: null,
    unitContext: model.unitContext,
  });
  assert.equal(unknown.canonical, null);
  assert.ok(unknown.warnings.some(warning => warning.code === 'unknown-measure-dimension'));
});

test('属性集的嵌套值保留声明类型', async () => {
  const model = loadIfcModel(await read());
  const set = readPropertySet(model, 302);
  const enumerated = set.properties.find(property => property.kind === 'enumerated');
  assert.deepEqual(
    enumerated.values.items.map(item => item.valueType),
    ['IFCLABEL', 'IFCLABEL'],
  );
  assert.equal(enumerated.enumeration.stepId, 420);
  const list = set.properties.find(property => property.kind === 'list');
  assert.deepEqual(
    list.rawValue.items.map(item => item.valueType),
    ['IFCTHERMODYNAMICTEMPERATUREMEASURE', 'IFCTHERMODYNAMICTEMPERATUREMEASURE'],
  );
});

test('候选设备排除空间结构与支撑实体', async () => {
  const model = loadIfcModel(await read());
  const candidates = model.entities.filter(isDeviceCandidate).map(entity => entity.id);
  assert.ok(candidates.includes(500));
  assert.ok(!candidates.includes(102));
  assert.ok(!candidates.includes(200));
  assert.ok(!candidates.includes(301));
});

test('既有查看入口仍然可用并可按 STEP 编号查看邻域', async () => {
  const parsed = await inspect(fixture);
  assert.ok(parsed.entities.some(entity => entity.id === 500 && entity.type === 'IFCPUMP'));
  const view = await entityView(fixture, 500);
  assert.equal(view.entity.ifcType, 'IFCPUMP');
  assert.ok(view.referencedBy.some(entity => entity.ifcType === 'IFCRELDEFINESBYPROPERTIES'));
  assert.ok(view.entity.stepLine > 0);
});
