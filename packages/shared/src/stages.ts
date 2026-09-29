/**
 * 9 阶段主干定义（附录 A · 业务流主线 · 研发作业流版）
 *
 * 阶段 I/O 与退出条件由平台兜底（不可删），阶段内活动由 playbook 定制（可改）。
 * 阶段顺序：接单开张 → 需求澄清 → 系统架构设计 → 功能设计 → 测试设计 →
 * 方案评审 → 写代码 → 构建验证 → 交付合入 → 已合入(终态)
 *
 * 设计段（人与 AI 共创）：intake ~ test-design；执行段（AI 自动 + 人审核）：code ~ merged。
 */

export const STAGE_ORDER = [
  'intake',
  'clarify',
  'architecture',
  'design',
  'test-design',
  'review',
  'code',
  'verify',
  'deliver',
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
  terminal: '终态（合入后发现问题仍可回退编码）',
}

export const DECIDER_ROLE_LABEL: Record<StageExitGate['deciderRole'], string> = {
  requester: '需求方',
  architect: '架构师',
  owner: '责任人',
  tse: 'TSE',
  reviewer: '评审人',
  merger: '合入方',
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
}

export const STAGES: Record<StageId, StageMeta> = {
  intake: {
    id: 'intake',
    no: 1,
    label: '接单开张',
    shortLabel: '接单',
    desc: '对齐上下文、选定开发方式；存量场景先逆向建立基线再动手',
    automatable: true,
    exitCondition: '改动切片基线已建立（含根级配置/入口），经「程序规则校验 + AI 复核」双层自动门放行（不靠人拍）',
    jobs: [
      {
        id: 'intake',
        label: '基线建立（逆向理解改动切片 + 开发方式分流）',
        outputs: [
          { path: 'process/baseline.md', partition: 'process', label: '基线快照（改动切片/根级校验/调用链/风险点）', evidence: false },
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
    exitGates: [],
    exitAction: 'auto',
  },
  clarify: {
    id: 'clarify',
    no: 2,
    label: '需求澄清',
    shortLabel: '澄清',
    desc: '成组质询、消除歧义、记决策；一句话落成可验收原子项，可结构化为 IR→SR→AR 三级分解',
    automatable: true,
    exitCondition: '一句话已落成可验收原子项；业务事实有决策记录（事实门全决或降级标记待追认）',
    jobs: [
      {
        id: 'clarify',
        label: 'IR→SR→AR 三级分解（按管理对象拆分场景需求）',
        outputs: [
          { path: 'process/clarify-ir-sr-ar.md', partition: 'process', label: '三级分解（意图/场景/原子项）', evidence: false },
          { path: 'process/decisions.json', partition: 'process', label: '业务决策记录' },
        ],
      },
    ],
    exitGates: [
      { kind: 'fact', deciderRole: 'requester', label: '业务事实门（成组质询，超时可降级待追认）', when: '仅当存在业务事实缺口' },
    ],
    exitAction: 'gate',
  },
  architecture: {
    id: 'architecture',
    no: 3,
    label: '系统架构设计',
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
  },
  design: {
    id: 'design',
    no: 4,
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
  },
  'test-design': {
    id: 'test-design',
    no: 5,
    label: '测试设计',
    shortLabel: '测试设计',
    desc: '需求测试分析、测试策略分析、测试点设计；TSE 与 AI 共创，产出测试 SPEC（交付区）',
    automatable: true,
    exitCondition: '测试 SPEC 落盘交付区（测试分析/策略/测试点）；TSE 拍板通过',
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
    exitGates: [{ kind: 'fact', deciderRole: 'tse', label: '测试设计门（拍板后主权移交开发）' }],
    exitAction: 'gate',
  },
  review: {
    id: 'review',
    no: 6,
    label: '方案评审',
    shortLabel: '评审',
    desc: '对方案全证据链（基线/澄清/架构/设计/测试设计）评审：证据同屏（反盲签）下唯一拍板，通过放行进编码；驳回附理由声明式回退',
    automatable: false,
    exitCondition: '评审人做出唯一拍板（通过 / 驳回附理由声明式回退），不无限循环',
    jobs: [],
    platformOutputs: [
      { path: 'process/review-report-r{round}.md', partition: 'process', label: '评审报告（每轮留痕，平台落盘）', evidence: false },
    ],
    exitGates: [{ kind: 'review', deciderRole: 'reviewer', label: '方案评审门（铁门，证据同屏唯一拍板）' }],
    exitAction: 'gate',
  },
  code: {
    id: 'code',
    no: 7,
    label: '写代码',
    shortLabel: '编码',
    desc: 'AI 自动迭代写代码，人可随时接管（via=interrupt）；写/修双模式；自报完成以文件证据裁决',
    automatable: true,
    exitCondition: 'AI 自报完成且平台校验文件存在（不只信自报）',
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
    ],
    exitGates: [
      { kind: 'fact', deciderRole: 'owner', label: 'AR 拆分门（确认派发子任务）', when: '仅 arParallel 父任务' },
      { kind: 'test', deciderRole: 'tse', label: '聚合验收门（子任务全部合入后收口）', when: '仅 arParallel 父任务' },
    ],
    exitAction: 'self-report',
  },
  verify: {
    id: 'verify',
    no: 8,
    label: '构建验证',
    shortLabel: '验证',
    desc: '多维并行评审（各维独立判定）+ Critic 终审 + 编译 + 测试；对抗式修复闭环不无限打转',
    automatable: true,
    exitCondition: '各维独立判定 + Critic 终审通过；评审范围与实现范围一致；编译 + 测试通过',
    jobs: [
      {
        id: 'verify-review',
        label: '维度评审（多维并行，独立判定）',
        outputs: [
          { path: 'process/review/dim-{dimension}-r{round}.md', partition: 'process', label: '维度评审报告（含分派 ID 溯源）', evidence: false },
        ],
      },
      {
        id: 'verify-critic',
        label: 'Critic 终审（来源交叉校验）',
        outputs: [{ path: 'process/review/critic-r{round}.md', partition: 'process', label: 'Critic 终审报告', evidence: false }],
      },
      { id: 'build', label: '编译构建', outputs: [{ path: 'process/build-r{round}.log', partition: 'process', label: '构建日志' }] },
      { id: 'test', label: '测试执行', outputs: [{ path: 'process/test-r{round}.md', partition: 'process', label: '测试报告' }] },
    ],
    exitGates: [{ kind: 'test', deciderRole: 'owner', label: '测试门（测试是否真跑、是否通过；证据同屏）' }],
    exitAction: 'gate',
  },
  deliver: {
    id: 'deliver',
    no: 9,
    label: '交付合入',
    shortLabel: '交付',
    desc: '提 MR（监听态非终态）→ 反馈聚合 → 分诊 → 修复 → 重验 → 合入方拍板合入',
    automatable: true,
    exitCondition: '5 类反馈全消化（SHA 校验、幂等重放）、远端流水线真绿、合入方拍板合入',
    jobs: [
      {
        id: 'deliver',
        label: 'MR 材料生成（一仓一 MR）',
        outputs: [{ path: 'process/mr-description.md', partition: 'process', label: 'MR 描述（spec/测试证据索引）', evidence: false }],
      },
    ],
    exitGates: [
      { kind: 'fact', deciderRole: 'owner', label: 'MR 反馈决策门（采纳修复 / 不采纳留痕）', when: '仅当 MR 反馈判定需人决策' },
      { kind: 'delivery', deciderRole: 'merger', label: '交付门（合入终态，永远人工不可代答）' },
    ],
    exitAction: 'watch',
  },
  merged: {
    id: 'merged',
    no: 10,
    label: '已合入',
    shortLabel: '已合入',
    desc: '终态：合入方拍板 + 远端流水线真绿 + 反馈全消化；工作区回收归档',
    automatable: false,
    exitCondition: '终态（合入后发现问题仍可回退到编码，见回退环）',
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
export const ROLLBACK_TARGETS = ['clarify', 'architecture', 'design', 'test-design', 'code', 'verify'] as const
export type RollbackTarget = (typeof ROLLBACK_TARGETS)[number]

export const ROLLBACK_TARGET_LABEL: Record<RollbackTarget, string> = {
  clarify: '需求澄清',
  architecture: '系统架构设计',
  design: '功能设计',
  'test-design': '测试设计',
  code: '写代码（修复模式）',
  verify: '构建验证',
}

export function isRollbackTarget(x: string): x is RollbackTarget {
  return (ROLLBACK_TARGETS as readonly string[]).includes(x)
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
