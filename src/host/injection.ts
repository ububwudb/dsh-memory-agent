/**
 * 常驻注入：把记忆摘要自动带进每轮上下文（P0 管道）。
 *
 * 落点是宿主 `@deepseek-ai/dsh-system-prompt` 服务的 **runtime context**：
 * - `context.text` 宿主是**同步**取值、每轮请求刷新（refreshContext），返回 Promise 会被
 *   renderContextSections 按「非字符串」静默丢掉——所以这里必须是同步函数、同步读库；
 * - 必须带 `interpolate: false`：记忆正文里可能出现 `{{...}}`，进插值器会直接抛错
 *   杀死整轮 prompt 组装（dsh 0.2.x 对未知变量是 fail-loud）；
 * - 空库 / 开关关闭 / 组装异常时返回空字符串，宿主对空 context 自然跳过。
 *
 * 组装规则（参照社区里迭代过的实现，只抄判据不抄代码）：
 * - 每条 80 字符摘要、字符预算硬顶（默认 1500，含标题行）；
 * - 内容优先级：有当前认知（digest）的槽位 > 命中过的（hit_count + 最近命中时间）> 其余按最近更新；
 * - 放不下的条数给一行省略提示，绝不能让文本悄悄超预算；
 * - 锚点失效的条目不注入（探测不到=未校验，不判失效）——撤注入、保留检索。
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import type { IndexEntry } from '../types.js'
import { DEFAULT_INJECT_BUDGET_CHARS, isRetrievable } from '../types.js'
import { evaluateAnchors } from '../store/anchors.js'
import { parseIndexLines, parseMemoryFile } from '../store/index-store.js'
import { USAGE_FILE, parseUsageText } from '../store/usage.js'
import type { UsageSummary } from '../store/usage.js'
import { DIGESTS_DIR, slotOfEntry } from '../tools/digest.js'
import { createNodeAnchorProbe } from './anchor-probe.js'

/** 宿主 systemPrompt 里我们的 context 名（重名会撞掉别人的注册，必须带命名空间）。 */
export const RECALL_CONTEXT_NAME = 'memory-agent:recall'

/** 记忆使用守则的 context 名（与记忆条目分开注册，互不挤占预算）。 */
export const USAGE_GUIDE_CONTEXT_NAME = 'memory-agent:guide'

/**
 * 记忆使用守则：告诉模型**什么时候该记、什么时候该搜、什么时候不该记**。
 *
 * 单独一条 context 而不是塞进 buildRecallSync，理由有两条：
 * 1. 那段有 1500 字符硬预算，守则是行为指导，不该挤占记忆条目的额度；
 * 2. 空库时 buildRecallSync 返回 ''（不注入），但「什么时候该记」恰恰在空库时最该说。
 *
 * 内容刻意短（≈200 字符）：它每轮都在上下文里，写长了就是常态噪音。
 */
export const USAGE_GUIDE_TEXT = [
  '## 记忆使用守则',
  '- 该记：稳定偏好、环境事实（路径/端口/版本/账号）、约定规范、用户纠正过的错。过程话和一次性细节不记。',
  '- 该搜：动手前先 memory_search_hybrid；用户说「上次」「之前」「不是记过吗」时必搜，别凭印象答。',
  '- 该问：搜不到又不确定就先问，别猜着写进记忆。',
  '- 写入：同义内容用同一个 key（旧版本会自动 superseded）；密钥会被脱敏，但别主动记。',
].join('\n')

/** runtime context 的排序：放在内置 context（工作目录/沙箱策略等，≤210）之后。 */
export const RECALL_CONTEXT_ORDER = 800

/** 注入标题行（也是契约检查锚点，改名要同步 verify.sh）。 */
export const INJECTION_HEADER = '## 记忆（自动注入）'

/** 单条摘要/标题的截断宽度（参照社区实现：每条 80 字符）。 */
export const MAX_INJECT_SUMMARY_CHARS = 80
export const MAX_INJECT_TITLE_CHARS = 40

/** 行数保险丝：预算内也不许超过这么多条（防超短摘要把行数刷爆）。 */
export const MAX_INJECT_LINES = 40

/** usage.jsonl 超过这个体积就只读尾部（同步读在主线程，别把大文件整读进来）。 */
const USAGE_TAIL_BYTES = 2 * 1024 * 1024

/** 省略提示行（契约检查锚点：fixture 断言「未注入」三个字）。 */
const OMISSION_TEMPLATE = (count: number): string =>
  `（还有 ${count} 条未注入：需要时用 memory_search_hybrid 检索，或让我 memory_assemble 展开）`

/** 宿主 systemPrompt 服务里我们用到的那一小块（防御式：不 import cordis）。 */
export interface SystemPromptContextEntry {
  name: string
  order: number
  /**
   * 宿主对 context.text 是同步取值、每轮请求刷新；
   * 返回 Promise 会被当「非字符串」静默丢弃，所以只允许同步函数。
   */
  text: string | ((assembly: unknown) => string)
  /** 必须关：记忆正文可能含 {{...}}，进插值器会抛错杀死整轮组装。 */
  interpolate?: boolean
  required?: boolean
}

export interface SystemPromptLike {
  context(entry: SystemPromptContextEntry): unknown
}

/** 注入相关的运行期配置（就是 MemoryRuntimeConfig 的切片）。 */
export interface RecallRuntimeConfig {
  injectEnabled: boolean
  injectBudgetChars: number
}

export interface InjectionCandidate {
  id: string
  path: string
  title: string
  summary: string
  time: string
  /** 槽位键（write_memory 的 key，回落 title:<归一化标题>，见 tools/digest.ts）。 */
  slot: string
  /** 该槽位有没有「当前认知」digest 文件（排序加权用）。 */
  hasDigest: boolean
  hitCount: number
  lastUsed: string
}

export interface RecallSnapshot {
  /** 最终注入文本；'' 表示本轮不注入（空库/预算放不下任何一条）。 */
  text: string
  /** 文本字符数（恒 ≤ 预算）。 */
  chars: number
  included: number
  omitted: number
  /** 参与排序的候选总数（active 且非 raw）。 */
  total: number
  /** 因锚点失效被撤掉注入的条目数（检索保留，等模型核对后回写）。 */
  staleSkipped: number
}

/**
 * 组装注入文本的上下文条目（给 index.ts 接线用）。
 * 开关与预算读的是 runtime 对象（config.set 原地改字段），改动立即生效、不用重装。
 */
export function createRecallContextEntry(
  root: string,
  runtime: RecallRuntimeConfig,
  onTick?: () => void,
): SystemPromptContextEntry {
  return {
    name: RECALL_CONTEXT_NAME,
    order: RECALL_CONTEXT_ORDER,
    interpolate: false,
    text: (): string => {
      // 自动沉淀挂在这里：宿主每轮都会同步取一次注入文本，天然是「每轮心跳」，
      // 不必额外订阅会话事件。onTick 必须同步、极轻（只做比较），
      // 真正解压/提炼是 fire-and-forget 的异步任务；它抛错也不许影响注入。
      if (onTick !== undefined) {
        try {
          onTick()
        } catch {
          // 沉淀是锦上添花，坏掉也不能拖垮本轮 prompt
        }
      }
      try {
        if (runtime.injectEnabled !== true) return ''
        return buildRecallSync(root, { budgetChars: runtime.injectBudgetChars }).text
      } catch (error) {
        // 注入是锦上添花，绝不能因为读库失败拖垮宿主的 prompt 组装
        console.warn(
          '[dsh-memory-agent] 常驻注入组装失败，本轮跳过:',
          error instanceof Error ? error.message : error,
        )
        return ''
      }
    },
  }
}

/**
 * 组装「记忆使用守则」的上下文条目（给 index.ts 接线用）。
 *
 * 跟 injectEnabled 共用开关：守则存在的意义就是配合记忆检索，
 * 注入关了就没有可搜的东西，守则也跟着消失，不额外造一个开关。
 */
export function createUsageGuideContextEntry(
  runtime: RecallRuntimeConfig,
): SystemPromptContextEntry {
  return {
    name: USAGE_GUIDE_CONTEXT_NAME,
    order: RECALL_CONTEXT_ORDER + 1,
    interpolate: false,
    text: (): string => (runtime.injectEnabled === true ? USAGE_GUIDE_TEXT : ''),
  }
}

/** 面板「注入预览」：不管开关状态都给出会注入什么（开关状态单独回传）。 */
export function recallPreview(root: string, runtime: RecallRuntimeConfig): RecallSnapshot & {
  enabled: boolean
  budget: number
} {
  const snapshot = buildRecallSync(root, { budgetChars: runtime.injectBudgetChars })
  return {
    enabled: runtime.injectEnabled === true,
    budget: runtime.injectBudgetChars,
    ...snapshot,
  }
}

/**
 * 同步组装注入文本。恒有 `text.length ≤ 预算`；放不下任何条目时返回空文本
 * （只有标题行没有内容的注入是纯噪音）。
 */
export function buildRecallSync(
  root: string,
  options: { budgetChars?: number } = {},
): RecallSnapshot {
  const budget = normalizeBudget(options.budgetChars)
  const { candidates, staleSkipped } = collectCandidates(root)
  const empty: RecallSnapshot = { text: '', chars: 0, included: 0, omitted: 0, total: 0, staleSkipped }
  if (candidates.length === 0) return empty
  if (budget < INJECTION_HEADER.length) return empty

  const lines: string[] = [INJECTION_HEADER]
  let used = INJECTION_HEADER.length
  let included = 0
  let omitted = 0

  for (let i = 0; i < candidates.length && included < MAX_INJECT_LINES; i += 1) {
    const line = renderCandidateLine(candidates[i])
    // 这条放不下而停的话，漏掉的就是 candidates.length - i 条；
    // 省略提示的字符必须现在就预留进预算，否则「加完条目再加提示」会悄悄超支
    const stopOmitted = candidates.length - i
    const omissionIfStop = OMISSION_TEMPLATE(stopOmitted)
    const cost = used + 1 + line.length + 1 + omissionIfStop.length
    if (cost > budget) {
      omitted = stopOmitted
      break
    }
    lines.push(line)
    used += 1 + line.length
    included += 1
  }
  // 行数保险丝截掉的也算「没放进来」
  if (omitted === 0 && candidates.length > included) omitted = candidates.length - included

  // 一条都放不下：与其注入光秃秃的标题行，不如什么都不注入
  if (included === 0) return empty

  if (omitted > 0) {
    const omission = OMISSION_TEMPLATE(omitted)
    if (used + 1 + omission.length <= budget) {
      lines.push(omission)
      used += 1 + omission.length
    }
  }

  const text = lines.join('\n')
  if (text.length > budget) return empty // 理论不可达；保险起见宁可本轮不注入
  return { text, chars: text.length, included, omitted, total: candidates.length, staleSkipped }
}

/**
 * 候选收集：active 且非 raw（raw 是原文兄弟，只配显式下钻，不占常驻预算）。
 * 锚点失效的条目不进候选（撤注入、保留检索）；探测不到 = 未校验，不判失效。
 */
function collectCandidates(root: string): { candidates: InjectionCandidate[]; staleSkipped: number } {
  let entries: IndexEntry[]
  try {
    entries = parseIndexLines(readFileSync(path.join(root, 'index.jsonl'), 'utf8')).entries
  } catch {
    return { candidates: [], staleSkipped: 0 }
  }
  const usage = readUsageSync(root)
  const digestSlots = readDigestSlotsSync(root)
  const probe = createNodeAnchorProbe()
  const out: InjectionCandidate[] = []
  let staleSkipped = 0
  for (const entry of entries) {
    if (!isRetrievable(entry.status)) continue
    if (entry.type === 'raw') continue
    if (
      entry.anchors !== undefined
      && entry.anchors.length > 0
      && evaluateAnchors(entry.anchors, probe).length > 0
    ) {
      staleSkipped += 1
      continue
    }
    const title = oneLine(entry.title)
    const summary = oneLine(entry.summary)
    if (title === '' && summary === '') continue
    const hit = usage.get(entry.id)
    const slot = slotOfEntry(entry)
    out.push({
      id: entry.id,
      path: entry.path,
      title: title === '' ? summary : title,
      summary: summary === '' ? title : summary,
      time: entry.time,
      slot,
      hasDigest: digestSlots.has(slot),
      hitCount: hit?.count ?? 0,
      lastUsed: hit?.last ?? '',
    })
  }
  out.sort(compareCandidates)
  return { candidates: out, staleSkipped }
}

/**
 * 排序 = 注入优先级：
 * 1. 有「当前认知」（digest）的槽位排前面——沉淀过的稳定知识，比零散条目更值得常驻；
 * 2. 命中过的排前面（模型看过、给过反馈的记忆，比没验证过的更可信）；
 * 3. 同组内按最近更新（优先最后命中时间）排前面，id 兜底保证稳定。
 */
function compareCandidates(a: InjectionCandidate, b: InjectionCandidate): number {
  if (a.hasDigest !== b.hasDigest) return a.hasDigest ? -1 : 1
  if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount
  const aRef = a.lastUsed !== '' ? a.lastUsed : a.time
  const bRef = b.lastUsed !== '' ? b.lastUsed : b.time
  return bRef.localeCompare(aRef) || a.id.localeCompare(b.id)
}

function renderCandidateLine(candidate: InjectionCandidate): string {
  const title = clampText(candidate.title, MAX_INJECT_TITLE_CHARS)
  const summary = clampText(candidate.summary, MAX_INJECT_SUMMARY_CHARS)
  if (summary === '') return `- ${title}`
  if (title === '') return `- ${summary}`
  return `- ${title}｜${summary}`
}

function readUsageSync(root: string): Map<string, UsageSummary> {
  try {
    return parseUsageText(readTextBounded(path.join(root, USAGE_FILE), USAGE_TAIL_BYTES))
  } catch {
    return new Map()
  }
}

/**
 * 同步读 digests/ 下的「当前认知」清单：slot → updated_at。
 * 目录不存在/坏文件一律单个忽略，绝不抛——注入是锦上添花，不能拖垮宿主的 prompt 组装。
 */
function readDigestSlotsSync(root: string): Map<string, string> {
  const out = new Map<string, string>()
  let names: string[]
  try {
    names = readdirSync(path.join(root, DIGESTS_DIR))
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    try {
      const { fields } = parseMemoryFile(readFileSync(path.join(root, DIGESTS_DIR, name), 'utf8'))
      const slot = fields.slot ?? ''
      if (slot === '') continue
      out.set(slot, fields.updated_at ?? '')
    } catch {
      // 单个坏文件忽略，不影响其余 digest 的识别
    }
  }
  return out
}

/** 超过 maxBytes 只读尾部，并丢掉第一行（可能是被截断的半行）。 */
function readTextBounded(file: string, maxBytes: number): string {
  const size = statSync(file).size
  if (size <= maxBytes) return readFileSync(file, 'utf8')
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const bytes = readSync(fd, buffer, 0, maxBytes, size - maxBytes)
    const text = buffer.toString('utf8', 0, bytes)
    const firstNewline = text.indexOf('\n')
    return firstNewline < 0 ? '' : text.slice(firstNewline + 1)
  } finally {
    closeSync(fd)
  }
}

function normalizeBudget(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_INJECT_BUDGET_CHARS
  return Math.max(0, Math.floor(raw))
}

function clampText(text: string, max: number): string {
  const normalized = oneLine(text)
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(1, max - 1))}…`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
