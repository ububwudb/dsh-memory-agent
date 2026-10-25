/**
 * memory_assemble：把命中条目压进固定预算的上下文。
 *
 * 硬不变量：`used_tokens <= budget` 永远成立（超出时先丢原文、再截摘要，最后停手），
 * 且 used_tokens 固定用 `Math.ceil(chars / 1.6)` 计算，不依赖真实 tokenizer。
 *
 * 预算装不下的命中不会无声消失：`omitted` 告诉你漏了几条，渲染层也会写出来，
 * 免得模型以为「这就是全部相关记忆」。
 */
import type { MemoryBackend } from '../store/backend.js'
import type { IndexEntry } from '../types.js'
import { DEFAULT_BUDGET, charsForBudget, estimateTokens } from '../types.js'
import type { Hit } from './search.js'
import { searchHandler } from './search.js'
import { memoryFileBody } from '../store/index-store.js'
import { loadIndex } from '../retrieve/index-cache.js'
import { loadDigest, slotOfEntry } from './digest.js'
import type { DigestRecord } from './digest.js'

export interface AssembleInput {
  task: string
  /** 外部给的命中（通常来自 memory_search_hybrid）；缺省时用 task 现搜。 */
  hits?: Hit[]
  /** token 硬顶；默认 DEFAULT_BUDGET。 */
  budget?: number
}

export interface AssembleOutput {
  context: string
  used_tokens: number
  /** 进入上下文的来源文件路径，按出现顺序去重。 */
  sources: string[]
  /** 因为预算/去重没放进上下文的命中条数。 */
  omitted: number
}

/** 单条命中的原文最多占多少字符。 */
const RAW_SNIPPET_LIMIT = 600
/** 兜底截断时，剩余空间小于该值就不再硬塞。 */
const MIN_BLOCK_CHARS = 60
/** hits 缺省时自搜的条数。 */
const AUTO_SEARCH_TOP_K = 20

export async function assembleHandler(
  backend: MemoryBackend,
  input: AssembleInput,
): Promise<AssembleOutput> {
  await backend.init()
  const budget = normalizeBudget(input.budget)
  const maxChars = charsForBudget(budget)

  const hits = await resolveHits(backend, input)
  if (hits.length === 0) return { context: '', used_tokens: 0, sources: [], omitted: 0 }

  const index = (await loadIndex(backend)).entries
  const byId = new Map(index.map((entry) => [entry.id, entry]))
  // 父条目已经带着 raw_ref 把原文带出来了，同一次 assemble 不再重复塞一条 raw 命中
  const referencedRaw = new Set<string>()
  for (const hit of hits) {
    const entry = byId.get(hit.id)
    if (entry?.raw_ref !== undefined) referencedRaw.add(entry.raw_ref)
  }

  // P1 分层蒸馏：命中槽位优先用「当前认知」（digest）。digest 是缓存不是真相源，
  // 只收录「新鲜（updated_at 不早于该条目）且确实覆盖这条条目」的 digest；
  // 不满足就回退碎片——旧认知不能冒充当前认知。同槽位只 loadDigest 一次（null 也缓存，避免重复读盘）。
  const digestBySlot = new Map<string, DigestRecord | null>()
  const hitDigests = new Map<string, DigestRecord>()
  for (const hit of hits) {
    const entry = byId.get(hit.id)
    if (entry === undefined || entry.type === 'raw') continue
    const slot = slotOfEntry(entry)
    if (!digestBySlot.has(slot)) digestBySlot.set(slot, await loadDigest(backend, slot))
    const record = digestBySlot.get(slot) ?? null
    if (record !== null && record.updated_at >= entry.time && record.sources.includes(entry.id)) {
      hitDigests.set(hit.id, record)
    }
  }
  // 同一个槽位的 digest 块在一次 assemble 里只放一份，防重复
  const usedDigestSlots = new Set<string>()

  const sources: string[] = []
  let context = ''
  let omitted = 0

  for (const [position, hit] of hits.entries()) {
    if (hit.path !== undefined && referencedRaw.has(hit.path)) {
      omitted += 1
      continue
    }
    const separator = context === '' ? 0 : 2
    const remaining = maxChars - context.length - separator
    const entry = byId.get(hit.id)
    // 槽位有「当前认知」且本槽位还没放过 digest 块：整块认知优先，不再拼这条的碎片
    const digestRecord = entry === undefined ? undefined : hitDigests.get(hit.id)
    if (digestRecord !== undefined && !usedDigestSlots.has(digestRecord.slot)) {
      const digestBlock = pickDigestBlock(digestRecord, remaining)
      if (digestBlock !== null) {
        context += separator === 0 ? digestBlock : `\n\n${digestBlock}`
        if (!sources.includes(digestRecord.path)) sources.push(digestRecord.path)
        usedDigestSlots.add(digestRecord.slot)
        continue
      }
      // 放不下（预算见底）才回退碎片
    }
    const rawFile = remaining <= 0 || entry?.raw_ref === undefined
      ? null
      : await backend.readFile(entry.raw_ref)
    // 原文文件里的 front-matter 和标题不是原文，拼片段前先剥掉
    const raw = rawFile === null ? null : memoryFileBody(rawFile)
    const block = remaining <= 0 ? null : pickBlock(hit, entry, raw, remaining)
    if (block === null) {
      omitted += hits.length - position
      break
    }
    context += separator === 0 ? block : `\n\n${block}`
    if (!sources.includes(hit.path)) sources.push(hit.path)
  }

  return { context, used_tokens: estimateTokens(context), sources, omitted }
}

/** 依次尝试：原文块 → 摘要块 → 截断摘要块。 */
function pickBlock(
  hit: Hit,
  entry: IndexEntry | undefined,
  raw: string | null,
  remaining: number,
): string | null {
  const header = `## [${hit.type}] ${hit.title}\n来源: ${hit.path}\n摘要: ${hit.summary}`
  const withRaw = raw === null || raw.trim() === ''
    ? header
    : `${header}\n原文: ${clip(raw.trim().replace(/\s+/g, ' '), RAW_SNIPPET_LIMIT)}`

  for (const candidate of [withRaw, header]) {
    if (candidate.length <= remaining) return candidate
  }
  if (remaining < MIN_BLOCK_CHARS) return null
  return clip(header, remaining)
}

/**
 * 「当前认知」块：`## [digest] 槽位` + 来源路径 + 正文。
 * 整块放得下就整块返回；剩余空间低于 MIN_BLOCK_CHARS 返回 null（回退碎片，别硬塞半截认知）；
 * 否则按剩余空间截断。截断口径与 pickBlock 一致，used_tokens ≤ budget 的硬不变量不受影响。
 */
function pickDigestBlock(record: DigestRecord, remaining: number): string | null {
  const block = `## [digest] ${record.slot}\n来源: ${record.path}\n${record.text}`
  if (block.length <= remaining) return block
  if (remaining < MIN_BLOCK_CHARS) return null
  return clip(block, remaining)
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 1) return ''
  return `${text.slice(0, max - 1).trimEnd()}…`
}

function normalizeBudget(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_BUDGET
  return Math.max(1, Math.floor(raw))
}

/** hits 缺省时用 task 现搜；有 hits 时按分数降序（稳定排序，同分保留原顺序）。 */
async function resolveHits(backend: MemoryBackend, input: AssembleInput): Promise<Hit[]> {
  if (Array.isArray(input.hits) && input.hits.length > 0) {
    return input.hits
      .slice()
      .sort((a, b) => (b.score === a.score ? 0 : b.score - a.score))
  }
  const query = typeof input.task === 'string' ? input.task.trim() : ''
  if (query === '') return []
  return searchHandler(backend, { query, top_k: AUTO_SEARCH_TOP_K })
}
