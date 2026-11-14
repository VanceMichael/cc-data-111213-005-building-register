import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { diffLedgers, readLedger } from '../src/ledger.js';

const load = async (file) => readLedger(await readFile(file, 'utf8'), { source: file });
const a = await load('fixtures/handover-a.ifc');
const b = await load('fixtures/handover-b.ifc');
const c = await load('fixtures/handover-c.ifc');

test('两次移交按 GlobalId 得到新增、消失和资料变化', () => {
  const diff = diffLedgers(a, b);
  assert.deepEqual(diff.added.map(device => device.globalId), ['9BBBBBBBBBBBBBBBBBBBBB']);
  assert.equal(diff.removed.length, 0);
  // #504 disappears, but its property relation in the earlier file was
  // already incomplete; that device is reported under uncertain.removed.
  assert.deepEqual(
    diff.uncertain.removed.map(device => device.globalId).sort(),
    ['6CCCCCCCCCCCCCCCCCCCCC', '8AAAAAAAAAAAAAAAAAAAAA'],
  );
  assert.equal(diff.changed.length, 4);

  const pump = diff.changed.find(device => device.globalId === '4AAAAAAAAAAAAAAAAAAAAA');
  const labels = pump.changes.map(change => change.label);
  assert.ok(labels.includes('型号'));
  assert.ok(labels.includes('安装长度'));
  assert.ok(labels.includes('空间容器'));
  const length = pump.changes.find(change => change.label === '安装长度');
  assert.equal(length.before.canonical, 1.2);
  assert.equal(length.after.canonical, 1.25);
  assert.equal(length.sources.before.propertyStepLine > 0, true);
  assert.equal(length.sources.after.propertyStepLine > 0, true);
});

test('依赖解析不完整时不得把设备判成已拆除', () => {
  const diff = diffLedgers(a, c);
  // #501 is absent from the later file, but a type relation that still names
  // it is dangling.  The disappearance must stay uncertain.
  const uncertain = diff.uncertain.removed.find(device => device.globalId === '4FFFFFFFFFFFFFFFFFFFFF');
  assert.ok(uncertain);
  assert.ok(uncertain.reasons.some(reason => reason.code === 'dangling-relation-endpoint'));
  assert.equal(uncertain.reasons[0].missingStepId, 501);
  assert.ok(
    uncertain.reasons.some(reason =>
      reason.survivingGlobalIds?.includes('2AAAAAAAAAAAAAAAAAAAAA')),
  );
  assert.ok(!diff.removed.some(device => device.globalId === '4FFFFFFFFFFFFFFFFFFFFF'));
});

test('真正消失的设备在关系可解析时判为拆除', () => {
  const diff = diffLedgers(a, c);
  // #502 (风机盘管) and #5021 (过渡件) are both gone and nothing dangling
  // points at them in the later delivery.
  const removed = diff.removed.find(device => device.globalId === '5DDDDDDDDDDDDDDDDDDDDD');
  assert.equal(removed.name, '风机盘管');
  assert.equal(removed.placementStatus, 'contained');
  assert.equal(removed.containers[0].spatialName, '二层');
  assert.ok(diff.removed.some(device => device.globalId === '6CCCCCCCCCCCCCCCCCCCCC'));
});

test('自身依赖未解析的设备不会被判为拆除', () => {
  const diff = diffLedgers(a, b);
  const fan = diff.uncertain.removed.find(device => device.globalId === '8AAAAAAAAAAAAAAAAAAAAA');
  assert.ok(fan);
  assert.ok(fan.reasons.some(reason => reason.code === 'missing-property-set'));
  assert.ok(fan.reasons.some(reason => reason.code === 'missing-property'));
});

test('新增设备按 GlobalId 判定，并与同名设备区分', () => {
  const diff = diffLedgers(a, b);
  // 补水泵 shares the name pattern of the other pumps but has its own
  // GlobalId, so it is a genuine addition and not a merge of names.
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].name, '补水泵');
  assert.equal(diff.added[0].globalId, '9BBBBBBBBBBBBBBBBBBBBB');
  assert.equal(diff.uncertain.added.length, 0);
  assert.ok(diff.before.rosterComplete);
});

test('未解析数值的变化进入 uncertain 而非静默忽略', async () => {
  const base = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0AAAAAAAAAAAAAAAAAAAAA',$,'P',$,$,$,$,$,$);
#2=IFCBUILDINGSTOREY('0BBBBBBBBBBBBBBBBBBBBB',$,'一层',$,$,$,$,$,.ELEMENT.,0.);
#3=IFCPUMP('0CCCCCCCCCCCCCCCCCCCCC',$,'泵',$,$,$,$,'P-1',.CIRCULATOR.);
#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('0DDDDDDDDDDDDDDDDDDDDD',$,$,$,(#3),#2);
#5=IFCRELDEFINESBYPROPERTIES('0EEEEEEEEEEEEEEEEEEEEE',$,$,$,(#3),#6);
#6=IFCPROPERTYSET('0FFFFFFFFFFFFFFFFFFFFF',$,'参数',$,(#7));
#7=IFCPROPERTYSINGLEVALUE('未知量',$,IFCUSERDEFINEDMEASURE(5.),$);
ENDSEC;
END-ISO-10303-21;
`;
  // Point at the number inside the typed value only; replacing the literal
  // "VALUE" would also hit IFCPROPERTYSINGLEVALUE.
  const read = value => readLedger(base.replace('MEASURE(5.)', `MEASURE(${value})`));
  const diff = diffLedgers(read('6.'), read('7.'));
  assert.equal(diff.changed.length, 0);
  assert.equal(diff.uncertain.changed.length, 1);
  const entry = diff.uncertain.changed[0];
  assert.equal(entry.changes[0].label, '未知量');
  assert.equal(entry.changes[0].unresolved, true);
  assert.equal(entry.changes[0].before.raw, 6);
  assert.equal(entry.changes[0].after.raw, 7);
  assert.ok(entry.reasons.some(reason => reason.code === 'unknown-measure-dimension'));
});
