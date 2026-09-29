/**
 * 知识库视图（顶层 · #/knowledge）：技能库 · 候选沉淀 · 采纳审计 —— "沉淀了什么可复用资产"的正交管理面
 * 内部实体仍为 Skill（引擎 OKL 注入的来源）；知识库是这些资产的组织级容器
 */
import SkillsPanel from '../components/SkillsPanel'

export default function KnowledgeView(): React.JSX.Element {
  return (
    <div className="page-view knowledge-view">
      <div className="page-toolbar">
        <div className="hall-title">
          <h2>知识库</h2>
          <span className="hint">技能库 · 候选沉淀 · 采纳审计 —— 组织级可复用知识资产，引擎作业时的注入来源</span>
        </div>
      </div>
      <div className="page-panels">
        <SkillsPanel />
      </div>
    </div>
  )
}
