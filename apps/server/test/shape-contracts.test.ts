/**
 * 形状契约回归测试（bug 类：引擎产物形状 ≠ 消费端假设 → worker 崩溃）
 *
 * 实锤三例（同款病）：
 *  - decisions.json：指令说数组，引擎写 {schemaVersion, decisions:[...]} 包装（已修：util 归一化）
 *  - api-contract.json（task-121）：renderContractView 假设 interfaces 是
 *    [{id,method,path}] 数组，引擎写 {接口名:{methods}} 对象映射 → TypeError 杀死 design 阶段
 *  - task-122：契约完全另形（pageRoutes/endpoints，无 interfaces）——读取端必须全部兼容
 *
 * 防线：指令钉形状（stage-prompts）+ 读取端归一化（normalizeStageOutput /
 * toStringArray / toRecordArray / renderContractView）双保险。
 */
import { describe, expect, it } from 'vitest'
import type { Playbook, StageId } from '@ai-platform/shared'
import { STAGES, STAGE_ORDER, isDeclaredOutputPath, renderOutputPath, stageEvidenceOutputs, stageOutputs } from '@ai-platform/shared'
import { toRecordArray, toStringArray } from '../src/domain/util.js'
import { normalizeStageOutput } from '../src/orchestrator/engine-runner.js'
import { renderInstruction } from '../src/engine/stage-prompts.js'
import { renderContractView } from '../src/orchestrator/workers.js'
import type { StageOutput } from '../src/engine/types.js'

describe('形状归一化助手', () => {
  it('toStringArray：数组 / 单串 / 逗号串 / 对象映射 / 空值全兼容', () => {
    expect(toStringArray(['a', 'b'])).toEqual(['a', 'b'])
    expect(toStringArray('a.md')).toEqual(['a.md'])
    expect(toStringArray('dsp-a, dsp-b,,', { splitComma: true })).toEqual(['dsp-a', 'dsp-b'])
    expect(toStringArray({ a: 'x.md', b: 'y.md' })).toEqual(['x.md', 'y.md'])
    expect(toStringArray(null)).toEqual([])
    expect(toStringArray(undefined)).toEqual([])
    expect(toStringArray('')).toEqual([])
    expect(toStringArray([1, 'ok', null])).toEqual(['ok']) // 非字符串项剔除，不崩
  })

  it('toRecordArray：数组原样过滤；对象映射键并入 keyField（自带字段优先）', () => {
    expect(toRecordArray<{ title: string }>([{ title: 'a' }, null, 'x'], 'title')).toEqual([{ title: 'a' }])
    expect(toRecordArray<{ title: string; summary: string }>({ ar1: { summary: '范围' }, ar2: { title: '自带', summary: 's' } }, 'title')).toEqual([
      { title: 'ar1', summary: '范围' }, // 无 title：键并入
      { title: '自带', summary: 's' }, // 有 title：自带字段优先（键不覆盖）
    ])
    expect(toRecordArray(null, 'title')).toEqual([])
  })
})

describe('stage-output 归一化（normalizeStageOutput）', () => {
  it('task-121 场景：各字段被引擎写歪后，消费端拿到的仍是声明形状', () => {
    const raw = {
      factQuestions: {
        q1: { digest: '摘要', materials: 'process/baseline.md' }, // 对象映射 + materials 单串
      },
      arItems: { ar1: { summary: '范围', acceptance: '验收' } }, // 对象映射（缺 title）
      dispatchIds: 'dsp-a,dsp-b', // 逗号串
      findings: '单条发现（字符串非数组）',
      verdict: 'FAIL',
    } as unknown as StageOutput
    const out = normalizeStageOutput(raw)
    expect(out.factQuestions).toEqual([
      { question: 'q1', digest: '摘要', preface: '', context: '', assumedAnswer: '', materials: ['process/baseline.md'] },
    ])
    expect(out.arItems).toEqual([{ title: 'ar1', summary: '范围', acceptance: '验收' }])
    expect(out.dispatchIds).toEqual(['dsp-a', 'dsp-b'])
    expect(out.findings).toEqual(['单条发现（字符串非数组）'])
    expect(out.verdict).toBe('FAIL')
  })

  it('空 / 非对象输入不崩；契约内字段原样透传', () => {
    expect(normalizeStageOutput(null)).toEqual({})
    const ok = normalizeStageOutput({ baselineReady: true, specReady: true, claimedFiles: ['delivery/src/a.ts'], done: true })
    expect(ok.baselineReady).toBe(true)
    expect(ok.claimedFiles).toEqual(['delivery/src/a.ts'])
  })
})

describe('契约视图渲染（renderContractView）', () => {
  it('HTTP 数组形态：渲染 method/path 行', () => {
    const view = renderContractView({ version: '2', service: 'svc', interfaces: [{ id: 'I1', method: 'GET', path: '/api/x' }] })
    expect(view).toContain('`GET /api/x`（I1）')
    expect(view).toContain('服务：svc')
  })

  it('task-121 对象映射形态：接口名/层/方法签名逐条渲染，不再 TypeError', () => {
    const view = renderContractView({
      interfaces: {
        IPointsRepository: {
          description: '积分仓储',
          layer: 'domain',
          methods: { findExpiring: { signature: '(n: number): Promise<X[]>', description: '查临期' } },
        },
      },
    })
    expect(view).toContain('**IPointsRepository**（domain）：积分仓储')
    expect(view).toContain('`findExpiring(n: number): Promise<X[]>`')
    expect(view).toContain('查临期')
  })

  it('task-122 另形（无 interfaces）：不崩并如实声明以单源为准', () => {
    const view = renderContractView({ contractVersion: 1, endpoints: {} })
    expect(view).toContain('单源未声明 interfaces 字段')
  })

  it('非对象输入不崩', () => {
    expect(typeof renderContractView('不是对象')).toBe('string')
    expect(typeof renderContractView(null)).toBe('string')
  })
})

describe('阶段注册表单源（STAGES 声明列一致性）', () => {
  it('每个阶段声明 exitAction/jobs/exitGates；作业 ID 不重复；产物路径与分区一致', () => {
    for (const sid of STAGE_ORDER) {
      const meta = STAGES[sid]
      expect(meta.exitAction, `${sid}.exitAction`).toBeTruthy()
      expect(Array.isArray(meta.jobs), `${sid}.jobs`).toBe(true)
      expect(Array.isArray(meta.exitGates), `${sid}.exitGates`).toBe(true)

      const ids = meta.jobs.map((j) => j.id)
      expect(new Set(ids).size, `${sid} 作业 ID 唯一`).toBe(ids.length)

      for (const o of stageOutputs(sid)) {
        expect(o.path.startsWith(`${o.partition}/`), `${sid} 产物 ${o.path} 应落在 ${o.partition}/ 分区`).toBe(true)
      }
    }

    // 出口门 kind 必须是四类门之一（与 GATE_META 对齐）
    for (const sid of STAGE_ORDER) {
      for (const g of STAGES[sid].exitGates) {
        expect(['fact', 'review', 'test', 'delivery'], `${sid} 出口门 kind`).toContain(g.kind)
      }
    }
  })

  it('关键门都有声明（十个 raiseGate 调用点的单源对齐）', () => {
    expect(STAGES.clarify.exitGates.map((g) => g.kind)).toContain('fact')
    expect(STAGES.architecture.exitGates.map((g) => g.kind)).toContain('fact')
    expect(STAGES.design.exitGates.map((g) => g.kind)).toContain('fact')
    expect(STAGES['test-design'].exitGates.map((g) => g.kind)).toContain('fact')
    expect(STAGES.review.exitGates.map((g) => g.kind)).toContain('review')
    expect(STAGES.code.exitGates.map((g) => g.kind)).toEqual(['fact', 'test']) // AR 拆分门 + 聚合验收门
    expect(STAGES.verify.exitGates.map((g) => g.kind)).toEqual(['test'])
    expect(STAGES.deliver.exitGates.map((g) => g.kind)).toEqual(['fact', 'delivery']) // 反馈决策门 + 交付门
    expect(STAGES.intake.exitGates).toEqual([]) // 双层自动门
    expect(STAGES.merged.exitGates).toEqual([]) // 终态
  })

  it('renderOutputPath：占位符渲染与保留', () => {
    expect(renderOutputPath('process/build-r{round}.log', { round: 3 })).toBe('process/build-r3.log')
    expect(renderOutputPath('process/review/dim-{dimension}-r{round}.md', { round: 2, dimension: '测试充分性' })).toBe(
      'process/review/dim-测试充分性-r2.md',
    )
    expect(renderOutputPath('process/test-r{round}.md', {})).toBe('process/test-r{round}.md') // 未提供的变量保持原样
  })

  it('isDeclaredOutputPath：精确/占位/目录前缀三类匹配', () => {
    expect(isDeclaredOutputPath('design', 'delivery/spec.md')).toBe(true)
    expect(isDeclaredOutputPath('design', 'delivery/unknown.md')).toBe(false)
    expect(isDeclaredOutputPath('verify', 'process/review/dim-测试充分性-r1.md')).toBe(true) // {dimension}/{round} 通配
    expect(isDeclaredOutputPath('verify', 'process/review/dim-x-r99.md')).toBe(true)
    expect(isDeclaredOutputPath('verify', 'process/review/dim-x-r1-extra.md')).toBe(false)
    expect(isDeclaredOutputPath('code', 'delivery/src/services/a.js')).toBe(true) // 目录前缀
    expect(isDeclaredOutputPath('code', 'delivery/src2/a.js')).toBe(false) // 前缀不误匹配
    expect(isDeclaredOutputPath('review', 'process/review-report-r2.md')).toBe(true) // 平台落盘产物也声明
    expect(isDeclaredOutputPath('intake', 'process/baseline.md')).toBe(true)
  })

  it('证据面产物过滤：过程草稿/派生视图/动态清单不进证据同屏', () => {
    const designEvidence = stageEvidenceOutputs('design').map((o) => o.path)
    expect(designEvidence).toEqual(['delivery/spec.md', 'delivery/design.md', 'delivery/contract/api-contract.json'])
    const verifyEvidence = stageEvidenceOutputs('verify', ['build', 'test']).map((o) => o.path)
    expect(verifyEvidence).toEqual(['process/build-r{round}.log', 'process/test-r{round}.md'])
    const allClarify = stageOutputs('clarify').map((o) => o.path)
    expect(allClarify).toContain('process/clarify-ir-sr-ar.md') // 全量含草稿，证据面不含
    expect(stageEvidenceOutputs('clarify').map((o) => o.path)).toEqual(['process/decisions.json'])
  })
})

describe('阶段指令与注册表一致（stage-prompts 单源）', () => {
  const VARS = { round: '1', dimension: '测试充分性', dispatchId: 'dsp-1' }

  function instructionOf(stage: StageId, jobId: string): string {
    return renderInstruction({
      task: { title: '演示任务', requirementText: '一句话需求', module: '会员中心', repo: 'membership-center', mode: 'incremental' },
      stage,
      job: jobId,
      injectedKnowledge: '',
      fixDirectives: [],
      vars: { ...VARS, title: '演示任务', requirementText: '一句话需求', module: '会员中心' },
      playbook: {} as Playbook,
    })
  }

  it('每个作业的指令都携带注册表声明的产物路径（占位符已渲染）与出口门说明', () => {
    for (const sid of STAGE_ORDER) {
      for (const job of STAGES[sid].jobs) {
        const instruction = instructionOf(sid, job.id)
        for (const o of job.outputs) {
          expect(instruction, `${sid}/${job.id} 指令应含声明产物 ${o.path}`).toContain(renderOutputPath(o.path, VARS))
        }
        expect(instruction, `${sid}/${job.id} 指令应含出口说明`).toContain('## 出口')
        expect(instruction).toContain('出口门')
      }
    }
  })

  it('产物分区说明随清单同屏（交付区入 git / 过程区不入 git）', () => {
    const design = instructionOf('design', 'design')
    expect(design).toContain('交付区，入 git')
    expect(design).toContain('过程区，不入 git')
    expect(design).toContain('delivery/contract/api-contract.json')
    expect(design).toContain('接口契约单源')

    const verify = instructionOf('verify', 'verify-review')
    expect(verify).toContain('process/review/dim-测试充分性-r1.md')
    expect(verify).toContain('测试门')
  })
})
