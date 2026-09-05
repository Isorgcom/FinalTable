# LONICERA: A Poker Game · 主动审查清单 v1

> **Inherited from upstream.** Written for [LONICERA](https://github.com/Evostructs/LONICERA) before the FinalTable fork and kept unaltered as a record. It describes LONICERA, not FinalTable: names, commands and image paths in it are upstream's. See [FORK.md](../FORK.md).

> **Warning: this file is byte-corrupted upstream.** It arrived at the fork point with 152 invalid UTF-8 sequences (multi-byte characters replaced by `?`), so parts of the Chinese text are unrecoverable. Kept for reference only; prefer the v2 manual, which is intact.

> 审查范围：`main` 当前代码基线  
> 审查方式：静态代码审�?+ 当前测试基线核对  
> 审查日期�?026-04-11

---

## 当前基线

- 当前本地基线�?026-04-11 主动审查增量
- `npm run lint`：通过
- `npm test -- --silent`：通过
- `npm run test:browser`：通过
- 当前测试结果：`6` �?Jest 测试套件，`93` 个测试通过；`3` �?Playwright 浏览器用例通过

结论�?
- 本轮没有新确认的 **P0 / P1 / P2** 级静态问题�?- 上一轮主动审查里优先级最高的 7 项已经处理：
  - 服务端洗牌与核心座位随机改为 `crypto.randomInt()`
  - 前端资源版本号改为构建时哈希，不再手工常�?  - 服务端与引擎补了结构化日志骨�?  - Socket 入口层接入结构化日志
  - 现金局 round-end �?NPC 死分支已移除
  - 增加了最�?UI 冒烟回归
  - 增加了最�?Playwright 浏览器交互回�?
---

## 本轮已处�?
### 已处�?01：核心随机源

- **结果**�?  - [deck.js](/path/to/lonicera/deck.js) 已使�?`crypto.randomInt()` 驱动 Fisher-Yates
  - [engine.js](/path/to/lonicera/engine.js) 的开局前随机入座与自动行动延迟也改为统一随机模块
  - [random.js](/path/to/lonicera/random.js) 统一提供 `randomInt()` �?`randomId()`

### 已处�?02：前端资源版本自动化

- **结果**�?  - [server/asset-version.js](/path/to/lonicera/server/asset-version.js) 会根据核心前端资源计算哈�?  - [server.js](/path/to/lonicera/server.js) 运行时渲染首页模板，自动注入资源版本
  - [public/index.html](/path/to/lonicera/public/index.html) 不再依赖手工版本常量
  - [public/js/three-loader.js](/path/to/lonicera/public/js/three-loader.js) 也会读取同一版本号加载依�?
### 已处�?03：结构化日志

- **结果**�?  - [server/logger.js](/path/to/lonicera/server/logger.js) 新增 JSON 结构化日志工�?  - [server.js](/path/to/lonicera/server.js) 补了�?    - `server_started`
    - `preflop_table_*`
    - `save_restored`
    - `room_cleaned`
    - 全局异常日志
  - [engine.js](/path/to/lonicera/engine.js) 补了�?    - `player_joined`
    - `player_left`
    - `round_start`
    - `player_action`
    - `street_advance`
    - `round_end`
    - `equity_used`
    - `equity_rejected`

### 已处�?04：现金局 round-end 死分�?
- **结果**�?  - [server.js](/path/to/lonicera/server.js) 中“先过滤 busted NPC、再�?busted NPC”的矛盾分支已删�?  - 当前现金局语义已明确：桌上 busted NPC 直接移除，不再保留死代码

### 已处�?05：最�?UI 冒烟

- **结果**�?  - [__tests__/ui-smoke.test.js](/path/to/lonicera/__tests__/ui-smoke.test.js) 新增 2 条回归：
    - 首页必须返回当前模式反馈壳子和已渲染的资源版�?    - `/api/status` 必须在同一服务实例下正常返�?
### 已处�?06：Socket 入口层结构化日志

- **结果**�?  - [server/socket-handlers.js](/path/to/lonicera/server/socket-handlers.js) 已接入统一 JSON 日志�?  - 当前已覆盖：
    - `socket_connected`
    - `join_room`
    - `join_rejected`
    - `ready_toggled`
    - `autoplay_toggled`
    - `start_game`
    - `action_received`
    - `action_rejected`
    - `action_error`
    - `next_round_started`
    - `npc_added`
    - `npc_removed`
    - `chips_gifted`
    - `exit_game`
    - `game_restarted`
    - `tournament_started`
    - `game_saved`
    - `save_deleted`
    - `player_renamed`
    - `equity_requested`
    - `equity_rejected`
    - `equity_error`
    - `socket_disconnected`

### 已处�?07：最小浏览器交互回归

- **结果**�?  - [playwright.config.js](/path/to/lonicera/playwright.config.js) 新增浏览器回归配�?  - [e2e/lobby.spec.js](/path/to/lonicera/e2e/lobby.spec.js) 新增 3 �?Playwright 用例�?    - 模式切换反馈�?practice 配置解锁
    - 预设房间卡片与房间摘要联�?    - practice 直入牌桌路径
  - [package.json](/path/to/lonicera/package.json) 新增 `npm run test:browser`

---

## 剩余 P3

### P3-01 浏览器回归仍是“最小版”，还不是完整桌面流�?E2E

- **分类**：测试覆�?- **现状**�?  - 当前已补 HTML/API 层冒烟与基础 Playwright 用例
  - 但还没覆盖完整牌桌交互：
    - 房间进入/退出后的顶栏状态清�?    - 顶栏展开与水晶球避让
    - replay 打开
    - auto-play / resume
    - result modal / rematch / ready again
- **影响**�?  - 视觉/HCI 类问题仍主要靠真人试用发�?- **建议**�?  - 下一轮把 Playwright 扩展到“进�?�?开局 �?弹层/顶栏/退出”这一条完整路�?
### P3-02 文档仍需要跟随发布基线同步维�?
- **分类**：文档维�?- **现状**�?  - 本轮已经同步 README / SECURITY / 审查手册
  - 但测试数、部署流程、安全头、资源版本策略、Playwright 覆盖范围都属于容易漂移的信息
- **建议**�?  - 每次发布前至少核对：
    - 测试数量
    - NAS 更新命令
    - 资源版本策略
    - rate limit 与安全说�?    - 浏览器回归命令与覆盖范围

---

## 下一轮专项验�?
以下项目本轮没有静态确认成�?bug，但仍值得按真实路径压测：

1. **Cash / Tournament 多人长局**
   - 多手连打
   - 短码 all-in
   - host 断线转交

2. **Spectate / auto-play / resume**
   - 中途进�?   - spectator next-hand 入座
   - auto-play 切回手动

3. **Equity Oracle 边界**
   - 免费转付�?   - 不足筹码拒绝
   - 多手价格递进与免费次数重�?
4. **Replay 正确�?*
   - 上一手回�?   - 当前手已开始时回放上一�?   - showdown / 未发完公共牌两类手牌都核�?
---

## 建议执行顺序

1. 扩展 Playwright 到完整牌桌路�?2. 发布前文档核对清单固�?3. 继续清理 Jest worker 退出尾�?
这样下一轮工作就会从“补基础设施”转成“守体验细节”�?