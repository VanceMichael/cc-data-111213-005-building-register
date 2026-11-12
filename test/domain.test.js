import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, sample } from '../src/domain.js';
import { splitStepArguments } from '../src/domain.js';

test('既有资料查看与本地来源符合领域约定', async () => {
  const result = await inspect(sample);
  assert.equal(result.entities.find(entity => entity.id === 11).type, 'IFCPUMP');
  assert.deepEqual(splitStepArguments("'a,b',(#1,#2),IFCLABEL('x''y')"), ["'a,b'", '(#1,#2)', "IFCLABEL('x''y')"]);
  assert.throws(() => splitStepArguments("'未结束"), /未闭合/);
});
