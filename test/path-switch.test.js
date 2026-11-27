import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeidLifecycle } from '../src/teid-lifecycle.js';

test('路径切换：新旧节点持有相同 TEID 时产生冲突隧道与误投报文', () => {
  const sim = new TeidLifecycle();
  sim.applyAll([
    { t: 0, type: 'endpoint.add', nodeId: 'upf-old', address: '10.0.0.1' },
    { t: 0, type: 'endpoint.add', nodeId: 'upf-new', address: '10.0.0.2' },
    { t: 1, type: 'session.create', sessionId: 'pdu-1', nodeId: 'upf-old', bearerId: 'b-5', teid: 100 },
    // 切换路径：新节点恰好分配到相同 TEID 值 100
    { t: 2, type: 'path.switch', sessionId: 'pdu-1', bearerId: 'b-5', fromNodeId: 'upf-old', toNodeId: 'upf-new', teid: 100 },
  ]);

  // t=2 时间片：两个节点都把 TEID 100 映射为有效，但旧节点已 stale
  const mapping = sim.mappingAt(2);
  assert.equal(mapping.get('upf-old').get(100).state, 'stale');
  assert.equal(mapping.get('upf-new').get(100).state, 'active');

  // 旧节点释放前的下行报文被误投到旧承载
  sim.apply({ t: 3, type: 'packet', nodeId: 'upf-old', teid: 100, forSessionId: 'pdu-1', forBearerId: 'b-9' });
  const mis = sim.misdeliveries();
  assert.equal(mis.length, 1);
  assert.equal(mis[0].reason, 'stale-binding');
  assert.equal(mis[0].actual.bearerId, 'b-5');

  // 冲突隧道在旧节点释放后关闭
  sim.apply({ t: 4, type: 'teid.release', nodeId: 'upf-old', teid: 100, sessionId: 'pdu-1', bearerId: 'b-5' });
  const conflicts = sim.conflicts();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].teid, 100);
  assert.deepEqual(
    conflicts[0].tunnels.map((x) => x.nodeId).sort(),
    ['upf-new', 'upf-old'],
  );
  assert.equal(conflicts[0].from, 2);
  assert.equal(conflicts[0].to, 4);

  // 清理顺序：先 stop-forward，再 release，最后允许重用
  const actions = sim.cleanupOrder().map((c) => c.action);
  assert.deepEqual(actions, ['stop-forward', 'release', 'reuse-allowed']);

  // 释放后旧节点不再持有 TEID 100
  assert.equal(sim.mappingAt(4).get('upf-old').has(100), false);
});

test('路径切换：echo 丢失推迟旧节点清理，冲突窗口被拉长', () => {
  const sim = new TeidLifecycle();
  sim.applyAll([
    { t: 0, type: 'endpoint.add', nodeId: 'upf-old', address: '10.0.0.1' },
    { t: 0, type: 'endpoint.add', nodeId: 'upf-new', address: '10.0.0.2' },
    { t: 1, type: 'session.create', sessionId: 'pdu-1', nodeId: 'upf-old', bearerId: 'b-5', teid: 42 },
    { t: 2, type: 'path.switch', sessionId: 'pdu-1', bearerId: 'b-5', fromNodeId: 'upf-old', toNodeId: 'upf-new', teid: 42 },
    // 旧节点 echo 丢失：控制面无法确认释放送达
    { t: 3, type: 'echo.loss', nodeId: 'upf-old' },
    // 释放事件在 echo 丢失期间到达，应被推迟而非生效
    { t: 4, type: 'teid.release', nodeId: 'upf-old', teid: 42, sessionId: 'pdu-1', bearerId: 'b-5' },
  ]);

  // 释放被推迟，旧绑定仍然存在，冲突仍未关闭
  assert.equal(sim.mappingAt(4).get('upf-old').has(42), true);
  assert.equal(sim.conflicts()[0].to, null);
  assert.ok(sim.cleanupOrder().some((c) => c.action === 'await-echo' && c.nodeId === 'upf-old'));

  // echo 恢复后，推迟的释放被冲刷，冲突关闭
  sim.apply({ t: 6, type: 'echo.response', nodeId: 'upf-old' });
  assert.equal(sim.mappingAt(6).get('upf-old').has(42), false);
  assert.equal(sim.conflicts()[0].to, 6);
});

test('会话迁移：全部承载搬到新节点，旧节点绑定转为 stale', () => {
  const sim = new TeidLifecycle();
  sim.applyAll([
    { t: 0, type: 'endpoint.add', nodeId: 'upf-a', address: '10.1.0.1' },
    { t: 0, type: 'endpoint.add', nodeId: 'upf-b', address: '10.1.0.2' },
    { t: 1, type: 'session.create', sessionId: 'pdu-1', nodeId: 'upf-a', bearerId: 'b-1', teid: 11 },
    { t: 1, type: 'session.create', sessionId: 'pdu-1', nodeId: 'upf-a', bearerId: 'b-2', teid: 12 },
    { t: 2, type: 'session.migrate', sessionId: 'pdu-1', fromNodeId: 'upf-a', toNodeId: 'upf-b' },
  ]);

  const mapping = sim.mappingAt(2);
  assert.equal(mapping.get('upf-a').get(11).state, 'stale');
  assert.equal(mapping.get('upf-a').get(12).state, 'stale');
  // 新节点为两个承载各分配了一个有效 TEID
  const newTable = mapping.get('upf-b');
  assert.equal(newTable.size, 2);
  for (const binding of newTable.values()) {
    assert.equal(binding.sessionId, 'pdu-1');
    assert.equal(binding.state, 'active');
  }

  // 迁移后到达旧节点的报文被误投
  sim.apply({ t: 3, type: 'packet', nodeId: 'upf-a', teid: 11, forSessionId: 'pdu-1', forBearerId: 'b-2' });
  assert.equal(sim.misdeliveries()[0].reason, 'stale-binding');

  // 旧节点完成释放后映射清空
  sim.applyAll([
    { t: 4, type: 'teid.release', nodeId: 'upf-a', teid: 11, sessionId: 'pdu-1', bearerId: 'b-1' },
    { t: 4, type: 'teid.release', nodeId: 'upf-a', teid: 12, sessionId: 'pdu-1', bearerId: 'b-2' },
  ]);
  assert.equal(sim.mappingAt(4).get('upf-a').size, 0);
});
