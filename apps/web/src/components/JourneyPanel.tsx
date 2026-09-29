/**
 * 历程时间线（看板页签）：阶段级大事记，与看板同页 = 空间全景 + 时间全景
 * 默认最近 8 条 + 按需展开全部（multica execution-log 模式：限量常显 + 按需全量）
 */
import { useState } from 'react'
import type { JourneyEntry } from '@ai-platform/shared'
import { fmtTime } from '../format'

const JOURNEY_PREVIEW = 8

export default function JourneyPanel({ journey }: { journey: JourneyEntry[] }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const list = showAll ? [...journey].reverse() : [...journey].reverse().slice(0, JOURNEY_PREVIEW)
  return (
    <section className="panel journey-panel">
      <h3>
        历程{journey.length > 0 && <small className="hint"> · {journey.length} 条</small>}
      </h3>
      <ul className="journey">
        {journey.length === 0 && <li className="empty">（暂无）</li>}
        {list.map((j) => (
          <li key={j.seq} className={`jr jr-${j.kind}`}>
            <time>{fmtTime(j.ts)}</time>
            <span>{j.text}</span>
          </li>
        ))}
      </ul>
      {journey.length > JOURNEY_PREVIEW && (
        <button className="link journey-more" onClick={() => setShowAll((s) => !s)}>
          {showAll ? '收起' : `显示全部 ${journey.length} 条`}
        </button>
      )}
    </section>
  )
}
