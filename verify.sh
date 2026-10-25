#!/usr/bin/env bash
#
# dsh-memory-agent 一键验证：退出码 0 才算通过。
#
#   bash verify.sh            # 全量
#   bash verify.sh 03         # 只跑名字含 03 的 fixture case
#
# 步骤：环境检查 → 清产物 → 编译 → 发布物契约 → fixture 断言 → UI 半身断言。
# 任何一步失败立刻非零退出，不给你「跳过失败继续」的机会。
set -euo pipefail
cd "$(dirname "$0")"

FILTER="${1:-}"
# node 认扩展名，临时脚本必须叫 .mjs
CHECK_TMP="$(mktemp).mjs"
trap 'rm -f "$CHECK_TMP"' EXIT

step() { printf '\n=== %s ===\n' "$1"; }

step "0/6 环境"
node --version
npm --version
if [ ! -d node_modules/typescript ]; then
  echo "安装构建期依赖（仅 devDependencies）"
  npm install --no-audit --no-fund --ignore-scripts
fi

step "1/6 清产物"
rm -rf lib
test ! -d lib && echo "lib/ 已清空"

step "2/6 编译 TypeScript"
npx tsc -p tsconfig.json
for f in lib/index.js lib/tools/nav.js lib/tools/search.js lib/tools/assemble.js \
         lib/tools/write.js lib/tools/confirm.js lib/tools/forget.js \
         lib/retrieve/keyword.js lib/retrieve/index-cache.js lib/retrieve/aliases.js \
         lib/store/file-backend.js lib/store/index-store.js lib/store/lock.js lib/store/redact.js \
         lib/store/facets.js lib/store/usage.js lib/store/anchors.js lib/store/query-log.js \
         lib/tools/resolve.js lib/tools/sweep.js lib/tools/digest.js lib/host/api.js lib/host/injection.js \
         lib/lifecycle/session-hook.js lib/lifecycle/auto-settle.js lib/lifecycle/auto-settle-writer.js; do
  test -f "$f" || { echo "缺少产物 $f"; exit 1; }
done
echo "产物齐全"

step "3/6 发布物契约"
cat > "$CHECK_TMP" <<'NODE'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const problems = []
const fail = (msg) => problems.push(msg)
const read = (rel) => readFileSync(rel, 'utf8')

/* ---------- package.json ---------- */
const pkg = JSON.parse(read('package.json'))
if (pkg.name !== 'dsh-memory-agent') fail(`package.json name 应为 dsh-memory-agent，实际 ${pkg.name}`)
if (!/^\d+\.\d+\.\d+/.test(pkg.version ?? '')) fail('version 不是 semver')
if (pkg.type !== 'module') fail('type 必须是 module（ESM 插件）')
if (pkg.main !== 'lib/index.js') fail('main 必须是 lib/index.js')
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('缺少 dsh.bundle.patch: ./cordis.patch.yml')
if (!Array.isArray(pkg.files) || !pkg.files.includes('cordis.patch.yml')) fail('files 必须包含 cordis.patch.yml')
if (!Array.isArray(pkg.files) || !pkg.files.includes('lib')) fail('files 必须包含 lib')

/* ---------- 零硬依赖 ---------- */
const runtimeDeps = Object.keys(pkg.dependencies ?? {})
if (runtimeDeps.length !== 0) fail(`运行时 dependencies 必须为空，实际 ${JSON.stringify(runtimeDeps)}`)
const FORBIDDEN = [
  'dsh-persist', 'dsh-memory-pyramid', '@max-null/dsh-memory', 'dsh-df-memory',
  '@libai168/dsh-tool-memory',
]
const allDeps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies }
for (const name of FORBIDDEN) {
  if (Object.hasOwn(allDeps, name)) fail(`不允许依赖/捆绑记忆插件 ${name}`)
}
for (const [name, version] of Object.entries({ ...pkg.peerDependencies })) {
  if (!name.startsWith('@deepseek-ai/')) fail(`peerDependencies 只允许 @deepseek-ai/*，发现 ${name}`)
  if (typeof version !== 'string') fail(`${name} 版本应固定为字符串`)
}
if (Object.hasOwn(pkg.dependencies ?? {}, '@deepseek-ai/dsh-tools')) {
  fail('@deepseek-ai/dsh-tools 必须放 peer/dev，不能进 dependencies')
}

/* ---------- cordis.patch.yml ---------- */
const patch = read('cordis.patch.yml')
if (!/^- /m.test(patch)) fail('cordis.patch.yml 顶层必须是数组（每行以 "- " 开头）')
if (!/insert:/.test(patch)) fail('cordis.patch.yml 必须用 insert 新增插件行')
if (!/name:\s*dsh-memory-agent\s*$/m.test(patch)) fail('insert 的 name 必须是 npm 包名 dsh-memory-agent')
if (/name:\s*[.\/]/.test(patch)) fail('insert 的 name 不能写源码路径')
if (!/inject:\s*\[tools,\s*systemPrompt,\s*webServer,\s*sessions\]/.test(patch)) fail('patch 里 inject 必须是 [tools, systemPrompt, webServer, sessions]（常驻注入 + 面板 API + 自动沉淀数据源；少任何一个都会在服务就绪前静默失效）')
if (!/autoSettle:/.test(patch)) fail('patch 缺少 autoSettle 配置段（自动沉淀默认关闭，需可配置）')
if (!/injectEnabled:\s*true/.test(patch)) fail('patch 缺少 injectEnabled: true（常驻注入默认开）')
if (!/injectBudgetChars:\s*1500/.test(patch)) fail('patch 缺少 injectBudgetChars: 1500')
if (!/id:\s*memory-agent/.test(patch)) fail('patch 缺少稳定的 id: memory-agent')

/* ---------- handler 必须是纯函数 ---------- */
const toolFiles = readdirSync('lib/tools').filter((name) => name.endsWith('.js'))
if (toolFiles.length !== 9) fail(`lib/tools 应有 9 个 handler，实际 ${toolFiles.length}`)
for (const file of toolFiles) {
  const source = read(path.join('lib/tools', file))
  if (/\bctx\b/.test(source)) fail(`lib/tools/${file} 出现 ctx：handler 必须是纯函数`)
  if (/from\s+['"]node:fs/.test(source)) fail(`lib/tools/${file} 直接用了 node:fs：只能走 backend`)
  if (/process\.cwd\(\)/.test(source)) fail(`lib/tools/${file} 读了 process.cwd()：路径只能来自 backend.root`)
}

/* ---------- digest：槽位编码/入口函数必须在（防文件被清空） ---------- */
const digestTool = read('lib/tools/digest.js')
if (!/slotOfEntry|digestPathFor/.test(digestTool)) {
  fail('digest.js 缺少 slotOfEntry/digestPathFor：digest 模块不完整')
}

/* ---------- 检索必须是 BM25，不是子串 ---------- */
const keyword = read('lib/retrieve/keyword.js')
for (const marker of ['.includes(', '.indexOf(', '.startsWith(']) {
  if (keyword.includes(marker)) fail(`lib/retrieve/keyword.js 出现 ${marker}：检索不许退化成子串匹配`)
}
if (!/Math\.log/.test(keyword)) fail('lib/retrieve/keyword.js 没有 IDF（Math.log）：不是 BM25')

/* ---------- 体验层：别名兜底 + 零命中引导 ---------- */
const searchSource = read('lib/tools/search.js')
if (!/buildSearchGuidance/.test(searchSource)) fail('search.js 缺少零命中引导（buildSearchGuidance）')
if (!/expandAliases/.test(searchSource)) fail('search.js 没有接别名词表（expandAliases）')

/* ---------- 常驻注入：同步 provider + interpolate 关闭 ---------- */
const indexSource = read('lib/index.js')
if (!/['"]systemPrompt['"]/.test(indexSource)) fail('index.ts 必须把 systemPrompt 声明进 inject 并防御式接线')
const injection = read('lib/host/injection.js')
if (!injection.includes('buildRecallSync')) fail('injection.js 缺少同步组装器 buildRecallSync')
if (!injection.includes('interpolate: false')) fail('注入条目必须 interpolate:false（记忆正文可能含 {{...}}，进插值器会抛错）')
if (!injection.includes('readFileSync')) fail('注入 provider 必须同步读库（宿主不会 await context.text）')
if (!injection.includes('记忆使用守则')) fail('injection.js 缺少「记忆使用守则」：模型不知道何时该记、何时该搜，只能靠临场发挥')
if (!injection.includes('USAGE_GUIDE_CONTEXT_NAME')) fail('injection.js 缺少守则 context：守则必须与记忆条目分开注册，不能挤占 1500 字符预算')
if (!indexSource.includes('createUsageGuideContextEntry')) fail('index.ts 没有注册记忆使用守则 context')

/* ---------- 索引用 sha1 做查重/冲突键 ---------- */
const writeTool = read('lib/tools/write.js')
if (!/sha1/.test(writeTool)) fail('write.js 缺少指纹（查重/冲突键）')
if (!/redactSecrets/.test(writeTool)) fail('write.js 必须在落盘前脱敏')

/* ---------- P2：检索日志 + 记忆锚点接线 ---------- */
const sweepSource = read('lib/tools/sweep.js')
if (!searchSource.includes('recordQueryLog')) fail('search.js 缺少 recordQueryLog：每次真实检索都要记日志（模型与面板同源）')
if (!/anchors/.test(writeTool)) fail('write.js 缺少 anchors：锚点写入没接线')
if (!sweepSource.includes('zeroHitQueries')) fail('sweep.js 缺少 zeroHitQueries：零命中查询要进体检输出')
if (!injection.includes('evaluateAnchors')) fail('injection.js 缺少 evaluateAnchors：锚点失效要撤常驻注入')
const queryLog = read('lib/store/query-log.js')
if (!queryLog.includes('QUERY_LOG_LIMIT')) fail('query-log.js 缺少 QUERY_LOG_LIMIT：日志必须做有界裁剪，不能无限涨')
const anchorsStore = read('lib/store/anchors.js')
if (!anchorsStore.includes('未校验')) fail('anchors.js 缺少「未校验」：探测不到绝不判失效的铁律必须写在实现里')

/* ---------- 自动沉淀：只写 suggested + 只认 user 来源 ---------- */
const settle = read('lib/lifecycle/auto-settle.js')
if (!settle.includes('deriveMessages')) fail('auto-settle.js 必须从 session.deriveMessages() 读消息（宿主会话服务，不是磁盘快照）')
if (!/source\??\.\s*kind/.test(settle)) fail('auto-settle.js 必须按 source.kind 过滤来源：常驻注入本身也是 user/message，不过滤会形成回音')
if (!settle.includes('lifecycle/auto-settle')) fail('auto-settle.js 缺少审计事件类型 lifecycle/auto-settle')
const settleWriter = read('lib/lifecycle/auto-settle-writer.js')
if (!settleWriter.includes('requireConfirmation: true')) fail('auto-settle-writer.js 必须硬编码 requireConfirmation: true（只写 suggested，不许直接进检索）')
if (!/type:\s*['"]episode['"]/.test(settleWriter)) fail('auto-settle-writer.js 必须落 episode（带 raw 原文，便于核对）')
if (!indexSource.includes('createSettleWriter')) fail('index.ts 的自动沉淀必须走 createSettleWriter（生产与测试同一份写库实现）')
if (!/['"]sessions['"]/.test(indexSource)) fail('index.ts 必须把 sessions 声明进 inject（自动沉淀的数据源）')

/* ---------- README 必须写清 token 口径 ---------- */
const readme = read('README.md')
if (!readme.includes('Math.ceil')) fail('README 必须注明 token 口径 Math.ceil(字符数/1.6)')
if (!readme.includes('1.6')) fail('README 必须写清 1.6 字符/token 的口径')
if (!readme.includes('verify.sh')) fail('README 必须写 verify.sh 用法')
if (!readme.includes('publish.sh')) fail('README 必须写发布流程')

/* ---------- 打包清单 ---------- */
if (!existsSync('lib/index.js')) fail('lib/index.js 不存在')
const packed = JSON.parse(execSync('npm pack --dry-run --json', { encoding: 'utf8', shell: true }))
const names = new Set((packed[0]?.files ?? []).map((item) => item.path.replace(/\\/g, '/')))
for (const required of ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'lib/index.js', 'lib/host/api.js', 'client/client.js']) {
  if (!names.has(required)) fail(`npm 包里缺少 ${required}`)
}
for (const forbiddenPrefix of ['src/', 'test/']) {
  for (const name of names) {
    if (name.startsWith(forbiddenPrefix)) fail(`npm 包里不该有 ${name}`)
  }
}

/* ---------- 客户端 UI 半身 ---------- */
const clientRel = pkg.exports?.['./client']
if (typeof clientRel !== 'string') fail('package.json 缺少 exports["./client"]')
if (!Array.isArray(pkg.files) || !pkg.files.includes('client')) fail('files 必须包含 client')
if (pkg.dsh?.client?.platform !== 'web') fail('dsh.client.platform 必须是 web')
if (!Array.isArray(pkg.dsh?.client?.inject) || !pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots')) {
  fail('dsh.client.inject 必须包含 @deepseek-ai/dsh-client-ui-slots')
}
if (existsSync('client/client.js')) {
  const client = read('client/client.js')
  if (!client.includes('window.__ModuleLoader__.load(')) fail('client/client.js 不是 ModuleLoader 产物')
  if (!/id:\s*['"]dsh-memory-agent['"]/.test(client)) fail('client/client.js 的 ModuleLoader id 必须是包名')
  if (!/exports\.apply\s*=/.test(client)) fail('client/client.js 必须导出 apply')
  if (!/exports\.inject\s*=\s*\[[^\]]*['"]slots['"]/.test(client)) fail('client/client.js 的 inject 必须包含 slots')
  if (/^\s*import\s+[\w{*]/m.test(client)) fail('client/client.js 不许用 ESM import（走 require）')
} else {
  fail('client/client.js 不存在')
}

/* ---------- 报告 ---------- */
const digest = createHash('sha256').update(JSON.stringify(pkg)).digest('hex').slice(0, 12)
if (problems.length > 0) {
  console.error(`契约检查失败（${problems.length} 项）：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`契约检查通过：${names.size} 个文件入包，package.json sha256=${digest}`)
NODE
node "$CHECK_TMP"

step "4/6 fixture 断言（带期望输出）"
node test/run-fixtures.mjs $FILTER

step "5/6 UI 半身断言（设置页面板 + 宿主 API）"
node test/run-client-check.mjs
node test/run-api-check.mjs
node test/run-settle-check.mjs

step "6/6 完成"
echo "VERIFY OK — 退出码 0"
