# AI 研发平台 —— 需求一句话到代码合入

支撑研发人员需求 E2E：**一句话需求 → 澄清 → 架构 → 功能设计 → 测试设计 → 人工审核 →（AR 拆分）AI 写码 → 多维验证 → MR 监听 → 合入**。
以 9 阶段主干 + 门禁体系 + 语义事件流 + AR 级并行为核心的公共 Agent 平台，实现《场景分析.md》全部 10 个业务场景与研发作业流（架构师/TSE 角色落位、TTM 度量、全流程追溯）。

```
┌─────────────────────────────────────────────────────────────────┐
│  会话厅（apps/web）        任务工作台（apps/web）                  │
│  任务卡片/度量面板/通知     三栏：材料 | 会话流+阶段轨 | 决策卡+MR   │
├─────────────────────────────────────────────────────────────────┤
│  L4 交互层   apps/server/src/api      REST 27 路由 + SSE 实时流   │
│  L3 编排层   orchestrator/            9 阶段 worker·门·调度·监听   │
│             + subtasks.ts            AR 并行（拆分/派发/聚合验收） │
│  L2 领域层   domain/                  状态机·事件流·健康·存储      │
│  L1 运行时   runtime/ + engine/       git·MR·通知·度量 + 引擎适配  │
│  扩展机制     extension/              playbook·知识库·技能·产物分层 │
├─────────────────────────────────────────────────────────────────┤
│  packages/shared    契约单源（zod schema + 展示元数据，前后端同源） │
└─────────────────────────────────────────────────────────────────┘
```

## 研发作业流（9 阶段主干）

| 阶段 | 主笔（AI） | 交付物 | 门（拍板人） |
|------|-----------|--------|-------------|
| intake 需求接单 | 平台 | 存量基线 / 绿地脚手架 | — |
| clarify 需求澄清 | 引擎 | IR→SR→AR 三级分解 | 事实门（需求方） |
| architecture 架构 | 引擎 | `delivery/architecture.md`（架构分析/边界设计/业务流） | 事实门（架构师，缺省责任人） |
| design 功能设计 | 引擎 | `delivery/spec.md` + `design.md` + 契约单源 + 功能 FMEA | 事实门（责任人） |
| test-design 测试设计 | 引擎 | `delivery/test-design.md`（需求测试分析/策略/测试点） | 事实门（TSE，缺省责任人） |
| review 人工审核 | — | 证据同屏（材料选区） | 审核门（检视人；可声明式回退 4 目标） |
| code 执行编码 | 引擎 | 代码 + UT；AR 并行时先拆分派发 | 拆分门（责任人）/ 聚合验收门（TSE） |
| verify 多维验证 | 引擎 | 并行评审 + Critic 终审 + 构建 + MST | 测试门（责任人） |
| deliver 交付合入 | 引擎 | MR + 就绪证据 | 交付门（合入方，永远人工 fail-closed） |

回退边（声明式，全留痕）：code→clarify/architecture/design；verify→code；deliver→code；合入后问题→code。

## 快速开始

```bash
npm install            # 安装（npm workspaces monorepo）
cp .env.example .env   # 端口 8787 / 引擎选择等
npm run dev            # server(8787) + web(5173) 并起
npm test               # 50 个测试全过（E2E 用 simulated 引擎）
npm run typecheck      # 三包类型检查
npm run seed           # 演示种子任务（strict 剧本；--ar-parallel=true 开 AR 并行）
npm run build          # 生产构建（web 产物由 server 同进程托管）
```

打开 **http://localhost:5173**（开发）或 **http://localhost:8787**（生产）。

## AI 引擎配置

`AI_ENGINE` 环境变量（`.env`）：

| 值 | 行为 |
|---|---|
| `auto` | 自动探测：opencode → claude → simulated |
| `opencode` | OpenCode 引擎（需本机 `opencode` CLI ≥ v2.0；直连 v2 HTTP API，见下） |
| `claude` | Claude Code 引擎（`@anthropic-ai/claude-code` SDK + 本机 CLI；需 `ANTHROPIC_API_KEY` 或已认证） |
| `simulated` | 内置确定性模拟引擎（测试/演示兜底，永远可用） |

演示种子任务显式指定 `engineId: simulated`，不依赖外部环境；新建任务走默认引擎。
引擎可用性在会话厅「调度与引擎」面板与顶栏实时可见。

### OpenCode 引擎工作原理（opencode v2.0.x）

- **直连 HTTP API，不经 SDK**：实测 `@opencode-ai/sdk` 1.18.x 的路由表与 opencode v2.0.18 不匹配（SDK prompt 打 `/message`，服务端只有 `/prompt`；`abort` 路由不存在），故引擎自行实现客户端：Basic 鉴权（口令经 `OPENCODE_SERVER_PASSWORD` 注入，不依赖 stdout 解析）+ SSE 事件流解析。
- **每作业临时 server，工作区级隔离**：v2.0.x 会话绑定服务端 cwd（`location[directory]`/`x-opencode-directory` 对 create 均不生效），因此引擎为每个阶段作业在任务工作区自起 `opencode serve --port=0`，回合收口即整树收杀（Windows 用 `taskkill /T` 防 shell 垫片留孤儿）。实测每 server 约占 300–500 MB 内存，作业并发度 = 同时在跑的临时 server 数，演示环境建议控制并发任务数（调度器 `maxConcurrent` 默认 2）。
- **异步 prompt + 事件流**：`POST /session/{id}/prompt` 只负责投递，AI 产出全部从 `GET /event` SSE 语义化映射（工具调用/结果/文本/用量）；回合收口以 `session.execution.succeeded/failed/aborted` 为准。
- **诚实收口**：空回合（收口成功但无文本且无工具）如实报失败不编造完成；server 意外退出/事件流断开带最近输出诊断；prompt 409（会话忙）退避 250ms 单次重投。
- **产物形状契约双保险（指令钉形状 + 读取端归一化）**：真实引擎对结构化产物可能写数组/对象映射/逗号串三种形态（decisions.json、api-contract.json 的 `interfaces` 均有实锤），指令层钉死 JSON 形状（stage-prompts），读取层统一归一化（`util.ts` 的 `toStringArray`/`toRecordArray` + `engine-runner.ts` 的 `normalizeStageOutput`），消费端只见声明的形状——不让一个畸形字段杀死整个阶段 worker。
- **远程模式**（`OPENCODE_HOST`/`OPENCODE_KEY`）：可连接自管 server，但会话将跑在远端 server 自己的项目目录（v2.0.x 限制），仅适合同机场景。
- 注意：dev 模式（`tsx watch`）改服务端代码会硬杀平台进程，在跑回合的临时 server 会孤儿化（回合的 `finally` 收杀来不及执行）；孤儿进程可用 `taskkill /IM opencode.exe /F` 之外按命令行 `serve --hostname=127.0.0.1` 甄别清理。生产用 `npm start`（无 watcher）不受影响；重启后 running 任务由恢复机制重新入队续跑。
- 协议核查工具：`node scripts/opencode-probe.mjs`（升级 opencode 后先跑它核对协议漂移）；`node scripts/opencode-spec.mjs`（路由表/规范 dump）；`node scripts/e2e-opencode.mjs`（建 opencode 引擎任务的全链路冒烟）。

## 演示剧本操作指引

会话厅顶部提供五个演示剧本按钮（等价 `POST /api/demo/seed`，simulated 引擎；前四个 playbook=strict，AR 并行为 fast）：

### 1. 顺滑全链路（clean）
1. 点「顺滑全链路」→ 任务创建，自动推进到**需求澄清事实门**。
2. 切身份为**张明（需求方）** → 决策卡作答（材料同屏）→ 提交。
3. 自动产出架构设计 → **架构门**（事实门）→ 切**陈枢（架构师）**确认。
4. 功能设计（spec/design/契约/FMEA）→ **方案确认门** → **王浩（开发）**拍「方案通过」。
5. 测试设计（需求测试分析/策略/测试点）→ **测试设计门** → **吴倩（TSE）**确认。
6. **审核门** → 切**赵磊（检视人）**「通过放行」。
7. verify 阶段自动跑多维并行评审 + Critic 终审 + 构建 + 测试（首轮可能回退编码修复一轮再复检）。
8. **测试门** → 王浩「认可」→ 进入 MR 监听态。
9. MR 面板演示注入：`流水线 真绿` + `Approve` → 就绪检测举**交付门**。
10. 切**周杰（合入方）**→「确认合入（终态）」→ merged ✔（质量度量面板 TTM 停表）。

### 2. 工具抽风·接管修复（flaky-tool）
1. code 阶段引擎连续工具报错 → 健康徽标黄→红（主动叫人）→ 健康红线自动中断。
2. 侧栏「✋ 接管」（任意身份）→ 任务转人接管中（lifecycle=interrupted，非失败）。
3. 会话流底部追加修复指令（= 人工放行下一轮自动执行）→ 自动修复 → 继续推进到合入。

### 3. 构建失败·预算耗尽（build-fail）
1. verify 阶段构建失败 → 重试预算耗尽 → 任务停止升级（不烧资源、不假装通过）。
2. 收件箱收到 `build-failed` 通知 → 打开任务 → 追加修复指令恢复（或「恢复自动」）→ 重验通过。

### 4. MR 反馈环（feedback-loop）
1. MR 监听态注入 `检视意见`（分诊:需人决策）→ 平台举事实门，owner 拍板。
2. 选「不采纳（waive 留痕）」→ 再注入 `MR 评论`（分诊:自动可修）→ 平台自动回编码修复。
3. 修复后推送新 SHA → **旧证据（流水线/评审）自动失效** → 需重新注入流水线真绿 + approve → 交付门 → 合入。
4. 合入后可注入「合入后问题」体验回退环（合入后发现问题仍可回编码）。

### 5. AR 并行拆分·聚合验收（clean + arParallel）
1. 审核门通过后，执行段先举 **AR 拆分门（事实门，责任人拍板）**：拆分方案（`process/ar-split.md`）+ 三级分解材料同屏。
2. 确认拆分 → 派发 3 个子任务（演示剧本：过期规则参数化 / 查询接口 / 月末扫描推送），**拷贝父任务设计产物、从编码阶段起跑**，开发轮转承接（王浩/刘阳/陈静），并发槽内真并行。
3. 父任务转 **AR 聚合中（aggregating，不占并发槽）**；会话厅卡片显示 `⧉ AR n/3` 进度，侧栏看 AR 谱系。
4. 每个子任务独立走 编码→验证→**测试门（子任务责任人拍）**→MR→**交付门（合入方 merge）**。
5. 全部合入 → 举 **聚合验收门（TSE 拍板，铁门超时只升级）** → 通过则父任务收口 merged（父交付=设计产物集+AR 谱系；代码交付见各子任务 MR）。
6. 事件流可回溯：`subtask_spawned`×3 + `subtask_completed`×3 全程留痕；验收不通过可清空拆分重新派发（修复轮 +1）。

### 通用演示点
- **门快进超时**：决策卡「⏩ 快进超时（演示）」观察超时策略（fact 降级+待追认 / review·test 升级不放行）。
- **晨间摘要**：通知面板「晨间摘要」手动合并安静时段通知。
- **并发槽**：会话厅右侧调整 maxConcurrent，观察排队/运行/门等待/AR 聚合的槽位流转（aggregating 不占槽）。
- **技能沉淀**：任务合入后在候选池评审采纳（候选不自动生效，防 AI 自我强化）。
- **质量度量**：会话厅右侧「质量度量」面板——TTM 中位/均值、各阶段平均活跃耗时（纯 CSS 条形图）、门等待（按门类，降级计入）、回退/修复轮；`GET /api/metrics` 同源。

## 十场景 → 实现映射

| # | 场景 | 核心实现 | 演示入口 |
|---|------|---------|---------|
| 1 | 接单开张·方式分流 | `workers.ts intake` + `legacy-seed.ts`（存量逆向基线/绿地） | 新建任务选开发方式 |
| 2 | 需求澄清·成组质询 | clarify worker + 事实门（answer）+ 超时降级待追认 | 决策卡作答；快进超时 |
| 3 | 定规格·双产物主权流转 | design worker + WHAT/HOW 产物 + 契约单源 + 主权移交 | 材料 tab 看 spec/design/契约 |
| 4 | 人工审核·证据同屏反盲签 | review 门（preface/context/材料选区）+ 声明式回退 | 决策卡驳回选回退目标 |
| 5 | 写代码·人机接管 | code worker + takeover(interrupt) + 追加指令 | 侧栏接管/会话流指令 |
| 6 | 构建验证·多维评审对抗修复 | verify worker（dim-* 并行 + critic 终审 + 防伪 + 修复闭环） | 材料 tab 看评审报告 |
| 7 | 持续检视·反馈消化合入 | watcher + 5 类反馈分诊 + SHA 校验 + fail-closed 合入 | MR 面板注入事件 |
| 8 | 多任务并发 | scheduler 并发槽（gate-wait/watching 不占槽） | 调度面板 + 多建任务 |
| 9 | 健康徽标·主动叫人 | health.ts + IM 通知合并/安静时段/晨间摘要 | flaky-tool 剧本 + 收件箱 |
| 10 | 技能沉淀 | skills.ts（提炼→候选→采纳留痕→物化注入） | 会话厅技能面板 |

## 硬约束落实

- **铁门永不代答**：四类门（fact/review/test/delivery）全部 fail-closed；无人值守只允许事实门「降级推进非阻塞部分 + 待追认」，绝不替答。AR 聚合验收门为 test 类铁门（超时只升级）。
- **决策证据同屏**：决策卡 preface/context/digest/材料选区与按钮同屏（反盲签）；合入三条件（流水线真绿/反馈全消化/人工拍板）缺一不可；AR 拆分门/聚合验收门同样材料同屏。
- **过程可接管可回溯**：16 类语义事件 append-only JSONL（`.flow/events.jsonl`），SSE 实时推送；接管=中断（interrupted≠failed），全程可回放；AR 拆分谱系（subtask_spawned/completed）落父任务事件流。
- **产物分层契约单源**：三分区 process（不入 git）/ delivery（git 仓）/ knowledge（可回流）；契约 `delivery/contract/api-contract.json` 单源，派生视图漂移检测；子任务拷贝父任务交付区设计产物（同一设计单源）。

## 关键机制

| 机制 | 位置 |
|------|------|
| 状态真源 + 乐观锁 | 每任务 `data/runtime/tasks/<id>/.flow/state.json`（stateVersion，409 冲突知情） |
| 语义事件流 | `domain/event-log.ts`（文件级互斥保证 seq 单调；`artifact_written` 由平台统一补发） |
| 调度器 | `runtime/scheduler.ts`（并发槽；await 派发防跨 tick 双跑；重启恢复） |
| 门禁 | `orchestrator/gates.ts`（拍板权唯一/会诊单拍板/管理员代拍留痕） |
| AR 并行 | `orchestrator/subtasks.ts`（拆分门→spawn 子任务→aggregating 聚合扫描（KeyedMutex 串行防竞态）→聚合验收门→父收口） |
| 质量度量 | `runtime/metrics.ts`（TTM/阶段段式耗时含回退重做/门等待含降级/事件量，事件流只读派生，`GET /api/metrics`） |
| MR 平台 | `runtime/mr-platform.ts`（监听态；`/api/tasks/:id/mr/events` 演示注入） |
| 通知 | `runtime/notifications.ts`（dedupKey 防重；安静时段并入晨间摘要） |
| Playbook | `extension/playbooks.ts`（locked 阶段 I/O + customizable 门风格/评审维度/预算） |
| OKL 知识库 | `extension/knowledge.ts`（forward/global/repos 按需叠加注入，摘要可观测） |

## API 一览（契约单源 `packages/shared/src/api.ts`）

- 认证：`GET /api/auth/options|me`、`POST /api/auth/login|logout`（演示模式另有 `demo-login|switch`）、`GET /api/health`
- 任务：`POST/GET /api/tasks`、`GET /api/tasks/:id`
- 事件：`GET /api/tasks/:id/events`（分页/过滤）、`GET .../events/stream`（SSE：events/state/notification/ping）
- 产物：`GET /api/tasks/:id/artifact?path=`、`POST .../annotations`
- 门：`POST .../gate/decide|invite|force-timeout`
- 交互：`POST .../takeover|resume-auto|instruction`
- MR 注入：`POST .../mr/events`（pipeline-run/comment/review-comment/approve/post-merge-issue）
- 通知：`GET /api/notifications`、`POST /api/notifications/:nid/read|read-all|digest/flush`
- 配置：`GET/POST /api/config/scheduler`、`GET /api/config`
- 技能：`GET /api/skills`、`POST /api/skills/:sid/actions`
- 度量：`GET /api/metrics`（TTM/阶段耗时/门等待/回退汇总，事件流只读派生）
- 其他：`GET /api/users|playbooks`、`POST /api/demo/seed`（`arParallel: true` 开 AR 并行）

除 `/api/health`、`/api/auth/options|login`（及演示模式的 `demo-login`）外全部要求认证。

## 测试

`npm test`（vitest，62 用例）：e2e-main（clean 全链路 merged/事件流/产物分区/技能候选 + 架构/TSE 门拍板人断言）、e2e-scenarios（flaky-tool 接管修复/build-fail 预算恢复/feedback-loop SHA 失效重推/并发槽因果/重启恢复）、e2e-ar（AR 并行全链路：拆分门→3 子任务并行→聚合验收门→父收口，spawn/completed 事件断言）、metrics（合成事件段式计时/回退重做/降级门等待 + 真实管线聚合）、auth（401 拦截/演示会话/伪造身份 403/taskId 校验/严格模式后门关闭/Bearer 令牌/限流）、store-backend（文件契约直检 + pg-mem 内存 PG 真 SQL 路径；配 TEST_DATABASE_URL 增真实 PG 段）、gates、scheduler、skills、state-machine、artifacts。
测试用 fast playbook（门超时 300ms）+ `SIM_DELAY=0` 控制时间。

另有 API 级演示驱动器（模拟前端操作序列自动通关，支持 AR 聚合递归驱动，按拍板人切换会话）：`node scripts/demo-drive.mjs <taskId>`。

## 生产部署

平台默认以开发/演示姿态启动（`DEMO_MODE=true`：免令牌身份切换、演示种子、MR 注入后门全开）。
上生产（或内网受控试点）必须完成以下开关与检查：

1. **关闭演示模式**：`.env` 置 `DEMO_MODE=false`。效果：
   - `/api/auth/demo-login`、`/api/auth/switch` 不再注册（无法免令牌切换身份）；
   - `/api/demo/seed`、`/api/tasks/:id/gate/force-timeout`、`/api/notifications/digest/flush` 仅管理员可用；
   - `/api/tasks/:id/mr/events` 必须携带 HMAC 签名（见下）。
2. **令牌与会话**：身份唯一来源 = 认证身份。
   - 用户令牌首启自动生成于 `data/runtime/auth-tokens.json`（`tok_<48hex>`/用户，含 `admin`）；分发给用户或对接企业 SSO（OIDC 适配位已留）。
   - 浏览器：`POST /api/auth/login`（userId+token）→ HttpOnly 签名 Cookie（12h）；API 客户端：`Authorization: Bearer <token>`。
   - 令牌轮换 = 编辑该文件后重启；会话密钥 `AUTH_SECRET` 可用 env 固定（否则首启生成于 `data/runtime/.auth-secret`，更换会使全部会话失效）。
   - 所有写操作的 `asUserId` 必须与登录身份一致，伪造 → `403 identity-mismatch`；admin 代拍板仍走原有留痕通道。
3. **MR webhook 签名**：`.env` 配 `MR_WEBHOOK_SECRET` 后，`/api/tasks/:id/mr/events` 需带
   `X-Signature: sha256=<hex>`，签名 = HMAC-SHA256(secret, JSON.stringify(body))。
4. **网络边界**：web 与 API 同进程托管，CORS 默认同源；跨域接入再配 `CORS_ORIGINS` 白名单。
   反向代理做 TLS 终止后置 `COOKIE_SECURE=true`。全局限流 `RATE_LIMIT_PER_MIN`（默认 600/min·IP，认证端点固定 10/min）。
5. **运维**：`GET /api/health`（LB 探活）；`data/` 定期备份（状态/事件/工作区全在其中）。

已知边界（诚实声明）：引擎子进程无容器隔离（建议按任务配额与独立执行机）；MCP 七件套与 MR/CI 仍为模拟对接，真实联调需企业内端点。

## 存储后端（双后端契约）

状态/事件/审计真源可切换（`domain/store-backend.ts` 抽象，公共面 `TaskStore` 不变）：

| | 文件后端（默认） | PG 后端（`DATABASE_URL` 启用） |
|---|---|---|
| 状态 | `tasks/<id>/.flow/state.json`（原子写） | `ai_tasks.state` jsonb + 乐观锁列 |
| 事件 | `events.jsonl` append-only | `ai_events` append-only，PK(task_id, seq) |
| 审计 | `audit.jsonl` append-only | `ai_audit` append-only |
| 串行 | 进程内 KeyedMutex | `pg_advisory_lock(hashtext('<ns>:<taskId>'))` 跨进程互斥 |
| 工作区 | 文件（git 仓库/产物/派生缓存） | 文件（不变；建议共享卷） |

- 并发语义两后端等价：mutate = 锁内乐观锁校验（409 知情）；append = 锁内 MAX(seq)+1（单调无冲突）；state/event/audit 三命名空间锁隔离，同任务跨类别嵌套不死锁。
- 契约测试：全量 e2e（62 用例）即契约——默认跑文件后端；`TEST_DATABASE_URL=postgres://… npm test` 跑 PG 后端（每实例独立 schema）。本地无 PG 时另有 pg-mem（内存 PG 模拟）直跑 SQL 路径（advisory lock 探测降级进程内互斥，真实 PG 不触发）。
- 通知/投影/调度配置仍为进程内文件（可从事件流重建或属运维配置）；多副本水平扩展前还需调度单写者改造。
