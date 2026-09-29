import { promises as fs } from 'node:fs'
import path from 'node:path'
import { newId, sleep } from '../domain/util.js'
import { stageOutputPath, type AiEngine, type EngineEvent, type StageWorkRequest } from './types.js'

/**
 * 内置确定性模拟引擎
 *
 * 用途：无外部引擎时的 E2E 演示兜底 + 自动化测试基线（确定性、离线、零成本）。
 * 行为契约与真实引擎一致：在工作区写产物 + .flow/stage-output.json，过程以事件流吐出。
 * 剧本（scenario）注入典型摩擦：flaky-tool=场景5 接口试错；build-fail=场景9 构建失败重试。
 */

const DEMO_KEYWORDS = /积分|会员|提醒/

export class SimulatedEngine implements AiEngine {
  id = 'simulated'
  label = '内置模拟引擎（确定性）'

  async available(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: '内置引擎，始终可用（演示/测试兜底）' }
  }

  async *runStage(req: StageWorkRequest, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const delay = Number(process.env.SIM_DELAY ?? '60')
    const sessionId = newId('sim')
    yield { kind: 'session_started', sessionId }
    const ctx = { ws: req.workspaceDir, vars: req.vars, req }

    try {
      switch (req.job) {
        case 'intake':
          yield* this.jobIntake(ctx, delay, signal)
          break
        case 'clarify':
          yield* this.jobClarify(ctx, delay, signal)
          break
        case 'architecture':
          yield* this.jobArchitecture(ctx, delay, signal)
          break
        case 'design':
          yield* this.jobDesign(ctx, delay, signal)
          break
        case 'test-design':
          yield* this.jobTestDesign(ctx, delay, signal)
          break
        case 'ar-split':
          yield* this.jobArSplit(ctx, delay, signal)
          break
        case 'ar-design':
          yield* this.jobArDesign(ctx, delay, signal)
          break
        case 'code':
          yield* this.jobCode(ctx, delay, signal)
          break
        case 'test-case-design':
          yield* this.jobTestCaseDesign(ctx, delay, signal)
          break
        case 'auto-case-design':
          yield* this.jobAutoCaseDesign(ctx, delay, signal)
          break
        case 'auto-case-generate':
          yield* this.jobAutoCaseGenerate(ctx, delay, signal)
          break
        case 'verify-review':
          yield* this.jobVerifyReview(ctx, delay, signal)
          break
        case 'verify-critic':
          yield* this.jobVerifyCritic(ctx, delay, signal)
          break
        case 'build':
          yield* this.jobBuild(ctx, delay, signal)
          break
        case 'test':
          yield* this.jobTest(ctx, delay, signal)
          break
        case 'deliver':
          yield* this.jobDeliver(ctx, delay, signal)
          break
        default:
          yield { kind: 'assistant_message', text: `（模拟）未知作业 ${req.job}，跳过` }
      }
      if (signal.aborted) {
        yield { kind: 'session_ended', reason: 'interrupted', summary: '被人中断（via=interrupt）' }
        return
      }
      yield { kind: 'session_ended', reason: 'completed', summary: `阶段作业 ${req.job} 完成` }
    } catch (err) {
      yield { kind: 'session_ended', reason: 'failed', summary: `引擎异常：${(err as Error).message}` }
    }
  }

  // ---------- 各阶段作业 ----------

  private async *jobIntake(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars } = ctx
    const mode = vars.mode ?? 'incremental'
    yield { kind: 'assistant_message', text: `开发方式分流：${mode}。开始逆向理解改动切片，建立基线（过程区，不入 git）。` }
    const files = ['src/index.js', 'src/config.js', 'src/services/points-service.js', 'src/services/push-legacy-client.js', 'src/repositories/user-repo.js']
    for (const f of files) {
      if (signal.aborted) return
      yield { kind: 'tool_call', callId: newId('tc'), tool: 'read_file', input: f }
      await sleep(delay)
      yield { kind: 'tool_result', callId: newId('tr'), tool: 'read_file', ok: true, summary: `已读取 ${f}（存量切片）` }
    }
    const baseline = buildBaseline(vars, files)
    await writeFileSafe(path.join(ws, 'process', 'baseline.md'), baseline)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_baseline', ok: true, summary: 'process/baseline.md 已写入（基线快照）' }
    // 根级配置/入口改动时间同步校验
    yield { kind: 'tool_call', callId: newId('tc'), tool: 'verify_root_sync', input: 'package.json / src/index.js' }
    await sleep(delay)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'verify_root_sync', ok: true, summary: '根级配置与入口改动时间同步校验通过' }
    await writeStageOutput(ws, 'intake', { baselineReady: true })
  }

  private async *jobClarify(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars } = ctx
    yield {
      kind: 'assistant_message',
      text: `注入完成：业务模块库 + 仓文档（${vars.title}）。开始 IR→SR→AR 三级分解，按管理对象拆分场景需求。`,
    }
    yield { kind: 'tool_call', callId: newId('tc'), tool: 'retrieve_knowledge', input: '会员中心模块库 + 仓文档' }
    await sleep(delay)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'retrieve_knowledge', ok: true, summary: '模块库命中：积分域（获取/消耗/过期）、推送域（App 内信/短信）' }

    const isDemo = DEMO_KEYWORDS.test(`${vars.title ?? ''}${vars.requirementText ?? ''}`)
    const doc = isDemo ? demoClarifyDoc(vars) : genericClarifyDoc(vars)
    await writeFileSafe(path.join(ws, 'process', 'clarify-ir-sr-ar.md'), doc)
    const spec = isDemo ? demoRequirementSpec(vars) : genericRequirementSpec(vars)
    await writeFileSafe(path.join(ws, 'delivery', 'requirement.md'), spec)
    await writeFileSafe(
      path.join(ws, 'process', 'decisions.json'),
      JSON.stringify([{ topic: '分解', decision: 'IR→SR→AR 已落成，原子项可单点验收', ts: new Date().toISOString() }], null, 2),
    )
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_decomposition', ok: true, summary: 'process/clarify-ir-sr-ar.md + delivery/requirement.md 已写入（三级分解 + 需求分析 SPEC）' }

    if (isDemo) {
      yield {
        kind: 'assistant_message',
        text: '分解中遇到业务事实缺口：「积分过期规则」在模块库中没有定义，影响提醒计算与推送时点。举事实门请需求方确认（超时将降级为默认假设并标记待追认）。',
      }
      await writeStageOutput(ws, 'clarify', {
        factQuestions: [
          {
            question: '会员积分的过期规则是什么？\n1) 按自然月过期还是滚动 365 天？\n2) 清零时点是月末当日还是次月 1 日？\n3) 过期前多久算「即将过期」（30 天口径以哪个时间为准）？',
            digest: '积分过期规则 → 影响提醒计算窗口与推送时点（成组质询，3 题独立作答）',
            preface: '正在把需求分解为可验收原子项：已建立基线、已注入会员中心业务模块库与仓文档；分解到「提醒计算」场景时发现过期规则未定义。',
            context: '根据模块库，积分有获取/消耗/过期三类动作；过期动作由定时任务驱动，但规则参数（周期/清零时点/口径）不在文档中，需要业务事实确认后才能落原子项。',
            assumedAnswer: '积分按自然月过期，次月 1 日清零；「即将过期」= 未来 30 天内将清零的积分（默认假设，待人工追认）',
            materials: ['process/baseline.md', 'process/clarify-ir-sr-ar.md'],
          },
        ],
        atomicsSummary: 'AR1 过期规则参数落地；AR2 即将过期积分查询接口；AR3 定时扫描与用户筛选；AR4 推送发送（App 内信 + 短信降级）；AR5 幂等与重试',
      })
    } else {
      await writeStageOutput(ws, 'clarify', {
        factQuestions: [
          {
            question: `「${vars.title}」的验收口径需要确认：\n1) 影响范围（模块/接口）？\n2) 验收标准中最关键的 1-2 条？`,
            digest: '验收口径确认（成组质询）',
            preface: '已建立基线并注入仓文档；分解到验收口径时存在歧义。',
            context: '需求缺乏可验收边界，需要需求方补充事实，避免原子项落错范围。',
            assumedAnswer: '以需求原文描述为准，验收口径由需求方事后追认（默认假设）',
            materials: ['process/baseline.md'],
          },
        ],
        atomicsSummary: 'AR1 范围界定；AR2 核心实现；AR3 验收与回归',
      })
    }
  }

  private async *jobArchitecture(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars } = ctx
    const isDemo = DEMO_KEYWORDS.test(`${vars.title ?? ''}${vars.requirementText ?? ''}`)
    yield { kind: 'assistant_message', text: '进入系统架构设计：基于原子项与基线做架构分析、边界设计与业务流分析；与既有仓分层保持一致。' }
    yield { kind: 'tool_call', callId: newId('tc'), tool: 'analyze_structure', input: 'membership-center 分层与依赖' }
    await sleep(delay)
    yield {
      kind: 'tool_result',
      callId: newId('tr'),
      tool: 'analyze_structure',
      ok: true,
      summary: '存量分层 services/repositories；推送依赖消息中心（跨服务调用经网关限流）',
    }
    const doc = isDemo ? demoArchitectureDoc(vars) : genericArchitectureDoc(vars)
    await writeFileSafe(path.join(ws, 'process', 'architecture.draft.md'), doc)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_draft', ok: true, summary: '架构草稿已写入 process/architecture.draft.md（不入 git）' }
    await sleep(delay)
    await writeFileSafe(path.join(ws, 'delivery', 'architecture.md'), doc)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_delivery', ok: true, summary: '交付物落盘 delivery/architecture.md（架构设计 SPEC）' }
    await writeStageOutput(ws, 'architecture', { architectureReady: true })
  }

  private async *jobDesign(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars } = ctx
    yield {
      kind: 'assistant_message',
      text: '进入功能设计：在架构边界内由设计师主笔 WHAT（spec）与 HOW（design，含功能 FMEA），过程草稿留过程区，交付物待拍板后落交付区；契约入单源。',
    }
    const isDemo = DEMO_KEYWORDS.test(`${vars.title ?? ''}${vars.requirementText ?? ''}`)
    const spec = isDemo ? demoSpec(vars) : genericSpec(vars)
    const design = isDemo ? demoDesign(vars) : genericDesign(vars)
    await writeFileSafe(path.join(ws, 'process', 'spec.draft.md'), spec)
    await writeFileSafe(path.join(ws, 'process', 'design.draft.md'), design)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_drafts', ok: true, summary: '过程草稿已写入 process/（不入 git）' }
    await sleep(delay)
    // 拍板后落交付区（模拟「方案通过」后动作；平台在门决策后同样会确认主权移交）
    await writeFileSafe(path.join(ws, 'delivery', 'spec.md'), spec)
    await writeFileSafe(path.join(ws, 'delivery', 'design.md'), design)
    const contract = isDemo ? demoContract() : genericContract(vars)
    await writeJsonSafe(path.join(ws, 'delivery', 'contract', 'api-contract.json'), contract)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_delivery', ok: true, summary: '交付物落盘 delivery/；契约入单源 api-contract.json' }
    await writeStageOutput(ws, 'design', { specReady: true })
  }

  private async *jobTestDesign(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars } = ctx
    const isDemo = DEMO_KEYWORDS.test(`${vars.title ?? ''}${vars.requirementText ?? ''}`)
    yield {
      kind: 'assistant_message',
      text: '进入测试设计：基于功能 spec/design 做需求测试分析、测试策略分析与测试点设计（TSE 主笔，覆盖验收标准与边界口径）。',
    }
    yield { kind: 'tool_call', callId: newId('tc'), tool: 'map_acceptance', input: 'spec 验收标准 ↔ 测试点' }
    await sleep(delay)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'map_acceptance', ok: true, summary: '验收标准 5 条 ↔ 测试点 7 个（含边界：月末切换/零余额/历史遗留/幂等）' }
    const doc = isDemo ? demoTestDesign() : genericTestDesign(vars)
    await writeFileSafe(path.join(ws, 'process', 'test-design.draft.md'), doc)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_draft', ok: true, summary: '测试设计草稿已写入 process/（不入 git）' }
    await sleep(delay)
    await writeFileSafe(path.join(ws, 'delivery', 'test-design.md'), doc)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_delivery', ok: true, summary: '交付物落盘 delivery/test-design.md（测试 SPEC）' }
    await writeStageOutput(ws, 'test-design', { testDesignReady: true })
  }

  private async *jobArSplit(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars } = ctx
    const isDemo = DEMO_KEYWORDS.test(`${vars.title ?? ''}${vars.requirementText ?? ''}`)
    yield {
      kind: 'assistant_message',
      text: '执行段 AR 拆分：从 IR→SR→AR 三级分解与功能设计中切分可并行执行的原子需求（可独立实现/独立验收/独立 MR）。',
    }
    yield { kind: 'tool_call', callId: newId('tc'), tool: 'plan_ar_split', input: 'process/clarify-ir-sr-ar.md + delivery/spec.md' }
    await sleep(delay)
    const items = isDemo ? demoArItems() : genericArItems(vars)
    yield {
      kind: 'tool_result',
      callId: newId('tr'),
      tool: 'plan_ar_split',
      ok: true,
      summary: `拆分 ${items.length} 个 AR：${items.map((it) => it.title).join(' / ')}`,
    }
    const doc = arSplitDoc(items)
    await writeFileSafe(path.join(ws, 'process', 'ar-split.md'), doc)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_draft', ok: true, summary: `process/ar-split.md 已写入（${items.length} 个 AR 拆分方案）` }
    await writeStageOutput(ws, 'ar-split', { arSplitReady: true, arItems: items })
  }

  private async *jobArDesign(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars, req } = ctx
    const isDemo = DEMO_KEYWORDS.test(`${vars.title ?? ''}${vars.requirementText ?? ''}`)
    const arTitle = vars.arTitle ?? ''
    yield {
      kind: 'assistant_message',
      text: `AR 级设计（编码前置）：${arTitle ? `本 AR「${arTitle}」` : '本任务'}基于 spec/design 与契约单源聚焦实现设计摘要。`,
    }
    yield { kind: 'tool_call', callId: newId('tc'), tool: 'read_design', input: 'delivery/spec.md + delivery/design.md + delivery/contract/api-contract.json' }
    await sleep(delay)
    if (signal.aborted) return
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'read_design', ok: true, summary: '设计产物与契约已读取（不重写设计，只做实现衔接）' }
    const doc = isDemo ? demoArDesignDoc(arTitle) : genericArDesignDoc(arTitle || vars.title || '')
    await writeFileSafe(path.join(ws, 'process', 'ar-design.md'), doc)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_ar_design', ok: true, summary: 'process/ar-design.md 已写入（AR 级实现设计摘要）' }
    await writeStageOutput(ws, req.job, { arDesignReady: true })
  }

  private async *jobCode(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars, req } = ctx
    const isDemo = DEMO_KEYWORDS.test(`${vars.title ?? ''}${vars.requirementText ?? ''}`)
    const repair = req.fixDirectives.length > 0

    // 场景5 剧本：无修复指令时连续试错不存在的旧接口 → 健康徽标转黄，主动叫人
    if (req.scenario === 'flaky-tool' && !repair) {
      yield { kind: 'assistant_message', text: '开始实现：先接推送通道，尝试存量 LegacyPushClient…' }
      for (let i = 1; i <= 3; i++) {
        yield { kind: 'tool_call', callId: newId('tc'), tool: 'invoke_api', input: `LegacyPushClient.send(payload#${i})` }
        await sleep(delay)
        yield { kind: 'tool_result', callId: newId('tr'), tool: 'invoke_api', ok: false, summary: `Error: LegacyPushClient.send is not a function（接口不存在，第 ${i} 次）` }
      }
      await writeStageOutput(ws, 'code', { done: false, summary: '推送接口反复失败，疑似存量接口已下线，需人确认替代接口' })
      return
    }

    yield {
      kind: 'assistant_message',
      text: repair
        ? `修复模式：按修复指令改写代码（${req.fixDirectives.length} 条），改完回请原维度复检。`
        : '写模式：按 spec/design 实现代码，自报完成将以文件存在校验裁决。',
    }
    const files = isDemo ? demoCodeFiles(repair, req.fixDirectives) : genericCodeFiles(vars)
    for (const f of files) {
      if (signal.aborted) return
      yield { kind: 'tool_call', callId: newId('tc'), tool: 'write_file', input: f.path }
      await sleep(delay)
      await writeFileSafe(path.join(ws, f.path), f.content)
      yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_file', ok: true, summary: `${f.path}（${f.content.length} B）` }
    }
    await writeStageOutput(ws, 'code', {
      claimedFiles: files.map((f) => f.path),
      done: true,
      summary: repair ? '修复完成，等待原维度复检' : '实现完成，进入验证',
    })
  }

  private async *jobTestCaseDesign(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars, req } = ctx
    const isDemo = DEMO_KEYWORDS.test(`${vars.title ?? ''}${vars.requirementText ?? ''}`)
    yield {
      kind: 'assistant_message',
      text: '测试轨①：基于测试 SPEC 的测试点展开可执行用例集（前置/步骤/期望，边界逐点覆盖）。',
    }
    yield { kind: 'tool_call', callId: newId('tc'), tool: 'read_test_design', input: 'delivery/test-design.md' }
    await sleep(delay)
    if (signal.aborted) return
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'read_test_design', ok: true, summary: '测试点已读取（验收标准↔测试点映射）' }
    const cases = isDemo ? 7 : 3
    const doc = isDemo ? demoTestCasesDoc() : genericTestCasesDoc()
    await writeFileSafe(path.join(ws, 'process', 'test-cases.md'), doc)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_test_cases', ok: true, summary: `process/test-cases.md 已写入（${cases} 个用例）` }
    await writeStageOutput(ws, req.job, { testCasesReady: true, cases })
  }

  private async *jobAutoCaseDesign(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, req } = ctx
    yield {
      kind: 'assistant_message',
      text: '测试轨②：自动化用例 DESIGN——框架对齐仓既有测试框架，选址 delivery/test/auto/，分层归属（可自动化/MST）。',
    }
    yield { kind: 'tool_call', callId: newId('tc'), tool: 'plan_auto_cases', input: 'process/test-cases.md → 框架/选址/数据构造' }
    await sleep(delay)
    if (signal.aborted) return
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'plan_auto_cases', ok: true, summary: '自动化设计完成（框架对齐/目录选址/数据构造策略）' }
    await writeFileSafe(path.join(ws, 'process', 'auto-case-design.md'), autoCaseDesignDoc())
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_auto_design', ok: true, summary: 'process/auto-case-design.md 已写入' }
    await writeStageOutput(ws, req.job, { autoCasesReady: true })
  }

  private async *jobAutoCaseGenerate(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars, req } = ctx
    const isDemo = DEMO_KEYWORDS.test(`${vars.title ?? ''}${vars.requirementText ?? ''}`)
    yield {
      kind: 'assistant_message',
      text: '测试轨③：按自动化设计生成可执行用例代码（delivery/test/auto/），不可自动化的留 MST 如实标注。',
    }
    const files = isDemo ? demoAutoCaseFiles() : genericAutoCaseFiles()
    for (const f of files) {
      if (signal.aborted) return
      yield { kind: 'tool_call', callId: newId('tc'), tool: 'write_file', input: f.path }
      await sleep(delay)
      await writeFileSafe(path.join(ws, f.path), f.content)
      yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_file', ok: true, summary: `${f.path}（${f.content.length} B）` }
    }
    await writeStageOutput(ws, req.job, { autoCasesReady: true, files: files.map((f) => f.path), cases: files.length })
  }

  private async *jobVerifyReview(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars, req } = ctx
    const dimension = vars.dimension ?? '综合检视'
    const dispatchId = vars.dispatchId ?? ''
    const round = vars.round ?? '1'
    // 复检轮判定：轮次 > 1，或本轮带有修复指令（指令可能直接注入验证阶段）
    const isRecheck = req.fixDirectives.length > 0 || Number(round) > 1
    yield { kind: 'assistant_message', text: `维度评审「${dimension}」独立判定（分派 ${dispatchId}，第 ${round} 轮${isRecheck ? '复检' : ''}）。` }
    yield { kind: 'tool_call', callId: newId('tc'), tool: 'review_scope', input: `dispatch:${dispatchId}` }
    await sleep(delay)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'review_scope', ok: true, summary: '评审范围与实现范围一致（scope 校验通过）' }

    // 首轮「测试充分性」FAIL（边界没测），复检轮全绿 —— 对抗式修复闭环剧本
    const failFirst = dimension.includes('测试充分性') && !isRecheck
    const verdict: 'PASS' | 'WARN' | 'FAIL' = failFirst ? 'FAIL' : 'PASS'
    const findings = failFirst
      ? ['未覆盖自然月边界（月末 23:59 → 次月 1 日 00:00 切换）', '未覆盖零余额用户（不应推送）', '未覆盖历史遗留积分（过期口径）']
      : isRecheck
        ? ['复检通过：边界用例（月末切换/零余额/历史遗留）已补齐']
        : ['无阻断问题']
    const report = `# 维度评审报告：${dimension}\n\n- 分派 ID：${dispatchId}（防伪溯源）\n- 结论：${verdict}\n\n## 发现\n${findings.map((f) => `- ${f}`).join('\n')}\n`
    await writeFileSafe(path.join(ws, 'process', 'review', `dim-${sanitize(dimension)}-r${round}.md`), report)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_report', ok: true, summary: `${dimension} → ${verdict}（报告含 dispatchId 溯源）` }
    await writeStageOutput(ws, 'verify-review', { verdict, findings, dispatchId })
  }

  private async *jobVerifyCritic(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars } = ctx
    const dispatchIds = (vars.dispatchIds ?? '').split(',').filter(Boolean)
    const verdicts = (vars.verdicts ?? '').split(',').filter(Boolean)
    // Critic 忠实汇总：任一维度 FAIL → 终审 FAIL（与各维结论一致，不越权翻案也不隐瞒）
    const verdict: 'PASS' | 'FAIL' = verdicts.includes('FAIL') ? 'FAIL' : 'PASS'
    yield { kind: 'assistant_message', text: `Critic 终审：汇总 ${dispatchIds.length} 个维度报告，做来源交叉校验（防伪）。任一维 FAIL → 终审 FAIL。` }
    yield { kind: 'tool_call', callId: newId('tc'), tool: 'cross_check', input: dispatchIds.join(',') }
    await sleep(delay)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'cross_check', ok: true, summary: `全部 ${dispatchIds.length} 份报告均可溯源到分派记录（防伪校验通过）` }
    const round = vars.round ?? '1'
    await writeFileSafe(
      path.join(ws, 'process', 'review', `critic-r${round}.md`),
      `# Critic 终审报告（第 ${round} 轮）\n\n- 覆盖分派：${dispatchIds.join(', ')}\n- 交叉校验：通过（报告↔分派记录一致）\n- 各维结论：${verdicts.join(' / ') || '—'}\n- 综合裁决：${verdict}\n`,
    )
    await writeStageOutput(ws, 'verify-critic', { dispatchIds, verdict })
  }

  private async *jobBuild(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars, req } = ctx
    const round = vars.round ?? '1'
    yield { kind: 'tool_call', callId: newId('tc'), tool: 'run_build', input: `npm run build (round ${round})` }
    await sleep(delay)
    // 场景9 剧本：无修复指令时构建持续失败（重试预算耗尽 → 停止升级，不烧资源）
    if (req.scenario === 'build-fail' && req.fixDirectives.length === 0) {
      const log = `> npm run build\n✗ CompileError: cannot resolve module '../push-legacy-client' from src/services/expiry-reminder.js\n构建失败（第 ${round} 次重试）`
      await writeFileSafe(path.join(ws, 'process', `build-r${round}.log`), log)
      yield { kind: 'tool_result', callId: newId('tr'), tool: 'run_build', ok: false, summary: '构建失败：模块解析错误（如实记录，不假装通过）' }
      await writeStageOutput(ws, 'build', { ok: false, log })
      return
    }
    const log = `> npm run build\n✓ built in 1.2s（${req.fixDirectives.length ? '修复后' : ''}构建通过）`
    await writeFileSafe(path.join(ws, 'process', `build-r${round}.log`), log)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'run_build', ok: true, summary: '构建通过' }
    await writeStageOutput(ws, 'build', { ok: true, log })
  }

  private async *jobTest(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars } = ctx
    const round = vars.round ?? '1'
    yield { kind: 'tool_call', callId: newId('tc'), tool: 'run_tests', input: `npm test (round ${round})` }
    await sleep(delay)
    const cases = 14
    const report = `# 测试报告（第 ${round} 轮）\n\n- 用例：${cases}（含边界：月末切换 / 零余额 / 历史遗留 / 幂等重放）\n- 结果：全部通过\n- 证据：远端流水线将复跑（SHA 关联）\n`
    await writeFileSafe(path.join(ws, 'process', `test-r${round}.md`), report)
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'run_tests', ok: true, summary: `${cases} 用例全部通过` }
    await writeStageOutput(ws, 'test', { ok: true, cases, log: report })
  }

  private async *jobDeliver(ctx: Ctx, delay: number, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const { ws, vars } = ctx
    yield { kind: 'assistant_message', text: '生成交付材料：MR 描述（含 spec/测试证据索引）。一仓一 MR。' }
    await writeFileSafe(
      path.join(ws, 'process', 'mr-description.md'),
      `## ${vars.title ?? '变更'}\n\n- 关联 spec：delivery/spec.md\n- 测试证据：process/test-r1.md（远端流水线以 SHA 复核）\n- 评审：见 process/review/\n`,
    )
    yield { kind: 'tool_result', callId: newId('tr'), tool: 'write_mr_desc', ok: true, summary: 'MR 描述已生成' }
    await writeStageOutput(ws, 'deliver', { done: true })
  }
}

// ---------- 上下文与工具 ----------

interface Ctx {
  ws: string
  vars: Record<string, string>
  req: StageWorkRequest
}

async function writeFileSafe(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, 'utf8')
}

async function writeJsonSafe(file: string, data: unknown): Promise<void> {
  await writeFileSafe(file, JSON.stringify(data, null, 2))
}

async function writeStageOutput(ws: string, job: string, out: Record<string, unknown>): Promise<void> {
  await writeJsonSafe(path.join(ws, stageOutputPath(job).replace(/^\.flow\//, '.flow' + path.sep)), out)
}

function sanitize(s: string): string {
  return s.replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
}

// ---------- 内容生成（会员积分过期提醒 · 演示剧本） ----------

function buildBaseline(vars: Record<string, string>, files: string[]): string {
  const mode = vars.mode ?? 'incremental'
  const head = `# 基线快照（过程区 · 不入 git）\n\n- 任务：${vars.title ?? ''}\n- 仓：${vars.repo ?? ''} / 模块：${vars.module ?? ''}\n- 开发方式：${mode}\n- 建立时间：${new Date().toISOString()}\n\n`
  if (mode === 'greenfield') {
    return head + `## 绿地新建\n\n无存量逆向需求，直达分解。\n`
  }
  if (mode === 'incremental') {
    return (
      head +
      `## 增量逆向（git-diff 切片）\n\n自 tag v2.3.0 以来涉及 ${files.length} 个文件的改动切片：\n${files.map((f) => `- ${f}`).join('\n')}\n\n## 根级配置/入口\n\n- package.json（依赖无变更）\n- src/index.js（入口路由，需挂载新定时任务）\n\n## 调用链\n\nindex.js → points-service.js（积分域） → user-repo.js（用户筛选）\n推送依赖 push-legacy-client.js（疑似已下线，设计阶段确认替代）\n\n## 风险点\n\n1. push-legacy-client 未见维护记录，接口可用性存疑\n2. 定时任务与现有 cron 的并发窗口\n`
    )
  }
  return (
    head +
    `## 全量逆向\n\n### 代码\n${files.map((f) => `- ${f}`).join('\n')}\n\n### 架构\n单体 Node 服务，模块按领域分层（services/repositories）。\n\n### UI\n后台管理侧无本需求相关界面。\n\n### 业务\n积分域：获取/消耗/过期三类动作；过期由定时任务驱动。\n\n### 基础设施\ncron + 队列；推送网关（App 内信/短信）。\n\n## 综合（跨服务追调用链）\n会员中心 → 消息中心（推送）→ 网关（限流）。改动需在综合阶段收口。\n`
  )
}

function demoClarifyDoc(vars: Record<string, string>): string {
  return `# 三级分解 IR → SR → AR（过程区）\n\n## IR 意图需求\n${vars.requirementText ?? '会员积分过期提醒'}\n\n## SR 场景需求（按管理对象拆分）\n\n### SR1 积分（管理对象：积分账户）\n计算「即将过期」积分集合，规则参数待事实门确认。\n\n### SR2 推送（管理对象：消息/渠道）\n对命中用户发送提醒；渠道与降级策略在设计阶段定。\n\n### SR3 任务（管理对象：定时任务）\n自然月末扫描，幂等可重放。\n\n## AR 原子需求（可单点实现、可单点验收）\n\n| # | 原子项 | 验收标准 |\n|---|---|---|\n| AR1 | 过期规则参数化落地 | 规则可配置，单测覆盖三种口径 |\n| AR2 | 即将过期积分查询接口 | 按契约返回，30 天窗口命中准确 |\n| AR3 | 月末定时扫描 + 用户筛选 | 扫描幂等，重放不重复推送 |\n| AR4 | 推送发送（App 内信 + 短信降级） | 渠道可配，失败降级可观测 |\n| AR5 | 限流与熔断保护 | 推送速率受限，网关不熔断 |\n`
}

function genericClarifyDoc(vars: Record<string, string>): string {
  return `# 三级分解 IR → SR → AR（过程区）\n\n## IR 意图需求\n${vars.requirementText ?? vars.title ?? ''}\n\n## SR 场景需求\n\n- SR1 范围界定：影响模块/接口清单\n- SR2 核心行为：主流程与异常流\n- SR3 验收口径：可验收标准\n\n## AR 原子需求\n\n| # | 原子项 | 验收标准 |\n|---|---|---|\n| AR1 | 范围内核心实现 | 主流程通过 |\n| AR2 | 异常与边界 | 异常流不劣化 |\n| AR3 | 回归 | 既有用例不破坏 |\n`
}

// ---------- 需求分析 SPEC（交付区 · 解决方案 SE 视角） ----------

function demoRequirementSpec(vars: Record<string, string>): string {
  return `# 需求分析 SPEC（交付区 · 解决方案 SE）\n\n- IR 意图：${vars.requirementText ?? '会员积分过期提醒'}\n- 决策记录：见 process/decisions.json（过期规则经事实门确认或待追认标记）\n\n## SR 场景需求（按管理对象）\n\n1. 积分域：计算未来 30 天内将清零的积分集合（口径以决策记录为准）。\n2. 推送域：对命中用户发送提醒（App 内信主，短信降级）。\n3. 任务域：自然月末扫描，幂等可重放。\n\n## 验收原子项（AR）\n\n| AR | 原子项 | 验收标准 |\n|---|---|---|\n| AR1 | 过期规则参数化落地 | 规则可配置，单测覆盖三种口径 |\n| AR2 | 即将过期积分查询接口 | 按契约返回，30 天窗口命中准确 |\n| AR3 | 月末定时扫描 + 用户筛选 | 扫描幂等，重放不重复推送 |\n| AR4 | 推送发送（双通道降级） | 渠道可配，失败降级可观测 |\n| AR5 | 限流与熔断保护 | 推送速率受限，网关不熔断 |\n\n## DFX 口径\n\n- 可靠：幂等键 (userId, month)；失败重试一次。\n- 性能：推送限流 100/s。\n- 安全：不推送已注销用户。\n`
}

function genericRequirementSpec(vars: Record<string, string>): string {
  return `# 需求分析 SPEC（交付区 · 解决方案 SE）\n\n- IR 意图：${vars.requirementText ?? vars.title ?? ''}\n\n## SR 场景需求\n\n1. 范围界定：影响模块/接口清单。\n2. 核心行为：主流程与异常流。\n3. 验收口径：可验收标准。\n\n## 验收原子项（AR）\n\n| AR | 原子项 | 验收标准 |\n|---|---|---|\n| AR1 | 范围内核心实现 | 主流程通过 |\n| AR2 | 异常与边界 | 异常流不劣化 |\n| AR3 | 回归 | 既有用例不破坏 |\n`
}

function demoArchitectureDoc(vars: Record<string, string>): string {
  return `# 架构设计 SPEC（交付区）\n\n- 任务：${vars.title ?? ''} / 模块：${vars.module ?? ''}\n- 输入：IR→SR→AR 分解（process/clarify-ir-sr-ar.md）+ 基线快照（process/baseline.md）\n\n## 架构分析\n\n存量结构：单体 Node 服务按领域分层（services / repositories），积分域（获取/消耗/过期）与消息域（推送）经网关限流解耦。本需求新增「过期提醒」横切两个域：积分域提供即将过期集合，消息域负责触达。约束：不引入新服务；定时任务挂既有 cron 框架；推送统一走 PushService 限流通道。\n\n## 架构边界设计\n\n| 边界 | 职责 | 接口归属 |\n|---|---|---|\n| 积分域（points） | 即将过期积分查询（30 天窗口） | query-expiring-points（新增，契约单源） |\n| 消息域（push） | 触达编排、渠道降级、频控 | send-reminder（新增，契约单源） |\n| 任务域（cron） | 月末扫描触发、幂等重放 | 内部调度，不对外 |\n| 用户域（user） | 活跃用户筛选（只读） | 复用既有接口，不新增 |\n\n边界规则：跨域只经契约接口调用，禁止直连对方仓储；幂等键（userId+month）由消息域持有。\n\n## 业务流分析\n\n1. cron 触发（月末 20:00）→ 任务域发起扫描\n2. 积分域返回即将过期集合（含清零时点）→ 用户域过滤活跃用户\n3. 消息域逐用户推送：App 内信 → 失败降级短信（双通道均限流）\n4. 推送记录落库（幂等键去重）→ 失败进重试队列（次日补发一次）\n\n关键路径：扫描 → 查询 → 推送为串行主链；降级与重试为旁路。风险点：push-legacy-client 疑似下线，触达层以 PushService 为唯一依赖（设计阶段确认）。\n`
}

function genericArchitectureDoc(vars: Record<string, string>): string {
  return `# 架构设计 SPEC（交付区）\n\n- 任务：${vars.title ?? ''} / 模块：${vars.module ?? ''}\n\n## 架构分析\n\n存量结构与约束分析：改动收敛在既有分层内，无跨服务引入。\n\n## 架构边界设计\n\n| 边界 | 职责 | 接口归属 |\n|---|---|---|\n| 核心域 | 业务行为 | 契约接口（单源） |\n| 触达域 | 外部交互 | 复用既有通道 |\n\n## 业务流分析\n\n1. 触发 → 2. 核心处理 → 3. 结果触达/留痕。\n`
}

// ---------- AR 拆分（执行段并行派发） ----------

interface ArItemDoc {
  title: string
  summary: string
  acceptance?: string
}

function demoArItems(): ArItemDoc[] {
  return [
    {
      title: '过期规则参数化落地',
      summary: '积分过期规则配置化（自然月清零 + 30 天窗口口径），参数可调并写决策记录',
      acceptance: '规则可配置；单测覆盖三种口径（自然月/固定窗口/自定义）',
    },
    {
      title: '即将过期积分查询接口',
      summary: '按契约（delivery/contract/api-contract.json 单源）提供即将过期积分查询',
      acceptance: '按契约返回；30 天窗口命中准确；含分页与空集',
    },
    {
      title: '月末扫描与提醒推送',
      summary: '月末定时扫描 + 活跃用户筛选 + 双通道提醒（App 内信优先、短信兜底）+ 清零留痕',
      acceptance: '扫描幂等（重放不重复推送）；清零写审计留痕',
    },
  ]
}

function genericArItems(vars: Record<string, string>): ArItemDoc[] {
  return [
    { title: `${vars.title ?? '核心'} · 主流程实现`, summary: vars.requirementText ?? '', acceptance: '主流程验收通过' },
    { title: `${vars.title ?? '核心'} · 边界与异常`, summary: '异常流与边界口径处理，不劣化既有行为', acceptance: '异常流有单测；回归不破坏' },
  ]
}

function arSplitDoc(items: ArItemDoc[]): string {
  return `# AR 拆分方案（过程区 · 执行段并行派发）\n\n拆分原则：每个 AR 可独立实现、独立验收、独立 MR；开发轮转承接（并发槽内并行）；全部合入后聚合验收（TSE）。\n\n| # | AR | 范围 | 验收标准 |\n|---|---|---|---|\n${items
    .map((it, i) => `| AR${i + 1} | ${it.title} | ${it.summary} | ${it.acceptance ?? '主流程通过'} |`)
    .join('\n')}\n\n依赖关系：AR 间无强顺序依赖（契约已单源）；联调由聚合验收门统一把关。\n`
}

// ---------- AR 级设计（编码前置 · 设计→实现的聚焦衔接） ----------

function demoArDesignDoc(arTitle: string): string {
  return `# AR 级实现设计摘要（过程区 · 编码前置）\n\n- 本 AR：${arTitle || '（单任务：全量实现）'}\n- 上游：delivery/spec.md / delivery/design.md / delivery/contract/api-contract.json（不重写，只做衔接）\n\n## 模块落位\n\n- services/expiry-reminder.js：扫描 + 筛选 + 编排主链。\n- services/push-gateway.js：PushService.send 限流 + 短信降级。\n- repositories/expiry-repo.js：即将过期查询（幂等键 userId+month）。\n\n## 接口实现要点\n\n- query-expiring-points / send-reminder 严格对齐契约单源（api-contract.json）；不私自增删字段。\n\n## 测试要点\n\n- UT：过期口径参数化（自然月/固定窗口/自定义）、幂等键去重、限流令牌。\n- MST（验证小节统一执行）：月末边界切换、零余额不推送、降级链路。\n\n## 设计缺口\n\n- 无（设计已覆盖本 AR 范围）。\n`
}

function genericArDesignDoc(title: string): string {
  return `# AR 级实现设计摘要（过程区 · 编码前置）\n\n- 本 AR：${title || '（单任务：全量实现）'}\n- 上游：delivery/spec.md / delivery/design.md（不重写，只做衔接）\n\n## 模块落位\n\n- 按既有分层落位，改动点收敛在核心域模块。\n\n## 接口实现要点\n\n- 对齐契约单源（api-contract.json）。\n\n## 测试要点\n\n- UT：核心行为 + 边界；MST 留验证小节。\n\n## 设计缺口\n\n- 无。\n`
}

// ---------- 测试轨（用例设计 → 自动化 DESIGN → 自动化生成） ----------

function demoTestCasesDoc(): string {
  return `# 测试用例集（测试轨① · 基于测试 SPEC 测试点展开）\n\n| 用例 | 对应测试点 | 前置 | 步骤 | 期望 |\n|---|---|---|---|---|\n| C1 | T1 月末边界 | 用户有 3 月底过期积分 | 模拟 23:59→00:00 切换扫描 | 窗口切换正确，不漏/不重 |\n| C2 | T2 零余额 | 用户积分为 0 | 执行月末扫描 | 不生成提醒 |\n| C3 | T3 历史遗留 | 用户有历史遗留积分 | 按过期口径计算 | 纳入/排除正确 |\n| C4 | T4 幂等重放 | 同月已推送 | 重放扫描 | 同月同用户仅 1 条 |\n| C5 | T5 降级链路 | App 内信通道失败 | 触发推送 | 降级短信且限流生效 |\n| C6 | T6 速率 | 批量用户到期 | 并发推送 | 超 100/s 被限流 |\n| C7 | T7 契约一致 | — | 比对 api-contract.json | 接口形状一致 |\n`
}

function genericTestCasesDoc(): string {
  return `# 测试用例集（测试轨① · 基于测试 SPEC 测试点展开）\n\n| 用例 | 对应测试点 | 前置 | 步骤 | 期望 |\n|---|---|---|---|---|\n| C1 | T1 主流程 | 环境就绪 | 执行主流程 | 通过 |\n| C2 | T2 边界 | 边界条件构造 | 执行边界场景 | 不漏/不重 |\n| C3 | T3 回归 | 既有用例在 | 全量跑 | 既有功能不破坏 |\n`
}

function autoCaseDesignDoc(): string {
  return `# 自动化用例 DESIGN（测试轨②）\n\n## 框架选型\n\n对齐仓既有测试框架（vitest/jest 惯例）；断言库用框架内置。\n\n## 目录选址\n\n\`delivery/test/auto/\`（与手写 UT 的 \`delivery/test/\` 区分；随 MR 入库，流水线自动执行）。\n\n## 数据构造\n\n内联 fixture 优先（用例自含），跨用例共享的构造放同目录 \`fixtures.js\`。\n\n## 分层归属\n\n| 用例 | 归属 |\n|---|---|\n| C1-C4 | 自动化（delivery/test/auto/） |\n| C5 | 自动化（降级链路 mock 通道） |\n| C6 | 自动化（限流令牌桶） |\n| C7 | MST（契约一致性由远端流水线复跑） |\n`
}

function demoAutoCaseFiles(): { path: string; content: string }[] {
  return [
    {
      path: 'delivery/test/auto/expiry-boundary.test.js',
      content: `'use strict'\n// 测试轨自动生成：边界用例（C1-C4）\nconst assert = require('assert')\n\ndescribe('自动化用例（测试轨生成）', () => {\n  it('C1 月末→次月切换：窗口不漏不重', () => assert.ok(true))\n  it('C2 零余额用户不推送', () => assert.ok(true))\n  it('C3 历史遗留积分口径正确', () => assert.ok(true))\n  it('C4 幂等重放：同月同用户仅 1 条', () => assert.ok(true))\n})\n`,
    },
    {
      path: 'delivery/test/auto/push-degrade.test.js',
      content: `'use strict'\n// 测试轨自动生成：降级与限流（C5-C6）\nconst assert = require('assert')\n\ndescribe('自动化用例（降级/限流）', () => {\n  it('C5 App 内信失败 → 短信降级且限流生效', () => assert.ok(true))\n  it('C6 超 100/s 被限流', () => assert.ok(true))\n})\n`,
    },
  ]
}

function genericAutoCaseFiles(): { path: string; content: string }[] {
  return [
    {
      path: 'delivery/test/auto/main.test.js',
      content: `'use strict'\n// 测试轨自动生成：主流程/边界/回归\nconst assert = require('assert')\n\ndescribe('自动化用例（测试轨生成）', () => {\n  it('C1 主流程通过', () => assert.ok(true))\n  it('C2 边界不漏不重', () => assert.ok(true))\n  it('C3 回归不破坏', () => assert.ok(true))\n})\n`,
    },
  ]
}

function demoSpec(vars: Record<string, string>): string {
  return `# 规格 spec（WHAT · 交付区）\n\n## 背景\n${vars.requirementText ?? ''}\n\n## 功能规格\n\n1. **过期规则**：积分按自然月过期，次月 1 日清零（事实门已确认/待追认标记以决策记录为准）。\n2. **提醒窗口**：未来 30 天内将清零的积分纳入提醒。\n3. **用户筛选**：仅推送有即将过期积分的活跃用户；零余额与已注销用户不推送。\n4. **推送渠道**：App 内信为主；失败或用户未安装时降级短信（降级同样限流）。\n5. **频控**：每用户每自然月最多 1 条过期提醒（幂等重放不重复）。\n\n## 非功能\n\n- 推送经 PushService 统一限流（见团队技能：推送限流规则）。\n- 扫描任务幂等：以 (userId, month) 为幂等键。\n\n## 验收\n\n见 test-design.md；远端流水线以 SHA 复核测试证据。\n`
}

function genericSpec(vars: Record<string, string>): string {
  return `# 规格 spec（WHAT · 交付区）\n\n## 背景\n${vars.requirementText ?? vars.title ?? ''}\n\n## 功能规格\n\n1. 核心行为按需求原文口径实现。\n2. 边界与异常路径明确。\n\n## 验收\n\n见 test-design.md。\n`
}

function demoDesign(vars: Record<string, string>): string {
  return `# 设计 design（HOW · 交付区）\n\n## 模块\n\n- \`services/expiry-reminder.js\`：扫描 + 筛选 + 编排\n- \`services/push-gateway.js\`：推送（PushService.send，限流）\n- \`repositories/expiry-repo.js\`：即将过期积分查询（幂等键 userId+month）\n\n## 时序\n\n1. cron 触发（月末 20:00）→ 2. 查询即将过期集合 → 3. 逐用户推送（限流）→ 4. 失败降级短信 → 5. 写推送记录（幂等）\n\n## 契约\n\n接口契约唯一真源：\`delivery/contract/api-contract.json\`（其余视图只读派生）。\n\n## 降级策略\n\nApp 内信失败率 > 阈值或单用户失败 → 短信兜底；短信同样经限流通道。\n`
}

function genericDesign(_vars: Record<string, string>): string {
  return `# 设计 design（HOW · 交付区）\n\n## 模块\n\n- 按现有分层落位，新增模块最小侵入。\n\n## 契约\n\n接口契约唯一真源：\`delivery/contract/api-contract.json\`。\n`
}

function demoTestDesign(): string {
  return `# 测试设计 test-design（交付区）\n\n| # | 用例 | 期望 |\n|---|---|---|\n| T1 | 月末 23:59 → 次月 1 日 00:00 边界 | 窗口切换正确，不漏/不重 |\n| T2 | 零余额用户 | 不推送 |\n| T3 | 历史遗留积分 | 按过期口径纳入/排除正确 |\n| T4 | 重复扫描（幂等重放） | 同月同用户仅 1 条 |\n| T5 | App 内信失败 | 降级短信，且限流生效 |\n| T6 | 推送速率 | 超 100/s 被限流，网关不熔断 |\n| T7 | 查询接口契约 | 与 api-contract.json 一致 |\n`
}

function genericTestDesign(_vars: Record<string, string>): string {
  return `# 测试设计 test-design（交付区）\n\n| # | 用例 | 期望 |\n|---|---|---|\n| T1 | 主流程 | 通过 |\n| T2 | 边界 | 不漏/不重 |\n| T3 | 回归 | 既有功能不破坏 |\n`
}

function demoContract(): unknown {
  return {
    version: '1.0.0',
    service: 'membership-center/expiry-reminder',
    interfaces: [
      {
        id: 'query-expiring-points',
        method: 'POST',
        path: '/api/points/expiry-reminders/query',
        request: { userId: 'string', windowDays: 'number=30' },
        response: { items: 'Array<{ userId, points, clearAt }>' },
      },
      {
        id: 'send-reminder',
        method: 'POST',
        path: '/api/points/expiry-reminders/send',
        request: { userId: 'string', channel: 'app|sms' },
        response: { accepted: 'boolean', dedupKey: 'string' },
      },
    ],
  }
}

function genericContract(vars: Record<string, string>): unknown {
  return {
    version: '1.0.0',
    service: (vars.repo || 'default') + '/change',
    interfaces: [{ id: 'main', method: 'POST', path: '/api/main', request: {}, response: {} }],
  }
}

function demoCodeFiles(repair: boolean, directives: string[]): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [
    {
      path: 'delivery/src/services/expiry-reminder.js',
      content: `'use strict'\n// 积分过期提醒：扫描 + 筛选 + 编排（实现见 spec/design）\nconst { queryExpiring } = require('../repositories/expiry-repo')\nconst { sendWithFallback } = require('./push-gateway')\n\nasync function runMonthlyScan({ now = new Date() } = {}) {\n  const items = await queryExpiring({ windowDays: 30, now })\n  const sent = []\n  for (const it of items) {\n    // 幂等键：userId + month\n    const res = await sendWithFallback({ userId: it.userId, points: it.points, month: now.toISOString().slice(0, 7) })\n    if (res.accepted) sent.push(it.userId)\n  }\n  return { scanned: items.length, sent: sent.length }\n}\n\nmodule.exports = { runMonthlyScan }\n`,
    },
    {
      path: 'delivery/src/services/push-gateway.js',
      content: `'use strict'\n// 推送网关：PushService.send + 限流 + 短信降级（团队技能：推送限流规则）\nconst PushService = require('./push-service')\nconst RATE_LIMIT = 100 // 条/秒\nlet bucket = { tokens: RATE_LIMIT, ts: Date.now() }\n\nfunction takeToken() {\n  const el = (Date.now() - bucket.ts) / 1000\n  bucket = { tokens: Math.min(RATE_LIMIT, bucket.tokens + el * RATE_LIMIT), ts: Date.now() }\n  if (bucket.tokens >= 1) { bucket.tokens -= 1; return true }\n  return false\n}\n\nasync function sendWithFallback({ userId, points, month }) {\n  if (!takeToken()) return { accepted: false, reason: 'rate-limited' }\n  try {\n    await PushService.send({ userId, template: 'points-expiry', data: { points, month } })\n    return { accepted: true, channel: 'app' }\n  } catch (e) {\n    // 降级短信（同样限流）\n    if (!takeToken()) return { accepted: false, reason: 'rate-limited' }\n    await PushService.send({ userId, template: 'points-expiry-sms', data: { points }, channel: 'sms' })\n    return { accepted: true, channel: 'sms', fallback: true }\n  }\n}\n\nmodule.exports = { sendWithFallback }\n`,
    },
    {
      path: 'delivery/src/repositories/expiry-repo.js',
      content: `'use strict'\n// 即将过期积分查询（契约：query-expiring-points）\nasync function queryExpiring({ windowDays = 30, now = new Date() }) {\n  // 实现按仓数据访问约定：自然月过期，次月 1 日清零\n  return [] // 占位：真实实现连接仓数据源\n}\n\nmodule.exports = { queryExpiring }\n`,
    },
  ]
  if (repair) {
    files.push({
      path: 'delivery/test/expiry-reminder.test.js',
      content: `'use strict'\n// 对抗式修复补齐：边界用例（月末切换/零余额/历史遗留/幂等）\nconst assert = require('assert')\n\ndescribe('expiry-reminder 边界（复检）', () => {\n  it('T1 月末→次月切换：窗口不漏不重', () => assert.ok(true))\n  it('T2 零余额用户不推送', () => assert.ok(true))\n  it('T3 历史遗留积分口径正确', () => assert.ok(true))\n  it('T4 幂等重放：同月同用户仅 1 条', () => assert.ok(true))\n})\n${directives.map((d) => `// 修复指令：${d}`).join('\\n')}\n`,
    })
  }
  return files
}

function genericCodeFiles(vars: Record<string, string>): { path: string; content: string }[] {
  return [
    {
      path: 'delivery/src/change.js',
      content: `'use strict'\n// ${vars.title ?? '变更'} 核心实现\nmodule.exports = { run: async () => ({ ok: true }) }\n`,
    },
  ]
}
