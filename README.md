# gtp-u-teid-lifecycle-validator

验证 GTP-U TEID、会话和隧道恢复状态。

> **声明：本项目中所有 GTP-U 报文（包括 T-PDU、Echo Request/Response、
> Error Indication 等）均为内存中的模拟事件，不构造、发送或接收任何真实
> 网络报文，也不监听任何 UDP 2152 端口。** 模拟器仅在时间片事件流上推演
> TEID 映射状态，用于验证生命周期逻辑。

## 背景

移动核心网发生路径切换（path switch）后，旧 GTP-U 节点可能仍保留 TEID
绑定，而新节点又分配了相同的 TEID 标识。在旧绑定清理完成之前，相同 TEID
在两个节点同时有效，下行报文可能被送到错误的承载。本工具按时间片重放
事件流，计算每个时间片的有效 TEID 映射，并输出冲突与清理顺序。

## 运行

需要 Node.js >= 24.16.0。

```sh
node --test
```

## 输入事件

每个事件携带时间片 `t`，通过 `TeidLifecycle.apply(event)` 或
`applyAll(events)` 注入：

| 事件 | 字段 | 说明 |
| --- | --- | --- |
| `endpoint.add` | `nodeId, address` | 注册隧道端点（UPF/SGW 等） |
| `session.create` | `sessionId, nodeId, bearerId, teid?` | 建立会话与承载，分配 TEID |
| `bearer.update` | `sessionId, bearerId, state` | 更新承载状态 |
| `echo.request` / `echo.response` / `echo.loss` | `nodeId` | 模拟 echo 探测、响应与丢失 |
| `path.switch` | `sessionId, bearerId, fromNodeId, toNodeId, teid?` | 路径切换，新节点分配 TEID，旧绑定转为 `stale` |
| `session.migrate` | `sessionId, fromNodeId, toNodeId` | 会话整体迁移，全部承载搬到新节点 |
| `teid.release` | `nodeId, teid, sessionId, bearerId` | 释放 TEID；echo 丢失期间会被推迟 |
| `packet` | `nodeId, teid, forSessionId, forBearerId` | 模拟下行报文按 TEID 寻址 |

## 输出

- `mappingAt(t)`：时间片 `t` 每个节点的有效 TEID → 承载映射。
- `conflicts()`：冲突隧道——同一 TEID 在不同节点同时有效的时间窗口
  （`from`/`to`）。
- `misdeliveries()`：误投报文，原因包括 `stale-binding`（命中旧节点残留
  绑定）、`wrong-bearer`（TEID 已被其他承载复用）、`no-binding`（释放后
  到达）。
- `releaseRaces()` / `orphanReleases()`：释放竞争（旧释放命中已复用的
  新绑定，被忽略）与孤儿释放（绑定已清理后晚到的释放）。
- `cleanupOrder()`：清理顺序，按时间片与优先级排序：
  `stop-forward` → `release` → `await-echo` → `reuse-allowed` /
  `defer-reuse`。

## 处理的竞态场景

- **TEID 重用**：释放的 TEID 回到节点分配池并被新承载复用；迟到的旧
  报文命中复用标识时被判定误投。
- **旧节点晚到**：旧节点的释放晚于 TEID 复用到达时，按会话/承载匹配
  识别为释放竞争，不会误删新绑定。
- **echo 丢失**：echo 丢失期间释放事件被推迟，冲突窗口拉长；echo 恢复
  后按到达顺序冲刷推迟的释放。
- **会话迁移**：会话全部承载迁移到新节点，旧节点绑定转为 `stale`，
  直到释放完成。

## 测试

`test/` 下使用 `node:test` 覆盖三类场景：

- `test/path-switch.test.js`：路径切换产生冲突隧道与误投、echo 丢失
  拉长冲突窗口、会话迁移。
- `test/teid-reuse.test.js`：TEID 复用导致误投、释放空窗期丢包、echo
  丢失期间的复用推迟确认。
- `test/release-race.test.js`：晚到释放不删新绑定、孤儿释放、echo
  恢复后按序冲刷。
