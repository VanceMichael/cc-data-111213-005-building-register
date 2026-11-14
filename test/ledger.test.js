import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readLedger } from '../src/ledger.js';

const load = async (file) => readLedger(await readFile(file, 'utf8'), { source: file });
const ledgerA = await load('fixtures/handover-a.ifc');
const findDevice = (ledger, stepId) => ledger.devices.find(device => device.identity.stepId === stepId);

test('类型对象与实例属性集各自保留来源，不按同名属性合并', async () => {
  const device = findDevice(ledgerA, 500);
  const typeSource = device.propertySources.find(source => source.sourceKind === 'type-object');
  const instanceSource = device.propertySources.find(source => source.sourceKind === 'instance');
  assert.equal(typeSource.typeStepId, 200);
  assert.equal(typeSource.setStepId, 301);
  assert.equal(instanceSource.relationStepId, 512);
  assert.equal(instanceSource.setStepId, 320);

  const nameFields = device.fields.filter(field => field.label === '型号');
  assert.equal(nameFields.length, 2);
  const values = nameFields.map(field => field.value.value).sort();
  assert.deepEqual(values, ['P-200', 'P-200-B']);
  for (const field of nameFields) {
    assert.ok(field.source.setStepId === 301 || field.source.setStepId === 320);
    assert.equal(field.source.propertyStepLine > 0, true);
  }

  const conflict = device.conflicts.find(entry => entry.propertyName === '型号');
  assert.equal(conflict.code, 'property-name-conflict');
  assert.equal(conflict.sources.length, 2);
  assert.deepEqual(
    conflict.sources.map(source => source.sourceKind).sort(),
    ['instance', 'type-object'],
  );
});

test('GlobalId 是跨文件业务标识，STEP 编号只是文件内位置', async () => {
  const ledgerB = await load('fixtures/handover-b.ifc');
  const device = findDevice(ledgerB, 500);
  assert.equal(device.identity.globalId, '4AAAAAAAAAAAAAAAAAAAAA');
  assert.notEqual(device.identity.globalId, device.identity.stepId);
  assert.equal(typeof device.identity.globalId, 'string');
});

test('空间包含、分解组合与空间路径都能逐条回到关系', async () => {
  const device = findDevice(ledgerA, 500);
  assert.equal(device.placement.status, 'contained');
  const container = device.placement.containers[0];
  assert.equal(container.via, 'direct');
  assert.equal(container.relationStepId, 511);
  assert.equal(container.spatial.name, '一层');
  assert.deepEqual(
    container.spatialPath.map(hop => hop.relationStepId),
    [110, 111],
  );
  assert.equal(container.spatialPath[0].parent.name, '主楼');

  // The part has no containment of its own; its placement comes from the
  // assembly, and the nesting hop is kept as evidence.
  const part = findDevice(ledgerA, 5021);
  assert.equal(part.placement.status, 'contained');
  assert.equal(part.placement.containers[0].via, 'decomposition');
  assert.equal(part.placement.containers[0].relationStepId, 516);
  assert.deepEqual(part.placement.containers[0].hops.map(hop => hop.relationStepId), [518]);
});

test('无空间归属与同名设备显式列出', async () => {
  const device = findDevice(ledgerA, 501);
  assert.equal(device.placement.status, 'unassigned');
  assert.ok(device.issues.some(issue => issue.code === 'no-spatial-containment'));
  assert.equal(device.resolution.presence.status, 'ambiguous');
  assert.ok(device.resolution.presence.issues.some(issue => issue.code === 'duplicate-device-name'));

  const names = ledgerA.sameNameDevices.find(entry => entry.name === '循环泵');
  assert.deepEqual(names.devices.map(item => item.stepId).sort(), [500, 501]);
  assert.ok(ledgerA.issues.some(issue => issue.code === 'duplicate-device-name'));
});

test('多条冲突关系不被静默取舍', async () => {
  const device = findDevice(ledgerA, 503);
  assert.deepEqual(
    device.typeDefinitions.entries.map(entry => entry.typeStepId).sort(),
    [200, 203],
  );
  assert.ok(device.issues.some(issue => issue.code === 'multiple-type-definitions'));
  assert.equal(device.resolution.presence.status, 'identified');
});

test('坏引用保留设备并标出缺口，不把设备丢掉', async () => {
  const device = findDevice(ledgerA, 504);
  assert.ok(device);
  assert.ok(device.issues.some(issue => issue.code === 'missing-property-set'));
  assert.ok(device.issues.some(issue => issue.code === 'missing-property'));
  const brokenSource = device.propertySources.find(source => source.setStepId === 999);
  assert.equal(brokenSource.observations.length, 0);
  assert.equal(device.resolution.data.status, 'partial');
  assert.ok(ledgerA.issues.some(issue => issue.code === 'dangling-relation-endpoint'));
});

test('显式覆盖关系只覆盖被点名的属性', async () => {
  const device = findDevice(ledgerA, 502);
  assert.equal(device.overrides.length, 1);
  assert.equal(device.overrides[0].relationStepId, 524);
  assert.deepEqual(device.overrides[0].propertyStepIds, [426]);

  const overrideSource = device.propertySources.find(source => source.sourceKind === 'instance-override');
  assert.equal(overrideSource.setStepId, 523);
  assert.equal(overrideSource.overrideRelationStepId, 524);
  const overridden = overrideSource.observations.find(observation => observation.propertyStepId === 426);
  const untouched = overrideSource.observations.find(observation => observation.propertyStepId === 427);
  assert.equal(overridden.overridden, true);
  assert.equal(untouched.overridden, false);
  const field = device.fields.find(entry => entry.label === '运行压力');
  assert.equal(field.source.propertyStepLine > 0, true);
  assert.equal(field.source.relationStepLine > 0, true);
});

test('属性值保留声明类型、复合单位与单位换算链', async () => {
  const device = findDevice(ledgerA, 502);
  const mode = device.fields.find(field => field.label === '安装方式');
  assert.equal(mode.value.type, 'enumerated');
  assert.deepEqual(mode.value.items.map(item => item.declaredType), ['IFCLABEL', 'IFCLABEL']);

  const points = device.fields.find(field => field.label === '工作点');
  assert.equal(points.value.type, 'list');
  assert.deepEqual(
    points.value.items.map(item => item.declaredType),
    ['IFCTHERMODYNAMICTEMPERATUREMEASURE', 'IFCTHERMODYNAMICTEMPERATUREMEASURE'],
  );
  assert.ok(points.value.items.every(item => item.unitSymbol === 'K'));
  assert.ok(points.value.items.every(item => item.unitSource === 'project'));;

  const pressure = device.fields.find(field => field.label === '运行压力');
  assert.equal(pressure.value.canonicalUnit, 'Pa');
  assert.equal(pressure.value.raw, 4);
  assert.ok(pressure.value.formula.includes('100000'));
  assert.equal(pressure.value.canonical, 400000);
  assert.equal(pressure.display, '4 bar → 400000 Pa');

  const pump = findDevice(ledgerA, 500);
  const length = pump.fields.find(field => field.label === '安装长度');
  assert.equal(length.value.canonical, 1.2);
  assert.equal(length.value.canonicalUnit, 'm');
  assert.equal(length.value.unitSource, 'property');
  assert.equal(length.value.unitSymbol, 'mm');
  assert.equal(length.display, '1200 mm → 1.2 m');
  assert.ok(ledgerA.unitContext.assignments.LENGTHUNIT.factorToSi === 1);
  assert.equal(ledgerA.unitContext.assignments.VOLUMETRICFLOWRATEUNIT.siSymbol, 'm³/s');
});

test('每条台账字段都带可回查的来源和文件行号', async () => {
  for (const device of ledgerA.devices) {
    for (const field of device.fields) {
      assert.ok(field.source, `${device.identity.stepId}/${field.key} 缺少来源`);
      if (field.category === 'property') {
        assert.equal(typeof field.source.propertyStepId, 'number');
        assert.ok(
          typeof field.source.propertyStepLine === 'number' ||
          field.value.type === 'missing',
        );
        assert.equal(typeof field.source.setStepId, 'number');
        assert.equal(typeof field.source.setStepLine, 'number');
      }
    }
  }
  const isolated = ledgerA.unreferencedPropertySets.find(set => set.stepId === 330);
  assert.ok(isolated);
  assert.equal(isolated.name, '孤立属性');
});
