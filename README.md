# dsh-memory-agent

给 DeepSeek Harness（DSH / Cordis）用的**文件式长上下文记忆**插件。

它是一次「整合升级」：把若干记忆插件里已经被验证过的机制——固定阅读预算、BM25 检索、
确认闸门、索引重建、原子写入、显式删除——收进**一个零硬依赖的包**里，而不是捆绑或依赖它们。

- 运行时 `dependencies` 为 `{}`；不捆绑 `dsh-persist`、`dsh-memory-pyramid`、`@max-null/dsh-memory`、
  `dsh-df-memory`、`@libai168/dsh-tool-memory`，也不依赖任何其他记忆插件。
- 默认后端就是纯文件（`<cwd>/.agent/memory/`），暴露 `MemoryBackend` 接口供后续替换。
- 工具 handler 是纯函数：`async (backend, input) => output`。所以 `test/run-fixtures.mjs`
  可以直接 `import('lib/tools/*.js')` 传临时 backend 做断言，不需要启动 DSH。

---

## 目录

- [安装](#安装)
- [工具契约](#工具契约)
- [存储布局与索引字段](#存储布局与索引字段)
- [Token 口径](#token-口径)
- [检索：BM25，不是子串](#检索bm25不是子串)
- [固定阅读预算不变量](#固定阅读预算不变量)
- [写入：查重、冲突、确认闸门](#写入查重冲突确认闸门)
- [当前认知（分层蒸馏）](#当前认知分层蒸馏)
- [自动沉淀](#自动沉淀)
- [检索日志与锚点（P2）](#检索日志与锚点p2)
- [删除联动 forget_memories_by_session](#删除联动-forget_memories_by_session)
- [索引重建](#索引重建)
- [配置](#配置)
- [零硬依赖与 MemoryBackend](#零硬依赖与-memorybackend)
- [验证：verify.sh](#验证verifysh)
- [发布：publish.sh](#发布publishsh)
- [安全与隐私](#安全与隐私)
- [已知限制](#已知限制)

---

## 安装

```bash
npm i -g dsh-memory-agent        # 或装进某个 DSH profile
```

`package.json` 里声明了 bundle patch：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`cordis.patch.yml` 顶层是数组，用 `insert` 增加插件行，`name` 写 npm 包名（不写源码路径）：

```yaml
- insert:
    - id: memory-agent
      name: dsh-memory-agent
      inject: [tools, systemPrompt, webServer, sessions]
      config:
        root: null
        requireConfirmation: false
        defaultBudget: 1200
        maxTopK: 200
        lifecycle:
          enabled: false
          audit: true
```

插件入口只导出三样：

```ts
export const name = 'dsh-memory-agent' // 包名
export const inject = ['tools']        // 让 Cordis 在 apply 前备好工具注册表
export function apply(ctx, config)     // 只做接线
```

`apply()` 只做三件事：创建 backend、把 handler 包成 `defineTool(...)` 注册到 `ctx.tools`、
用 `ctx.effect` 注册清理（卸载时逐个调用注册器返回的 disposer，不留悬空状态）。

> `defineTool` 来自宿主 `@deepseek-ai/dsh-tools`。若该模块解析不到（三方插件常常解析不到，
> 它装在宿主自己的 `node_modules` 里），插件会打印一次警告，并改用内置的
> **DSL → JSON Schema 编译器**把同一份作者 DSL 编成注册表要求的原始 JSON Schema。
> 两条路径产出同构定义，不会因为一条 import 解析失败而整体不可用；verify 的接线烟测
> 就是跑降级路径，顺带断言 `parameters.type === "object"`、`required` 已经是数组。

---

## UI 面板（给不想改 YAML 的人）

装好后在 **设置 → 记忆** 里有一块面板：

| 能做什么 | 说明 |
|---|---|
| 看记忆库路径 | 只读展示 `<cwd>/.agent/memory` 的绝对路径 |
| 看统计 | 全部 / 可检索 / 待确认 / 冲突 / 待清理 / 孤儿 六个计数 |
| 改六项行为 | 「写入需要确认」开关、默认阅读预算（token）、检索条数上限、**写入前脱敏**开关、常驻注入开关（含字符预算 200–8000）、**自动沉淀**开关（勾完下一轮生效） |
| 搜索 | 输入框 + 「搜索」，走的是**和模型同一套 BM25 + 别名**；别名推断的命中标「别名」，零命中直接列出常用标签供点选重搜 |
| 写一条记忆 | 文本框 + 标签，手写的直接生效（不过确认闸门），不用等模型动手 |
| 看详情 | 每行「详情」展开：id / 路径 / 状态 / 时间 / 置信度 / 来源 / 标签 / 冲突现场 / 原文预览 |
| 确认 | 待确认的条目一键转「可检索」 |
| 冲突收尾 | 冲突行给「保留这条」/「丢弃」：留下的转 active，同槽位其它说法转 superseded 并退出检索 |
| 软删 / 恢复 | 软删只是标记（文件保留、退出检索），随时能点「恢复」撤回 |
| 重建索引 | 等价 `rebuildIndex()`，索引坏了点一下就好 |
| 清理已软删 | 物理删掉已软删的 `episodes/`、`raw/` 文件；`topics/` 永不删 |
| 按会话忘却 | 列出会话及条数，两步确认后整批忘却（共享 topics 只解绑来源） |
| 导出备份 | 一键把索引 + 所有记忆文件打成 JSON bundle 下载走（≤8MB，超了会标记截断） |

改完点「保存设置」立即生效（不用重启宿主）：面板写的是 `<root>/config.json`，
启动时 `createRuntimeConfig()` 用它覆盖 cordis 配置里的同名字段。
想回到配置文件为准，删掉 `config.json` 即可。

实现方式（两个半身，都不引入新依赖）：

- **宿主半身** `src/host/api.ts`：一个路由 `POST /memory-agent/api`，按 `op` 分发
  （`status` / `config.set` / `rebuild` / `confirm` / `resolve` / `softDelete` / `restore` /
  `purgeDeleted` / `search` / `detail` / `create` / `forgetSession` / `export`）。
  三重门槛：只接受 **POST + `content-type: application/json`**、只放行**本机回环**、
  并且要么 `Origin` 与 `Host` 一致、要么带面板自带的 `x-dsh-memory-agent: panel` 头。
  所以 `curl -X POST` 这种没有 Origin 也没有面板头的请求一律 403；
  op 白名单、请求体上限 64KB；配置只允许写白名单里的四个字段并做范围收敛
  （`maxTopK` 超 200 会被夹回 200）。宿主没提供 `webServer` 时安静跳过，工具照常可用。
- **客户端半身** `client/client.js`：手写的 `window.__ModuleLoader__.load({ id, factory })`
  产物，不需要打包器，`require` 只用平台种子表里的 `react`；通过
  `ctx.slots.inject("settings.section", () => ctx.slots.register({…, id: "memory-agent"}, MemorySection))`
  挂到设置页，`ctx.effect` 兜住卸载。

面板本身没有任何自动化测试靠肉眼——`verify.sh` 第 5 步会用一个迷你 React + 假 fetch
把这块面板渲染出来、把按钮点一遍（`test/run-client-check.mjs`），
再拿假 req/res 把宿主路由打一遍（`test/run-api-check.mjs`）。

---

## 工具契约

九个工具，返回值就是契约本身：

| 工具 | 入参 | 返回 |
|---|---|---|
| `memory_nav` | `{ path?, limit?, offset?, sort? }` | `{ entries: { id, path, type, title, summary, time }[], total, offset, limit, has_more, facets?, readme? }` |
| `memory_search_hybrid` | `{ query, tags?, time_range?, entities?, top_k? }` | `{ hits: { id, path, type, title, summary, score, reason }[], guidance }` |
| `memory_assemble` | `{ task, hits?, budget? }` | `{ context, used_tokens, sources, omitted }` |
| `write_memory` | `{ summary, raw?, tags?, entities?, source, session_id, confidence?, requireConfirmation?, ... }` | `{ path, id, status, dedupe?, similarity? }` |
| `memory_confirm` | `{ id }` | `{ id, status: "active" }` |
| `forget_memories_by_session` | `{ session_id, scope?, mode? }` | 见[删除联动](#删除联动-forget_memories_by_session) |
| `memory_resolve` | `{ id, action?: "keep" \| "drop" }` | `{ id, status, superseded: string[] }` |
| `memory_sweep` | `{ days?, limit? }` | `{ at, scanned, thresholds, longUnused[], supersededBacklog[] }`（只读体检，见[体检与使用信号](#体检与使用信号)） |
| `memory_digest` | `{ key?, refresh? }` | 有 key：`{ slot, path, text, updated_at, status: "active" \| "conflict", rebuilt }`；无 key：`{ slots: { slot, path, updated_at, stale, entries, conflict, history, text? }[] }`，见[当前认知](#当前认知分层蒸馏) |

handler 的 TS 形状（`lib/tools/*.js` 里就是这些函数，纯函数、不依赖 ctx）：

```ts
navHandler(backend, input): Promise<NavOutput>
searchHandler(backend, input): Promise<Hit[]>
assembleHandler(backend, input): Promise<AssembleOutput>
writeHandler(backend, input): Promise<WriteOutput>
confirmHandler(backend, input): Promise<ConfirmOutput>
forgetHandler(backend, input): Promise<ForgetOutput>
resolveHandler(backend, input): Promise<ResolveOutput>
sweepHandler(backend, input): Promise<SweepOutput>
digestHandler(backend, input): Promise<DigestOutput>
```

`memory_nav` 的默认行为是**只读摘要层 + 分页**：`entries` 只带 `id/path/type/title/summary`，
任何正文（尤其 `raw/` 全文）都不会被带出来；默认一次只给 50 条（上限 500），
用 `offset` 翻页、`has_more` 判断还有没有——库再大也不会一次糊满上下文。
要读全文，必须把 `path` 显式指到那个文件：

- `nav({})` → 第一页摘要层元数据 + 根 `README.md`
- `nav({ offset: 50 })` → 第二页
- `nav({ path: "topics/" })` → 该目录下的条目 + 该目录 `_index.md`
- `nav({ path: "raw/mem_x.md" })` 或 `nav({ path: "mem_x" })` → 那一条 + **该文件全文**（不分页）

---

## 存储布局与索引字段

默认根目录 `<cwd>/.agent/memory/`（fixture 用独立临时目录）：

```
.agent/memory/
  README.md
  index.jsonl          # 索引，一行一条
  ledger.jsonl         # 只追加的审计事件
  episodes/            # 会话情节（带 session_id 来源标记）
  raw/                 # 原文（只能通过 raw_ref 下钻）
  topics/              # 共享/主题记忆（可多来源）
  _index.md            # 每个目录一份，随写入自动刷新
  config.json          # 面板写入的运行期配置（可删，删了回落 YAML）
  aliases.json         # 可选：自定义别名词表，和内置表合并
```

`index.jsonl` 一行一个条目：

```json
{
  "id": "mem_xxx", "path": "topics/xxx.md", "type": "topic",
  "title": "...", "summary": "...", "tags": [], "entities": [],
  "time": "2026-01-01T00:00:00.000Z",
  "sources": [{ "session_id": "s1", "kind": "session" }],
  "session_id": "s1", "confidence": 0.6,
  "raw_ref": "raw/mem_xxx.md", "vector_id": null,
  "status": "active"
}
```

- `type`：`summary | episode | raw | topic`
- `status`：`active | suggested | superseded | conflict | deleted_pending | orphaned`
- `sources` 是**数组**，元素 `{ session_id, kind: "session" | "plugin" | "user" }`。
  所有写入记录全部来源；顶层 `session_id` 只是主来源的快捷字段，
  **forget 逻辑只读 `sources` 数组**。
- 读索引时跳过 JSON parse 失败的行：一条坏行不会让整个库崩掉。
- 索引条目带 `schema_version`（当前 2）：旧数据缺这个字段会被当成 1，不会报错；
  点一次「重建索引」就整体升到当前版本（`rebuildIndex` 写出的条目一律是新版本）。
- **文件是真相源**，`index.jsonl` 只是索引。状态变更（`suggested → active`、
  `conflict`、`deleted_pending`、`orphaned`）会同步写回记忆文件的 front-matter，
  所以 `rebuildIndex()` 重建出来的状态和索引里的一致。

记忆文件长这样（front-matter 由本插件自解析，不引入 YAML 依赖）：

```markdown
---
id: mem_xxx
type: topic
title: PostgreSQL 索引选择
time: 2026-01-02T10:00:00.000Z
status: active
session_id: sess-a
confidence: 0.9
tags: database, postgresql
entities: PostgreSQL, B-tree
sources: sess-a:session
---

# PostgreSQL 索引选择

B-tree 适合等值与范围查询；GIN 适合数组和全文。
```

**原子写入**：所有落盘都走「写临时文件 → `rename`」，Windows 上 `rename` 覆盖失败时先
`unlink` 再 `rename`；`ledger.jsonl` 只 `append`，从不重写。

**并发写入**：索引是「读整个 `index.jsonl` → 改 → 整体重写」，所以每次改索引都在
`<root>/.index.lock`（`open(path, 'wx')` 互斥 + 15s 陈旧锁清理 + 8s 超时报错）里做。
两个 session / 两个 subagent 同时写不会互相吃掉对方的条目——宁可报「锁超时」，
也不静默丢数据。

---

## Token 口径

token 口径是**固定**的，不调用任何 tokenizer：

```
tokens = Math.ceil(text.length / 1.6)
```

为什么不是 `/3`：中文在 DeepSeek tokenizer 里 1 字约 0.6~0.7 token，按 `/3` 会**低估近一倍**，
`budget: 1200` 实际可能吃掉 2000+ token，预算等于形同虚设。`/1.6` 对中文基本贴合、
对英文偏保守（英文 1 token ≈ 4 字符）——偏保守的方向是「少放一点」，比悄悄超支安全。

`memory_assemble.used_tokens`、`charsForBudget()` 全部用这一个口径。
要换精确口径，改 `src/types.ts` 的 `estimateTokens` / `CHARS_PER_TOKEN` 一处，
README 与 fixture 断言一起改。

---

## 检索：BM25，不是子串

`src/retrieve/keyword.ts` 是纯函数 BM25，无外部依赖、无 LLM 调用、确定性可缓存。

**切词**

- CJK：单字 + 相邻 2-gram（中文没空格，单字保召回、2-gram 保精度）
- 拉丁字母/数字：按词，统一小写，再做轻量词形归一（`ies→y`、`ing/ed/es/s` 去尾）
- 停用词：中英各一小张表（`的/是/和…`、`the/of/and…`），含停用字的 2-gram 也丢掉，
  免得「的兜」「是互」这种语法胶水把 BM25 分数拉平
- 标点/空白是分隔符，不进词表

**精确标签加成**：查询词正好等于某条记忆的某个 tag/entity 时，分数 ×1.5——
「tag 里写了 postgresql」比「正文里提了一嘴 postgresql」更可信。

**缓存**：索引解析与切词结果按「索引文本指纹」缓存在进程内，写入后指纹变化自动失效。
不为每次检索重新切全库。

### 没有向量，靠什么补？——别名词表

先用真实口语问题量过一轮，BM25-only 的失败模式**不是排序差，而是词汇不重合**：

| 怎么问 | 库里怎么记 | 裸 BM25 |
|---|---|---|
| 包管理器 | pnpm 管理依赖 | ✅ |
| 图片存哪 | 图片上传走对象存储 | ✅ |
| **数据库连的哪个** | sqlite / postgres | ❌ 零命中 |
| **上线前要做什么检查** | 提交前跑 verify.sh | ❌ 零命中 |

于是加了一层**别名词表**（`src/retrieve/aliases.ts`，零依赖）：

- 内置 14 组常见同义/上位词（数据库→sql/sqlite/postgres/mysql…、检查→test/verify/lint…、
  部署→deploy/release/发布…），**查询命中组内任一词，就把同组其它词作为低权重补充项**
  （权重 0.5）参与打分，并允许它们构成命中；
- 这类命中在结果里标 `reason: "alias"`，渲染成「（别名推断）」——让你一眼看出
  「这是按同义词猜的」而不是字面命中；
- 表可以用 `<root>/aliases.json` 追加：`{ "组名": ["词1","词2"] }`，和内置表合并；
  文件写坏了直接忽略，不会因为配置错误就搜不了。

同一组 query 的复测结果：**4/6 → 6/6 命中**，两个原本零命中的都靠别名兜住。

### 零命中时给「下一步」，而不是空数组

`memory_search_hybrid` 现在返回**信封** `{ hits, guidance }`：

- 命中为 0 → `guidance` 摊开「库里有几条、常用标签、最近记的 3 条标题」，
  并提示可以 `memory_nav({ sort: "recent" })` 浏览；
- 有别名命中 → 说明「其中 N 条是推断的，不对就换说法」。

没有语义检索时，模型最常犯的错不是搜不准，而是**不换词重试**就告诉用户「没记过」。
这段引导就是把这个动作显式化。面板里同样处理：零命中会列出常用标签，点一下就按标签重搜。

**字段加权**：`content`（`title + summary`）权重 1，`keywords`（`tags + entities`）权重 2；
TF 与文档长度都按这个权重折算，DF 取「content ∪ keywords」的文档频次。

**强词规则**：长度 ≥ 2 的 token 是强词。只要查询里有强词，文档必须命中至少一个强词才算候选——
否则「算力」会把「量子计算」的查询拉进来，中文单字命中只准加分、不准单独成命。

**流程**：先按 `tags`（AND）/`time_range`（闭区间）/`entities`（AND）过滤，
再 BM25 打分排序，最后截断 `top_k`（默认 10，硬上限 200）。同分按 `id` 升序，保证确定性。

**不参与检索的状态**：`suggested`（闸门未确认）、`superseded`（冲突裁决后被取代的旧说法）、
`deleted_pending`（已忘却）、`orphaned`（来源被清空）。只有 `active` / `conflict` 会进结果——
`conflict` 留在结果里是为了让你看见「这里有两套说法」，再由 `memory_resolve` 收尾。

---

## 固定阅读预算不变量

```
used_tokens <= budget      // 永远成立
```

`memory_assemble` 的做法：

1. 有 `hits` 就按分数降序用；没有就按 `task` 现搜（20 条）。
2. 预算换成字符上限 `charsForBudget(budget) = floor(budget × 1.6)`。
3. 每条命中先试「摘要 + 原文片段（≤600 字）」，放不下退成「只要摘要」，
   再放不下就按剩余空间截断摘要；剩余空间小于 60 字符就停手。
4. `used_tokens` 用最终 `context` 反算，所以不可能超过 `budget`。
5. 没塞进去的命中不会无声消失：`omitted` 给你漏了几条，渲染层还会写
   `未放入 N 条（预算不够）`——避免模型以为「这就是全部相关记忆」。

输出永远带来源路径（块内 `来源: <path>`，整体再给 `sources[]`）。
`memory_nav` 默认只读摘要层**且分页（50 条/页）**，`raw` 只能通过 `raw_ref` 显式下钻——
这三条一起构成「固定阅读预算」：**所有读路径都有上限，要烧 token 必须自己指名道姓。**

---

## 写入：查重、冲突、确认闸门

`write_memory` 写一条记忆：摘要 + 可选原文 + 来源 + 时间 + `session_id` + 置信度 + 标签 + 实体。

- 有 `raw` → `type=episode`，正文写 `episodes/<date>-<id>.md`，原文单独写 `raw/<id>.md`
  并登记一条 `type=raw` 的索引（`raw_ref` 指过去）。`episodes/`、`raw/` 必须带 `session_id`，
  没给会直接报错。
- 没 `raw` → `type=topic`，写 `topics/<slug>-<id>.md`。
- 写入前**查重**（两级）：
  - 完全重复：`sha1(type + 归一化摘要)` 相同 → 直接返回既有 `path/id/status`；
  - 近似重复：同槽位（title 相同）且 2-gram Jaccard ≥ 0.9 → 也返回既有条目。
    避免「改个标点就是一条新记忆」把库撑爆。返回里带 `dedupe: "exact" | "near"` 与
    `similarity`，模型能看出刚刚那句没有被重复记录。
- **版��演进（默认）**：同槽位（`key`，不给则用归一化标题）但内容不同 → **旧版本转
  `superseded`、新版本 `active`**，两边互相留指针（`supersedes` / `superseded_by`），
  旧版本的 `raw/` 兄弟条目一起退场。`superseded` 不参与检索，所以库里只会留下
  「当前认知 + 历史版本」，不会出现两份互斥事实同时被喂给模型。
  fixture `19-key-supersede` 覆盖：双向指针、原文联动、旧文件仍可 `nav` 下钻。
- **冲突要显式声明**：只有 `write_memory({ expectConflict: true })` 才走 `conflict` 语义
  （双方都标 `conflict`、旧值进 `variants` 等裁决）。默认不再自动制造冲突——
  「改主意」是常态，不该被当成「无法判断谁对」。裁决仍用
  `memory_resolve({ id, action })`：`keep` 本条 active、同槽位其它转 `superseded`。
- **确认闸门**：`config.requireConfirmation` 默认 `false`（直接 `active`）。
  为 `true` 时先写 `suggested`——**不进入检索、不进入 assemble**，只有 `memory_confirm`
  才能提升为 `active`。这个模式用来挡「模型自我提升错误记忆」。
- **落盘前脱敏**（`redactSecrets`，默认开）：`sk-…`、`ghp_/github_pat_…`、`AKIA…`、
  私钥块、`Bearer …`、JWT、连接串里的密码、18 位身份证号，写进磁盘前就换成
  `[已脱敏:kind]`。返回里的 `redactions` 会告诉你动过哪几类，`ledger` 里也有记录。
  只挡「几乎确定是凭证」的形态，不碰手机号/邮箱——那种通常是用户真想记住的。

`memory_confirm` 只处理 `suggested → active`；已是 `active` 幂等返回；其他状态直接报错，
不许拿确认动作绕过 `conflict` / `deleted_pending` 的语义。

---

## 体检与使用信号

记忆系统只增不减必然腐化，所以要有「哪条还有用」的证据。这部分判据不是拍脑袋定的，
是参考了社区里迭代过十几个版本的实现（`@max-null/dsh-memory` 的 `sweep` / `demoteStale`）
在注释里留下的结论，只搬规则不搬代码：

- **使用信号**：每次检索命中的前 5 条记进 `<root>/usage.jsonl`（追加一行，`{id, at, rank}`）。
  只记前 5 条是刻意的——保证 `hit_count` 度量的是「模型真的会看的那几条」。
  为什么是独立文件而不是写索引：检索是读路径，绝不能为了 +1 去重写整个 `index.jsonl`；
  记录失败也静默（旁路证据，不影响检索结果）。面板搜索同样计数，否则会误判「没人用」。
- **`memory_sweep`（只读体检）**：
  - `longUnused`：默认 **90 天**没命中。阈值远大于降级阈值，因为「非常驻记忆几十天不用」
    是常态，按 30 天报会把正常记录说成待清理。
  - `supersededBacklog`：已被新版本取代、但文件还留档的旧版本（可择期物理清理）。
  - **只列清单，绝不删除**：阈值在没攒够分布数据前只能靠猜，所以先让它可观察；
    真要删就走 `forget`，要合并就走 `memory_resolve`。
- 面板里每条会显示「命中 N 次 / 还没被检索过」，`idleDays` 由 `last_used_at ?? time` 反算。

## 常驻注入（记忆自动进上下文）

没有注入管道时，「记忆生效」依赖模型主动调用检索工具；注入管道把**每轮最值得带上的记忆摘要**
自动放进 runtime context，模型不调用任何工具也能看到。

- **落点**：宿主 `@deepseek-ai/dsh-system-prompt` 的 `context()` 条目（`memory-agent:recall`，
  order 800，排在内置 runtime context 之后）。宿主对 `context.text` 是**同步**取值、每轮请求刷新
  （`refreshContext`），所以 provider 是同步函数、同步读库；返回 Promise 会被宿主按「非字符串」
  静默丢弃，这是硬约束不是风格偏好。
- **`interpolate: false` 是强制的**：记忆正文里可能出现 `{{...}}`，进宿主插值器会抛
  `unknown prompt variable` 直接杀死整轮 prompt 组装（dsh 0.2.x 对未知变量 fail-loud）。
- **内容优先级**：命中过的条目在前（`hit_count` 降序，再按最后命中时间），其余按最近更新贪心保留。
- **字符预算硬顶**（默认 1500，含标题行；注意与 `memory_assemble` 的 token 预算是两个口径）：
  每条标题 40 字符、摘要 80 字符；放不下的条数给一行省略提示；`text.length ≤ 预算` 恒成立，
  一条都放不下时返回空字符串（只有标题行的注入是纯噪音）。空库 / 开关关闭 / 读库失败同样不注入。
- **面板**：行为设置里有「常驻注入」开关与「注入字符预算」（200–8000），「常驻注入」卡片可以
  预览本轮会注入什么、占多少字符（`injectPreview` op，不写 usage、不污染读路径）。
- **fixture 覆盖**：21（空库不注入）、22（预算硬顶 + 省略提示）、23（命中优先排序），
  wiring 断言覆盖「开关关闭不注入」与「provider 必须同步」。

## 当前认知（分层蒸馏）

同一个槽位（`write_memory` 的 `key`）反复演进后，逐条翻摘要会越翻越长。
`digests/` 目录给每个槽位存一份 **200~400 token 的「当前认知」**：最新说法做主体，
未裁决冲突与历史版本数附在后面，模型先读它、再决定要不要下钻原文。

**存储与编码**：每个槽位一个文件 `digests/<slotKey>.md`。槽位键经 `encodeURIComponent`
编码（`/` 与 `..` 进不了文件名，防路径穿越），超过 120 字符截断后追加 sha1 前 12 位
（防文件名超限）。文件 front-matter 记 `slot / updated_at / status / sources`
（参与提炼的条目 id）；`digests/` 不在检索目录里，`rebuildIndex` 不会把它当条目扫。

**memory_digest 的两种用法**：

| 用法 | 入参 | 返回 |
|---|---|---|
| 查单个槽位 | `{ key }` | `{ slot, path, text, updated_at, status: "active" \| "conflict", rebuilt }` |
| 列槽位清单 | `{}` | `{ slots: { slot, path, updated_at, stale, entries, conflict, history, text? }[] }` |

两种用法都接受 `refresh: true` 强制重建（有 key 只重建该槽位，没 key 全量重建）。

**digest 是缓存，条目文件才是真相源**：正文按时间取槽位最新条目的摘要做主体；
digest 的 `updated_at` 落后于槽位最新条目，或 `sources` 没覆盖最新条目 id
（同一毫秒写入的新版本也算落后），就判定过期——下次读取自动重建并置 `rebuilt: true`，
命中新鲜缓存则 `rebuilt: false`。

**谁在消费**：`memory_assemble` 命中槽位时优先拼新鲜 digest（缺失/过期回退碎片拼装）；
常驻注入给有 digest 的槽位排序加权。两头都不要求模型先调 `memory_digest`。

**未裁决冲突会标注在认知里**：`status: "conflict"` 时正文加「⚠ 未裁决冲突」行，
列出其它说法（最多 3 条，带日期与来源）；被取代的历史版本不进正文，只报
「另有 N 个历史版本留档（superseded，可顺 supersedes 链追溯）」。

**fixture 覆盖**：24（缺失重建 → 新鲜缓存 → 写新版本再重建）、25（冲突标注 + 槽位清单）、
26（assemble 优先用 digest）。

## 自动沉淀

把会话里用户**明确说过**的事实/偏好，自动提炼成待确认记忆。默认关闭。
提炼规则在 `src/lifecycle/auto-settle.ts`；「候选怎么变成一条记忆」单独放在
`src/lifecycle/auto-settle-writer.ts`——生产接线和测试都走它，让「只写 suggested」只有一个落点。

**数据源是宿主 `ctx.sessions`**（`@deepseek-ai/dsh-session` 的 SessionStore）：
`ctx.sessions.list()` 拿会话，`session.deriveMessages()` 直接给出模型看到的消息历史。
不需要去读磁盘上的 `session.v4.jsonl.zstd` 快照——早期「插件层拿不到会话消息」的判断不成立。
`inject` 因此变成 `[tools, systemPrompt, webServer, sessions]`：没进 `inject` 时 apply 阶段
拿不到服务，沉淀会静默失效（和面板 404 那次是同一类坑）。

两个实现约束：`deriveMessages()` 返回的 Message 是宿主 **deep-frozen 的共享对象**，只读、绝不
mutate；`content` 的块类型共 7 种（`text` / `reasoning` / `image` / `file` / `tool-call` /
`tool-addition` / `tool-removal`），沉淀只取 `text`。

**只写 `suggested`**：`auto-settle-writer.ts` 里硬编码 `requireConfirmation: true`，
写出来的条目必须 `memory_confirm` 才进入检索。机器提炼必然有误判，闸门不过就不许污染检索。

**来源判据是 `kind === "user"` 且带 `rpcId`，这是白名单不是优化**：宿主把注入内容也塞进
`user/message`。实测 `source.kind` 有 6 种——`user`（聊天框输入）、`agent-instructions`、
`runtime-context`、`skill-catalog`、`time-context`、`user-approval`；一次 14 条 `user/message`
的会话分布是 user 6 / agent-instructions 1 / runtime-context 3 / skill-catalog 1 / time-context 2 /
user-approval 1，一半以上是注入。

只认 `kind === "user"` 还不够：这一档里还有一批**非聊天框的产出者**——`/plan` 引导消息、
goal 附件引用、子代理续跑提示、ACP / SDK / headless 提交、标题生成会话。漏判的方向是「多认」，
不是「漏认」。宿主自己的判据（`dsh-api-session-controller` 的 `hasPromptRequest`）是：

```ts
message.source?.kind === 'user'
  && typeof message.source.rpcId === 'string'
  && message.source.rpcId !== ''
```

`rpcId` 只出现在聊天框 RPC 提交的消息上，所以两条一起用：`kind` 挡掉六种里的注入，`rpcId`
挡掉 `kind: "user"` 里的注入。实测 5 个真实会话里 `kind === "user"` 共 23 条、**23/23 都带
`rpcId`**，加这一条不会漏掉真人打字。来源整体缺失时退一步，只接受不带本插件注入标题的文本。

不按来源过滤的后果是回音：把插件自己注入的记忆（连同技能目录、时间上下文）当成用户发言，
再提炼成「用户说过 X」。

**规则提炼，不调 LLM、不联网**。判定顺序（任一不过就丢）：

1. 去代码块、行内代码、URL
2. 长度 ≥ 12 字（更短的多半是「好的」「继续」）
3. 含问号 → 丢（那是提问，不是知识）
4. 中文疑问语气 → 丢：`好不好`、`能不能`、`够不够`、`是不是`、`行不行`、`要不要`、
   `有没有`、`怎么样`、`如何`。真实会话里大量征求意见的话不带问号，只按 `?` 过滤会把它们
   当事实沉淀下去
5. 以指令动词开头（`帮我`、`请`、`看下`、`查一下`…）→ 丢（那是让我干活）
6. 必须命中强信号词表

强信号五类，命中的那类直接当标签：`记住`、`偏好`、`约定`、`环境`、`身份`。
词表刻意保守：漏沉淀只是少记一条，误沉淀会污染整库。

`身份` 只认具体名词（名字 / 电脑 / 机器 / 手机 / 项目 / 账号 / 环境 / 系统 / 版本 / 工作区）：
「我的意思是」「我的问题是」这类是口语引导词、不是身份陈述，按 `我的…是` 泛匹配会把它们全捞进来。

**触发时机**：心跳挂在常驻注入的 systemPrompt context `text` provider 上（宿主每轮同步取一次
文本）。`tick()` 只做轻量比较（有没有新消息、是否过了间隔），然后 fire-and-forget；
真正的提炼是后台异步任务。不订阅任何会话事件。

**写入形态**：`type: "episode"`，`raw` 存用户原话（便于日后核对），`tags` 含 `auto-settle`
与命中的信号类别，落盘前过 `redactSecrets`。写了哪些条记进 `ledger.jsonl`
（事件类型 `lifecycle/auto-settle`）。

**失败静默**：任何异常只 `console.warn`，绝不影响宿主 prompt 组装或会话收尾。
宿主没提供 `sessions`（老版本 / headless）时 `tick()` 是纯空操作，工具与常驻注入照常。

**配置**：总开关由 `cordis.patch.yml` 的 `lifecycle.autoSettle.enabled` 打底，同时映射成运行期字段
`autoSettleEnabled`——面板「行为设置」里勾的就是它（默认 `false`，写进 `<root>/config.json`）。
settler 里 `enabled` 是 getter、每次心跳实时求值，所以面板勾完**下一轮立即生效**，不用重启宿主。
其余三项只从 cordis 配置读，改完要重启：

```yaml
lifecycle:
  autoSettle:
    enabled: false        # 总开关（等价于面板的 autoSettleEnabled）
    minIntervalMs: 90000  # 两次尝试的最小间隔
    minMessages: 4        # 会话里至少这么多条用户消息才提炼
    maxCandidates: 3      # 单次最多沉淀几条
```

先开着观察几天准确率（产出都在「待确认」里），确认一条才生效：

```ts
memory_confirm({ id: "mem_xxx" })
```

断言在 `test/run-settle-check.mjs`（14 项），`verify.sh` 的第 5 步会跑它。

## 检索日志与锚点（P2）

### 检索日志：query-log.jsonl

`<root>/query-log.jsonl` 一行一次**真实检索**：`{ at, query, hits }`。模型工具调用与面板搜索
走的是同一个 `searchHandler`，所以两边同源，不会出现「面板搜了但不计数」的盲区；
query 为空的纯浏览分支（只带过滤条件不带词）不进这条日志。query 去空白后截断到
**120 字符**。

**有界策略**（日志不能无限涨）：

- 上限 200 条 + 滞回裁剪：逐条 append 很便宜，但每写一次就全量重写太贵，所以只在
  行数超过 250（200 + 余量 50）时才重写一次，保留最近 200 条；
- 稳态效果：大约每 51 次检索才触发一次重写，文件行数恒 ≤ 251。

纪律与 `usage.jsonl` 相同：只追加、失败静默、绝不为记录而拖慢检索主路径。

**零命中查询进 `memory_sweep` 输出**（`zeroHitQueries`，新→旧最多 20 条）：
模型问了但库没命中——这是「库该补什么内容」的**只读信号**，只列清单不做任何动作。
面板「检索日志」卡片可以看全部记录。

### 锚点：记忆的失效探测器

`write_memory` 支持 `anchors: [{ kind, name?, value }]`（入口过白名单：kind 受控、value
非空、name/value 截断去重，单条记忆最多 8 个）：

| kind | name | value | 语义 |
|---|---|---|---|
| `env` | 变量名 | 期望值（留空只查存在） | 环境变量还在、值没变 |
| `tool-list` | 工具名（可选） | 工具名 | 该工具还在宿主清单里 |
| `self-version` | — | 版本号 | 插件版本没变 |
| `path-exists` | — | 路径 | 路径还存在 |

**两条铁律：**

- **探测不到 = 未校验，绝不判失效**——probe 返回 undefined 就当没看见，
  绝不把「宿主没这个能力」误报成「记忆失效」；
- **失效只撤常驻注入、保留检索**，等模型核对后回写（改记忆或换锚点）。

宿主当前只实现 `env` / `path-exists` 两种探测（`tool-list` / `self-version` 恒为未校验，
等宿主 API）。两头的表现：

- `memory_sweep` 输出里多一个 `staleAnchors` 清单（最多 20 条）：哪条记忆、哪个锚点、
  为什么失效；
- 常驻注入自动跳过失效条目（`staleSkipped` 计数），检索不受影响。

**fixture 覆盖**：27（query-log 有界 + 零命中清单）、28（锚点写入与评估）、
29（失效锚点撤注入）。

## 删除联动 forget_memories_by_session

显式工具，不依赖任何自动钩子。判定只看 `sources` 数组。

| scope | episodes/ raw/ | topics/（共享） |
|---|---|---|
| `session_only`（默认） | 标 `deleted_pending`，移出检索，**文件保留** | 不动 |
| `include_shared_unlink` | 同上 | 从 `sources` 移除该 session；`sources` 空了标 `orphaned`，**绝不删文件** |

`mode`：

- `soft`（默认）：只改状态（同时写回文件 front-matter）+ 写 `ledger.jsonl`。
- `hard`：在 `soft` 基础上**物理删除**本次 session 相关的 `episodes/`、`raw/` 文件并移出索引；
  `topics/` 永不删除——那是共享知识。

返回：

```ts
{
  deleted_episode_count, deleted_raw_count,
  unlinked_topic_count, orphaned_topic_count,
  affected_paths: string[],
  status_changes: { id, from, to }[]
}
```

计数只统计本次真的发生的状态迁移，重复调用是幂等的（`deleted_*_count` 为 0）。

---

## 索引重建

```ts
import { rebuildIndex } from 'dsh-memory-agent/lib/store/index-store.js'
await rebuildIndex(root) // → { entries, scanned, skipped }
```

只扫 `episodes/`、`raw/`、`topics/`（跳过 `_index.md`），从每个文件的 front-matter
反推条目，重写 `index.jsonl` 和各级 `_index.md`。没有 front-matter 的手写文件也能救回来：
`id` 取文件名、`title` 取首个 `# 标题`、`summary` 取首段、时间取 mtime。
fixture `08-rebuild-index-from-files` 会真的把 `index.jsonl` 删掉再重建。

---

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `root` | `null` | 存储根目录；`null` = `<cwd>/.agent/memory` |
| `requireConfirmation` | `false` | 写入是否先落 `suggested` |
| `defaultBudget` | `1200` | `memory_assemble` 默认预算（token） |
| `maxTopK` | `200` | 检索硬上限 |
| `injectEnabled` | `true` | 常驻注入开关；空库时自然什么都不注入 |
| `injectBudgetChars` | `1500` | 注入文本的字符预算硬顶（200–8000） |
| `lifecycle.enabled` | `false` | 会话钩子，只注入/审计，**绝不删除** |
| `lifecycle.audit` | `true` | 钩子是否写 `lifecycle/attach`、`lifecycle/detach` 事件 |
| `autoSettleEnabled` | `false` | 自动沉淀总开关；面板「行为设置」可勾，**下一轮生效**（只写 `suggested`，见[自动沉淀](#自动沉淀)） |
| `lifecycle.autoSettle.enabled` | `false` | 上面那个开关在 cordis 配置里的落点（面板写 `config.json` 时以面板为准） |
| `lifecycle.autoSettle.minIntervalMs` | `90000` | 两次尝试的最小间隔（毫秒） |
| `lifecycle.autoSettle.minMessages` | `4` | 会话里至少这么多条用户消息才提炼 |
| `lifecycle.autoSettle.maxCandidates` | `3` | 单次最多沉淀几条 |

会话钩子默认关闭：删除只能通过 `forget_memories_by_session` 显式触发。
钩子打开也只往 `ledger.jsonl` 写两条审计事件，不碰任何记忆文件。

`lifecycle.enabled` / `lifecycle.audit` 与自动沉淀的间隔、条数阈值只从 cordis 配置读；
自动沉淀的总开关另映射成运行期字段 `autoSettleEnabled`，面板可改、立即生效（见[自动沉淀](#自动沉淀)）。

---

## 零硬依赖与 MemoryBackend

`dependencies: {}`。`@deepseek-ai/*` 只在 `peerDependencies`（`dsh-tools` 标 optional）
和 `devDependencies` 里。默认文件后端满足这个接口，换成 SQLite / 远端实现只需要实现它：

```ts
interface MemoryBackend {
  readonly root: string
  init(): Promise<void>
  readIndex(): Promise<IndexEntry[]>        // 坏行跳过
  writeIndex(entries: IndexEntry[]): Promise<void>
  appendLedger(event: LedgerEvent): Promise<void>
  readLedger(): Promise<LedgerEvent[]>
  readFile(relPath: string): Promise<string | null>
  writeFileAtomic(relPath: string, text: string): Promise<void>
  removeFile(relPath: string): Promise<boolean>
  listFiles(relDir: string): Promise<string[]>
  now(): string
}
```

约束：handler 不依赖 ctx、不读全局状态、不碰 `backend.root` 之外的路径
（文件后端对越界路径直接抛错）。

---

## 验证：verify.sh

```bash
bash verify.sh          # 全量，退出码 0 才算通过
bash verify.sh 06       # 只跑名字含 06 的 case
```

六步，任何一步失败立刻非零退出：

1. 环境检查（Node / npm，缺构建依赖就装 devDependencies）
2. 清 `lib/` + `tsc` 全量编译
3. **发布物契约**：`dsh.bundle.patch` / `dsh.client`、`files` 含 `cordis.patch.yml` 与 `client`、
   `dependencies` 为空、不许依赖记忆插件、patch 顶层数组 + `insert` + `name` 是包名、
   `lib/tools/*` 里不许出现 `ctx`/`node:fs`/`process.cwd()`、
   `keyword.js` 不许出现 `.includes(`/`.indexOf(`/`.startsWith(`、
   `client/client.js` 必须是 ModuleLoader 产物且 `id` 等于包名、
   `npm pack` 清单必须含 `lib`、`client`、`cordis.patch.yml` 且不含 `src/`、`test/`
4. **fixture 断言**：`test/cases.json` 里每个 case 都带**期望输出**，逐条对照，
   对不上就打印「期望 vs 实际」并失败
5. **UI 半身断言**：迷你 React 渲染设置页面板 + 点按钮（`run-client-check.mjs`），
   假 req/res 打宿主路由（`run-api-check.mjs`），最后跑自动沉淀的用例（`run-settle-check.mjs`）
6. 接线烟测（在 fixture 阶段末尾）：假 ctx 跑 `apply()`，验证 9 个工具注册、`ctx.effect` 卸载后零残留

还有一个**真宿主探针** `test/host-probe.mjs`：用 DSH 安装目录里真实的
`@deepseek-ai/dsh-tools` 校验注册出去的 schema（`assertSupportedJsonSchema` +
`validateJsonSchemaValue`），再跑一遍 write → search → nav → assemble → confirm → forget。
它依赖具体安装路径，所以不在 verify.sh 里，本地想复核时手动跑：

```bash
node test/host-probe.mjs "<DSH安装目录>/resources/app/dsh" "<profile>/node_modules/dsh-memory-agent/lib/index.js"
```

fixture case 的形状（新增 case 直接往 `test/cases.json` 追加）：

```json
{
  "name": "03-assemble-budget-hard-cap",
  "description": "大量 hits + 小预算：used_tokens 绝不超过 budget",
  "fixture": "seed-minimal",          // 可选：从 test/fixtures/ 拷一份种子库
  "steps": [
    { "op": "writeMany", "count": 40, "input": { "summary": "第 {{i}} 条", "session_id": "s" } },
    { "op": "assemble", "input": { "task": "训练", "budget": 120 } }
  ],
  "expect": [
    { "step": 1, "path": "used_tokens", "lte": 120 }
  ]
}
```

可用 op：`write`、`writeMany`、`confirm`、`nav`、`search`、`searchMany`、`assemble`、`forget`、
`resolve`、`sweep`、`digest`、`inject`、`queryLog`、`anchorCheck`、`index`、`indexStats`、
`ledger`、`exists`、`readFile`、`removeFile`、`rebuild`。
断言种类：`value`（深比较）、`lte`、`gte`、`length`、`includes`、`jsonIncludes`、`jsonNotIncludes`。
入参与期望都支持 `{"$ref":{"step":0,"path":"id"}}`（避免硬编码随机 id）和
`{"$repeat":{"text":"…","count":30}}`（造长文本）。

---

## 发布：publish.sh

发布走**一条命令**：

```bash
bash publish.sh
```

脚本先找 `dsh-publish-plugin`（npm 上那个插件，提供 `/publish-dsh-plugin` 命令与
`publish_plugin` 工具）；找得到就整段委托给它，找不到才执行本脚本自己的整体流程：

```
verify.sh → npm pack 预检 → 认证闸门 → npm publish --access public
```

认证闸门：`NPM_TOKEN` 环境变量或 `npm whoami` 成功才继续，否则打印指引并**退出码 3**——
不会假装发布成功。

`npm publish` 前会自动跑 `prepublishOnly`（重新编译 + 跑一遍 fixture），
所以「本地过了」和「发出去的包能跑」是同一件事。

---

## 安全与隐私

- 默认不联网、不调 LLM；检索是本地 BM25，可缓存。
- `memory_nav` 默认不带正文；`raw/` 全文只能显式下钻。
- 确认闸门挡住「模型自己把猜测写成事实」。
- 删除是显式的：`session_only` 软删保留文件，`hard` 才真删 `episodes/`、`raw/`；
  共享 `topics/` 永远不会被整文件删除。
- 审计事件只增不改，`ledger.jsonl` 里能查到每次写入/冲突/确认/忘却的来源。
- 包里不写死任何真实姓名、邮箱、内部地址；`LICENSE` 用 contribution 署名。

---

## 已知限制

**检索**

- 没有真语义检索：`vector_id` 字段一直空着，同义/上位词靠**人工维护的别名词表**兜，
  兜不住的（比喻、跨领域联想）依然零命中。表之外的语义关系无能为力。
- BM25 只有进程内缓存（按索引指纹失效），**没有持久化倒排表**：进程重启后第一次检索
  要重新切全库。万级条目开始变慢，再大就该换 `MemoryBackend`。
- 强词规则（长度 ≥ 2 的词才算命中依据）会牺牲一部分纯单字查询的召回。
- `confidence` 只存不用：既不参与打分，也不拦低置信度写入。
- 没有同义词表：停用词和词形归一只解决「写法不同」，解决不了「语义不同」。

**记忆语义**

- 没有「更新」概念：改一条记忆 = 新建一条（同标题会变成 conflict，再由 resolve 收尾），
  旧条目不会自动 superseded。
- 没有 TTL / 时间衰减 / 归档：记忆只增不减，靠人清理。
- `session_id` 当前仍需模型显式给（`forget_memories_by_session` 依赖它）——所以面板里做了
  「按会话忘却」，由 UI 替用户填这个 id。能拿到当前会话之后，让 `write_memory` 自动带上它属于
  后续增强，本轮没做。
- 会话钩子本身只做 attach/detach 审计，不删记忆；自动沉淀是另一条链
  （`ctx.sessions` → 规则提炼 → `suggested`），两件事不要混谈。

**安全**

- UI 的 API 已经挡住「网页 CSRF」和「随手 curl」（要求 JSON + Origin 或面板头），
  但**没有 per-request token**：同机进程如果刻意伪造 `Origin` 与 `x-dsh-memory-agent`，
  仍能读写你的记忆库。它防的是误触与浏览器跨站，不防本机恶意程序。
- 记忆是明文 markdown：凭证类已经落盘前脱敏，但手机号/邮箱等 PII 不处理，
  文件本身也不加密（备份、云盘同步都会带着明文走）。
- `source.kind` 是调用方自称，模型可以声称「这是 user 说的」。

**工程**

- 配置有两个来源：cordis 的 `cordis.patch.yml`（初值）与 `<root>/config.json`（面板覆盖）。
  规则写在上面了，但仍然是两个地方能改同一件事；要根治得走官方的
  `Config` schema + `settings.describe` 通道，那会引入 `schemastery` 依赖，
  和「零硬依赖」冲突，所以这次没做。
- `index.jsonl` 有 `schema_version` 字段，但**没有自动迁移脚本**：
  旧条目要升版只能点「重建索引」（从文件重建，顺带写上新版本）。
- 客户端产物是手写的（无构建、无类型），测试用迷你 React 模拟，
  不覆盖真浏览器的 React 版本差异 / StrictMode 双调用。
- 没有跨项目的用户级记忆：root 跟着 `<cwd>` 走，每个工作区各一份。
- `dsh-publish-plugin` 未安装时只能保证 npm 侧；GitHub 侧需要另配 `gh`。
