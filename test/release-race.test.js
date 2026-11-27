import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeidLifecycle } from '../src/teid-lifecycle.js';

test('释放竞争：旧节点晚到的释放不得删除已复用的新绑定', () => {
  const sim = new TeidLifecycle();
  sim.applyAll([
    { t: 0, type: 'endpoint.add', nodeId: 'upf-1', address: '10.3.0.1' },
    { t: 1, type: 'session.create', sessionId: 'pdu-1', nodeId: 'upf-1', bearerId: 'b-1', teid: 7 },
    { t: 2, type: 'teid.release', nodeId: 'upf-1', teid: 7, sessionId: 'pdu-1', bearerId: 'b-1' },
    // TEID 7 被 pdu-2 复用
    { t: 3, type: 'session.create', sessionId: 'pdu-2', nodeId: 'upf-1', bearerId: 'b-1' },
    // pdu-1 的重复/晚到释放到达：必须被识别为竞争，不得删掉 pdu-2 的绑定
    { t: 4, type: 'teid.release', nodeId: 'upf-1', teid: 7, sessionId: 'pdu-1', bearerId: 'b-1' },
  ]);

  const races = sim.releaseRaces();
  assert.equal(races.length, 1);
  assert.equal(races[0].teid, 7);
  assert.deepEqual(races[0].stale, { sessionId: 'pdu-1', bearerId: 'b-1' });
  assert.deepEqual(races[0].current, { sessionId: 'pdu-2', bearerId: 'b-1' });

  // 新绑定仍然有效
  const mapping = sim.mappingAt(4).get('upf-1');
  assert.equal(mapping.get(7).sessionId, 'pdu-2');
  assert.equal(mapping.get(7).state, 'active');
});

test('释放竞争：绑定清理后晚到的释放记为孤儿释放', () => {
  const sim = new TeidLifecycle();
  sim.applyAll([
    { t: 0, type: 'endpoint.add', nodeId: 'upf-1', address: '10.3.0.1' },
    { t: 1, type: 'session.create', sessionId: 'pdu-1', nodeId: 'upf-1', bearerId: 'b-1', teid: 21 },
    { t: 2, type: 'teid.release', nodeId: 'upf-1', teid: 21, sessionId: 'pdu-1', bearerId: 'b-1' },
    // 同一释放被旧节点重传，此时绑定已不存在
    { t: 5, type: 'teid.release', nodeId: 'upf-1', teid: 21, sessionId: 'pdu-1', bearerId: 'b-1' },
  ]);

  const orphans = sim.orphanReleases();
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].t, 5);
  assert.equal(orphans[0].teid, 21);
  // 孤儿释放不产生新的清理动作
  assert.equal(sim.cleanupOrder().filter((c) => c.action === 'release').length, 1);
});

test('释放竞争：echo 丢失期间的释放在恢复前不生效，恢复后按序冲刷', () => {
  const sim = new TeidLifecycle();
  sim.applyAll([
    { t: 0, type: 'endpoint.add', nodeId: 'upf-1', address: '10.3.0.1' },
    { t: 1, type: 'session.create', sessionId: 'pdu-1', nodeId: 'upf-1', bearerId: 'b-1', teid: 30 },
    { t: 1, type: 'session.create', sessionId: 'pdu-2', nodeId: 'upf-1', bearerId: 'b-1', teid: 31 },
    { t: 2, type: 'echo.loss', nodeId: 'upf-1' },
    // echo 丢失期间两个释放都被推迟
    { t: 3, type: 'teid.release', nodeId: 'upf-1', teid: 30, sessionId: 'pdu-1', bearerId: 'b-1' },
    { t: 4, type: 'teid.release', nodeId: 'upf-1', teid: 31, sessionId: 'pdu-2', bearerId: 'b-1' },
  ]);

  // 释放未生效，两个 TEID 均仍有效
  const during = sim.mappingAt(4).get('upf-1');
  assert.equal(during.size, 2);

  // echo 恢复，推迟的释放按到达顺序冲刷
  sim.apply({ t: 5, type: 'echo.response', nodeId: 'upf-1' });
  const after = sim.mappingAt(5).get('upf-1');
  assert.equal(after.size, 0);

  const releases = sim.cleanupOrder().filter((c) => c.action === 'release');
  assert.deepEqual(releases.map((r) => r.teid), [30, 31]);
  // 清理顺序中 await-echo 必须先于 release
  const actions = sim.cleanupOrder().map((c) => c.action);
  assert.ok(actions.indexOf('await-echo') < actions.indexOf('release'));
});
