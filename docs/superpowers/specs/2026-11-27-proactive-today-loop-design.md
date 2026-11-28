# 设计规格：Today 主动闭环升级（Feed、Ideas、Goals、Spaces 协同飞轮）

**日期：** 2026-11-27  
**状态：** 已记录 / 待排期  
**目标分支：** `main`（后续按阶段切独立特性分支实现）  
**参考来源：** Meta Muse 深度机制考证（Feed / Ideas / Goals / Spaces、Active Focus、固定容器动态内容）与 OpenSuperBot 现有源码审计（`gateway/src/feed/`、`goals/`、`spaces/`、`tools.ts`、`context-distill.ts`、`server.ts`、`web/src/components/`）

---

## 1. 背景与现状诊断

OpenSuperBot 已具备完整的今日工作台四大表面（动态 `Feed`、灵感 `Ideas`、待办与目标 `Goals`、声明式实时空间 `Spaces`），且拥有比托管式 Agent 更严格的本地权限隔离与污点追踪机制。但对照源码审计，四大模块目前仍偏**各自独立、偏被动触发**，存在 4 个关键断层：

1. **Spaces 缺乏“安全低权后台自刷新”与主动露面机制：**
   - `gateway/src/tools.ts` 中 `PREPARE_TOOL_NAMES` 仅包含 `wiki_upsert`、`wiki_patch`、`write_file`，**不包含 `space_upsert_item` / `space_delete_item`**，导致想让 Space 后台自动更新数据时，要么开放高危 `act` 例程，要么依赖人工点击按钮。
   - `SpaceRow` 没有原生的后台刷新例程绑定；所有 Space 均收纳在 `今日 → 空间` 二级 Tab 下，侧边栏无快捷置顶，也无法按工作日/周末自动显隐切换。
2. **Feed 数据源局限于公网检索，且缺少偏好反馈与沉淀出口：**
   - `gateway/src/server.ts` 中 `runFeedTopic` 的提示词限定使用公网 `web_search` / `web_fetch`，尚未利用 `WATCH_TOOL_NAMES` 已内置的个人连接器（Gmail / Outlook / Calendar / Notion / Slack / Polery）与只读 MCP。
   - 用户对 Feed 卡片仅能“已读/归档/删除”，缺少轻量正负反馈调优“值得浮出水面（worth surfacing）”的过滤阈值，也缺少一键将卡片收入某个 Space 的通道。
3. **Ideas 偏向“对话被动速记”，缺少“主动参谋”与 `Idea → Space` 出口：**
   - `gateway/src/context-distill.ts` 严格只提取聊天里明确提及过的点子，不结合已接连接器做冷启动引导，也不会主动巡检停滞/临期 Goals 提出计划修订建议。
   - 灵感孵化完成后目前只能派发聊天或晋升为 Goal，不能一键孵化为常驻 Space。
4. **Goals 缺少开箱即用的后台推进引擎、临期预警与受阻换路：**
   - `PREPARE_TOOL_NAMES` 同样**不包含 `update_goal_progress`**；新建 Goal 后若不手动另建并关联 Routine，后台完全静止。
   - 已有 `targetDate` 与里程碑 `dueDate`，但缺少临期破窗核查机制；后台推进遇阻时缺少结构化的软件侧“Active Focus”换路与阻塞落档闭环。

---

## 2. 安全与架构不变量（绝对不突破的红线）

沿用并强化 `docs/security.md` 的确定性安全边界：

1. **操作者专权不变：** `manage_space`（创建/修改布局、HTML 块、`action_bar` 按钮）与 `manage_goal`（修改目标定义、成功标准、里程碑结构与状态）继续留在 `OPERATOR_ONLY_TOOL_NAMES`，后台例程、Webhook 与转交回合永不可调用。
2. **`prepare` 模式扩容保持零外部写入：**
   - 仅将 `space_upsert_item`（可选 `space_delete_item`）与 `update_goal_progress` 纳入 `PREPARE_TOOL_NAMES`。
   - 两者均由网关代码强校验既有授权（Space 显式 `editor` 角色、Goal 显式参与成员且状态为 `active`）、严守单回合写上限（Space ≤ 10、Goal 备注 ≤ 2）、自动强制标记 `tainted = 1`（模型无法洗白），且继续禁止 `shell`、浏览器点击输入、外部连接器写与同事转交。
3. **连接器 Feed 严守零默认授权与只读脱敏：**
   - 接入个人连接器/MCP 的 `FeedTopic` 仍运行在严格 `watch` 只读模式，仅能看到该同事在 `bot_connectors` / `bot_mcp_servers` 中已明确获授权的账号与只读工具；
   - 邮件读取继续经 `mail-sanitize` 剥离 OTP 与重置链接；产出卡片强制 `tainted = 1`，无论转入 Idea 还是收入 Space 均单调保留污点标记。
4. **主动修订提案绝不静默篡改：**
   - 针对既有 Goals 生成的修订类 Idea（`kind: 'goal_revision'`）必须经操作者审阅并显式点击「采纳」后才由网关落库，附带 `goal_updated` 审计记录与外部来源污点警示徽章。
5. **提醒克制防骚扰：**
   - Space 自动刷新与 Goal 自动巡检在无实质变化时静默收场（`Nothing to prepare.`），不在聊天线程堆垃圾消息；
   - 里程碑临期预警每条里程碑 24 小时内最多触发一次破窗提醒，且优先走 `prepare` 核查确认风险后再推送。

---

## 3. 四大模块详细设计

### 3.1 Spaces：后台静默自刷新 + 侧边栏置顶 + 按作息显隐

1. **`prepare` 写入放行（`gateway/src/tools.ts`、`agent.ts`）：**
   - 将 `SPACE_UPSERT_ITEM_TOOL_NAME`（及 `SPACE_DELETE_ITEM_TOOL_NAME`）加入 `PREPARE_TOOL_NAMES`。
   - 在 `prepare` 提示词中明确告知：可更新你拥有 `editor` 权限的 Space 数据记录，但不可改动布局或执行外部操作。
2. **原生后台自动刷新绑定（`gateway/src/routines.ts`、`spaces/`、`server.ts`）：**
   - `routines` 表新增可选外键列 `space_id TEXT`（类似现有 `goal_id`）；`SpaceView` 返回关联的 `refreshRoutines` 摘要（开关、cron、最近刷新时间与错误状态）。
   - 提供 `POST /api/spaces/:id/refresh-routine`（或 Space 创建/设置面板一键配置）：自动校验目标同事对该 Space 拥有 `editor` 权限（或引导勾选授予），创建一条 `mode: 'prepare'`、`surface: 'thread'` 的静默刷新例程；提示词要求仅在发现数据变化时调用 `space_upsert_item` 更新指定 block，无变化回复 `Nothing to prepare.` 保持线程完全安静。
   - 删除 Space 时自动清理或暂停其关联的 `space_id` 例程。
3. **侧边栏置顶与按作息时间表自动显隐（`spaces/types.ts`、`spaces/api.ts`、`web/src/components/Sidebar.tsx`、`SpacesView.tsx`）：**
   - `spaces` 表新增 `pinned INTEGER NOT NULL DEFAULT 0` 与 `visibility_schedule_json TEXT`（支持结构化规则：`{ mode: 'always' | 'weekdays' | 'weekends' | 'custom', days?: number[], startHour?: number, endHour?: number }`）。
   - `Sidebar` 在「今日」下方增加轻量「置顶空间」分组：仅展示 `pinned = 1` 且当前时间（按网关/本地时区）命中 `visibilitySchedule` 的 Space；`SpacesView` 列表始终可查看全部 Space（非当前时段的 Space 显示柔和的时段徽章，支持随时手动点开）。

### 3.2 Feed：个人连接器聚合 + 轻反馈调优 + `Feed → Space` 沉淀

1. **多源 `FeedTopic`（`gateway/src/feed/types.ts`、`store.ts`、`api.ts`、`server.ts`）：**
   - `feed_topics` 新增 `source_scope TEXT NOT NULL DEFAULT 'web'`（枚举：`'web' | 'connectors' | 'both'`）。
   - `runFeedTopic` 根据 `source_scope` 动态拼装检索指引：
     - `'web'`：保持现有公网 `web_search` / `web_fetch` 逻辑完全不变；
     - `'connectors'` / `'both'`：允许结合该同事已授权的只读连接器（邮件/日历/Notion/Slack/Polery）与只读 MCP 提炼高信号简报；仍强制 `watch` 模式、7 天去重与每日条数上限。
2. **Worth Surfacing 轻反馈闭环（`feed/types.ts`、`feed/api.ts`、`FeedView.tsx`）：**
   - `feed_items` 新增 `feedback TEXT`（`'up' | 'down' | null`），新增 `POST /api/feed/:id/feedback`。
   - `runFeedTopic` 组装提示词时，自动附带该 Topic 近 14 天内最多 5 条 `up` 与 5 条 `down` 的标题摘要作为“信号筛选偏好参考”；当同一 Topic 近期连续累积 `down >= 3` 时，可触发低打扰提示引导用户调整该 Topic 提示词。
3. **`Feed → Space` 一键收入（`gateway/src/feed/api.ts`、`FeedView.tsx`）：**
   - 新增 `POST /api/feed/:id/save-to-space`，接受 `{ spaceId, blockId? }`（默认自动匹配目标 Space 的首个 `cards` / `table` / `timeline` / `checklist` block）。
   - 将 Feed 卡片的标题、摘要、首条来源链接、标签写入 `space_items`，**原样继承 `item.tainted`**，并同步广播 `spaces_changed` 与标记 Feed 已读。

### 3.3 Ideas：三形态主动参谋 + `Idea → Space` 一键孵化

1. **扩展 Idea 数据模型（`gateway/src/feed/types.ts`、`store.ts`）：**
   - `ideas` 表新增：
     - `kind TEXT NOT NULL DEFAULT 'spark'`（`'spark' | 'onboarding' | 'goal_revision'`）；
     - `target_goal_id TEXT`（仅 `goal_revision` 使用）；
     - `proposal_json TEXT`（结构化修订提案：如建议新增里程碑列表、建议新 `targetDate`、理由说明）；
     - `promoted_space_id TEXT`（记录从该 Idea 孵化出的 Space ID）。
2. **形态 ① 冷启动与新能力引导（Onboarding Sparks）：**
   - 当首次接入某个连接器（Gmail / Calendar / Notion / Slack / Polery）或灵感箱为空时，基于本地规则模板生成 2–3 条贴合当前已启用连接器与同事角色的可执行试用卡片（零额外模型调用、每种能力最多提示一次、可随时关闭）。
3. **形态 ② 既有 Goals 主动修订巡检（P3 低优后台扫描）：**
   - 复用现有后台低优队列（类似 `proactive/dreaming.ts`），低频（例如每日一次或闲置触发）扫描 `active` Goals：
     - 条件：连续 7 天无新 `goal_updates`、存在已逾期 `dueDate` 里程碑，或近期 Feed/Wiki 出现与该 Goal 高度相关的新动态；
   - 通过只读分析生成 `kind: 'goal_revision'` 的 Idea 卡片（对同一 Goal 保留未处理修订卡去重上限 1 条，绝不刷屏；如参考了外部数据则强制标 `tainted = 1`）。
   - 新增 `POST /api/ideas/:id/apply-revision`：操作者可先预览/编辑建议内容，点击采纳后由网关调用 `goals/store.ts` 应用变更、写入 `goal_updates` 审计日志并将 Idea 置为 `promoted`。
4. **形态 ③ `Idea → Space` 一键孵化：**
   - 在 `FeedView` 灵感卡片的「晋升为目标」旁新增「孵化为空间」操作，将 Idea 标题、笔记与只读孵化总结作为结构化 brief 交给目标同事（引导先 `read_skill("space-design")` 再调 `manage_space`），创建成功后自动关联 `promoted_space_id` 便于双向回跳。

### 3.4 Goals：一键后台巡检 + 临期预警 + 软件侧 Active Focus 自愈

1. **`prepare` 记录目标进展 + 一键开启后台巡检：**
   - 将 `UPDATE_GOAL_PROGRESS_TOOL_NAME` 加入 `PREPARE_TOOL_NAMES`。
   - `POST /api/goals`（及前端创建/晋升 Goal 表单）支持可选参数 `autoCheckin?: { enabled: boolean; cron?: string }`：启用时由网关自动为 `ownerBotId` 创建一条挂在该 `goal_id` 下的 `mode: 'prepare'` 巡检例程（默认如每日 09:00 或工作日 09:00），目标暂停/完成/归档时自动随现有 `pauseGoalRoutines` 停用。
2. **里程碑临期破窗预警（Deadline Watch）：**
   - 新增低频扫描器（如每 30 分钟运行一次，带 `goal_deadline_notified` 24 小时去重状态）：检测 `active` Goal 中 `status = 'open'` 且 `dueDate` 距今 `<= 24h`（含已逾期）的里程碑。
   - 触发一次 `ownerBotId` 的 `prepare` 核查（检查最新上下文与进度）；若确认仍未完成且需操作者介入，则允许发送带明确截止期说明的 `urgent: true` 提醒（突破 Quiet Hours），并在今日工作台高亮展示。
3. **软件侧 “Active Focus” 受阻自愈协议（`gateway/src/prompts.ts`、`server.ts`、`agent.ts`）：**
   - 在 Goal Check-in、Goal 关联例程与后台任务的运行上下文中注入轻量受阻处理规范：
     - 当单步工具失败、目标网页不可达或接近 `loop-guard` 阈值时，显式引导切换备选通道（例如浏览器受阻改走 `web_search` / `web_fetch`、单一关键词无果改换检索词、单人受阻提示可协调 `memberBotIds`）；
     - 若重试替代路径后仍被外部条件阻断（缺少权限、需人工决策、对方未回复），强制要求：① 调用 `update_goal_progress` 落盘“阻塞点 + 已尝试方案”（避免下次巡检重复踩坑）；② 调用 `ask_operator` 输出 2–3 个清晰决策选项卡片。

---

## 4. 数据模型演进与向后兼容

> 注：当前 `gateway/src/db.ts` 最新 Schema 版本为 `v28`（`flashback_state`）。本规格涉及的表结构变更将按合入顺序作为独立顺序迁移（`v29+`）落地，且所有新增列均带安全默认值，保证存量数据零迁移故障：

- `routines`: 新增 `space_id TEXT`（可空，加索引 `idx_routines_space_id`）
- `spaces`: 新增 `pinned INTEGER NOT NULL DEFAULT 0`、`visibility_schedule_json TEXT`
- `feed_topics`: 新增 `source_scope TEXT NOT NULL DEFAULT 'web'`
- `feed_items`: 新增 `feedback TEXT`（`'up' | 'down' | null`）
- `ideas`: 新增 `kind TEXT NOT NULL DEFAULT 'spark'`、`target_goal_id TEXT`、`proposal_json TEXT`、`promoted_space_id TEXT`
- `goal_milestones`: 新增 `last_deadline_alert_at INTEGER`（用于 24h 临期预警去重，无需额外建表）

---

## 5. 分阶段落地策略

1. **Phase 1 — 打通后台闭环（最小改动、最高 ROI）：**
   - `PREPARE_TOOL_NAMES` 纳入 `space_upsert_item` / `space_delete_item` 与 `update_goal_progress`；
   - Space 原生绑定 `prepare` 自动刷新例程（`routines.space_id`）；
   - Goal 创建/晋升表单支持一键开启默认 `prepare` 后台巡检。
2. **Phase 2 — 提升日常使用感（Spaces 常驻化 + Feed 多源闭环）：**
   - Spaces 侧边栏置顶与按作息时间表自动显隐；
   - `FeedTopic` 支持 `web` / `connectors` / `both` 数据源、卡片 `👍/👎` 偏好回喂、`Feed → Space` 一键沉淀。
3. **Phase 3 — 主动参谋与自愈（Ideas 三形态 + Goal 预警与换路）：**
   - Ideas 能力冷启动引导、P3 低优巡检滞后/临期 Goals 生成 `goal_revision` 修订卡与一键采纳、`Idea → Space` 一键孵化；
   - Goal 里程碑临期破窗核查 + 软件侧 Active Focus 受阻换路与阻塞落档协议。
