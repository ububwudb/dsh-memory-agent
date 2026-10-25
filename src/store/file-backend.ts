/**
 * 默认后端：纯文件、零依赖、原子写入。
 *
 * 目录结构：
 *   <root>/README.md  index.jsonl  ledger.jsonl  episodes/  raw/  topics/
 */
import { appendFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { MemoryBackend } from './backend.js'
import type { IndexEntry, LedgerEvent, MemoryConfig } from '../types.js'
import { DEFAULT_MEMORY_DIR } from '../types.js'
import { acquireLock } from './lock.js'
import {
  INDEX_FILE,
  LEDGER_FILE,
  MEMORY_DIRS,
  README_FILE,
  atomicWriteAbsolute,
  parseIndexLines,
  patchFrontMatter,
  renderLedgerLine,
  renderRootReadme,
  serializeIndex,
  syncDirIndexes,
} from './index-store.js'

/**
 * 解析存储根目录：config.root 优先，否则 <cwd>/.agent/memory。
 * fixture 走 createFileBackend(tmpDir) 直接给独立目录。
 */
export function resolveMemoryRoot(config: MemoryConfig | undefined, cwd: string): string {
  const configured = config?.root
  if (typeof configured === 'string' && configured.trim() !== '') {
    return path.resolve(cwd, configured)
  }
  return path.resolve(cwd, DEFAULT_MEMORY_DIR)
}

/** 创建文件后端。后端本身不缓存索引，永远以磁盘为准。 */
export function createFileBackend(root: string): MemoryBackend {
  const absoluteRoot = path.resolve(root)
  let ready: Promise<void> | undefined

  const inside = (relPath: string): string => {
    const target = path.resolve(absoluteRoot, relPath)
    const rel = path.relative(absoluteRoot, target)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`memory backend refuses path outside root: ${relPath}`)
    }
    return target
  }

  const init = (): Promise<void> => {
    ready ??= (async () => {
      await mkdir(absoluteRoot, { recursive: true })
      for (const dir of MEMORY_DIRS) {
        await mkdir(path.join(absoluteRoot, dir), { recursive: true })
      }
      try {
        await readFile(path.join(absoluteRoot, README_FILE), 'utf8')
      } catch {
        await atomicWriteAbsolute(path.join(absoluteRoot, README_FILE), renderRootReadme())
      }
    })()
    return ready
  }

  return {
    root: absoluteRoot,
    init,
    async readIndex() {
      await init()
      let text: string
      try {
        text = await readFile(path.join(absoluteRoot, INDEX_FILE), 'utf8')
      } catch {
        return []
      }
      return parseIndexLines(text).entries
    },
    async writeIndex(entries: IndexEntry[]) {
      await init()
      await atomicWriteAbsolute(path.join(absoluteRoot, INDEX_FILE), serializeIndex(entries))
      await syncDirIndexes(absoluteRoot, entries)
    },
    async appendLedger(event: LedgerEvent) {
      await init()
      await appendFile(path.join(absoluteRoot, LEDGER_FILE), renderLedgerLine(event), 'utf8')
    },
    async appendFile(relPath: string, text: string) {
      await init()
      const target = inside(relPath)
      if (target === null) throw new Error(`path escapes memory root: ${relPath}`)
      await mkdir(path.dirname(target), { recursive: true })
      await appendFile(target, text, 'utf8')
    },
    async readLedger() {
      await init()
      let text: string
      try {
        text = await readFile(path.join(absoluteRoot, LEDGER_FILE), 'utf8')
      } catch {
        return []
      }
      const events: LedgerEvent[] = []
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed: unknown = JSON.parse(trimmed)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            events.push(parsed as LedgerEvent)
          }
        } catch {
          // 坏行跳过着
        }
      }
      return events
    },
    async readFile(relPath: string) {
      await init()
      try {
        return await readFile(inside(relPath), 'utf8')
      } catch {
        return null
      }
    },
    async writeFileAtomic(relPath: string, text: string) {
      await init()
      await atomicWriteAbsolute(inside(relPath), text)
    },
    async removeFile(relPath: string) {
      await init()
      try {
        await unlink(inside(relPath))
        return true
      } catch {
        return false
      }
    },
    async listFiles(relDir: string) {
      await init()
      let names: string[]
      try {
        names = await readdir(inside(relDir))
      } catch {
        return []
      }
      return names
        .filter((name) => name.endsWith('.md') && name !== '_index.md')
        .sort()
        .map((name) => `${relDir}/${name}`)
    },
    now() {
      return new Date().toISOString()
    },
  }
}

/** 定手术式改一个记忆文件的 front-matter（状态/来源变更必须落到文件，文件才是真相源）。 */
export async function patchEntryFile(
  backend: MemoryBackend,
  entryPath: string,
  changes: Record<string, string | undefined>,
): Promise<void> {
  const text = await backend.readFile(entryPath)
  if (text === null) return
  await backend.writeFileAtomic(entryPath, patchFrontMatter(text, changes))
}

/** 读取单个条目（按 id）。 */
export async function findEntry(
  backend: MemoryBackend,
  id: string,
): Promise<IndexEntry | undefined> {
  const entries = await backend.readIndex()
  return entries.find((entry) => entry.id === id)
}

/** 索引写锁文件名（放在 root 下，跟着库走）。 */
export const INDEX_LOCK_FILE = '.index.lock'

/**
 * 在索引锁内做一次「读 → 改 → 写」。
 *
 * mutator 直接就地修改传入的 entries 数组（也可以在里面写/删记忆文件），
 * 返回什么就原样返回给调用方；mutator 抛错时不会写回索引。
 */
export async function mutateIndex<T>(
  backend: MemoryBackend,
  mutator: (entries: IndexEntry[]) => T | Promise<T>,
): Promise<T> {
  await backend.init()
  const release = await acquireLock(path.join(backend.root, INDEX_LOCK_FILE))
  try {
    const entries = await backend.readIndex()
    const result = await mutator(entries)
    await backend.writeIndex(entries)
    return result
  } finally {
    await release()
  }
}
