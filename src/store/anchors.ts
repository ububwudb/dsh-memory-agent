/**
 * 锚点探测与失效判定（P2）。
 *
 * 判据借自社区里迭代过的实现（只抄规则不抄代码）：
 * - 四种受控 kind：`env` / `tool-list` / `self-version` / `path-exists`；
 * - **探测不到 = 未校验**（不判失效）——probe 返回 undefined 就当没看见，绝不把
 *   「宿主没这个能力」误报成「记忆失效」；
 * - 失效只**撤常驻注入、保留检索**，等模型核对后回写（改记忆或换锚点）。
 *
 * 本模块纯函数：probe 由宿主层注入（host/anchor-probe.ts 的 Node 实现、fixture 的假 probe），
 * 这里绝不碰 process / node:fs——保持 lib/tools 与 store 的可测试性。
 */
import type { AnchorKind, IndexEntry, MemoryAnchor } from '../types.js'
import { isRetrievable } from '../types.js'

/** 受控 kind 白名单（写入口径，超出即丢弃）。 */
export const ANCHOR_KINDS: readonly AnchorKind[] = ['env', 'tool-list', 'self-version', 'path-exists']

/** 单条记忆最多挂几个锚点（防模型刷字段）。 */
export const MAX_ANCHORS_PER_ENTRY = 8

/** 锚点字段截断宽度。 */
const ANCHOR_NAME_CHARS = 80
const ANCHOR_VALUE_CHARS = 300

/** 宿主注入的探测能力；任何方法返回 undefined 都表示「当前探测不到」→ 未校验。 */
export interface AnchorProbe {
  env(name: string): string | undefined
  pathExists(path: string): boolean | undefined
  toolList(): string[] | undefined
  selfVersion(): string | undefined
}

/** 一个锚点失效的现场。 */
export interface AnchorFailure {
  anchor: MemoryAnchor
  reason: string
}

/**
 * 归一化写入口的 anchors：白名单 kind、value 必须非空、name/value 截断去换行、去重、封顶 8 个。
 * 全部非法时返回 undefined（视为没给）。
 */
export function normalizeAnchors(raw: unknown): MemoryAnchor[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: MemoryAnchor[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const kind = record.kind
    if (typeof kind !== 'string' || !(ANCHOR_KINDS as readonly string[]).includes(kind)) continue
    const value = oneLine(typeof record.value === 'string' ? record.value : '')
    if (value === '') continue
    const nameRaw = typeof record.name === 'string' ? oneLine(record.name) : ''
    const name = kind === 'env' || kind === 'tool-list'
      ? clip(nameRaw, ANCHOR_NAME_CHARS) || undefined
      : undefined
    const anchor: MemoryAnchor = {
      kind: kind as AnchorKind,
      value: clip(value, ANCHOR_VALUE_CHARS),
      ...(name !== undefined ? { name } : {}),
    }
    const fingerprint = `${anchor.kind}|${anchor.name ?? ''}|${anchor.value}`
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    out.push(anchor)
    if (out.length >= MAX_ANCHORS_PER_ENTRY) break
  }
  return out.length > 0 ? out : undefined
}

/** front-matter 单行 JSON（anchors: [{"kind":"path-exists","value":"…"}]）。 */
export function serializeAnchors(anchors: readonly MemoryAnchor[]): string {
  return JSON.stringify(anchors)
}

/** 解析 front-matter 的 anchors 字段；坏 JSON / 形状不对返回 undefined。 */
export function parseAnchorsField(raw: string | undefined): MemoryAnchor[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  try {
    return normalizeAnchors(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/**
 * 逐个评估锚点；探测不到（probe 返回 undefined）按「未校验」跳过，不算失效。
 * - env：有 name 用 name，否则用 value 做变量名；value 非空时还要求值相等；
 * - path-exists：value 是路径，存在才算过；
 * - tool-list：value（或 name）必须出现在工具清单里；
 * - self-version：value 必须等于当前插件版本。
 */
export function evaluateAnchors(
  anchors: readonly MemoryAnchor[],
  probe: AnchorProbe,
): AnchorFailure[] {
  const failures: AnchorFailure[] = []
  for (const anchor of anchors) {
    let probed: boolean | undefined
    let reason = ''
    switch (anchor.kind) {
      case 'env': {
        const varName = anchor.name ?? anchor.value
        const actual = varName === '' ? undefined : probe.env(varName)
        if (actual === undefined) continue // 未校验
        if (anchor.value !== '' && actual !== anchor.value) reason = `环境变量 ${varName} 的值已变化`
        probed = true
        break
      }
      case 'path-exists': {
        const exists = probe.pathExists(anchor.value)
        if (exists === undefined) continue // 未校验
        probed = true
        if (!exists) reason = `路径已不存在：${anchor.value}`
        break
      }
      case 'tool-list': {
        const expected = anchor.name ?? anchor.value
        const list = probe.toolList()
        if (list === undefined) continue // 未校验
        probed = true
        if (!list.includes(expected)) reason = `工具 ${expected} 不在当前清单里`
        break
      }
      case 'self-version': {
        const version = probe.selfVersion()
        if (version === undefined) continue // 未校验
        probed = true
        if (version !== anchor.value) reason = `插件版本已从 ${anchor.value} 变为 ${version}`
        break
      }
    }
    if (probed && reason !== '') failures.push({ anchor, reason })
  }
  return failures
}

/**
 * 找出「锚点已失效」的条目：只看可检索的非 raw 条目
 * （suggested 还没生效、superseded/deleted/orphaned 已退出注入，报它们是噪音）。
 */
export function staleAnchorIds(
  entries: readonly IndexEntry[],
  probe: AnchorProbe,
): Array<{ id: string; summary: string; failures: AnchorFailure[] }> {
  const out: Array<{ id: string; summary: string; failures: AnchorFailure[] }> = []
  for (const entry of entries) {
    if (entry.type === 'raw' || !isRetrievable(entry.status)) continue
    if (entry.anchors === undefined || entry.anchors.length === 0) continue
    const failures = evaluateAnchors(entry.anchors, probe)
    if (failures.length > 0) out.push({ id: entry.id, summary: entry.summary, failures })
  }
  return out
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 1) return ''
  return `${text.slice(0, max - 1).trimEnd()}…`
}
