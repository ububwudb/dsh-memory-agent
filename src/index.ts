/**
 * dsh-memory-agent 插件入口：只做接线。
 *
 * 三件事，别的一律不做：
 * 1. 按配置造一个 backend（默认文件后端）；
 * 2. 把纯函数 handler 包成 defineTool 定义并注册到 ctx.tools；
 * 3. 用 ctx.effect 挂清理，卸载时注销工具，不留悬空状态。
 */
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { createFileBackend, resolveMemoryRoot } from './store/file-backend.js'
import type { MemoryConfig } from './types.js'
import { DEFAULT_TOP_K } from './types.js'
import type { MemoryBackend } from './store/backend.js'
import { loadIndex } from './retrieve/index-cache.js'
import { buildFacets, describeFacets } from './store/facets.js'
import { staleAnchorIds } from './store/anchors.js'
import type { AnchorFailure } from './store/anchors.js'
import { createRuntimeConfig, registerMemoryApi } from './host/api.js'
import { createRecallContextEntry, createUsageGuideContextEntry } from './host/injection.js'
import type { SystemPromptLike } from './host/injection.js'
import { createNodeAnchorProbe } from './host/anchor-probe.js'
import { installSessionHook } from './lifecycle/session-hook.js'
import { createAutoSettler } from './lifecycle/auto-settle.js'
import type { SessionRouter } from './lifecycle/auto-settle.js'
import { createSettleWriter } from './lifecycle/auto-settle-writer.js'
import { navHandler } from './tools/nav.js'
import type { NavInput, NavOutput } from './tools/nav.js'
import { buildSearchGuidance, searchHandler } from './tools/search.js'
import type { Hit, SearchInput } from './tools/search.js'
import { assembleHandler } from './tools/assemble.js'
import type { AssembleInput, AssembleOutput } from './tools/assemble.js'
import { writeHandler } from './tools/write.js'
import type { WriteInput, WriteOutput } from './tools/write.js'
import { confirmHandler } from './tools/confirm.js'
import type { ConfirmInput, ConfirmOutput } from './tools/confirm.js'
import { forgetHandler } from './tools/forget.js'
import type { ForgetInput, ForgetOutput } from './tools/forget.js'
import { resolveHandler } from './tools/resolve.js'
import type { ResolveInput, ResolveOutput } from './tools/resolve.js'
import { sweepHandler } from './tools/sweep.js'
import type { SweepInput, SweepOutput } from './tools/sweep.js'
import { digestHandler } from './tools/digest.js'
import type { DigestInput, DigestOutput } from './tools/digest.js'


/** 插件名（与 npm 包名一致）。 */
export const name = 'dsh-memory-agent'

/**
 * 必须先备好的宿主服务：
 * - tools：注册 9 个记忆工具；
 * - systemPrompt：常驻注入（把记忆摘要带进每轮上下文）；
 * - webServer：UI 面板的 API 路由。按宿主插件的通行写法写进 inject——
 *   cordis 会等它就绪才调 apply；靠 apply 里一次性解析会在服务未就绪时静默丢失路由。
 * - sessions：自动沉淀的数据源（`ctx.sessions.list()` + `session.deriveMessages()`）。
 *   同样必须进 inject，否则 apply 阶段拿不到服务，沉淀会静默失效。
 * apply 里对三者仍是防御式获取（解析不到就降级，不让插件整体失效）。
 */
export const inject = ['tools', 'systemPrompt', 'webServer', 'sessions']

/**
 * defineTool 由宿主提供。
 *
 * 解析不到时**不是**把 DSL 原样丢给注册表（那样 schema 会坏），而是用本文件内的
 * 编译器把同一份作者 DSL 编成注册表要求的原始 JSON Schema。两条路径产出同构定义，
 * 所以插件不会因为一条 import 解析失败而整体不可用。
 */
type Definition = {
  name: string
  description: string
  parameters: Spec
  // 参数由注册表/宿主按 schema 调用，这里不做类型收窄
  output: { schema: Spec; render: (...args: any[]) => unknown[] }
  execute: (...args: any[]) => unknown
}

type Spec = Record<string, unknown>

type DefineTool = (definition: Definition) => unknown

let hostDefineTool: DefineTool | undefined
try {
  const hostTools = await import('@deepseek-ai/dsh-tools')
  if (typeof hostTools.defineTool === 'function') {
    hostDefineTool = hostTools.defineTool as unknown as DefineTool
  }
} catch {
  console.warn(
    '[dsh-memory-agent] @deepseek-ai/dsh-tools 不可解析，改用内置 DSL→JSON Schema 编译器（行为等价）',
  )
}

/** 统一的定义构造入口：宿主有 defineTool 就用，没有就本地编译。 */
function define(definition: Definition): unknown {
  return hostDefineTool === undefined ? compileDefinition(definition) : hostDefineTool(definition)
}

/** 作者 DSL（本插件用到的那一小撮）→ 注册表要求的原始 JSON Schema。 */
function compileDefinition(definition: Definition): Definition {
  return {
    ...definition,
    parameters: compilePropertyMap(definition.parameters),
    output: { ...definition.output, schema: compileValue(definition.output.schema) },
  }
}

function compilePropertyMap(spec: Spec): Spec {
  const properties: Record<string, Spec> = {}
  const required: string[] = []
  const entries = Object.entries((spec ?? {}) as Record<string, Spec>)
  for (const [key, child] of entries) {
    properties[key] = compileValue(child)
    if (child?.required === true) required.push(key)
  }
  return {
    type: 'object',
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  }
}

function compileValue(spec: Spec): Spec {
  const node: Spec = {}
  if (typeof spec.description === 'string') node.description = spec.description
  const type = typeof spec.type === 'string' ? spec.type : 'string'

  if (type === 'object') {
    const compiled = compilePropertyMap((spec.properties ?? {}) as Record<string, Spec>)
    node.type = 'object'
    node.properties = compiled.properties
    node.additionalProperties = spec.additionalProperties === true
    if (compiled.required !== undefined) node.required = compiled.required
    return node
  }
  if (type === 'array') {
    node.type = 'array'
    if (spec.items !== undefined) node.items = compileValue(spec.items as Spec)
    return node
  }
  node.type = type
  if (Array.isArray(spec.enum)) node.enum = spec.enum
  return node
}

/** 插件用到的 ctx 能力；webServer/systemPrompt/sessions 是可选的（没有就降级，不让插件失效）。 */
export interface PluginContext {
  tools: { register(definition: unknown): (() => void) | undefined }
  effect(execute: () => void | (() => void), label?: string): unknown
  get?(name: string): unknown
  webServer?: unknown
  systemPrompt?: unknown
  sessions?: unknown
}

/**
 * 防御式解析宿主的 systemPrompt 服务（@deepseek-ai/dsh-system-prompt）。
 * cordis 的服务既能 ctx.get('systemPrompt') 也能属性访问，两条路都试；
 * 拿不到或形状不对就返回 undefined（工具照常工作，只是没有常驻注入）。
 */
function resolveSystemPrompt(ctx: PluginContext): SystemPromptLike | undefined {
  const viaGet = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  const candidate = viaGet ?? ctx.systemPrompt
  if (candidate === null || typeof candidate !== 'object') return undefined
  const service = candidate as Partial<SystemPromptLike>
  return typeof service.context === 'function'
    ? (candidate as SystemPromptLike)
    : undefined
}

/**
 * 防御式解析宿主的 sessions 服务（@deepseek-ai/dsh-session 的 SessionStore）。
 * 只认有 `list()` 的形状；老宿主 / headless 拿不到就降级成「没有自动沉淀」，
 * 工具与注入照常工作。
 */
function resolveSessions(ctx: PluginContext): SessionRouter | undefined {
  const viaGet = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  const candidate = viaGet ?? ctx.sessions
  if (candidate === null || typeof candidate !== 'object') return undefined
  const service = candidate as Partial<SessionRouter>
  return typeof service.list === 'function'
    ? (candidate as SessionRouter)
    : undefined
}

/** search 工具的返回信封：命中 + 给模型的下一步引导。 */
export interface SearchOutput {
  hits: Hit[]
  guidance: string
}

/** 容错：`hits` 既可能是数组，也可能是 search 的整个信封。 */
function unwrapHits(raw: unknown): Hit[] | undefined {
  if (Array.isArray(raw)) return raw as Hit[]
  if (raw !== null && typeof raw === 'object') {
    const nested = (raw as { hits?: unknown }).hits
    if (Array.isArray(nested)) return nested as Hit[]
  }
  return undefined
}

export const TOOL_NAMES = [
  'memory_nav',
  'memory_search_hybrid',
  'memory_assemble',
  'write_memory',
  'memory_confirm',
  'forget_memories_by_session',
  'memory_resolve',
  'memory_sweep',
  'memory_digest',
] as const

/**
 * 启动归因：宿主崩在插件加载期时，光看崩溃日志分不清是谁拖慢/拖垮的。
 * 这里在 apply 头和尾各落一行到 <tmp>/dsh-memory-agent-apply.log，
 * 而且带上「距宿主进程启动多少毫秒」——那才是它在启动关键路径上的真实成本。
 * 写文件失败就算了，绝不能因为打日志把宿主拖崩。
 */
const APPLY_LOG = join(tmpdir(), 'dsh-memory-agent-apply.log')
function markApply(phase: string, startedAt: number): void {
  const line = `[${new Date().toISOString()}] ${phase}`
    + ` 距进程启动 ${Math.round(performance.now())}ms`
    + (startedAt === 0 ? '' : ` 本插件 apply 耗时 ${Date.now() - startedAt}ms`)
    + ` pid=${process.pid}\n`
  console.warn(`[dsh-memory-agent] ${line.trimEnd()}`)
  try {
    appendFileSync(APPLY_LOG, line)
  } catch {
    // 打不了日志也别影响加载
  }
}

export function apply(ctx: PluginContext, config?: MemoryConfig): void {
  const applyStartedAt = Date.now()
  markApply('apply 开始', 0)
  const backend = createFileBackend(resolveMemoryRoot(config, process.cwd()))
  // 运行期配置：cordis 配置打底 + <root>/config.json 覆盖（UI 面板改的就是后者）
  const runtime = createRuntimeConfig(backend.root, config)
  const disposers: Array<() => void> = []

  const register = (definition: Definition): void => {
    const disposer = ctx.tools.register(define(definition))
    if (typeof disposer === 'function') disposers.push(disposer)
  }

  register({
    name: 'memory_nav',
    description:
      '浏览记忆的摘要层：默认只返回 id/path/type/title/summary，绝不展开原文，且默认分页（limit=50）。'
      + '要读某个文件的全文（含 raw），必须把 path 显式指到那个文件。',
    parameters: {
      path: {
        type: 'string',
        description: '目录前缀（如 topics/）或具体文件路径（如 raw/mem_x.md）；留空只看摘要层',
      },
      limit: { type: 'number', description: '一次返回多少条，默认 50，上限 500' },
      offset: { type: 'number', description: '跳过多少条（翻页用）' },
      sort: {
        type: 'string',
        enum: ['path', 'recent'],
        description: '排序：path 默认；recent = 最近写入优先（想「看看最近记了什么」时用）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                path: { type: 'string', required: true },
                type: { type: 'string', required: true, enum: ['summary', 'episode', 'raw', 'topic'] },
                title: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                time: { type: 'string', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
          offset: { type: 'integer', required: true },
          limit: { type: 'integer', required: true },
          has_more: { type: 'boolean', required: true },
          facets: {
            type: 'object',
            additionalProperties: false,
            properties: {
              total: { type: 'integer', required: true },
              retrievable: { type: 'integer', required: true },
              types: { type: 'object', additionalProperties: true, properties: {} },
              tags: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true },
                    count: { type: 'integer', required: true },
                  },
                },
              },
              newest: { type: 'string' },
              oldest: { type: 'string' },
            },
          },
          readme: { type: 'string' },
        },
      },
      render: (_args: NavInput, value: NavOutput) => [{ type: 'text', text: renderNav(value) }],
    },
    execute: async (args: NavInput) => navHandler(backend, args ?? {}),
  })

  register({
    name: 'memory_search_hybrid',
    description:
      '先在 tags/entities/时间区间上过滤，再用 BM25 打分（CJK 单字+2-gram，拉丁按词+词形归一），'
      + '最后截断 top_k。查询用**名词/关键词**比整句提问命中率高。'
      + '别名词表会把「数据库」扩展到 sqlite/postgres 等（命中会标 reason=alias）。'
      + 'suggested / superseded / deleted_pending / orphaned 不参与检索；'
      + '零命中时 `guidance` 会给库里有哪些标签、最近记了什么，照着换词重试。',
    parameters: {
      query: { type: 'string', required: true, description: '检索语句（关键词优先，别整句提问）' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签过滤（需全部命中）' },
      entities: { type: 'array', items: { type: 'string' }, description: '实体过滤（需全部命中）' },
      time_range: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', description: 'ISO 时间下界（含）' },
          to: { type: 'string', description: 'ISO 时间上界（含）' },
        },
      },
      top_k: { type: 'number', description: '返回条数，默认 10，硬上限 200' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                path: { type: 'string', required: true },
                type: { type: 'string', required: true },
                title: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                score: { type: 'number', required: true },
                reason: { type: 'string', enum: ['bm25', 'alias'] },
              },
            },
          },
          guidance: { type: 'string', required: true },
        },
      },
      render: (_args: SearchInput, value: SearchOutput) => [
        { type: 'text', text: renderHits(value.hits, value.guidance) },
      ],
    },
    execute: async (args: SearchInput) => {
      const hits = await searchHandler(backend, {
        ...args,
        // 面板上的 maxTopK 是硬上限，模型自己要求更多也不放行
        top_k: Math.min(args.top_k ?? DEFAULT_TOP_K, runtime.maxTopK),
      })
      // 使用信号在 searchHandler 里记（面板搜索同样计一次使用），这里不再重复
      return { hits, guidance: await buildSearchGuidance(backend, hits) }
    },
  })

  register({
    name: 'memory_assemble',
    description:
      '把命中压进固定 token 预算：预算硬顶，超了先丢原文再截摘要，输出永远带来源路径，'
      + '装不下的条数报在 omitted 里。token 口径固定 Math.ceil(字符数 / 1.6)。'
      + 'hits 直接传 memory_search_hybrid 的 hits 数组（传整个返回对象也认）。',
    parameters: {
      task: { type: 'string', required: true, description: '本次任务；hits 缺省时用它检索' },
      hits: {
        type: 'array',
        description: 'memory_search_hybrid 的命中；留空则按 task 现搜',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            path: { type: 'string' },
            type: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            score: { type: 'number' },
          },
        },
      },
      budget: { type: 'number', description: 'token 硬顶，默认 1200' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          context: { type: 'string', required: true },
          used_tokens: { type: 'integer', required: true },
          sources: { type: 'array', required: true, items: { type: 'string' } },
          omitted: { type: 'integer', required: true },
        },
      },
      render: (_args: AssembleInput, value: AssembleOutput) => [
        { type: 'text', text: renderAssembled(value) },
      ],
    },
    execute: async (args: AssembleInput) => assembleHandler(backend, {
      ...args,
      // 模型常常把 search 的整个返回对象塞进来，这里兼容一下，别让它因为多包一层就失败
      hits: unwrapHits(args.hits),
      budget: args.budget ?? runtime.defaultBudget,
    }),
  })

  register({
    name: 'write_memory',
    description:
      '写入一条记忆：摘要 + 可选原文 + 来源 + 置信度 + 标签 + 实体。'
      + '写入前查重；冲突不覆盖（旧值/新值都留档并标 conflict）；'
      + 'requireConfirmation=true 时先写 suggested，需要 memory_confirm 才进检索。',
    parameters: {
      summary: { type: 'string', required: true, description: '摘要（检索用的就是它）' },
      raw: { type: 'string', description: '原文；给了就落 episodes/ 且原文存 raw/' },
      tags: { type: 'array', items: { type: 'string' } },
      entities: { type: 'array', items: { type: 'string' } },
      title: { type: 'string' },
      source: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string', required: true },
          kind: { type: 'string', enum: ['session', 'plugin', 'user'] },
        },
      },
      sources: {
        type: 'array',
        description: '追加来源（多来源共享记忆）',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session_id: { type: 'string', required: true },
            kind: { type: 'string', enum: ['session', 'plugin', 'user'] },
          },
        },
      },
      session_id: { type: 'string', description: '主来源会话 id（episodes/ 与 raw/ 必须有）' },
      confidence: { type: 'number', description: '0~1，默认 0.6' },
      key: {
        type: 'string',
        description: '稳定槽位键（如 project.pkg-manager）。同 key 写入新内容 = 更新，旧版本自动转 superseded；'
          + '不给则用标题充当槽位。',
      },
      expectConflict: {
        type: 'boolean',
        description: '显式声明「这两条判不清谁对」：保留 conflict 等裁决，不自动演进。默认 false。',
      },
      requireConfirmation: { type: 'boolean', description: '覆盖插件级配置' },
      type: { type: 'string', enum: ['episode', 'topic'] },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          id: { type: 'string', required: true },
          status: {
            type: 'string',
            required: true,
            enum: ['active', 'suggested', 'superseded', 'conflict', 'deleted_pending', 'orphaned'],
          },
          dedupe: { type: 'string', enum: ['exact', 'near'] },
          similarity: { type: 'number' },
          redactions: { type: 'array', items: { type: 'string' } },
          supersedes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: WriteInput, value: WriteOutput) => [{ type: 'text', text: renderWrite(value) }],
    },
    execute: async (args: WriteInput) => writeHandler(backend, {
      ...args,
      requireConfirmation: args.requireConfirmation ?? runtime.requireConfirmation,
      redactSecrets: runtime.redactSecrets,
    }),
  })

  register({
    name: 'memory_confirm',
    description: '确认闸门：把一条 suggested 记忆提升为 active，之后才会进入检索与 assemble。',
    parameters: {
      id: { type: 'string', required: true, description: 'write_memory 返回的 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['active'] },
        },
      },
      render: (_args: ConfirmInput, value: ConfirmOutput) => [
        { type: 'text', text: `已确认 ${value.id} → ${value.status}` },
      ],
    },
    execute: async (args: ConfirmInput) => confirmHandler(backend, args),
  })

  register({
    name: 'forget_memories_by_session',
    description:
      '按 session 显式忘却：episodes/raw 标 deleted_pending 并移出检索；'
      + 'include_shared_unlink 时从 topics 的 sources 解绑该 session，sources 空了标 orphaned（不删文件）。',
    parameters: {
      session_id: { type: 'string', required: true },
      scope: { type: 'string', enum: ['session_only', 'include_shared_unlink'] },
      mode: { type: 'string', enum: ['soft', 'hard'], description: 'soft 只改状态；hard 物理删除已标记的 episodes/raw 文件' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted_episode_count: { type: 'integer', required: true },
          deleted_raw_count: { type: 'integer', required: true },
          unlinked_topic_count: { type: 'integer', required: true },
          orphaned_topic_count: { type: 'integer', required: true },
          affected_paths: { type: 'array', required: true, items: { type: 'string' } },
          status_changes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args: ForgetInput, value: ForgetOutput) => [
        { type: 'text', text: renderForget(value) },
      ],
    },
    execute: async (args: ForgetInput) => forgetHandler(backend, args),
  })

  register({
    name: 'memory_resolve',
    description:
      '给冲突收尾：keep（默认）把这条转 active、同槽位的其它冲突条目转 superseded；'
      + 'drop 把这这条转 superseded。只处理 conflict 状态。',
    parameters: {
      id: { type: 'string', required: true, description: '冲突条目的 id' },
      action: { type: 'string', enum: ['keep', 'drop'], description: '默认 keep' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: {
            type: 'string',
            required: true,
            enum: ['active', 'superseded'],
          },
          superseded: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args: ResolveInput, value: ResolveOutput) => [
        { type: 'text', text: renderResolve(value) },
      ],
    },
    execute: async (args: ResolveInput) => resolveHandler(backend, args),
  })

  register({
    name: 'memory_sweep',
    description:
      '记忆体检（**只读，不删任何东西**）：列出「久未命中」和「已被取代但仍留档」的条目，'
      + '附带 hit_count 与闲置天数。用它判断哪些记忆该淘汰/合并，再自己决定调用 forget 或 memory_resolve。'
      + '阈值默认 90 天（非常驻记忆几十天不用是常态，别按 30 天报）。'
      + '体检还含最近的零命中查询（问了但库没命中，该补记忆的信号）与锚点失效清单（失效只撤常驻注入、检索保留）。',
    parameters: {
      days: { type: 'number', description: '覆盖「久未命中」的天数阈值，默认 90' },
      limit: { type: 'number', description: '每类清单最多返回几条，默认 20' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          at: { type: 'string', required: true },
          scanned: { type: 'integer', required: true },
          thresholds: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: { longUnusedDays: { type: 'integer', required: true } },
          },
          longUnused: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                idleDays: { type: 'integer', required: true },
                hit_count: { type: 'integer', required: true },
              },
            },
          },
          supersededBacklog: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                idleDays: { type: 'integer', required: true },
                hit_count: { type: 'integer', required: true },
              },
            },
          },
          zeroHitQueries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                at: { type: 'string', required: true },
                query: { type: 'string', required: true },
              },
            },
          },
          staleAnchors: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                failures: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      kind: {
                        type: 'string',
                        required: true,
                        enum: ['env', 'tool-list', 'self-version', 'path-exists'],
                      },
                      name: { type: 'string' },
                      value: { type: 'string', required: true },
                      reason: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args: SweepInput, value: SweepRenderValue) => [
        { type: 'text', text: renderSweep(value) },
      ],
    },
    execute: async (args: SweepInput) => {
      // 体检本体与零命中查询由 sweepHandler 负责（见 tools/sweep.ts）；这里只补锚点体检
      const result = await sweepHandler(backend, args ?? {})
      const probe = createNodeAnchorProbe()
      const entries = await backend.readIndex()
      // 探测不到 = 未校验（不判失效）；失效只撤常驻注入、检索保留（见 store/anchors.ts）
      const staleAnchors: Array<{ id: string; summary: string; failures: AnchorFailureView[] }> =
        staleAnchorIds(entries, probe)
          .slice(0, 20)
          .map((item) => ({
            id: item.id,
            summary: item.summary,
            failures: item.failures.map((failure) => ({
              kind: failure.anchor.kind,
              name: failure.anchor.name,
              value: failure.anchor.value,
              reason: failure.reason,
            })),
          }))
      return { ...result, staleAnchors }
    },
  })

  register({
    name: 'memory_digest',
    description:
      '槽位的「当前认知」：同一 key 反复演进的记忆，先读 digest（最新说法 + 未裁决冲突标注 + 历史版本数）'
      + '再决定要不要下钻原文。给 key 返回该槽位的当前认知，缺失/过期自动重建；不给 key 返回槽位清单'
      + '（每槽的条目数/历史版本数/有无冲突/digest 是否过期）。refresh=true 强制重建'
      + '（有 key 只重建该槽位，没 key 全量重建所有槽位）。',
    parameters: {
      key: {
        type: 'string',
        description: '槽位键（write_memory 的 key，或回落生成的 title:<标题>）；留空 = 列出槽位清单',
      },
      refresh: {
        type: 'boolean',
        description: '强制重建：给了 key 只重建该槽位，没给重建全部槽位',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slot: { type: 'string' },
          path: { type: 'string' },
          text: { type: 'string' },
          updated_at: { type: 'string' },
          status: { type: 'string', enum: ['active', 'conflict'] },
          rebuilt: { type: 'boolean' },
          slots: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slot: { type: 'string', required: true },
                path: { type: 'string', required: true },
                updated_at: { type: 'string', required: true },
                stale: { type: 'boolean', required: true },
                entries: { type: 'integer', required: true },
                conflict: { type: 'boolean', required: true },
                history: { type: 'integer', required: true },
                text: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args: DigestInput, value: DigestOutput) => [
        { type: 'text', text: renderDigest(value) },
      ],
    },
    execute: async (args: DigestInput) => digestHandler(backend, args ?? {}),
  })

  // UI 面板的宿主半身：宿主没给 webServer 就安静跳过（工具仍然可用）
  const disposeApi = registerMemoryApi(ctx, { backend, config: runtime })

  // 自动沉淀：会话消息从宿主 ctx.sessions 读，只写 suggested 等 memory_confirm。
  // 心跳挂在常驻注入的 text provider 上（宿主每轮同步取一次），不必订阅会话事件。
  const settleConfig = config?.lifecycle?.autoSettle
  const settler = createAutoSettler(resolveSessions(ctx), {
    // 用 getter：面板勾掉开关后下一轮就停，不用重启宿主
    enabled: () => runtime.autoSettleEnabled === true,
    minIntervalMs: settleConfig?.minIntervalMs,
    minMessages: settleConfig?.minMessages,
    maxCandidates: settleConfig?.maxCandidates,
    // 写库走独立工厂：requireConfirmation: true 在那里硬编码，测试与生产同一份实现
    write: createSettleWriter(backend, { redactSecrets: runtime.redactSecrets }),
    audit: async (event) => {
      await backend.appendLedger(event)
    },
  })

  // 常驻注入：把记忆摘要挂进每轮 prompt 的 runtime context。
  // 宿主解析不到 systemPrompt 服务（老版本/headless）时安静跳过，工具不受影响；
  // text provider 是同步取值、每轮请求刷新（宿主 refreshContext 的硬约束，见 host/injection.ts）。

  const systemPrompt = resolveSystemPrompt(ctx)
  if (systemPrompt !== undefined) {
    try {
      const disposeEntry = systemPrompt.context(
        createRecallContextEntry(backend.root, runtime, settler.tick),
      )
      if (typeof disposeEntry === 'function') disposers.push(disposeEntry as () => void)
      // 记忆使用守则单独一条：不占记忆预算，空库也在（模型才知道什么时候该记、该搜）
      const disposeGuide = systemPrompt.context(
        createUsageGuideContextEntry(runtime),
      )
      if (typeof disposeGuide === 'function') disposers.push(disposeGuide as () => void)
    } catch (error) {
      console.warn(
        '[dsh-memory-agent] 常驻注入注册失败（工具不受影响）:',
        error instanceof Error ? error.message : error,
      )
    }
  }

  const disposeHook = installSessionHook(ctx, backend, {
    enabled: config?.lifecycle?.enabled === true,
    audit: config?.lifecycle?.audit,
  })

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // 卸载阶段不抛异常，避免拖垮宿主
      }
    }
    try {
      disposeApi?.()
    } catch {
      // 同上
    }
    disposeHook()
  }, 'dsh-memory-agent:teardown')
  markApply('apply 完成', applyStartedAt)
}

/* ------------------------------ 渲染（只影响观感） ------------------------------ */

function renderNav(value: NavOutput): string {
  const range = value.total <= value.entries.length
    ? `共 ${value.total} 条`
    : `第 ${value.offset + 1}–${value.offset + value.entries.length} 条 / 共 ${value.total} 条`
  const head = `摘要层 ${range}（不含正文；raw 需把 path 指到具体文件）`
  const lines = value.entries.map(
    (entry) => `- [${entry.type}] ${entry.path} — ${entry.title}｜${oneLine(entry.summary)}`,
  )
  const parts = [head, ...lines]
  if (value.facets !== undefined) parts.push('', describeFacets(value.facets))
  if (value.has_more) {
    parts.push(`（还有更多，用 offset=${value.offset + value.entries.length} 继续翻）`)
  }
  if (value.readme !== undefined && value.readme !== '') parts.push('', value.readme)
  return parts.join('\n')
}

function renderHits(hits: readonly Hit[], guidance: string): string {
  if (hits.length === 0) {
    return guidance === '' ? '没有命中（BM25 分数为 0 的条目不会返回）' : guidance
  }
  const lines = hits.map((hit, index) => {
    const tag = hit.reason === 'alias' ? '（别名推断）' : ''
    return `${index + 1}. score=${hit.score}${tag} [${hit.type}] ${hit.path} — ${hit.title}｜${oneLine(hit.summary)}`
  })
  if (guidance !== '') lines.push('', guidance)
  return lines.join('\n')
}

function renderAssembled(value: AssembleOutput): string {
  const footer = `used_tokens=${value.used_tokens} / sources=${value.sources.length}`
    + (value.omitted > 0 ? ` / 未放入 ${value.omitted} 条（预算不够）` : '')
  if (value.context === '') return `（预算内没有任何内容可放）${footer}`
  return `${value.context}\n\n---\n${footer}\n${value.sources.map((path) => `- ${path}`).join('\n')}`
}

function renderWrite(value: WriteOutput): string {
  const masked = value.redactions !== undefined && value.redactions.length > 0
    ? `（落盘前已脱敏：${value.redactions.join(', ')}）`
    : ''
  const replaced = value.supersedes !== undefined && value.supersedes.length > 0
    ? `，取代了 ${value.supersedes.length} 条旧版本（${value.supersedes.join(', ')}，已退出检索）`
    : ''
  if (value.dedupe === 'exact') {
    return `已存在完全相同的记忆 ${value.path}（id=${value.id}，未重复写入）${masked}`
  }
  if (value.dedupe === 'near') {
    return `已存在高度相似的记忆 ${value.path}（id=${value.id}，相似度 ${value.similarity}，未重复写入）${masked}`
  }
  return `已写入 ${value.path}（id=${value.id}, status=${value.status}${replaced}）${masked}`
}

/** 锚点失效的输出形状：把 AnchorFailure 的锚点字段拍平再补 reason（schema 与渲染共用）。 */
type AnchorFailureView = AnchorFailure['anchor'] & { reason: string }

/**
 * renderSweep 的入参：sweepHandler 的输出（zeroHitQueries 由 tools/sweep.ts 直接返回）
 * 加上本文件 execute 里附加的锚点体检。两段都按可选处理，哪段缺了就整段跳过。
 */
type SweepRenderValue = SweepOutput & {
  zeroHitQueries?: Array<{ at: string; query: string }>
  staleAnchors?: Array<{ id: string; summary: string; failures: AnchorFailureView[] }>
}

function renderSweep(value: SweepRenderValue): string {
  const lines = [
    `记忆体检 @ ${value.at}（统计 ${value.scanned} 条；久未命中阈值 ${value.thresholds.longUnusedDays} 天）`,
    `久未命中：${value.longUnused.length} 条`,
  ]
  for (const item of value.longUnused) {
    lines.push(`- ${item.id} 闲置 ${item.idleDays} 天 / 命中 ${item.hit_count} 次 — ${item.summary}`)
  }
  lines.push(`已被取代但留档：${value.supersededBacklog.length} 条`)
  for (const item of value.supersededBacklog) {
    lines.push(`- ${item.id} 闲置 ${item.idleDays} 天 / 命中 ${item.hit_count} 次 — ${item.summary}`)
  }
  const zeroHits = value.zeroHitQueries ?? []
  lines.push(`最近零命中查询（问了但库没命中，该补记忆的信号）：${zeroHits.length} 条`)
  for (const item of zeroHits.slice(0, 5)) {
    lines.push(`- ${item.query}（${item.at.slice(0, 10)}）`)
  }
  if (zeroHits.length > 5) {
    lines.push(`（还有 ${zeroHits.length - 5} 条未列出）`)
  }
  const staleAnchors = value.staleAnchors ?? []
  lines.push(`锚点失效（撤了常驻注入，检索仍在；核对后回写）：${staleAnchors.length} 条`)
  for (const item of staleAnchors) {
    for (const failure of item.failures) {
      lines.push(`- ${item.id} — ${failure.reason}（${failure.value}）`)
    }
  }
  lines.push('（这是只读清单，不会删任何东西。要淘汰用 forget，要合并/裁决用 memory_resolve。）')
  return lines.join('\n')
}

function renderDigest(value: DigestOutput): string {
  // 清单模式：每槽一行「- 槽位｜条目 N｜历史 M｜状态尾缀」，冲突优先于过期优先于日期
  if (value.slots !== undefined) {
    if (value.slots.length === 0) {
      return '还没有任何槽位（先用 write_memory 写入；同 key 的写入会自动归进同一个槽位）'
    }
    const lines = value.slots.map((item) => {
      const tail = item.conflict
        ? '⚠未裁决冲突'
        : item.updated_at === ''
          ? '尚未生成'
          : item.stale
            ? '已过期'
            : `更新于 ${item.updated_at.slice(0, 10)}`
      return `- ${item.slot}｜条目 ${item.entries}｜历史 ${item.history}｜${tail}`
    })
    lines.push('（要看某个槽位的当前认知：memory_digest({ key: "<槽位>" })；标了已过期的会在下次读取时自动重建）')
    return lines.join('\n')
  }
  // 单槽位模式：状态头 + 正文 + 来源行
  const state = value.status === 'conflict' ? '有未裁决冲突' : '一致'
  const freshness = value.rebuilt === true ? '已重建' : '缓存'
  const parts = [`当前认知 · ${value.slot ?? ''}（${state}，${freshness}）`, '', value.text ?? '']
  if (value.path !== undefined && value.path !== '') {
    parts.push('', `来源: ${value.path}（更新于 ${value.updated_at ?? ''}）`)
  }
  return parts.join('\n')
}

function renderResolve(value: ResolveOutput): string {
  const tail = value.superseded.length > 0
    ? `，连带 superseded ${value.superseded.length} 条（${value.superseded.join(', ')}）`
    : ''
  return `冲突已处理：${value.id} → ${value.status}${tail}`
}

function renderForget(value: ForgetOutput): string {
  return [
    `episodes=${value.deleted_episode_count} raw=${value.deleted_raw_count} `
    + `unlinked_topics=${value.unlinked_topic_count} orphaned_topics=${value.orphaned_topic_count}`,
    ...value.affected_paths.map((path) => `- ${path}`),
  ].join('\n')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
