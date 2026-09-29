/**
 * 阶段主干定义 v2（附录 A · 业务流主线 · 对齐「人与AI协同工作平台」愿景图）
 *
 * 愿景五节点 + 终态：需求 → 架构 → 功能设计 → 测试设计 → 执行与编码 → 已合入。
 * 阶段 I/O 与退出条件由平台兜底（不可删），阶段内活动由 playbook 定制（可改）。
 *
 * 设计段（人与 AI 共创）：requirement ~ test-design；执行段（AI 自动 + 人审核）：execute ~ merged。
 * v2 合并史：intake+clarify→requirement；review 连拍为 test-design 出口第二门（设计段收口）；
 * code+verify+deliver→execute（段内循环：编码自报→多维评审→测试门→MR 监听→交付门）。
 * 门与角色主权全保留——砍的是格子，不是拍板。
 */

export const STAGE_ORDER = [
  'requirement',
  'architecture',
  'design',
  'test-design',
  'execute',
  'merged',
] as const

export type StageId = (typeof STAGE_ORDER)[number]

/**
 * 阶段注册表声明列（单源 · mae-flow stageRegistry 教训）：
 * 产物清单 / 出口门 / 出口动作在这里声明一次，门证据同屏（workers）、引擎指令（stage-prompts）、
 * 形状契约测试（shape-contracts/e2e）全部读表生成——消灭「改一个阶段要同步三处」的漂移。
 */

/** 阶段产物声明 */
export interface StageOutput {
  /** 工作区相对路径；支持 {round}/{dimension} 占位符；结尾 / 表示目录前缀（动态清单） */
  path: string
  /** 产物分区（三区纪律：process 不入 git / delivery 入 git / knowledge 可回流） */
  partition: 'process' | 'delivery' | 'knowledge'
  label: string
  /** 是否进入出口门证据同屏（过程草稿/派生视图/动态清单为 false；默认 true） */
  evidence?: boolean
  /** 任务基底（存量仓种子/绿地脚手架，平台注入，非阶段作业产物） */
  substrate?: boolean
}

/** 阶段作业声明（引擎派发单元；id = runEngine 的 job 参数） */
export interface StageJob {
  id: string
  label: string
  outputs: StageOutput[]
}

/** 出口门声明（raiseGate 按此机械校验：阶段未声明的门举不起来） */
export interface StageExitGate {
  kind: 'fact' | 'review' | 'test' | 'delivery'
  /** 拍板角色（缺省角色由责任人代理，如 architect 缺省 → owner） */
  deciderRole: 'requester' | 'architect' | 'owner' | 'tse' | 'reviewer' | 'merger'
  label: string
  /** 举门条件（未标注 = 阶段收口必举） */
  when?: string
}

/** 出口动作形态 */
export type StageExitAction = 'auto' | 'self-report' | 'gate' | 'watch' | 'terminal'

export const EXIT_ACTION_LABEL: Record<StageExitAction, string> = {
  auto: '双层自动门放行（程序规则校验 + AI 复核，不靠人拍）',
  'self-report': '自报完成，平台以文件证据裁决（不只信自报）',
  gate: '出口门拍板收口',
  watch: '监听态收口（反馈全消化 + 流水线真绿 + 合入拍板）',
  terminal: '终态（合入后发现问题仍可回退执行段）',
}

export const DECIDER_ROLE_LABEL: Record<StageExitGate['deciderRole'], string> = {
  requester: '需求方',
  architect: '架构师',
  owner: '责任人',
  tse: 'TSE',
  reviewer: '评审人',
  merger: '合入方',
}

/** 阶段绑定的知识（Skill）声明（愿景四层：人/知识/交付件/AI Workflow） */
export interface StageSkill {
  id: string
  label: string
  desc: string
}

export interface StageMeta {
  id: StageId
  /** 阶段轨序号（展示用，从 1 开始） */
  no: number
  label: string
  shortLabel: string
  desc: string
  /** 该阶段主体工作 AI 是否可自动推进 */
  automatable: boolean
  /** 退出条件（平台兜底，不可删） */
  exitCondition: string
  /** 阶段内作业清单（引擎派发 + 产物单源） */
  jobs: StageJob[]
  /** 平台（非引擎）落盘的产物：评审报告/派生视图等 */
  platformOutputs?: StageOutput[]
  /** 出口门声明（空 = 无人工门，自动校验放行） */
  exitGates: StageExitGate[]
  /** 出口动作形态 */
  exitAction: StageExitAction
  /** 本段绑定的知识（Skill）：人/知识/交付件/AI Workflow 四层中的「知识」层 */
  skills?: StageSkill[]
}

export const STAGES: Record<StageId, StageMeta> = {
  requirement: {
    id: 'requirement',
    no: 1,
    label: '需求',
    shortLabel: '需求',
    desc: '需求验收 → 系统需求分析：对齐上下文建立基线，成组质询消除歧义，IR→SR→AR 三级分解落成可验收原子项',
    automatable: true,
    exitCondition:
      '改动切片基线已建立并过双层自动校验（程序规则 + AI 复核，段内检查点不靠人拍）；需求已落成可验收原子项；业务事实有决策记录（事实门全决或降级标记待追认）',
    jobs: [
      {
        id: 'intake',
        label: '基线建立（逆向理解改动切片 + 开发方式分流）',
        outputs: [{ path: 'process/baseline.md', partition: 'process', label: '基线快照（改动切片/根级校验/调用链/风险点）', evidence: false }],
      },
      {
        id: 'clarify',
        label: 'IR→SR→AR 三级分解（需求分析含 DFX、功能/用例/场景分析）',
        outputs: [
          { path: 'process/clarify-ir-sr-ar.md', partition: 'process', label: '三级分解（意图/场景/原子项）', evidence: false },
          { path: 'process/decisions.json', partition: 'process', label: '业务决策记录' },
        ],
      },
    ],
    platformOutputs: [
      {
        path: 'delivery/',
        partition: 'delivery',
        label: '任务基底（存量仓种子 / 绿地脚手架，平台注入；逆向的对象而非阶段作业产物）',
        evidence: false,
        substrate: true,
      },
    ],
    exitGates: [{ kind: 'fact', deciderRole: 'requester', label: '业务事实门（成组质询，超时可降级待追认）', when: '仅当存在业务事实缺口' }],
    exitAction: 'gate',
    skills: [{ id: 'requirement', label: '需求 Skill', desc: '领域模块库 + 仓文档检索；需求验收与 DFX 口径' }],
  },
  architecture: {
    id: 'architecture',
    no: 2,
    label: '架构',
    shortLabel: '架构',
    desc: '架构分析、架构边界设计、业务流分析；架构师与 AI 共创，产出架构设计 SPEC（交付区）',
    automatable: true,
    exitCondition: '架构设计 SPEC 落盘交付区（架构分析/边界/业务流）；架构师拍板通过',
    jobs: [
      {
        id: 'architecture',
        label: '架构设计 SPEC（架构分析/边界设计/业务流分析）',
        outputs: [
          { path: 'process/architecture.draft.md', partition: 'process', label: '架构草稿（共创过程，不入 git）', evidence: false },
          { path: 'delivery/architecture.md', partition: 'delivery', label: '架构设计 SPEC' },
        ],
      },
    ],
    exitGates: [{ kind: 'fact', deciderRole: 'architect', label: '架构门（拍板后主权移交开发）' }],
    exitAction: 'gate',
    skills: [{ id: 'architecture', label: '架构 Skill', desc: '架构分析 · 边界设计 · 业务流分析' }],
  },
  design: {
    id: 'design',
    no: 3,
    label: '功能设计',
    shortLabel: '功能设计',
    desc: 'WHAT(spec)/HOW(design) 双产物 + 功能 FMEA；过程草稿不入 git；契约单源无漂移；拍板后主权移交',
    automatable: true,
    exitCondition: 'spec.md/design.md 落盘交付区（含实现设计/规格接口/功能 FMEA），契约入单源，开发拍板「方案通过」后主权移交开发',
    jobs: [
      {
        id: 'design',
        label: 'WHAT/HOW 双产物 + 契约单源',
        outputs: [
          { path: 'process/spec.draft.md', partition: 'process', label: 'spec 草稿（共创过程，不入 git）', evidence: false },
          { path: 'process/design.draft.md', partition: 'process', label: 'design 草稿（共创过程，不入 git）', evidence: false },
          { path: 'delivery/spec.md', partition: 'delivery', label: '规格 spec（WHAT）' },
          { path: 'delivery/design.md', partition: 'delivery', label: '设计 design（HOW，含功能 FMEA）' },
          { path: 'delivery/contract/api-contract.json', partition: 'delivery', label: '接口契约单源' },
        ],
      },
    ],
    platformOutputs: [
      { path: 'process/contract-view.md', partition: 'process', label: '契约只读派生视图（平台生成，漂移检测用）', evidence: false },
    ],
    exitGates: [{ kind: 'fact', deciderRole: 'owner', label: '方案确认门（拍板后主权移交开发）' }],
    exitAction: 'gate',
    skills: [{ id: 'design', label: '设计 Skill', desc: '实现设计 · 规格/接口 · 功能 FMEA · 契约单源' }],
  },
  'test-design': {
    id: 'test-design',
    no: 4,
    label: '测试设计',
    shortLabel: '测试设计',
    desc: '需求测试分析、测试策略分析、测试点设计；TSE 与 AI 共创产出测试 SPEC，出口连拍方案评审门收口设计段（评审人放行进编码）',
    automatable: true,
    exitCondition: '测试 SPEC 落盘交付区（测试分析/策略/测试点）；TSE 拍板通过；方案评审门对全证据链唯一拍板（通过放行进编码 / 驳回声明式回退）',
    jobs: [
      {
        id: 'test-design',
        label: '测试 SPEC（需求测试分析/策略分析/测试点设计）',
        outputs: [
          { path: 'process/test-design.draft.md', partition: 'process', label: '测试设计草稿（共创过程，不入 git）', evidence: false },
          { path: 'delivery/test-design.md', partition: 'delivery', label: '测试 SPEC' },
        ],
      },
    ],
    platformOutputs: [
      { path: 'process/review-report-r{round}.md', partition: 'process', label: '评审报告（每轮留痕，平台落盘）', evidence: false },
    ],
    exitGates: [
      { kind: 'fact', deciderRole: 'tse', label: '测试设计门（拍板后主权移交开发）' },
      { kind: 'review', deciderRole: 'reviewer', label: '方案评审门（设计段收口连拍第二门：全证据链唯一拍板，通过放行进编码）', when: '连拍：测试设计门通过后举' },
    ],
    exitAction: 'gate',
    skills: [{ id: 'test-design', label: '测试 Skill', desc: '需求测试分析 · 测试策略分层 · 测试点设计' }],
  },
  execute: {
    id: 'execute',
    no: 5,
    label: '执行与编码',
    shortLabel: '执行',
    desc: '全功能团队×N：AR 拆分 → 编码+UT+MST（自报以文件证据裁决）→ 多维评审+Critic+构建+测试 → 测试门 → MR 监听（反馈分诊/SHA 校验）→ 交付门拍板合入',
    automatable: true,
    exitCondition:
      '自报完成经文件证据裁决；各维独立判定 + Critic 终审通过；构建 + 测试通过；测试门认可；5 类反馈全消化（SHA 校验、幂等重放）、远端流水线真绿、合入方拍板合入',
    jobs: [
      {
        id: 'code',
        label: '实现（写/修双模式，自报完成以文件证据裁决）',
        outputs: [
          { path: 'delivery/src/', partition: 'delivery', label: '实现代码目录（动态清单，平台校验存在）', evidence: false },
          { path: 'delivery/test/', partition: 'delivery', label: '实现测试目录（动态清单）', evidence: false },
        ],
      },
      {
        id: 'ar-split',
        label: 'AR 拆分（并行父任务执行段）',
        outputs: [{ path: 'process/ar-split.md', partition: 'process', label: 'AR 拆分方案（可并行原子需求）' }],
      },
      {
        id: 'verify-review',
        label: '维度评审（多维并行，独立判定）',
        outputs: [{ path: 'process/review/dim-{dimension}-r{round}.md', partition: 'process', label: '维度评审报告（含分派 ID 溯源）', evidence: false }],
      },
      {
        id: 'verify-critic',
        label: 'Critic 终审（来源交叉校验）',
        outputs: [{ path: 'process/review/critic-r{round}.md', partition: 'process', label: 'Critic 终审报告', evidence: false }],
      },
      { id: 'build', label: '编译构建', outputs: [{ path: 'process/build-r{round}.log', partition: 'process', label: '构建日志' }] },
      { id: 'test', label: '测试执行', outputs: [{ path: 'process/test-r{round}.md', partition: 'process', label: '测试报告' }] },
      {
        id: 'deliver',
        label: 'MR 材料生成（一仓一 MR）',
        outputs: [{ path: 'process/mr-description.md', partition: 'process', label: 'MR 描述（spec/测试证据索引）', evidence: false }],
      },
    ],
    exitGates: [
      { kind: 'fact', deciderRole: 'owner', label: 'AR 拆分门（确认派发子任务）', when: '仅 arParallel 父任务' },
      { kind: 'test', deciderRole: 'tse', label: '聚合验收门（子任务全部合入后收口）', when: '仅 arParallel 父任务' },
      { kind: 'test', deciderRole: 'owner', label: '测试门（测试是否真跑、是否通过；证据同屏）', when: '连拍：编码+验证完成后举' },
      { kind: 'fact', deciderRole: 'owner', label: 'MR 反馈决策门（采纳修复 / 不采纳留痕）', when: '仅当 MR 反馈判定需人决策' },
      { kind: 'delivery', deciderRole: 'merger', label: '交付门（合入终态，永远人工不可代答）' },
    ],
    exitAction: 'watch',
    skills: [{ id: 'execute', label: 'Workflow / Skill', desc: 'AR 并行 · 编码+UT+MST · 自动化用例 · 多维评审 · MR 交付' }],
  },
  merged: {
    id: 'merged',
    no: 6,
    label: '已合入',
    shortLabel: '已合入',
    desc: '终态：合入方拍板 + 远端流水线真绿 + 反馈全消化；工作区回收归档',
    automatable: false,
    exitCondition: '终态（合入后发现问题仍可回退到执行段修复，见回退环）',
    jobs: [],
    exitGates: [],
    exitAction: 'terminal',
  },
}

/** 开发方式分流（场景1） */
export const DEV_MODES = ['greenfield', 'incremental', 'reverse-full', 'refactor'] as const
export type DevMode = (typeof DEV_MODES)[number]

export const DEV_MODE_LABEL: Record<DevMode, string> = {
  greenfield: '绿地新建（无需逆向，直达分解）',
  incremental: '维护型 hotfix（增量逆向 · git-diff 切片）',
  'reverse-full': '重构型（全量逆向：代码/架构/UI/业务/基础设施）',
  refactor: '重构调整（局部逆向 + 结构重排）',
}

/** 声明式回退目标（场景4：驳回时直接指定退回到哪一步，而非从头重跑） */
export const ROLLBACK_TARGETS = ['requirement', 'architecture', 'design', 'test-design', 'execute'] as const
export type RollbackTarget = (typeof ROLLBACK_TARGETS)[number]

export const ROLLBACK_TARGET_LABEL: Record<RollbackTarget, string> = {
  requirement: '需求（重分解/补事实）',
  architecture: '架构',
  design: '功能设计',
  'test-design': '测试设计',
  execute: '执行与编码（修复模式）',
}

export function isRollbackTarget(x: string): x is RollbackTarget {
  return (ROLLBACK_TARGETS as readonly string[]).includes(x)
}

// ==================== v1 → v2 兼容（存量事件流/产物索引里的旧阶段 id） ====================

/** v1 十步 → v2 六段映射（事件流 append-only 不改写，读取侧归一） */
export const LEGACY_STAGE_ALIAS: Record<string, StageId> = {
  intake: 'requirement',
  clarify: 'requirement',
  review: 'test-design',
  code: 'execute',
  verify: 'execute',
  deliver: 'execute',
}

/** 旧阶段 id 的展示名（历程回放用：历史词汇保持历史语义，不冒充新轨） */
export const LEGACY_STAGE_LABEL: Record<string, string> = {
  intake: '接单开张',
  clarify: '需求澄清',
  review: '方案评审',
  code: '写代码',
  verify: '构建验证',
  deliver: '交付合入',
}

/** 任意（含 v1）阶段 id → 当前轨 StageId；未知 id 原样透传（由调用方兜底展示） */
export function toCurrentStage(id: string): StageId {
  return (LEGACY_STAGE_ALIAS[id] ?? id) as StageId
}

// ==================== 阶段注册表读取（单源派生，消费端不再各自硬编码） ====================

/** 查阶段作业声明（job id = 引擎派发标识） */
export function stageJob(stage: StageId, jobId: string): StageJob | undefined {
  return STAGES[stage].jobs.find((j) => j.id === jobId)
}

/** 阶段全部产物声明（各作业摊平 + 平台落盘产物） */
export function stageOutputs(stage: StageId): StageOutput[] {
  return [...STAGES[stage].jobs.flatMap((j) => j.outputs), ...(STAGES[stage].platformOutputs ?? [])]
}

/** 证据面产物（进入出口门证据同屏；过程草稿/派生视图/动态清单不进） */
export function stageEvidenceOutputs(stage: StageId, jobIds?: string[]): StageOutput[] {
  const outputs =
    jobIds !== undefined
      ? STAGES[stage].jobs.filter((j) => jobIds.includes(j.id)).flatMap((j) => j.outputs)
      : stageOutputs(stage)
  return outputs.filter((o) => o.evidence !== false)
}

/** 渲染产物路径占位符（{round}/{dimension}；未提供的变量保持原样） */
export function renderOutputPath(p: string, vars: { round?: number | string; dimension?: string }): string {
  let out = p
  if (vars.round !== undefined) out = out.replace(/\{round\}/g, String(vars.round))
  if (vars.dimension !== undefined) out = out.replace(/\{dimension\}/g, vars.dimension)
  return out
}

/** 实际产物路径是否被该阶段声明覆盖（结尾 / 前缀匹配；{round}/{dimension} 占位按通配） */
export function isDeclaredOutputPath(stage: StageId, relPath: string): boolean {
  return stageOutputs(stage).some((o) => {
    if (o.path.endsWith('/')) return relPath.startsWith(o.path)
    const re = o.path
      .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
      .replace(/\{round\}/g, '\\d+')
      .replace(/\{dimension\}/g, '.+')
    return new RegExp(`^${re}$`).test(relPath)
  })
}
