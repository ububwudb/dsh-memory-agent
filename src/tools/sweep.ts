/**
 * memory_sweep：记忆体检（**只读**，不删任何东西）。
 *
 * 为什么只读：清理动作是不可逆的，而「多久没命中算没用」这个阈值在没有分布数据前
 * 只能靠猜。社区里迭代过十几个版本的实现给出的答案是同一句话——先让阈值变得可观察，
 * 攒一段时间的 `idleDays` 分布再定，别让插件替用户删记忆。
 *
 * 三类清单（阈值借自实战经验，理由写在下面）：
 * - `longUnused`：90 天没被命中过。阈值远大于降级阈值，因为「非常驻记忆几十天不用」是常态，
 *   定太低会把正常记录报成待清理。
 * - `autoDemote`：30 天没命中的**常驻**条目（本插件没有常驻概念，留作以后接口）。
 * - `supersededBacklog`：已经被新版本取代、但文件还留着的旧版本（可选物理清理）。
 *
 * 零命中清单（`zeroHitQueries`）：模型问了但库没命中的查询，是只读的「库该补什么内容」信号。
 *
 * 执行动作不在这里：想真删就走 `forget` / `memory_forget`，想合并就走 `memory_resolve`。
 */
import type { MemoryBackend } from '../store/backend.js'
import type { IndexEntry } from '../types.js'
import { loadIndex } from '../retrieve/index-cache.js'
import { idleDays, loadUsage, mergeUsage, STALE_USAGE_DAYS } from '../store/usage.js'
import { zeroHitQueries } from '../store/query-log.js'

export interface SweepInput {
  /** 覆盖「久未命中」的天数阈值（默认 90）。 */
  days?: number
  /** 返回条数上限，默认 20。 */
  limit?: number
}

export interface SweepItem {
  id: string
  summary: string
  idleDays: number
  hit_count: number
}

export interface SweepOutput {
  /** 体检时间，方便对比两次报告的差异。 */
  at: string
  longUnused: SweepItem[]
  supersededBacklog: SweepItem[]
  /** 最近的零命中查询（新→旧，只留时间与查询本身）：库该补什么内容的只读信号。 */
  zeroHitQueries: Array<{ at: string; query: string }>
  /** 库里实际参与统计的条目数（排除已删/已取代）。 */
  scanned: number
  /** 阈值说明，直接展示给模型/用户，避免它对数字产生误解。 */
  thresholds: { longUnusedDays: number }
}

/** 摘要截断长度：清单是给人扫一眼的，不是给模型读全文的。 */
const BRIEF_CHARS = 120

export async function sweepHandler(
  backend: MemoryBackend,
  input: SweepInput = {},
): Promise<SweepOutput> {
  await backend.init()
  const now = new Date()
  const days = typeof input.days === 'number' && Number.isFinite(input.days) && input.days > 0
    ? Math.floor(input.days)
    : STALE_USAGE_DAYS
  const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
    ? Math.floor(input.limit)
    : 20

  const entries = (await loadIndex(backend)).entries
  const usage = await loadUsage(backend)
  mergeUsage(entries, usage)

  // 参与体检的只有「活着」的条目：已删、已被取代、原文副本都不算
  const living = entries.filter(
    (entry) => entry.status !== 'deleted_pending'
      && entry.status !== 'superseded'
      && entry.type !== 'raw',
  )

  const longUnused = living
    .filter((entry) => idleDays(entry, now) >= days)
    .map(toItem)
    .sort((a, b) => (b.idleDays === a.idleDays ? a.id.localeCompare(b.id) : b.idleDays - a.idleDays))
    .slice(0, limit)

  const supersededBacklog = entries
    .filter((entry) => entry.status === 'superseded' && entry.type !== 'raw')
    .map(toItem)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit)

  return {
    at: backend.now(),
    longUnused,
    supersededBacklog,
    // 零命中查询只报 at/query，hits 字段在这里丢掉（都是 0，报出去只是噪音）
    zeroHitQueries: (await zeroHitQueries(backend, 20)).map(({ at, query }) => ({ at, query })),
    scanned: living.length,
    thresholds: { longUnusedDays: days },
  }
}

function toItem(entry: IndexEntry): SweepItem {
  return {
    id: entry.id,
    summary: clip(entry.summary),
    idleDays: idleDays(entry, new Date()),
    hit_count: entry.hit_count ?? 0,
  }
}

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= BRIEF_CHARS ? oneLine : `${oneLine.slice(0, BRIEF_CHARS - 1)}…`
}
