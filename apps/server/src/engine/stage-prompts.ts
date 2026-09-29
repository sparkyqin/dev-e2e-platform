import type { Playbook, StageId } from '@ai-platform/shared'
import { DECIDER_ROLE_LABEL, EXIT_ACTION_LABEL, STAGES, renderOutputPath, stageJob } from '@ai-platform/shared'
import { stageOutputPath, type StageWorkRequest } from './types.js'

/**
 * 真实引擎的阶段指令模板（L3 流程模板的一部分）
 *
 * 渲染要素：角色 + 阶段目的/退出条件 + 产物清单（阶段注册表单源）+ 出口门 + 注入知识 + 修复指令 + 结构化输出契约。
 * 结构化输出统一写 .flow/stage-output-{job}.json（按作业分文件，双轨并行安全）—— 平台只信文件证据（[机-交付事实远端真实]的自报裁决原则）。
 * 产物清单/出口门读 STAGES 注册表声明：与门证据同屏（workers）、模拟引擎、形状契约测试同一来源，改一处生效。
 */

export interface PromptInput {
  task: { title: string; requirementText: string; module: string; repo: string; mode: string }
  stage: StageId
  job: string
  injectedKnowledge: string
  fixDirectives: string[]
  vars: Record<string, string>
  playbook: Playbook
}

export function renderInstruction(input: PromptInput): string {
  const meta = STAGES[input.stage]
  const parts: string[] = []

  parts.push(`# 阶段作业：${meta.label}（${input.job}）`)
  parts.push(`## 任务\n- 标题：${input.task.title}\n- 模块：${input.task.module} / 仓：${input.task.repo}\n- 需求原文：${input.task.requirementText}\n- 开发方式：${input.task.mode}`)
  parts.push(`## 阶段目标\n${meta.desc}\n\n**退出条件（平台兜底）**：${meta.exitCondition}`)

  // 产物清单（阶段注册表声明 · 单源）：与门证据同屏/模拟引擎/形状契约测试共用同一份
  const outputs = stageJob(input.stage, input.job)?.outputs ?? []
  if (outputs.length > 0) {
    const partitionNote: Record<string, string> = { delivery: '交付区，入 git', process: '过程区，不入 git', knowledge: '知识区，可回流' }
    parts.push(
      `## 阶段产物（注册表声明，写这里、只写这里）\n${outputs
        .map((o) => `- \`${renderOutputPath(o.path, input.vars)}\` —— ${o.label}（${partitionNote[o.partition] ?? o.partition}）`)
        .join('\n')}`,
    )
  }

  // 出口（阶段注册表声明）：让引擎知道收口由谁拍板、产物主权归谁
  const gates = meta.exitGates.map((g) => `${g.label}（${DECIDER_ROLE_LABEL[g.deciderRole]}拍板${g.when ? `；${g.when}` : ''}）`).join('；')
  parts.push(`## 出口\n- 出口动作：${EXIT_ACTION_LABEL[meta.exitAction]}\n- 出口门：${gates || '无人工门（自动校验放行）'}`)

  if (input.injectedKnowledge.trim()) {
    parts.push(`## 注入知识（OKL：global/repos/forward 按需叠加）\n${input.injectedKnowledge}`)
  }

  if (input.fixDirectives.length > 0) {
    parts.push(`## 修复指令（修复模式）\n${input.fixDirectives.map((d, i) => `${i + 1}. ${d}`).join('\n')}`)
  }

  parts.push(jobInstruction(input))

  parts.push(
    [
      '## 通用约束',
      '- 只在当前工作区内操作；不执行 git 命令（平台统一管理版本）。',
      '- 过程草稿写 process/，交付物写 delivery/。',
      '- 如实报告：跑不通就写失败原因，不假装通过。',
      `- 完成后必须把结构化结果写入 ${stageOutputPath(input.job)}（字段见上），这是平台裁决依据。`,
    ].join('\n'),
  )

  return parts.join('\n\n')
}

function jobInstruction(input: PromptInput): string {
  const v = input.vars
  const so = stageOutputPath(input.job)
  switch (input.job) {
    case 'intake':
      return [
        '## 本次作业要求',
        '1. 逆向理解本次改动涉及的代码切片（含根级配置/入口），建立基线快照，写入 `process/baseline.md`。',
        '2. 基线需包含：改动切片清单、根级配置与入口的同步校验、调用链、风险点。',
        `3. \`${so}\` 写：\`{ "baselineReady": true }\`。`,
      ].join('\n')
    case 'clarify':
      return [
        '## 本次作业要求',
        '1. 把需求做三级分解（IR→SR→AR），按管理对象拆分 SR，落成可单点实现、可单点验收的原子项。',
        '2. 产物写入 `process/clarify-ir-sr-ar.md`；需求分析 SPEC 写入 `delivery/requirement.md`（内容口径：IR→SR→AR 汇总 + 验收原子项清单，解决方案 SE 视角）。',
        '3. 业务决策记录写入 `process/decisions.json`（必须是数组：`[{"topic":"主题","decision":"结论","ts":"ISO 时间"}]`，不要包一层对象）。',
        '4. 遇到无法从知识库推断的业务事实，不要编造：整理成问题清单。',
        `5. \`${so}\` 写：`,
        '```json',
        '{ "factQuestions": [{ "question": "成组质询（一次2-3题，独立作答）", "digest": "一句话摘要", "preface": "举卡前上文（为什么问这个）", "context": "提问前你的最后推理", "assumedAnswer": "超时降级用的默认假设", "materials": ["process/baseline.md"] }], "atomicsSummary": "原子项概览" }',
        '```',
      ].join('\n')
    case 'architecture':
      return [
        '## 本次作业要求',
        '1. 基于澄清产出的原子项（process/clarify-ir-sr-ar.md）与基线（process/baseline.md）做系统架构设计，产出架构设计 SPEC，写入 `delivery/architecture.md`。',
        '2. 必须包含三部分：架构分析（存量结构与约束）、架构边界设计（模块/服务职责与接口归属）、业务流分析（端到端时序与关键路径）。',
        '3. 与既有仓分层一致，不引入未经声明的新组件；边界冲突如实标注。',
        `4. \`${so}\` 写：\`{ "architectureReady": true }\`。`,
      ].join('\n')
    case 'design':
      return [
        '## 本次作业要求',
        '1. 在架构边界内（delivery/architecture.md）产出 WHAT/HOW 双产物：规格 `delivery/spec.md`、设计 `delivery/design.md`（含实现设计、规格/接口、功能 FMEA；过程草稿先写 process/）。',
        '2. 接口契约唯一真源写入 `delivery/contract/api-contract.json`（其余视图只读派生）。**顶层固定形状**：`{ "schemaVersion": 1, "service": "服务名", "interfaces": [...] }`；`interfaces` **必须是数组**，项形态二选一：HTTP 接口 `{"id","method","path","description"}`，或领域/仓储接口 `{"id","layer","methods":[{"name","signature","description"}]}`；实体与值对象放 `entities`/`valueObjects`（对象映射），不要塞进 interfaces。',
        `3. \`${so}\` 写：\`{ "specReady": true }\`。`,
      ].join('\n')
    case 'test-design':
      return [
        '## 本次作业要求',
        '1. 基于功能设计（delivery/spec.md / delivery/design.md）产出测试 SPEC，写入 `delivery/test-design.md`。',
        '2. 必须包含三部分：需求测试分析（验收标准↔用例映射）、测试策略分析（分层：UT/MST/自动化用例归属）、测试点设计（含边界与 DFX 口径）。',
        `3. \`${so}\` 写：\`{ "testDesignReady": true }\`。`,
      ].join('\n')
    case 'ar-split':
      return [
        '## 本次作业要求',
        '1. 基于 IR→SR→AR 三级分解（process/clarify-ir-sr-ar.md）与功能设计（delivery/spec.md），把需求拆为可并行执行的原子需求（AR）。',
        '2. 每个 AR 必须可独立实现、独立验收、独立提 MR；AR 间避免强顺序依赖（接口走契约单源）。',
        '3. 拆分方案写入 `process/ar-split.md`（表格：AR / 范围 / 验收标准）。',
        `4. \`${so}\` 写：`,
        '```json',
        '{ "arSplitReady": true, "arItems": [{ "title": "AR 标题", "summary": "范围一句话", "acceptance": "验收标准" }] }',
        '```',
      ].join('\n')
    case 'ar-design':
      return [
        '## 本次作业要求',
        '1. 编码前置：基于功能设计（delivery/spec.md / delivery/design.md）与契约（delivery/contract/api-contract.json），产出本 AR 的实现设计摘要，写入 `process/ar-design.md`。',
        '2. 摘要需包含：模块落位（在既有分层内的改动点）、接口实现要点（对齐契约单源）、测试要点（UT 覆盖哪些、MST 留给验证小节）。',
        '3. 不重写 spec/design，只做「设计 → 本 AR 实现」的聚焦衔接；发现设计缺口如实标注（不要替设计做决定）。',
        `4. \`${so}\` 写：\`{ "arDesignReady": true }\`。`,
      ].join('\n')
    case 'code':
      return [
        '## 本次作业要求',
        '1. 按 spec/design（与 AR 级设计摘要 process/ar-design.md）在 `delivery/src/` 下实现代码（修复模式则按修复指令改写）。',
        '2. 自报完成必须真实：claimedFiles 里列出的文件必须真实存在（平台会校验文件存在）。',
        `3. \`${so}\` 写：\`{ "claimedFiles": ["delivery/src/..."], "done": true, "summary": "..." }\`。`,
      ].join('\n')
    case 'test-case-design':
      return [
        '## 本次作业要求（测试轨①）',
        '1. 基于测试 SPEC（delivery/test-design.md）的测试点设计，展开为可执行用例集，写入 `process/test-cases.md`。',
        '2. 每个用例需含：用例编号（对应测试点）、前置条件、操作步骤、期望结果；边界与 DFX 口径逐点覆盖。',
        `3. \`${so}\` 写：\`{ "testCasesReady": true, "cases": 用例数 }\`。`,
      ].join('\n')
    case 'auto-case-design':
      return [
        '## 本次作业要求（测试轨②）',
        '1. 基于用例集（process/test-cases.md）做自动化设计：框架选型（对齐仓既有测试框架）、目录选址（delivery/test/auto/）、数据构造策略（fixture/工厂/内联）、分层归属（哪些用例自动化、哪些留 MST）。',
        '2. 设计写入 `process/auto-case-design.md`。',
        `3. \`${so}\` 写：\`{ "autoCasesReady": true }\`。`,
      ].join('\n')
    case 'auto-case-generate':
      return [
        '## 本次作业要求（测试轨③）',
        '1. 按自动化设计（process/auto-case-design.md）生成自动化用例代码，写入 `delivery/test/auto/`。',
        '2. 生成的用例必须可执行（对齐仓测试框架）；不可自动化的用例如实标注留 MST，不假装覆盖。',
        `3. \`${so}\` 写：\`{ "autoCasesReady": true, "files": ["delivery/test/auto/..."], "cases": 用例数 }\`。`,
      ].join('\n')
    case 'verify-review':
      return [
        '## 本次作业要求',
        `对维度「${v.dimension ?? '综合检视'}」做独立判定（PASS/WARN/FAIL）：`,
        '1. 评审范围必须与实现范围一致（delivery/ 下实际变更）。',
        `2. 报告写入 \`process/review/dim-${v.dimension ?? 'review'}-r${v.round ?? '1'}.md\`，正文必须包含分派 ID：${v.dispatchId ?? ''}（防伪溯源）。`,
        `3. \`${so}\` 写：\`{ "verdict": "PASS|WARN|FAIL", "findings": ["..."], "dispatchId": "..." }\`。`,
      ].join('\n')
    case 'verify-critic':
      return [
        '## 本次作业要求',
        'Critic 终审：汇总各维度报告（process/review/dim-*.md），做来源交叉校验（每份报告必须能溯源到分派记录）。',
        '1. 报告写入 `process/review/critic-r{轮次}.md`。',
        `2. \`${so}\` 写：\`{ "dispatchIds": ["..."], "verdict": "PASS|FAIL" }\`。`,
      ].join('\n')
    case 'build':
      return [
        '## 本次作业要求',
        '1. 在工作区内执行构建/编译（如 npm run build 或等价检查）；失败如实记录日志。',
        '2. 日志写入 `process/build-r{轮次}.log`。',
        `3. \`${so}\` 写：\`{ "ok": true|false, "log": "..." }\`。`,
      ].join('\n')
    case 'test':
      return [
        '## 本次作业要求',
        '1. 执行测试（优先 delivery/test/ 下用例，含 delivery/test/auto/ 自动化用例）；失败如实记录。',
        '2. 报告写入 `process/test-r{轮次}.md`。',
        `3. \`${so}\` 写：\`{ "ok": true|false, "cases": 数量, "log": "..." }\`。`,
      ].join('\n')
    case 'deliver':
      return [
        '## 本次作业要求',
        '1. 生成交付材料：MR 描述（含 spec/测试证据索引）写入 `process/mr-description.md`。',
        '2. 不要执行 git/push（平台统一操作）。',
        `3. \`${so}\` 写：\`{ "done": true }\`。`,
      ].join('\n')
    default:
      return `按阶段要求完成作业，并把结构化结果写入 ${so}。`
  }
}
