# LONICERA: A Poker Game · 全面审查手册 v2

> **Inherited from upstream.** Written for [LONICERA](https://github.com/Evostructs/LONICERA) before the FinalTable fork and kept unaltered as a record. It describes LONICERA, not FinalTable: names, commands and image paths in it are upstream's. See [FORK.md](../FORK.md).

> 审查目标：不再被用户反馈牵着走，而是按系统化标准主动审查当前主干代码，优先拦截规则错误、状态串线、前后端不同步和 NAS 部署失真。
>
> 适用版本：截至 2026-04-11 的 `main` 分支（已包含 auto-play、spectate、rematch-ready、Equity Oracle、固定房间 lobby、bilingual 房间名、practice 特殊规则、预发牌随机座位等）
>
> 生成日期：2026-04-11

---

## 目录

1. [审查层级总览](#1-审查层级总览)
2. [第一层：核心不变量](#2-第一层核心不变量)
3. [第二层：状态机完整性](#3-第二层状态机完整性)
4. [第三层：真实用户路径场景测试](#4-第三层真实用户路径场景测试)
5. [第四层：前端交互审计](#5-第四层前端交互审计)
6. [第五层：并发与时序](#6-第五层并发与时序)
7. [第六层：安全与反作弊](#7-第六层安全与反作弊)
8. [第七层：日志与可观测性](#8-第七层日志与可观测性)
9. [第八层：引擎-前端同步一致性](#9-第八层引擎-前端同步一致性)
10. [严重级别定义与分类规则](#10-严重级别定义与分类规则)
11. [审查执行流程](#11-审查执行流程)
12. [问题清单模板](#12-问题清单模板)
13. [附录 D：当前代码基线与新增审查重点](#附录-d当前代码基线与新增审查重点)
14. [附录 E：NAS 部署与前端版本核验](#附录-enas-部署与前端版本核验)

---

## 1. 审查层级总览

```
┌──────────────────────────────────────────────────────────────┐
│  L1  核心不变量        — 任何时刻都不能违反的数学/规则硬约束    │
│  L2  状态机完整性      — 所有状态转移必须有明确定义和防护        │
│  L3  真实路径场景测试  — 模拟真实玩家操作序列验证端到端正确性    │
│  L4  前端交互审计      — 按钮/overlay/提示文案与真实行为一致性   │
│  L5  并发与时序        — 断连/竞态/动画队列/计时器边界          │
│  L6  安全与反作弊      — WebSocket伪造/DevTools篡改/信息泄露    │
│  L7  日志与可观测性    — 关键事件是否有结构化日志可供复盘        │
│  L8  引擎-前端同步     — 双方对同一状态的理解是否一致            │
└──────────────────────────────────────────────────────────────┘
```

**原则：每一层发现的问题都要标注严重级别（P0/P1/P2/P3），高优先级问题在审查过程中直接修复。**

### 1.1 当前审查基线

本手册不再按早期 v3 思路审查，而是以当前主干功能为基线：

- 三种模式：`Cash Game` / `Tournament` / `Practice`
- `Practice` 模式允许调 `NPC / Chips / Blind`，但 **至少 1 个 NPC**
- 房间模型为固定预设房间；中途加入的人类玩家会 **spectate 本手，next hand 再入座**
- 房主权限、`Ready Again` / `Play Again` rematch 流程已存在
- `auto-play / resume`、断线自动托管、resume 误触保护已存在
- Equity Oracle 规则已改为：
  - **翻牌前不可用**
  - `Practice` 在 flop 之后免费
  - `Cash / Tournament` 每手前三次免费，之后按 `20 → 40 → 80 → ...` 付费
  - 服务端硬拦截透支
- 房间重连依赖 **session token**，不接受“同名顶号”
- 开局前座位已改成 **随机落座但一旦 Deal 后不再重新洗座位**
- 目前前端资源带版本号；NAS 更新时应当把部署副本 **强制对齐远端**
- 当前自动化基线约为 **5 个测试文件、100+ 条 Jest 用例**；但这些用例仍不足以覆盖全部真实视觉/交互路径

---

## 2. 第一层：核心不变量

核心不变量 = 无论游戏处于什么状态，以下断言必须恒真。任何一条被违反即为 P0 级 bug。

### 2.1 筹码守恒

| 编号 | 不变量 | 检查方法 |
|------|--------|----------|
| INV-01 | 任何时刻，所有玩家筹码 + pot + 边池总额 = 游戏开始时总筹码 | 在每次 action 处理后断言 `sumAllStacks() + pot + sidePots === initialTotal` |
| INV-02 | 任何玩家筹码不得为负数 | 断言 `player.stack >= 0` 始终成立 |
| INV-03 | pot 不得为负数 | 断言 `pot >= 0` |
| INV-04 | all-in 后玩家 stack 必须恰好为 0 | 处理 all-in 后断言 `player.stack === 0` |
| INV-05 | 一手结束时，pot 必须完全分配完毕（pot === 0） | showdown/所有人fold后断言 `pot === 0 && allSidePots.every(sp => sp.amount === 0)` |

### 2.2 行动合法性

| 编号 | 不变量 | 检查方法 |
|------|--------|----------|
| INV-06 | `call` 必须使当前玩家本街投入 = 当前最高投注（或 all-in） | 断言 `player.streetBet === currentBet || player.stack === 0` |
| INV-07 | `raise` 金额 ≥ 上一次加注增量（min-raise规则），除非 all-in | 断言 `raiseAmount >= lastRaiseIncrement || player.stack === 0` |
| INV-08 | `fold` 的玩家不能出现在后续行动轮次中 | 断言 folded 玩家不在 `activePlayers` 中 |
| INV-09 | 已 all-in 的玩家不应收到行动请求 | 断言 all-in 玩家不会进入 `getNextActor()` 的返回值 |
| INV-10 | 无效 raise（金额不足、语法错误）不能伪装为有效动作静默执行 | 必须抛出错误或降级为 call/fold 并通知前端 |

### 2.3 发牌与牌堆

| 编号 | 不变量 | 检查方法 |
|------|--------|----------|
| INV-11 | 一副牌 52 张，不重复 | 每局开始断言 `new Set(deck).size === 52` |
| INV-12 | 已发出的手牌 + 公共牌 + 剩余牌堆 = 52 | 任何发牌操作后断言 |
| INV-13 | 不同玩家的手牌不重叠、与公共牌不重叠 | 断言所有已发出牌无重复 |
| INV-14 | 洗牌必须保持 52 张无重复且服务端执行；当前实现使用 Fisher-Yates + `crypto.randomInt()`，如需更高对抗级别再评估更完整随机性策略 | 代码审查 |

### 2.4 付费/免费边界（水晶球 Equity）

| 编号 | 不变量 | 检查方法 |
|------|--------|----------|
| INV-15 | 翻牌前（preflop）查询 equity 必须被拒绝，且不消耗任何免费次数/筹码 | 测试用例：preflop 查 10 次，`freeLeft`、`priceLevel`、stack 不变 |
| INV-16 | `Practice` 模式 flop 之后 equity 免费且不限次，不允许走付费路径 | 测试用例：practice 模式连续查询多次，cost 始终为 0 |
| INV-17 | `Cash / Tournament` 每手开始时 `freeLeft` 必须重置为 3，但 `priceLevel` 应按规则保留/衰减，不得乱跳 | 跨两手牌连续测试 |
| INV-18 | 免费次数用完后，价格阶梯严格按 20→40→80 递增，且服务端返回的 `priceLevel` 为唯一真值 | 测试用例：连续购买 3 次，验证扣款和 priceLevel |
| INV-19 | 买不起 equity 时必须被拒绝，且不得出现“弹窗可买、扣成负数、价格继续上涨” | 断言 `chips`、`priceLevel` 都不变 |
| INV-20 | equity 查询不得泄露 NPC 底牌（仅基于公开信息 + 自己手牌计算） | 代码审查 equity 计算的输入参数 |

---

## 3. 第二层：状态机完整性

### 3.1 需要维护的状态转移表

以下每一个状态域都需要一张明确的状态转移表（state transition table），列出所有合法转移和触发条件。

#### 3.1.1 游戏模式状态

```
┌──────────┐    开始游戏    ┌──────────┐    结束/退出    ┌──────────┐
│  lobby   │ ──────────── > │ running  │ ──────────── > │ gameOver │
└──────────┘                └──────────┘                └──────────┘
      │                          │                           │
      │                          v                           │
      │                    ┌──────────┐                      │
      │                    │  paused  │                      │
      │                    └──────────┘                      │
      │                          │                           │
      └──────── rematch ─────────┴───────── rematch ─────────┘
```

**检查项：**

| 编号 | 检查点 | 状态 |
|------|--------|------|
| SM-01 | `lobby → running` 的触发条件和前置校验（座位数、筹码数） | ☐ |
| SM-02 | `running → paused` 和 `paused → running` 的双向转移 | ☐ |
| SM-03 | `running → gameOver` 的所有触发路径（筹码归零 / 主动退出 / 断线超时） | ☐ |
| SM-04 | `gameOver → lobby`（rematch）的状态重置是否完整（pot、牌堆、计时器、边池全部清零） | ☐ |
| SM-05 | 任何非法转移（如 `gameOver → running` 跳过 lobby）是否被拦截 | ☐ |

#### 3.1.2 游戏类型状态

```
practice ←→ cash ←→ tournament
```

**检查项：**

| 编号 | 检查点 | 状态 |
|------|--------|------|
| SM-06 | 三种模式的差异点是否有统一配置表（盲注结构、买入规则、重购规则） | ☐ |
| SM-07 | 切换模式时是否强制结束当前牌局 | ☐ |
| SM-08 | practice 模式的特殊规则（至少 1 NPC、可调起始筹码/盲注、equity flop 后免费、speed/pause 可用）是否正确隔离 | ☐ |
| SM-08a | `practice` 与非 practice 之间切换时，room 选择、锁定配置、遗留 lobby 状态是否完全清理 | ☐ |

#### 3.1.3 街（Street）状态

```
preflop → flop → turn → river → showdown
```

**检查项：**

| 编号 | 检查点 | 状态 |
|------|--------|------|
| SM-09 | 每条街转移时是否正确重置：本街投注计数、行动标记、当前最高注 | ☐ |
| SM-10 | 所有人 fold 只剩一人时是否直接跳到结算（不经过后续街） | ☐ |
| SM-11 | 所有活跃玩家 all-in 时是否自动发完剩余公共牌 | ☐ |
| SM-12 | 从任意街到 showdown 的转移条件是否严格（不会提前/延迟触发） | ☐ |

#### 3.1.4 玩家行动状态

```
waiting → acting → acted → folded / allIn
```

**检查项：**

| 编号 | 检查点 | 状态 |
|------|--------|------|
| SM-13 | `waiting → acting` 的轮转顺序是否正确（按座位顺序、跳过 folded/allIn） | ☐ |
| SM-14 | BB 在无人加注时的特殊 check/raise 权利（option）是否实现 | ☐ |
| SM-15 | heads-up（单挑）时盲注和行动顺序是否符合 TDA 规则（SB=Button 先行动） | ☐ |
| SM-16 | 一街内的行动终止条件：所有未 fold/allIn 玩家都已行动且投注额一致 | ☐ |

#### 3.1.5 Auto-play / 观战状态

```
manual ←→ autoPlay
spectate ←→ playing
```

**检查项：**

| 编号 | 检查点 | 状态 |
|------|--------|------|
| SM-17 | auto-play → manual 切换时，如果当前轮到该玩家行动，行动权是否正确移交 | ☐ |
| SM-18 | auto-play 模式下的决策逻辑（fold/check/call 策略）是否可配置且不会卡死 | ☐ |
| SM-19 | spectate 模式下能否看到任何玩家的底牌（必须不能） | ☐ |
| SM-20 | spectate → join 时的座位分配、筹码初始化是否正确 | ☐ |
| SM-20a | `resume` 后的误触保护是否生效，是否会把紧接着的一次点击误判成 `Play Again / Start Practice` | ☐ |

#### 3.1.6 UI Overlay 状态

```
none ←→ resultModal
none ←→ pauseOverlay
none ←→ roundOverlay
none ←→ equityPanel
```

**检查项：**

| 编号 | 检查点 | 状态 |
|------|--------|------|
| SM-21 | 任意两个 overlay 是否可能同时显示（不应该） | ☐ |
| SM-22 | overlay 显示期间底层游戏逻辑是否被正确暂停/阻塞 | ☐ |
| SM-23 | overlay 关闭后游戏状态是否正确恢复 | ☐ |
| SM-24 | 快速操作导致 overlay 还没关闭就触发下一个 overlay 的情况 | ☐ |
| SM-25 | 游戏内统一 app dialogs（改名、删档、付费确认、锦标赛时间、赠送筹码）是否都走同一套生命周期，而非混用原生 alert/confirm/prompt | ☐ |

---

## 4. 第三层：真实用户路径场景测试

每个场景必须端到端执行，不是单元测试层面的函数调用。

### 4.1 基础牌局流程

| 编号 | 场景 | 验证要点 |
|------|------|----------|
| PATH-01 | Cash 模式：一手完整走到 river/showdown（无 all-in） | 每条街的 pot 累加正确、公共牌数量正确（0→3→4→5）、winner 判定正确、筹码分配正确 |
| PATH-02 | Cash 模式：翻牌前所有人 fold 到 BB | BB 直接赢得 pot（仅盲注）、不发公共牌 |
| PATH-03 | Cash 模式：flop 后一人 bet 其余全 fold | 下注者赢得 pot、不发 turn/river |
| PATH-04 | 多人 showdown 比牌 | 牌力比较正确（同花 > 顺子 > 三条等）、平局时 pot 平分、奇数筹码处理 |
| PATH-04a | 开局前多人加入同一房间 | 座位顺序应已随机化，但点击 `Deal` 后不再重新洗位置 |

### 4.2 All-in 与边池

| 编号 | 场景 | 验证要点 |
|------|------|----------|
| PATH-05 | 短码玩家 preflop all-in（筹码 < BB） | 正确创建边池、其余玩家继续在主池行动 |
| PATH-06 | 两个不同筹码量的玩家先后 all-in | 正确创建多个边池、每个边池参与者列表正确 |
| PATH-07 | All-in 后剩余玩家继续行动到 river | 边池金额不变、主池继续累加 |
| PATH-08 | 边池分配：短码 all-in 者赢了 | 只能赢自己参与的边池、剩余边池分配给其他 winner |
| PATH-09 | 边池分配：短码 all-in 者输了 | 边池归赢家、验证筹码守恒 |

### 4.3 NPC 行为

| 编号 | 场景 | 验证要点 |
|------|------|----------|
| PATH-10 | NPC 连续行动（玩家 fold 后剩余全 NPC） | NPC 之间能正常完成整手牌、不卡死、不死循环 |
| PATH-11 | NPC raise → 玩家 re-raise → NPC 决策 | NPC 对 re-raise 的响应合理（不总是 fold、不总是 call） |
| PATH-12 | NPC 在短码时的 all-in 决策 | NPC 会在合适时候 all-in 而非永远 fold |
| PATH-13 | NPC 的 rangeWeightedMC 计算 | 验证分母修复后的计算结果合理、不出现 NaN/Infinity |
| PATH-13a | NPC vs NPC 后续街连续行动 | 不得出现 `call` 文案出现但 `streetBet/pot` 不增加的 0-call 卡死 |
| PATH-13b | 短码 raise 不够最小加注 | 必须收口成 `all-in` 或 `call/check`，不能出现假 raise |

### 4.4 Auto-play / Resume

| 编号 | 场景 | 验证要点 |
|------|------|----------|
| PATH-14 | 开启 auto-play，观察 3 手牌 | auto 模式决策合理、UI 显示 auto 状态、筹码变化正确 |
| PATH-15 | auto-play 中途切回 manual | 行动权正确交回、当前手牌状态正确、UI 切换无残留 |
| PATH-16 | 在行动中切换 auto（轮到自己时点 auto） | 当前这手是 auto 决策还是等手动？行为是否明确 |
| PATH-16a | 挂机触发 auto-play 后点击 `resume` | 倒计时回到正确座位、不会误触发 `Start Practice / Play Again` |

### 4.5 进出房间

| 编号 | 场景 | 验证要点 |
|------|------|----------|
| PATH-17 | 牌局中退出房间再进入 | 筹码正确、手牌正确、pot 正确、座位正确 |
| PATH-18 | 牌局中刷新浏览器 | 同上 |
| PATH-19 | 牌局中断网 10 秒再恢复 | WebSocket 重连、状态同步、行动权恢复 |
| PATH-20 | gameOver 后 rematch | 所有状态完全重置、盲注/button 位置正确移动 |
| PATH-21 | practice 模式 restart | 筹码重置到初始值、牌局计数器是否重置 |
| PATH-21a | 退出旧房间后进入新房间 | 右上角实时信息、mode badge、ticker、锦标赛横幅、日志展开状态不得残留上一个房间内容 |

### 4.6 Equity 水晶球

| 编号 | 场景 | 验证要点 |
|------|------|----------|
| PATH-22 | Preflop 查询 equity 多次 | 必须被锁住，不消耗免费次数、不扣钱、不涨价 |
| PATH-23 | Flop/Turn/River 各查一次 equity | 免费次数正确递减 |
| PATH-24 | 免费次数耗尽后继续查询 | 每次付费都弹确认，价格正确（20→40→80） |
| PATH-25 | 购买 equity 后查询 | 扣款正确、次数正确、结果正确显示 |
| PATH-26 | equity 结果中 NPC 显示为范围而非精确手牌 | 不泄露 NPC 底牌 |
| PATH-27 | 当前筹码小于本次价格时尝试购买 | 必须被拒绝，且 `chips/freeLeft/priceLevel` 全部不变 |

---

## 5. 第四层：前端交互审计

不看样式，只看行为正确性。

### 5.1 按钮状态

| 编号 | 检查点 | 状态 |
|------|--------|------|
| UI-01 | 非自己行动回合时，fold/check/call/raise 按钮是否禁用（不仅是视觉灰色，onclick 也无效） | ☐ |
| UI-02 | gameOver 状态下，行动按钮是否完全隐藏/禁用 | ☐ |
| UI-03 | paused 状态下，行动按钮是否禁用 | ☐ |
| UI-04 | raise 按钮在 stack 不足最小加注时是否禁用 | ☐ |
| UI-05 | all-in 按钮在 stack=0 时是否禁用（已经 all-in 了） | ☐ |
| UI-06 | 快速连点 raise 按钮是否会重复提交（需要 debounce 或 loading 锁） | ☐ |
| UI-06a | 翻牌前水晶球按钮是否明确表现为不可用（禁用态/提示态），而不是“可点但悄悄浪费次数” | ☐ |

### 5.2 Overlay 穿透

| 编号 | 检查点 | 状态 |
|------|--------|------|
| UI-07 | result modal 显示时，底层行动按钮是否可点击（不应该） | ☐ |
| UI-08 | pause overlay 显示时，是否能通过 Tab 键聚焦到底层元素 | ☐ |
| UI-09 | equity panel 打开时，是否阻止了牌局行动（应该不阻止，但行动按钮不应被遮挡） | ☐ |
| UI-10 | 多个 overlay 快速触发时是否有 z-index 冲突 | ☐ |
| UI-10a | 右上实时信息栏展开后，是否与 equity 水晶球、聊天气泡、锦标赛 banner 相互遮挡 | ☐ |

### 5.3 提示文案一致性

| 编号 | 检查点 | 状态 |
|------|--------|------|
| UI-11 | "Call X" 按钮上显示的金额 = 实际需要补的差额（不是总投注额） | ☐ |
| UI-12 | "Raise to X" 的最小值 = 上次加注额 + 当前最高注（min-raise） | ☐ |
| UI-13 | "All-in X" 显示的金额 = 玩家剩余全部筹码 | ☐ |
| UI-14 | pot 显示值 = 本街所有人已投入 + 之前街累计（实时更新） | ☐ |
| UI-15 | 胜利/失败结算文案中的金额 = 实际筹码变化 | ☐ |
| UI-15a | `raise` 的提示文案必须明确区分 `to X` 与 `+Y`，不能让玩家误解总额/追加额 | ☐ |
| UI-15b | replay / 结果弹窗 / 实时消息中的西方 NPC 公开名应使用英文显示名 | ☐ |

### 5.4 滑块与输入

| 编号 | 检查点 | 状态 |
|------|--------|------|
| UI-16 | raise 滑块的最小值 = min-raise、最大值 = 玩家 stack | ☐ |
| UI-17 | 手动输入 raise 金额：负数 → 拒绝 | ☐ |
| UI-18 | 手动输入 raise 金额：小数 → 向下取整或拒绝 | ☐ |
| UI-19 | 手动输入 raise 金额：超过 stack → 自动 cap 为 all-in | ☐ |
| UI-20 | 手动输入 raise 金额：非数字字符 → 拒绝 | ☐ |
| UI-21 | 练习模式空名时，是否仅用红框 + 聚焦引导，不再弹原生对话框打断 | ☐ |
| UI-22 | mode feedback 文案和模式切换后的实际 CTA 是否同步变化，不能只变顶部按钮颜色 | ☐ |

---

## 6. 第五层：并发与时序

### 6.1 WebSocket 断连

| 编号 | 检查点 | 状态 |
|------|--------|------|
| CONC-01 | 断连后自动重连机制是否存在（指数退避？） | ☐ |
| CONC-02 | 重连后是否请求完整状态快照（而非依赖增量消息） | ☐ |
| CONC-03 | 断连期间如果轮到该玩家行动，超时处理是否正确（auto-fold？） | ☐ |
| CONC-04 | 重连后手牌/pot/公共牌/座位/行动权全部正确 | ☐ |

### 6.2 计时器竞态

| 编号 | 检查点 | 状态 |
|------|--------|------|
| CONC-05 | 计时器到期瞬间玩家提交了操作 → 以哪个为准？是否有锁？ | ☐ |
| CONC-06 | 计时器到期后的 auto-action（fold/check）是否只执行一次 | ☐ |
| CONC-07 | 切街时旧计时器是否被清除（不会在新街触发旧的超时） | ☐ |
| CONC-08 | pause 状态下计时器是否暂停（不会在暂停中超时） | ☐ |
| CONC-08a | 计时器 UI 是否始终挂在**当前行动玩家**座位上，而不是前一个/下一个玩家 | ☐ |

### 6.3 动画与逻辑同步

| 编号 | 检查点 | 状态 |
|------|--------|------|
| CONC-09 | NPC 连续 fold 时，动画队列是否顺序执行（不叠加、不跳过） | ☐ |
| CONC-10 | 发牌动画未完成时，逻辑层是否已经允许行动（应该等动画完成） | ☐ |
| CONC-11 | showdown 翻牌动画和结算弹窗的时序是否正确（先翻牌 → 再弹窗） | ☐ |
| CONC-12 | 快速模式（跳过动画）下逻辑是否完全正确 | ☐ |

---

## 7. 第六层：安全与反作弊

### 7.1 WebSocket 消息安全

| 编号 | 检查点 | 状态 |
|------|--------|------|
| SEC-01 | 客户端能否发送伪造的 action 消息冒充其他玩家 | ☐ |
| SEC-02 | 客户端能否发送非法 action（如不到自己行动时发 raise） | ☐ |
| SEC-03 | WebSocket 消息是否有 session token 校验（v3 应该已有） | ☐ |
| SEC-04 | 消息频率限制（rate limiting）是否生效 | ☐ |
| SEC-05 | 连接数限制（同 IP / 同用户）是否生效 | ☐ |
| SEC-05a | 仅凭玩家名字是否可以抢占他人会话（当前应当不能，必须依赖 session token） | ☐ |

### 7.2 信息泄露

| 编号 | 检查点 | 状态 |
|------|--------|------|
| SEC-06 | WebSocket 广播消息中是否包含其他玩家的底牌（showdown 前不应该） | ☐ |
| SEC-07 | 服务端发给客户端的状态快照是否过滤了敏感信息（其他玩家手牌、牌堆顺序） | ☐ |
| SEC-08 | equity API 的响应中是否可推断 NPC 底牌 | ☐ |
| SEC-09 | 错误消息/日志是否泄露了内部状态（stack trace、牌堆内容） | ☐ |

### 7.3 客户端篡改

| 编号 | 检查点 | 状态 |
|------|--------|------|
| SEC-10 | 通过 DevTools 修改本地 stack 显示后，发送 action 是否使用服务端的 stack 值 | ☐ |
| SEC-11 | 通过 DevTools 修改手牌显示后，showdown 比牌是否使用服务端数据 | ☐ |
| SEC-12 | 项目当前**默认不启用** CSP / HSTS / Helmet 强制 HTTPS；必须确认没有意外重新引入会破坏 NAS HTTP 部署的头 | ☐ |
| SEC-13 | 当前轻量安全头（`X-Frame-Options`、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`）是否仍在 | ☐ |

### 7.4 随机性

| 编号 | 检查点 | 状态 |
|------|--------|------|
| SEC-14 | 洗牌算法是否为 Fisher-Yates（当前实现是） | ☑ |
| SEC-15 | 当前实现是否使用服务端 `crypto.randomInt()` 作为核心随机源 | ☑ |
| SEC-16 | 洗牌在服务端执行（客户端无法影响） | ☑ |

---

## 8. 第七层：日志与可观测性

### 8.1 必须记录的事件

| 编号 | 事件 | 需要记录的字段 | 状态 |
|------|------|----------------|------|
| LOG-01 | 新牌局开始 | gameId, players, stacks, blinds, button位置, 时间戳 | ☑ |
| LOG-02 | 发牌 | gameId, street, cards（仅服务端日志，不暴露给客户端） | ☑ |
| LOG-03 | 玩家行动 | gameId, playerId, action, amount, pot变化, 时间戳 | ☑ |
| LOG-04 | 街切换 | gameId, fromStreet, toStreet, pot, activePlayers | ☑ |
| LOG-05 | 边池创建 | gameId, sidePotId, amount, eligiblePlayers | ☐ |
| LOG-06 | Showdown 结果 | gameId, winners, hands, potDistribution | ☐ |
| LOG-07 | 玩家断连/重连 | gameId, playerId, event, 时间戳 | ☐ |
| LOG-08 | 错误/异常 | gameId, error, context, stack trace | ☑ |
| LOG-09 | Equity 查询 | gameId, playerId, street, freeCountRemaining, cost | ☑ |

### 8.2 日志质量

| 编号 | 检查点 | 状态 |
|------|--------|------|
| LOG-10 | 日志格式是否为结构化 JSON（便于机器解析） | ☑ |
| LOG-11 | 日志级别是否合理（info/warn/error 区分明确） | ☑ |
| LOG-12 | 日志是否能完整复盘一手牌的全部过程 | ☑ |
| LOG-13 | 生产环境日志是否排除了敏感信息（底牌、牌堆顺序只在 debug 级别） | ☐ |

---

## 9. 第八层：引擎-前端同步一致性

这是之前问题的重灾区：引擎和前端各自"觉得自己知道状态"。

### 9.1 同步清单

| 编号 | 数据项 | 引擎侧 | 前端侧 | 检查方法 |
|------|--------|--------|--------|----------|
| SYNC-01 | 当前街 | game.street | UI street indicator | 对比 WebSocket 消息和 UI 显示 |
| SYNC-02 | pot 金额 | game.pot | UI pot display | 每次 action 后对比 |
| SYNC-03 | 各玩家筹码 | player.stack | UI stack display | 每次 action 后对比 |
| SYNC-04 | 当前行动者 | game.currentActor | UI highlight/timer | 切换行动者时对比 |
| SYNC-05 | 可用行动列表 | game.getValidActions() | UI 按钮启用状态 | 轮到行动时对比 |
| SYNC-06 | 公共牌 | game.communityCards | UI board cards | 切街后对比 |
| SYNC-07 | 玩家状态（folded/allIn/acting） | player.status | UI 玩家显示 | 状态变化时对比 |
| SYNC-08 | 水晶球免费次数 | server.equityFreeCount | UI 显示的免费次数 | 使用/刷新后对比 |
| SYNC-09 | 水晶球价格 | server.equityPrice | UI 显示的价格 | 免费用完后对比 |
| SYNC-10 | dealer button 位置 | game.dealerSeat | UI button token | 每手开始时对比 |
| SYNC-10a | spectate / auto-play / disconnected 状态徽记 | player flags | 座位 badge / 顶栏提示 | 状态变化时对比 |
| SYNC-10b | 计时器可见性与剩余秒数 | engine timer metadata | seat 上的沙漏/秒数 | 每次轮转时对比 |

### 9.2 同步机制检查

| 编号 | 检查点 | 状态 |
|------|--------|------|
| SYNC-11 | 前端是否有独立的状态计算逻辑（不应该有，应完全依赖服务端推送） | ☐ |
| SYNC-12 | 如果前端有缓存/本地状态，是否在每次服务端推送后强制覆盖 | ☐ |
| SYNC-13 | 状态推送是否为完整快照（推荐）还是增量更新（容易丢失） | ☐ |
| SYNC-14 | 前端收到未知状态值时的容错处理（不应该崩溃） | ☐ |

---

## 10. 严重级别定义与分类规则

| 级别 | 定义 | 示例 | 处理方式 |
|------|------|------|----------|
| **P0 — 破坏性** | 违反核心不变量、导致游戏不可玩或数据错误 | 筹码凭空消失、pot分配错误、非法行动被执行、底牌泄露 | 审查过程中立即修复 |
| **P1 — 严重** | 不破坏数据但严重影响体验或可被利用 | 按钮在错误状态可点击、overlay穿透导致误操作、NPC卡死、计时器竞态 | 审查完成后第一批修复 |
| **P2 — 中等** | 体验问题或边缘场景异常 | 动画顺序不对、文案金额不匹配、断线重连后UI残留 | 排入迭代计划 |
| **P3 — 低** | 优化建议或极端边缘 | 日志格式不够结构化、滑块交互不够流畅、缺少某个状态的loading指示 | 记录备忘 |

---

## 11. 审查执行流程

### 阶段一：静态审查（代码阅读）

1. **绘制状态转移表**（对照 §3 的所有状态域）
   - 从代码中提取所有状态值和转移逻辑
   - 标记缺失的转移/防护
2. **核验核心不变量**（对照 §2）
   - 搜索所有 stack/pot 修改点，确认每处修改后都有断言或守卫
   - 搜索所有 action 处理函数，确认合法性校验
3. **引擎-前端同步审查**（对照 §9）
   - 比对 WebSocket 消息 schema 和前端状态管理
   - 标记前端有独立计算/缓存的地方
4. **安全审查**（对照 §7）
   - 检查所有 WebSocket 消息处理的鉴权
   - 检查所有发给客户端的数据是否过滤了敏感信息

### 阶段二：动态测试（场景执行）

5. **按 §4 的场景表逐个执行**
   - 每个场景记录：通过/失败、失败现象、关联代码位置
6. **前端交互审计**（对照 §5）
   - 在浏览器中逐项验证按钮状态、overlay行为、文案准确性
7. **并发与时序测试**（对照 §6）
   - 模拟断连、快速操作、计时器边界

### 阶段三：输出与修复

8. **汇总问题清单**（使用 §12 模板）
9. **按 P0→P1→P2→P3 排序**
10. **P0 问题直接修复并提交**
11. **P1 问题给出修复方案**
12. **P2/P3 问题记录备忘**

---

## 12. 问题清单模板

每个发现的问题按以下格式记录：

```
### [级别] 编号：标题

- **检查项编号**：INV-XX / SM-XX / PATH-XX / UI-XX / CONC-XX / SEC-XX / LOG-XX / SYNC-XX
- **严重级别**：P0 / P1 / P2 / P3
- **现象描述**：（简述观察到的问题）
- **期望行为**：（正确的行为应该是什么）
- **复现路径**：（如何触发）
- **关联代码**：（文件名 + 行号/函数名）
- **修复方案**：（建议的修复方式）
- **修复状态**：☐ 待修 / ☑ 已修 / ⊘ 不修（注明原因）
```

---

## 附录 A：Heads-Up 盲注与行动顺序速查（TDA 标准）

| 阶段 | SB（= Button） | BB |
|------|----------------|-----|
| 发牌 | 先收到第1、3张牌 | 收到第2、4张牌 |
| Preflop 行动 | 先行动（可 fold/call/raise） | 后行动 |
| Postflop 行动 | 后行动 | 先行动 |

> ⚠ 这是 heads-up 专属规则，3人及以上时 SB 和 Button 不是同一人。

## 附录 B：Min-Raise 计算规则

```
minRaise = lastBet + lastRaiseIncrement

示例：
- 盲注 1/2
- 玩家A raise to 6（增量 = 6 - 2 = 4）
- 玩家B 的 min-raise = 6 + 4 = 10
- 玩家B raise to 10（增量 = 10 - 6 = 4）
- 玩家A 的 min-raise = 10 + 4 = 14

特殊情况：
- 如果玩家短码 push 的总额 **高于 call 但低于完整 min-raise**，当前项目应按 **all-in** 处理，但该不足量 all-in **不重新开放行动权**
- 如果玩家连当前 bet 都抬不过，则应退化为 `call/check`，不能伪装成 `raise`
```

## 附录 C：边池计算公式

```
对所有 all-in 金额排序：a1 ≤ a2 ≤ ... ≤ an

边池1金额 = a1 × 参与人数
边池2金额 = (a2 - a1) × 边池2参与人数
...
边池k金额 = (ak - ak-1) × 边池k参与人数
主池金额 = 剩余

每个边池独立比牌，只有参与该边池的玩家有资格赢取。
```

## 附录 D：当前代码基线与新增审查重点

以下问题类型已经在最近版本中真实出现过，后续主动审查必须优先覆盖：

1. **0-call / 假 raise / NPC 对卡死**
   - 后续街 `call` 不能再用累计 `totalBet` 算
   - 不够最小加注时不能伪装成有效 `raise`

2. **Equity Oracle 状态漂移**
   - preflop 被误消耗
   - `20 → 40` 阶梯卡住
   - 本地 affordability 判断和服务端真值不一致
   - 透支购买

3. **座位与倒计时漂移**
   - 开局后洗座位导致观感突变
   - 倒计时跑到前一个/下一个玩家

4. **房间间状态残留**
   - 退出房间后新房间出现旧 ticker / mode badge / tournament banner

5. **practice 特殊规则丢失**
   - 0 NPC 未被拦截
   - 切模式后 lobby 锁定状态残留
   - auto/resume 后误触重开

6. **NAS 部署副本污染**
   - `git pull --ff-only` 经常被脏工作区卡住
   - 新功能已推到 Gitea，但 NAS 容器实际仍在跑旧前端

## 附录 E：NAS 部署与前端版本核验

### E.1 推荐更新方式

如果 NAS 目录仅作为部署副本，不要再依赖普通 `git pull --ff-only`，而应直接强制对齐远端：

```bash
cd /path/to/lonicera-deploy

sudo docker run --rm \
  --entrypoint sh \
  -v "$PWD":/repo \
  -w /repo \
  alpine/git \
  -lc 'git config --global --add safe.directory /repo && \
       git fetch origin main && \
       git reset --hard origin/main && \
       git clean -fd && \
       git rev-parse --short HEAD'

sudo NPM_REGISTRY=https://registry.npmmirror.com docker compose up -d --build
```

### E.2 前端是否真的更新的核验方法

不要只看 `docker compose up -d --build` 有没有成功，还要核验：

1. NAS 工作目录的 `HEAD` 是否已经是目标 commit
2. 容器内 `/app/public/index.html` 是否带了最新资源版本号
3. 浏览器是否实际加载到了带版本号的 CSS/JS

示例：

```bash
sudo docker exec lonicera sh -lc "grep -n 'lonicera-asset-version' /app/public/index.html"
```

---

*手册结束。下一步：拉取代码，按阶段一开始静态审查。*
