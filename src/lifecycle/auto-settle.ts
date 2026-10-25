/**
 * 自动沉淀（auto-settle）：把会话里「用户明确表达过的事实/偏好」提炼成待确认记忆。
 *
 * 为什么现在能做：宿主暴露 `ctx.sessions`（`@deepseek-ai/dsh-session` 的 SessionStore），
 * `session.deriveMessages()` 直接给出模型看到的消息历史——不需要去读磁盘上的
 * `session.v4.jsonl.zstd`。早期「插件层拿不到会话消息」的判断已经不成立。
 *
 * 四条硬约束（改动前先读一遍）：
 * 1. **只写 suggested**：机器提炼必然有误判，确认闸门不过就不许进检索，
 *    否则错误记忆会自我强化、越用越脏；
 * 2. **只认 source.kind === 'user'**：常驻注入本身也是 `user/message`（宿主会保留来源），
 *    不按来源过滤就会把插件自己注入的记忆当成用户发言，形成回音；
 * 3. **规则提炼、不调 LLM**：插件零运行时依赖、默认不联网；
 * 4. **全程静默**：任何异常只 warn，绝不能影响宿主 prompt 组装或会话收尾。
 */
import type { MemoryBackend } from '../store/backend.js'

/**
 * 宿主 Message 的最小形状（只读我们需要的字段，防御式不 import 宿主类型）。
 *
 * `source.rpcId` 是关键：它只出现在聊天框 RPC 提交的消息上，
 * 是区分「用户真打字」与「同 kind 的插件注入」的唯一可靠字段。
 */
export interface SettleMessage {
  role?: string
  content?: unknown
  source?: { kind?: string; rpcId?: unknown; form?: string }
}

/** 宿主 Session 的最小形状。 */
export interface SettleSession {
  id: string
  /** 当前日志长度；只用来判断「有没有新内容」，不解析事件。 */
  seq?: number
  deriveMessages?: () => SettleMessage[]
}

/** 宿主 SessionStore 的最小形状（`ctx.sessions`）。 */
export interface SessionRouter {
  list?: () => SettleSession[]
}

/** 一条提炼出来的候选。 */
export interface SettleCandidate {
  title: string
  summary: string
  /** 命中的信号类别，直接当标签用（偏好/约定/环境/记住/身份）。 */
  tag: string
}

/** 交给宿主写库的回调入参（本模块不认识 writeHandler 的完整签名）。 */
export interface AutoSettleWriteInput {
  title: string
  summary: string
  tags: string[]
  session_id: string
}

export interface AutoSettleOptions {
  /**
   * 总开关。默认关：先观察一段时间准确率再打开。
   * 传函数则每次 tick 实时求值——面板改完开关立即生效，不用重装插件。
   */
  enabled: boolean | (() => boolean)
  /** 两次尝试的最小间隔（毫秒），默认 90s。tick 每轮都会被调，必须便宜。 */
  minIntervalMs?: number
  /** 会话里至少要有这么多条用户消息才值得提炼，默认 4。 */
  minMessages?: number
  /** 单次最多沉淀几条，默认 3（宁缺毋滥）。 */
  maxCandidates?: number
  /** 写库：由 index.ts 接到 writeHandler，且必须固定 requireConfirmation。 */
  write: (input: AutoSettleWriteInput) => Promise<{ id?: string; status?: string; dedupe?: string }>
  /** 审计落盘（ledger.jsonl）；形状与 store 的 LedgerEvent 一致。 */
  audit?: (event: { at: string; type: string; [key: string]: unknown }) => Promise<void>
  now?: () => string
  warn?: (message: string, error?: unknown) => void
}

export interface AutoSettler {
  /** 每轮心跳：同步、极轻、可重入安全；真正干活是 fire-and-forget。 */
  tick: () => void
  /** 等当前在飞的提炼任务收尾（测试与卸载用）。 */
  idle: () => Promise<void>
}

/** 单条候选的最大字符数（记忆是给模型看的，太长就是噪音）。 */
const MAX_SUMMARY_CHARS = 200
const MAX_TITLE_CHARS = 32
/** 太短的话大概率是「好的」「继续」这类过程话。 */
const MIN_TEXT_CHARS = 12
const DEFAULT_MIN_INTERVAL_MS = 90_000
const DEFAULT_MIN_MESSAGES = 4
const DEFAULT_MAX_CANDIDATES = 3
/** 首次见到某个会话时，最多回看多少条用户消息（防「刚开开关就把整部历史提炼一遍」）。 */
const BOOTSTRAP_WINDOW = 20

/** 本插件自己的注入标题：用来兜底识别「这条 user/message 是插件注入的」。 */
const SELF_INJECTION_MARKERS = ['## 记忆（自动注入）', 'memory-agent:recall']

/**
 * 强信号表：只有明确出现「约定/偏好/环境事实」的说法才值得沉淀。
 * 刻意做得保守——漏沉淀只是少记一条，误沉淀会污染整库。
 */
const STRONG_SIGNALS: Array<{ tag: string; pattern: RegExp }> = [
  { tag: '记住', pattern: /(记住|记一下|记下|别忘了)/ },
  { tag: '偏好', pattern: /(以后|从今往后|下次).{0,12}(都|别|不要|用|按|走)/ },
  { tag: '约定', pattern: /(默认|统一|一律|习惯|约定|规范).{0,14}(用|走|按|是|不)/ },
  { tag: '环境', pattern: /(路径|目录|端口|版本|账号|用户名|地址|密钥|配置|环境).{0,8}(是|在|为|用)/ },
  // 刻意只认具体名词：「我的意思是」「我的问题是」这类是口语引导词，不是身份陈述
  { tag: '身份', pattern: /(我用(的)?是|我的.{0,6}(名字|电脑|机器|手机|项目|账号|环境|系统|版本|工作区)是|我们这边)/ },
]

/**
 * 疑问语气：中文疑问句经常不带问号（「好不好」「能不能」「够不够」），
 * 只按 `?` 过滤会把大量征求意见的话当成事实陈述沉淀下去。
 */
const QUESTION_STYLE = /(好不好|能不能|够不够|是不是|对不对|行不行|要不要|可不可以|有没有|怎么样|如何|咋办)/

/** 纯指令开头：这些是「让我干活」，不是「知识」。 */
const INSTRUCTION_HEAD = /^(帮我|请|麻烦|看下|看看|查一下|查查|试一下|试试|改一下|改改|写一个|写个|跑一下|跑跑|执行|修一下|分析一下|给我)/

/**
 * 建一个 settler。
 *
 * `router` 可能为 undefined（老宿主 / headless），此时 tick 是纯空操作。
 */
export function createAutoSettler(
  router: SessionRouter | undefined,
  options: AutoSettleOptions,
): AutoSettler {
  const minIntervalMs = normalizeInterval(options.minIntervalMs)
  const minMessages = normalizePositive(options.minMessages, DEFAULT_MIN_MESSAGES)
  const maxCandidates = normalizePositive(options.maxCandidates, DEFAULT_MAX_CANDIDATES)
  const warn = options.warn ?? ((message: string, error?: unknown) => {
    console.warn(`[dsh-memory-agent] ${message}`, error instanceof Error ? error.message : error)
  })

  /** 每个会话处理到了第几条用户消息（不是 seq：消息条数才是提炼的进度）。 */
  const settled = new Map<string, number>()
  let lastAttemptAt = 0
  let inflight: Promise<void> | null = null

  function isEnabled(): boolean {
    try {
      return typeof options.enabled === 'function' ? options.enabled() === true : options.enabled === true
    } catch {
      return false
    }
  }

  function tick(): void {
    if (!isEnabled()) return
    if (router === undefined || typeof router.list !== 'function') return
    if (inflight !== null) return
    const stamp = Date.now()
    if (stamp - lastAttemptAt < minIntervalMs) return

    let session: SettleSession | undefined
    try {
      session = pickActiveSession(router)
    } catch (error) {
      warn('自动沉淀：读取会话列表失败，本轮跳过', error)
      return
    }
    if (session === undefined) return

    let messages: SettleMessage[]
    try {
      messages = readMessages(session)
    } catch (error) {
      warn('自动沉淀：读取会话消息失败，本轮跳过', error)
      return
    }
    const userTexts = extractUserTexts(messages)

    // 首次见到这个会话：只回看最近 BOOTSTRAP_WINDOW 条。
    // 否则「刚打开开关」或「重启后第一次」会把整部历史一次性提炼，
    // 冒出几条来自陈年对话的候选——那是最容易被当成 bug 的行为。
    const known = settled.get(session.id)
    const baseline = known ?? Math.max(0, userTexts.length - BOOTSTRAP_WINDOW)
    if (known === undefined) settled.set(session.id, baseline)
    if (userTexts.length - baseline < (baseline === 0 ? minMessages : 1)) return

    lastAttemptAt = stamp
    inflight = run(session, userTexts, baseline).finally(() => {
      inflight = null
    })
  }

  async function run(
    session: SettleSession,
    userTexts: readonly string[],
    already: number,
  ): Promise<void> {
    const fresh = userTexts.slice(already)
    try {
      const candidates = distill(fresh, maxCandidates)
      if (candidates.length === 0) {
        // 有新内容但提炼不出东西：推进水位，否则每轮都会重扫同一段
        settled.set(session.id, userTexts.length)
        return
      }
      const written: Array<{ title: string; id?: string; status?: string; dedupe?: string }> = []
      for (const candidate of candidates) {
        try {
          const result = await options.write({
            title: candidate.title,
            summary: candidate.summary,
            tags: ['auto-settle', candidate.tag],
            session_id: session.id,
          })
          written.push({ title: candidate.title, ...result })
        } catch (error) {
          warn(`自动沉淀：写入候选失败（${candidate.title}）`, error)
        }
      }
      settled.set(session.id, userTexts.length)
      if (written.length > 0 && options.audit !== undefined) {
        try {
          await options.audit({
            at: options.now?.() ?? new Date().toISOString(),
            type: 'lifecycle/auto-settle',
            session_id: session.id,
            scanned: fresh.length,
            written,
          })
        } catch (error) {
          warn('自动沉淀：审计写入失败', error)
        }
      }
    } catch (error) {
      warn('自动沉淀：提炼流程异常，本轮放弃', error)
    }
  }

  return {
    tick,
    idle: () => inflight ?? Promise.resolve(),
  }
}

/** 取日志最长的会话（桌面版通常只有一个；多开时视为「当前最活跃」）。 */
export function pickActiveSession(router: SessionRouter): SettleSession | undefined {
  const list = typeof router.list === 'function' ? router.list() : []
  let best: SettleSession | undefined
  let bestSeq = -1
  for (const session of list) {
    if (session === null || typeof session !== 'object' || typeof session.id !== 'string') continue
    const seq = typeof session.seq === 'number' && Number.isFinite(session.seq) ? session.seq : 0
    if (seq > bestSeq) {
      best = session
      bestSeq = seq
    }
  }
  return best
}

/** 防御式调 deriveMessages：宿主换签名时返回空数组而不是炸掉整轮注入。 */
export function readMessages(session: SettleSession): SettleMessage[] {
  if (typeof session.deriveMessages !== 'function') return []
  const raw = session.deriveMessages()
  return Array.isArray(raw) ? (raw as SettleMessage[]) : []
}

/**
 * 抽出「用户真的说过的话」。
 *
 * 判定链（缺一不可；第 1、2 条是从宿主源码里挖出来的，别简化成「只认 kind」）：
 * 1. `source.kind === 'user'`——挡住 runtime-context / agent-instructions /
 *    skill-catalog / time-context / user-approval 这些注入
 *    （实测：14 条 user/message 里只有 6 条 kind=user，其余 8 条都是注入）；
 * 2. **还必须带 `rpcId`**——`kind: 'user'` 还有一批非聊天框的产出者：
 *    `/plan` 引导消息、goal 附件引用、子代理续跑提示、ACP / SDK / headless 提交、
 *    标题生成会话。宿主自己的判据就是 `source.kind === 'user' && 'rpcId' in source`
 *    （`dsh-api-session-controller` 的 `hasPromptRequest`），这里跟它保持一致；
 * 3. 只取 text 块（content 有 text/reasoning/image/file/tool-call/tool-addition/
 *    tool-removal 七种块类型，其余一律跳过）；
 * 4. 来源字段整体缺失时退回「只认 role 且不含本插件注入标题」。
 *
 * 注意：`deriveMessages()` 返回的 Message 是 deep-frozen 的共享对象，
 * 这里只读，绝不改。
 */
export function extractUserTexts(messages: readonly SettleMessage[]): string[] {
  const out: string[] = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== undefined && message.role !== 'user') continue
    const source = message.source
    const text = collectText(message.content)
    if (text === '') continue
    if (source !== undefined && source.kind !== undefined) {
      // 只认「聊天框 RPC 提交」：kind=user 但没有 rpcId 的是插件注入，不能当用户发言
      if (source.kind === 'user' && typeof source.rpcId === 'string' && source.rpcId !== '') {
        out.push(text)
      }
      continue
    }
    // 来源整体缺失：只在不像本插件注入时才认
    if (SELF_INJECTION_MARKERS.some((marker) => text.includes(marker))) continue
    out.push(text)
  }
  return out
}

/** 把 content（字符串或块数组）拼成纯文本。 */
function collectText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const item = block as { type?: string; text?: string }
    if (item.type !== 'text' || typeof item.text !== 'string') continue
    parts.push(item.text)
  }
  return parts.join('\n').trim()
}

/**
 * 规则提炼：把一段用户发言压成 0~N 条候选。
 *
 * 判定顺序（任一不过就丢）：去噪 → 长度 → 问句 → 纯指令 → 强信号。
 * 这是「宁可漏，不可错」的取舍：误沉淀会污染检索，漏一条几乎没成本。
 */
export function distill(texts: readonly string[], limit: number): SettleCandidate[] {
  const out: SettleCandidate[] = []
  const seen = new Set<string>()
  for (const raw of texts) {
    if (out.length >= limit) break
    const cleaned = stripNoise(raw)
    if (cleaned.length < MIN_TEXT_CHARS) continue
    if (/[?？]/.test(cleaned)) continue
    if (QUESTION_STYLE.test(cleaned)) continue
    if (INSTRUCTION_HEAD.test(cleaned)) continue
    const signal = STRONG_SIGNALS.find((item) => item.pattern.test(cleaned))
    if (signal === undefined) continue
    const sentence = pickSentence(cleaned, signal.pattern)
    if (sentence === '') continue
    const title = clamp(sentence.replace(/\s+/g, ' '), MAX_TITLE_CHARS)
    if (title === '' || seen.has(title)) continue
    seen.add(title)
    out.push({ title, summary: clamp(sentence.replace(/\s+/g, ' '), MAX_SUMMARY_CHARS), tag: signal.tag })
  }
  return out
}

/** 去掉代码块/命令行/URL 这类复制粘贴内容，它们不是用户的知识表达。 */
function stripNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\r/g, '')
    .trim()
}

/** 从多句里挑出真正命中信号的那一句（首句常是寒暄）。 */
function pickSentence(text: string, pattern: RegExp): string {
  const sentences = text.split(/(?<=[。！!；;\n])/).map((item) => item.trim()).filter((item) => item !== '')
  for (const sentence of sentences) {
    if (pattern.test(sentence) && sentence.length >= MIN_TEXT_CHARS) return sentence
  }
  return sentences.find((sentence) => sentence.length >= MIN_TEXT_CHARS) ?? ''
}

function clamp(text: string, max: number): string {
  const normalized = text.trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(1, max - 1))}…`
}

function normalizePositive(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

/** 间隔允许 0（测试用；生产默认 90s）。 */
function normalizeInterval(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_MIN_INTERVAL_MS
  return Math.floor(value)
}

/** 审计事件类型常量（verify.sh 的契约锚点）。 */
export const AUTO_SETTLE_LEDGER_TYPE = 'lifecycle/auto-settle'

/** 供宿主侧复用的 backend 类型别名（只为了 import type 不落空）。 */
export type SettleBackend = MemoryBackend
