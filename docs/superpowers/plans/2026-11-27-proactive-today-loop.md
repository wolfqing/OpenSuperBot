# 实施计划：Today 主动闭环升级（Feed、Ideas、Goals、Spaces 协同飞轮）

**日期：** 2026-11-27  
**规格文档：** `docs/superpowers/specs/2026-11-27-proactive-today-loop-design.md`  
**建议分支：** `feat/proactive-today-loop`  
**状态：** 已规划（分 3 个 Phase 渐进交付）

---

## Phase 1：打通 `prepare` 后台自刷新与 Goal 默认巡检闭环

### 任务 1：安全放行 `prepare` 模式写 Space 数据与记 Goal 进度
- 修改 `gateway/src/tools.ts`：将 `SPACE_UPSERT_ITEM_TOOL_NAME`、`SPACE_DELETE_ITEM_TOOL_NAME`、`UPDATE_GOAL_PROGRESS_TOOL_NAME` 加入 `PREPARE_TOOL_NAMES`（继续保持 `manage_space` / `manage_goal` 仅限 `OPERATOR_ONLY_TOOL_NAMES`）。
- 修改 `gateway/src/agent.ts`、`gateway/src/server.ts`、`gateway/src/prompts.ts`：同步更新 `prepare` 拒绝提示文案与 `prepareNote` 提示词说明（明确可更新已授权 `editor` 的 Space 数据与已参与 `active` 目标的进度备注，仍禁 `shell`、浏览器点击与外部写入）。
- 新增/扩展单测 `gateway/test/prepare-today-loop.test.ts`：验证 `prepare` 回合可调用 `space_upsert_item`（仅限 `editor` 授权、自动标 `tainted = 1`）与 `update_goal_progress`（仅限参与中的 `active` 目标、自动标 `tainted = 1`），同时依然拒绝 `manage_space`、`manage_goal`、`shell` 与外部连接器写工具。

### 任务 2：Space 原生绑定自动刷新例程 + Goal 一键开启后台巡检
- 修改 `gateway/src/db.ts`：新增顺序 Schema 迁移，为 `routines` 增加 `space_id TEXT`（及索引 `idx_routines_space_id`）。
- 修改 `gateway/src/routines.ts`：支持 `spaceId` 创建、`listSpaceRoutines`、`pauseSpaceRoutines` / `clearSpaceFromRoutines`。
- 修改 `gateway/src/spaces/types.ts`、`store.ts`、`api.ts`、`gateway/src/server.ts`：
  - `SpaceView` 增加 `refreshRoutines` 摘要；
  - 新增 `POST /api/spaces/:id/refresh-routine` 创建/绑定静默 `prepare` 刷新例程（校验目标同事 `editor` 权限）；
  - 删除 Space 时自动暂停并移除对应 `scheduler` 任务。
- 修改 `gateway/src/goals/api.ts`、`gateway/src/server.ts`：`POST /api/goals` 支持可选 `autoCheckin: { enabled, cron? }`，自动创建关联 `goal_id` 的 `prepare` 巡检例程并注册到 `scheduler`。
- 修改 `web/src/types.ts`、`web/src/api.ts`、`web/src/i18n/en.ts`、`zh-CN.ts`、`web/src/components/SpacesView.tsx`、`GoalsView.tsx`、`FeedView.tsx`：
  - Space 顶部操作区增加「自动刷新」配置浮层（频率、负责同事、开关、立即刷新）；
  - Goal 创建表单与 Idea 晋升 Goal 表单增加「开启后台自动巡检（`prepare`）」开关与频率选择。
- 补充前后端单测覆盖 Space 刷新例程绑定/删除联动与 Goal 一键巡检创建。

---

## Phase 2：Spaces 侧边栏置顶/时段显隐 + Feed 多源聚合与反馈沉淀

### 任务 3：Spaces 侧边栏置顶与按作息时间表自动显隐
- 修改 `gateway/src/db.ts`：为 `spaces` 增加 `pinned INTEGER NOT NULL DEFAULT 0` 与 `visibility_schedule_json TEXT`。
- 修改 `gateway/src/spaces/types.ts`、`schema.ts`、`store.ts`、`api.ts`：
  - 定义并严格校验 `SpaceVisibilitySchedule`（`always` / `weekdays` / `weekends` / `custom` 时段与星期范围）；
  - `PATCH /api/spaces/:id` 支持更新 `pinned` 与 `visibilitySchedule`。
- 修改 `web/src/types.ts`、`web/src/api.ts`、`web/src/App.tsx`、`web/src/components/Sidebar.tsx`、`SpacesView.tsx`、`web/src/i18n/`：
  - 左侧栏渲染当前时段生效的「置顶空间」快捷入口（支持一键直达指定 Space）；
  - `SpacesView` 增加「置顶到侧边栏」按钮与「显隐时间表」选择器（全天 / 工作日 / 周末 / 自定义时段），非当前时段的 Space 展示时段角标并仍可随时查看。
- 补充 `gateway/test/spaces-schedule.test.ts` 与 `web/src/components/Sidebar.test.tsx` / `SpacesView.test.tsx` 单测（含固定时钟下的工作日/周末切换断言）。

### 任务 4：Feed 多源聚合（连接器 + 公网）、卡片轻反馈与 `Feed → Space` 沉淀
- 修改 `gateway/src/db.ts`：为 `feed_topics` 增加 `source_scope TEXT NOT NULL DEFAULT 'web'`；为 `feed_items` 增加 `feedback TEXT`。
- 修改 `gateway/src/feed/types.ts`、`store.ts`、`api.ts`、`gateway/src/server.ts`：
  - `FeedTopic` 创建/编辑接口支持 `sourceScope: 'web' | 'connectors' | 'both'`；`runFeedTopic` 按 `sourceScope` 生成对应提示词，仍强制 `watch` 只读模式与 `tainted = 1`；
  - 新增 `POST /api/feed/:id/feedback`（`'up' | 'down' | null`），并在 `runFeedTopic` 中附带近 14 天同 Topic 正负反馈标题摘要优化筛选质量；
  - 新增 `POST /api/feed/:id/save-to-space`，将卡片写入指定 Space 的兼容 block 并严格保留 `tainted` 标记。
- 修改 `web/src/types.ts`、`web/src/api.ts`、`web/src/components/FeedView.tsx`、`web/src/i18n/`：
  - Feed Topic 表单增加数据源范围选择（公网 / 已授权连接器 / 两者结合）；
  - Feed 卡片底部增加 `👍/👎` 轻反馈与「收入空间」快捷下拉动作。
- 补充 `gateway/test/feed-connectors-feedback.test.ts` 与 `web/src/components/FeedView.test.tsx` 单测（验证零默认连接器隔离、反馈回喂提示词与收入 Space 污点不洗白）。

---

## Phase 3：Ideas 三形态主动参谋 + Goal 临期预警与受阻自愈

### 任务 5：Ideas 扩展（冷启动引导、既有 Goal 修订巡检与 `Idea → Space`）
- 修改 `gateway/src/db.ts`：为 `ideas` 增加 `kind TEXT NOT NULL DEFAULT 'spark'`、`target_goal_id TEXT`、`proposal_json TEXT`、`promoted_space_id TEXT`。
- 新建 `gateway/src/feed/idea-advisor.ts`：
  - **Onboarding Sparks：** 接入新连接器或空灵感箱时基于本地模板生成最多 3 条贴合当前授权能力的试用 Idea（去重防重复提示）；
  - **Goal Revision Scanner（P3 低优）：** 闲置巡检停滞（≥ 7 天无更新）或含逾期里程碑的 `active` Goal，生成结构化 `goal_revision` Idea（每 Goal 最多 1 条待处理修订卡，涉外数据强制 `tainted = 1`）。
- 修改 `gateway/src/feed/types.ts`、`store.ts`、`api.ts`、`gateway/src/server.ts`：
  - 新增 `POST /api/ideas/:id/apply-revision`（操作者审阅确认后应用里程碑/日期修订并记 `goal_updates` 审计日志）；
  - 挂载 P3 闲置巡检触发器与 `promotedSpaceId` 更新支持。
- 修改 `web/src/components/FeedView.tsx`、`web/src/types.ts`、`web/src/api.ts`、`web/src/i18n/`：
  - 区分渲染 `goal_revision` 修订建议卡（含外部数据污点警示、变更预览与「采纳修订」按钮）；
  - 为普通灵感卡片增加「孵化为空间」入口（预填标题、笔记与孵化摘要调用 `onDesignSpaceWithBot`）。
- 新增 `gateway/test/idea-advisor.test.ts` 覆盖冷启动生成、停滞 Goal 修订提案去重、污点保留与操作者采纳落库。

### 任务 6：Goal 临期里程碑破窗核查与软件侧 Active Focus 受阻换路
- 修改 `gateway/src/db.ts`：为 `goal_milestones` 增加 `last_deadline_alert_at INTEGER`。
- 新建 `gateway/src/goals/deadline-watch.ts`：定时扫描 `active` Goal 中 `open` 且 `dueDate` 距今 `<= 24h`（含逾期）的里程碑，24h 去重后触发 `ownerBotId` 的 `prepare` 核查，确有风险时推送 `urgent: true` 提醒突破 Quiet Hours。
- 修改 `gateway/src/prompts.ts`、`gateway/src/server.ts`、`gateway/src/agent.ts`：为 Goal Check-in / Goal Routine / 后台任务注入结构化“受阻换路与阻塞落档”指令（工具连续受阻切换备选通道；仍卡住则调用 `update_goal_progress` 记录阻塞点并弹 `ask_operator` 选项卡片）。
- 修改 `docs/security.md` 与 `CHANGELOG.md`：记录 `prepare` 模式新增受控工具边界、连接器 Feed 只读隔离、`goal_revision` 人工采纳门禁及临期预警防抖机制。
- 新增 `gateway/test/goal-deadline-watch.test.ts` 验证 24h 临期触发、去重防骚扰与暂停目标不误报。

---

## 每阶段合入前必跑校验
- `pnpm typecheck`
- `pnpm --filter @opensuperbot/gateway test`
- `pnpm --filter @opensuperbot/web test`
- `pnpm --filter @opensuperbot/desktop test`
- `pnpm build`
