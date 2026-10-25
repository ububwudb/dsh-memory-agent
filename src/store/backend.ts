/**
 * MemoryBackend：工具 handler 能碰到的全部存储能力。
 *
 * 约束（务必保持）：
 * - handler 只通过本接口读写，不碰 `root` 之外的任何路径；
 * - 接口不含 ctx、不含全局状态，便于 test/run-fixtures.mjs 传入临时 backend 做断言；
 * - 后端可替换（文件后端是默认实现），后续可加 SQLite/远端实现。
 */
import type { IndexEntry, LedgerEvent } from '../types.js'

export interface MemoryBackend {
  /** 存储根目录（绝对路径）。handler 不得读取该路径之外的文件。 */
  readonly root: string

  /** 幂等初始化：建目录、写 README.md 骨架。 */
  init(): Promise<void>

  /** 读 index.jsonl；跳过 JSON parse 失败的行，不因坏行整体崩溃。 */
  readIndex(): Promise<IndexEntry[]>

  /** 全量覆写 index.jsonl（原子写）。 */
  writeIndex(entries: IndexEntry[]): Promise<void>

  /** 只追加审计事件到 ledger.jsonl。 */
  appendLedger(event: LedgerEvent): Promise<void>

  /**
   * 只追加文本到某个相对路径文件（不存在则创建）。
   * 用于 usage.jsonl 这类「旁路信号」：绝不能读-改-写全量覆盖。
   */
  appendFile(relPath: string, text: string): Promise<void>

  /** 读回审计事件（坏行跳过）。 */
  readLedger(): Promise<LedgerEvent[]>

  /** 读一个相对路径文件；不存在返回 null。 */
  readFile(relPath: string): Promise<string | null>

  /** 原子写一个相对路径文件（写临时文件 + rename）。 */
  writeFileAtomic(relPath: string, text: string): Promise<void>

  /** 删除一个相对路径文件；返回是否真的删掉了。 */
  removeFile(relPath: string): Promise<boolean>

  /** 列出某目录下（不含子目录）的记忆文件名，返回相对路径，已排序。 */
  listFiles(relDir: string): Promise<string[]>

  /** 当前时间（ISO 8601）。 */
  now(): string
}
