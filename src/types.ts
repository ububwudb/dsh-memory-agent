/**
 * 共享类型与常量。工具 handler 只依赖本文件 + store 接口，不依赖 cordis。
 */

/** 索引条目类型：摘要层 / 会话情节 / 原文 / 主题（共享）。 */
export type EntryType = 'summary' | 'episode' | 'raw' | 'topic'

/**
 * 条目状态。
 * - active：可检索、可 assemble
 * - suggested：写入闸门未确认，不进入检索与 assemble
 * - superseded：被新条目取代，保留但降权
 * - conflict：与已有条目冲突且未覆盖，旧值/新值都在 variants 里
 * - deleted_pending：忘却被标记，文件保留、从检索索引移除
 * - orphaned：共享记忆的所有来源都被解绑，文件保留
 */
export type EntryStatus =
  | 'active'
  | 'suggested'
  | 'superseded'
  | 'conflict'
  | 'deleted_pending'
  | 'orphaned'

/** 来源种类。 */
export type SourceKind = 'session' | 'plugin' | 'user'

/** 一条来源记录。forget 逻辑只读 sources 数组，不读顶层 session_id。 */
export interface MemorySource {
  session_id: string
  kind: SourceKind
}

/**
 * 记忆锚点（P2）：给记忆挂一个可探测的事实依据。
 * 四种受控 kind（判据借自社区实现）：探测不到 = 未校验（不判失效）；
 * 失效只**撤常驻注入、保留检索**，等模型核对后回写。
 */
export type AnchorKind = 'env' | 'tool-list' | 'self-version' | 'path-exists'

export interface MemoryAnchor {
  kind: AnchorKind
  /** env 用：环境变量名；tool-list 用：工具名；其余 kind 不用。 */
  name?: string
  /** 期望值：env 的变量值（空串=只查存在）、path-exists 的路径、tool-list 的工具名、self-version 的版本。 */
  value: string
}

/** 冲突现场：旧值/新值 + 时间 + 来源，绝不覆盖。 */
export interface ConflictVariant {
  value: string
  time: string
  source: MemorySource
}

/** index.jsonl 的一行。 */
export interface IndexEntry {
  id: string
  path: string
  type: EntryType
  title: string
  summary: string
  tags: string[]
  entities: string[]
  time: string
  sources: MemorySource[]
  /** 主来源快捷字段；仅用于展示，forget 只读 sources。 */
  session_id: string
  confidence: number
  raw_ref?: string
  vector_id?: string
  status: EntryStatus
  /** 查重指纹（type + 归一化 summary），用于识别完全重复。 */
  fingerprint?: string
  /** 冲突槽位键（type + 归一化 title/summary 前缀），槽位相同即冲突。 */
  conflict_key?: string
  /** 冲突现场。 */
  variants?: ConflictVariant[]
  /** 软删时间。 */
  deleted_at?: string
  deleted_by_session?: string
  /**
   * 稳定槽位键（版本演进用）：同 key 的新内容会取代旧内容，而不是并存。
   * 显式给就原样用（小写），不给则回落到 `title:<归一化标题>`。
   */
  key?: string
  /** 记忆锚点：探测失效 → 撤常驻注入、保留检索（见 store/anchors.ts）。 */
  anchors?: MemoryAnchor[]
  /** 本条取代了哪些旧版本（被取代方 status=superseded）。 */
  supersedes?: string[]
  /** 本条被谁取代（superseded 态的指回指针）。 */
  superseded_by?: string
  /**
   * 使用信号：被检索命中的次数。
   * 独立记在 usage.jsonl 里（旁路），这里是聚合后的展示值，不作为检索依据。
   */
  hit_count?: number
  /** 使用信号：最后一次被命中/回写的时间。 */
  last_used_at?: string
  /** 索引 schema 版本；缺省视为 1（旧数据），点「重建索引」会升到当前版本。 */
  schema_version?: number
}

/** 审计事件（ledger.jsonl 一行）。只追加。 */
export interface LedgerEvent {
  at: string
  type: string
  [key: string]: unknown
}

/** 插件配置（cordis.patch.yml 的 config）。 */
export interface MemoryConfig {
  /** 存储根目录；null/缺省 = <cwd>/.agent/memory */
  root?: string | null
  /** 默认 false：直接写 active；true：先写 suggested，需 memory_confirm */
  requireConfirmation?: boolean
  /** memory_assemble 默认预算（token） */
  defaultBudget?: number
  /** 检索硬上限 */
  maxTopK?: number
  /** 写入前把密钥类文本打码，默认 true */
  redactSecrets?: boolean
  /** 常驻注入开关：把记忆摘要自动带进每轮上下文，默认 true */
  injectEnabled?: boolean
  /** 常驻注入的字符预算硬顶（含标题行），默认 1500 */
  injectBudgetChars?: number
  lifecycle?: {
    enabled?: boolean
    audit?: boolean
    /**
     * 自动沉淀：会话里用户明确表达的事实/偏好，自动提炼成 suggested 记忆。
     * 默认关闭——机器提炼必然有误判，先观察准确率再打开。
     */
    autoSettle?: {
      enabled?: boolean
      /** 两次尝试的最小间隔（毫秒），默认 90000。 */
      minIntervalMs?: number
      /** 会话里至少多少条用户消息才提炼，默认 4。 */
      minMessages?: number
      /** 单次最多沉淀几条，默认 3。 */
      maxCandidates?: number
    }
  }
}

/**
 * 运行期配置：cordis 配置给初始值，UI 面板可以把改动写进 <root>/config.json，
 * 覆盖项立即生效（不需要重启宿主）。
 */
export interface MemoryRuntimeConfig {
  requireConfirmation: boolean
  defaultBudget: number
  maxTopK: number
  /** 写入前把密钥类文本打码，默认开。 */
  redactSecrets: boolean
  /** 常驻注入开关，默认开（空库时自然什么都不注入）。 */
  injectEnabled: boolean
  /** 常驻注入的字符预算硬顶（不是 token：注入文本短小，直接用字符数更好估算）。 */
  injectBudgetChars: number
  /**
   * 自动沉淀开关（面板可改，立即生效）：会话里用户明确表达的事实/偏好
   * 自动提炼成 suggested 记忆。默认关——先观察准确率再打开。
   */
  autoSettleEnabled: boolean
}

/** UI 面板能改的字段白名单（其余字段只读，避免面板把配置写坏）。 */
export const TUNABLE_CONFIG_KEYS = [
  'requireConfirmation',
  'defaultBudget',
  'maxTopK',
  'redactSecrets',
  'injectEnabled',
  'injectBudgetChars',
  'autoSettleEnabled',
] as const

/** 运行期配置文件（相对 backend.root）。 */
export const RUNTIME_CONFIG_FILE = 'config.json'

/** 默认存储目录（相对 cwd）。 */
export const DEFAULT_MEMORY_DIR = '.agent/memory'

/** memory_search_hybrid 的 top_k 默认值与硬上限。 */
export const DEFAULT_TOP_K = 10
export const MAX_TOP_K = 200

/** memory_assemble 的默认预算（token）。 */
export const DEFAULT_BUDGET = 1200

/**
 * 常驻注入的默认字符预算。
 *
 * 注意口径差异：memory_assemble 的预算单位是 token（除以 1.6 估算），
 * 注入预算是**字符**——参照社区实现（每条 80 字符摘要、1500 字符预算），
 * 注入文本很短，用字符数做硬顶更直观，面板上也好解释。
 */
export const DEFAULT_INJECT_BUDGET_CHARS = 1500

/**
 * token 口径：固定 `Math.ceil(text.length / 1.6)`，不调用任何 tokenizer。
 *
 * 为什么不是 /3：中文在 DeepSeek tokenizer 里 1 字约 0.6~0.7 token，按 /3 会**低估近一倍**，
 * 等于预算形同虚设。/1.6 对中文基本贴合、对英文偏保守（英文 1 token≈4 字符），
 * 保守方向是「少放一点」，比「悄悄超支」安全。
 */
export const CHARS_PER_TOKEN = 1.6

/** 估算 token 数（唯一口径，务必与 README 一致）。 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** 反算：给定 token 预算最多能放多少字符（向下取整，保证 estimateTokens 不超预算）。 */
export function charsForBudget(budget: number): number {
  return Math.floor(budget * CHARS_PER_TOKEN)
}

/**
 * 不进入检索/assemble 的状态集合：
 * - suggested：确认闸门没过，模型自我提升的错误记忆不许回流；
 * - superseded：冲突裁决后被取代的旧说法，留档但不该再被检索到；
 * - deleted_pending：已被显式忘却，从检索索引移除；
 * - orphaned：共享记忆的所有来源都已解绑，文件保留但不再参与检索。
 */
export const RETRIEVAL_EXCLUDED_STATUSES: readonly EntryStatus[] = [
  'suggested',
  'superseded',
  'deleted_pending',
  'orphaned',
]

/** status 是否参与检索。 */
export function isRetrievable(status: EntryStatus): boolean {
  return !RETRIEVAL_EXCLUDED_STATUSES.includes(status)
}
