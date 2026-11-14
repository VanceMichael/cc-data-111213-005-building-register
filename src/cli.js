import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Archive } from './archive.js';
import { entityView, inspect, sample } from './domain.js';
import { deviceIndex, diffLedgers, ledgerRows, readLedger } from './ledger.js';

const [command = 'help', first, second] = process.argv.slice(2);

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function ledgerFor(file) {
  const path = resolve(file);
  return readLedger(await readFile(path, 'utf8'), { source: path });
}

async function run() {
  if (command === 'help') {
    print({
      usage: 'npm start -- <命令> [参数...]',
      commands: {
        inspect: 'inspect <资料路径>：现有 STEP 实体查看',
        entity: 'entity <资料路径> <STEP 编号>：单条实体及前后引用',
        ledger: 'ledger <资料路径> [GlobalId]：按 IFC4 关系网络领取设备台账',
        rows: 'rows <资料路径> [GlobalId]：台账的逐行视图，含来源行号',
        index: 'index <资料路径>：设备索引，只为选中的设备再展开细节',
        diff: 'diff <较早资料> <较晚资料>：两次移交的台账差异',
        capture: 'capture <资料路径> [归档目录]：保存来源字节',
        list: 'list [归档目录]：列出领取回执',
        demo: 'demo：读取本地合成资料并输出台账和差异',
      },
    });
  } else if (command === 'inspect') {
    if (!first) throw new Error('需要资料路径');
    print(await inspect(resolve(first)));
  } else if (command === 'entity') {
    if (!first || !second) throw new Error('需要资料路径和 STEP 编号');
    print(await entityView(resolve(first), Number(second)));
  } else if (command === 'ledger') {
    if (!first) throw new Error('需要资料路径');
    print(await ledgerFor(first));
  } else if (command === 'rows') {
    if (!first) throw new Error('需要资料路径');
    const ledger = await ledgerFor(first);
    print(ledgerRows(ledger, { deviceGlobalId: second || null }));
  } else if (command === 'index') {
    if (!first) throw new Error('需要资料路径');
    print(deviceIndex(await ledgerFor(first)));
  } else if (command === 'diff') {
    if (!first || !second) throw new Error('需要两份资料路径');
    const before = await ledgerFor(first);
    const after = await ledgerFor(second);
    print(diffLedgers(before, after));
  } else if (command === 'capture') {
    if (!first) throw new Error('需要资料路径');
    const path = resolve(first);
    const inventory = await inspect(path);
    const ledger = await ledgerFor(first);
    const receipt = await new Archive(second || '.local/archive').accept(
      await readFile(path),
      {
        source: path,
        inventory,
        ledger: {
          schema: ledger.schema,
          stats: ledger.stats,
          integrity: ledger.integrity,
        },
      },
    );
    print(receipt);
  } else if (command === 'list') {
    print(await new Archive(first || '.local/archive').receipts());
  } else if (command === 'demo') {
    const temporary = await mkdtemp(join(tmpdir(), 'intake-'));
    try {
      const ledgerA = await ledgerFor('fixtures/handover-a.ifc');
      const ledgerB = await ledgerFor('fixtures/handover-b.ifc');
      const ledgerC = await ledgerFor('fixtures/handover-c.ifc');
      const archive = new Archive(temporary);
      const receipt = await archive.accept(await readFile(sample), {
        source: sample,
        inventory: await inspect(resolve(sample)),
      });
      const verified = (await archive.read(receipt.sha256)).length;
      print({
        ledger: {
          source: ledgerA.source,
          stats: ledgerA.stats,
          integrity: ledgerA.integrity,
          units: ledgerA.unitContext,
          devices: ledgerA.devices.map(device => ({
            identity: device.identity,
            placement: device.placement,
            types: device.typeDefinitions.entries.map(entry => ({
              relationStepId: entry.relationStepId,
              typeStepId: entry.typeStepId,
              typeGlobalId: entry.typeGlobalId,
              typeName: entry.typeName,
            })),
            conflicts: device.conflicts,
            resolution: device.resolution,
            fields: device.fields,
          })),
          sameNameDevices: ledgerA.sameNameDevices,
          issues: ledgerA.issues,
        },
        diffs: {
          // A -> B: a genuine addition plus two disappearances that cannot
          // be called demolitions (one leaves a dangling relation, one had
          // an unresolved dependency in the earlier delivery).
          handoverAB: diffLedgers(ledgerA, ledgerB),
          // A -> C: two devices disappear with an intact later roster, so
          // they are reported as removed; #501 stays uncertain.
          handoverAC: diffLedgers(ledgerA, ledgerC),
        },
        archive: { receipt, verified },
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } else {
    throw new Error('支持 inspect、entity、ledger、rows、index、diff、capture、list、demo');
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
