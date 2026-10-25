#!/usr/bin/env node
/**
 * 自动沉淀的独立断言：不需要宿主运行时，用假 ctx.sessions + 真 backend。
 *
 * 覆盖四条硬约束里最容易回归的三条：
 * 1. 只写 suggested（确认闸门）；
 * 2. 只认 source.kind === 'user'（防回音）；
 * 3. 提炼规则宁缺毋滥（问句/指令/太短一律丢）。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const { createFileBackend } = await load('lib/store/file-backend.js')
const { createAutoSettler, distill, extractUserTexts } = await load('lib/lifecycle/auto-settle.js')
const { createSettleWriter } = await load('lib/lifecycle/auto-settle-writer.js')

let passed = 0
const problems = []
const check = (name, ok, detail) => {
  if (ok) {
    passed += 1
    return
  }
  problems.push(detail === undefined ? name : `${name} — ${detail}`)
}

/* ---------- 1. distill：宁缺毋滥 ---------- */
const candidates = distill([
  '以后都用 pnpm，不要用 npm 装依赖。',
  '这个怎么改？',
  '帮我看看日志',
  '好的',
  '我的意思是，这个插件到底好不好，能不能发布了，够不够用',
  '记住我的 SQL Server 实例是 MYPC\\SQLEXPRESS。',
], 5)
check('distill 只留强信号句', candidates.length === 2, JSON.stringify(candidates))
// 真实会话里踩到的两个误判模式，必须挡住
check('中文疑问语气（好不好/能不能）不进沉淀', distill(['我的意思是，这个插件到底好不好，能不能发布了，够不够用'], 3).length === 0)
check('「我的意思是」不算身份陈述', distill(['我的意思是，这个方案先放着。'], 3).length === 0)
check('「我的电脑是」算身份陈述', distill(['我的电脑是 ThinkPad T14。'], 3).length === 1)
check(
  'distill 丢掉问句/指令/过短',
  candidates.every((item) => !item.summary.includes('怎么改') && !item.summary.includes('看看日志') && item.summary.length > 10),
  JSON.stringify(candidates),
)
check('distill 单次上限生效', distill(new Array(10).fill('以后都用 pnpm 装依赖，别再问。'), 2).length <= 2)

/* ---------- 2. extractUserTexts：只认真用户发言 ---------- */
const texts = extractUserTexts([
  { role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: [{ type: 'text', text: '以后都用 pnpm。' }] },
  // kind=user 但没有 rpcId：/plan 引导、goal 附件引用、子代理续跑都长这样，必须挡掉
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '记住：这是 /plan 引导消息。' }] },
  { role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: '记住：这是运行时上下文。' }] },
  { role: 'user', source: { kind: 'agent-instructions', form: 'instructions' }, content: [{ type: 'text', text: '记住：这是 AGENTS.md。' }] },
  { role: 'user', content: [{ type: 'text', text: '## 记忆（自动注入）\n- 不该被沉淀' }] },
  { role: 'assistant', source: { kind: 'user', rpcId: 'rpc-2' }, content: [{ type: 'text', text: '记住：助手自己说的。' }] },
])
check('extractUserTexts 只留真用户发言（kind=user 且带 rpcId）', texts.length === 1 && texts[0].includes('pnpm'), JSON.stringify(texts))
check(
  'kind=user 但没有 rpcId 的注入不进沉淀',
  !texts.some((text) => text.includes('/plan') || text.includes('运行时上下文') || text.includes('AGENTS.md')),
  JSON.stringify(texts),
)

/* ---------- 3. 端到端：真 backend + writeHandler，只落 suggested ---------- */
const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-memory-settle-'))
const backend = createFileBackend(root)
await backend.init()

const fakeSession = {
  id: 'session-settle-check',
  seq: 12,
  deriveMessages: () => [
    { role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: [{ type: 'text', text: '以后都用 pnpm，不要用 npm 装依赖。' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好，记下了。' }] },
    { role: 'user', source: { kind: 'user', rpcId: 'rpc-2' }, content: [{ type: 'text', text: '记住我的 SQL Server 实例是 MYPC\\SQLEXPRESS。' }] },
    { role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: '记住：运行时上下文不该被沉淀。' }] },
    { role: 'user', source: { kind: 'user', rpcId: 'rpc-3' }, content: [{ type: 'text', text: '默认端口统一用 8080。' }] },
    { role: 'user', source: { kind: 'user', rpcId: 'rpc-4' }, content: [{ type: 'text', text: '我的机器是 ThinkPad T14。' }] },
  ],
}

const settler = createAutoSettler(
  { list: () => [fakeSession] },
  {
    enabled: true,
    minIntervalMs: 0,
    minMessages: 4,
    maxCandidates: 3,
    // 与生产接线同一份实现（requireConfirmation 在工厂里硬编码），避免测试漂移
    write: createSettleWriter(backend),
    audit: async (event) => {
      await backend.appendLedger(event)
    },
    warn: (message, error) => {
      problems.push(`自动沉淀意外告警：${message} — ${error instanceof Error ? error.message : String(error)}`)
    },
  },
)

const readRows = async (file) => {
  try {
    return (await readFile(path.join(root, file), 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

settler.tick()
await settler.idle()
const entries = await readRows('index.jsonl')
check('自动沉淀写入了条目', entries.length > 0, `条数 ${entries.length}`)
check(
  '写入的全部是 suggested（确认闸门没过）',
  entries.length > 0 && entries.every((entry) => entry.status === 'suggested'),
  JSON.stringify(entries.map((entry) => entry.status)),
)
check(
  '标签带 auto-settle',
  entries.length > 0 && entries.every((entry) => Array.isArray(entry.tags) && entry.tags.includes('auto-settle')),
  JSON.stringify(entries.map((entry) => entry.tags)),
)

const ledger = await readRows('ledger.jsonl')
check('审计写入 lifecycle/auto-settle', ledger.some((event) => event.type === 'lifecycle/auto-settle'), JSON.stringify(ledger.map((event) => event.type)))

/* ---------- 4. 水位：没有新消息就不再重复写 ---------- */
settler.tick()
await settler.idle()
const after = await readRows('index.jsonl')
check('水位生效，不重复沉淀', after.length === entries.length, `before=${entries.length} after=${after.length}`)

/* ---------- 5. 首次只回看最近 20 条，不把整部历史一次性提炼 ---------- */
const longRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-memory-settle-long-'))
const longBackend = createFileBackend(longRoot)
await longBackend.init()
const oldMessages = Array.from({ length: 10 }, (_, i) => ({
  role: 'user',
  source: { kind: 'user', rpcId: `old-${i}` },
  content: [{ type: 'text', text: `记住：旧消息${i}，以后都用 npm 装依赖。` }],
}))
const newMessages = Array.from({ length: 20 }, (_, i) => ({
  role: 'user',
  source: { kind: 'user', rpcId: `new-${i}` },
  content: [{ type: 'text', text: `记住：新消息${i}，以后都用 pnpm 装依赖。` }],
}))
const longSettler = createAutoSettler(
  { list: () => [{ id: 'session-long', seq: 30, deriveMessages: () => [...oldMessages, ...newMessages] }] },
  {
    enabled: true,
    minIntervalMs: 0,
    minMessages: 4,
    maxCandidates: 3,
    write: createSettleWriter(longBackend),
    warn: (message, error) => {
      problems.push(`长会话告警：${message} — ${error instanceof Error ? error.message : String(error)}`)
    },
  },
)
longSettler.tick()
await longSettler.idle()
const longEntries = (await readFile(path.join(longRoot, 'index.jsonl'), 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
check('首次运行也会提炼（最近一段）', longEntries.length > 0, `条数 ${longEntries.length}`)
check(
  '首次只回看最近 20 条，不碰陈年历史',
  longEntries.length > 0 && longEntries.every((entry) => !entry.title.includes('旧消息')),
  JSON.stringify(longEntries.map((entry) => entry.title)),
)
await rm(longRoot, { recursive: true, force: true })

/* ---------- 6. 开关关闭时是纯空操作 ---------- */
const offSettler = createAutoSettler(
  { list: () => [fakeSession] },
  {
    enabled: false,
    minIntervalMs: 0,
    minMessages: 1,
    maxCandidates: 3,
    write: async () => {
      problems.push('开关关闭时不该调用 write')
      return {}
    },
  },
)
offSettler.tick()
await offSettler.idle()
check('开关关闭时不写任何东西', true)

await rm(root, { recursive: true, force: true })

if (problems.length > 0) {
  console.error(`[FAIL] 自动沉淀：${problems.length} 项未通过`)
  for (const problem of problems) console.error(`       ${problem}`)
  process.exit(1)
}
console.log(`[PASS] 自动沉淀：${passed} 项断言全绿（只写 suggested / 只认 user 来源 / 水位不重复 / 开关可关）`)
