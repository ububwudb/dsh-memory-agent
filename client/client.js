/**
 * dsh-memory-agent 的浏览器半身：在「设置」里加一个「记忆」分区。
 *
 * 手写产物，不需要打包：DSH 的客户端加载器（window.__ModuleLoader__）直接吃这个文件，
 * 依赖只有平台种子表里的 react。读写全走宿主半身的 /memory-agent/api。
 *
 * 目标是「不看文档也能用」：搜索、详情、新建、恢复、冲突收尾、按会话忘却，
 * 全部在面板里点，不用知道 id 从哪来、session 是什么。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-agent',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    const { useState, useEffect, useCallback } = react

    const API = '/memory-agent/api'
    const NS = 'dsh-memory-agent'

    const STATUS_LABEL = {
      active: '可检索',
      suggested: '待确认',
      conflict: '冲突',
      superseded: '已取代',
      deleted_pending: '待清理',
      orphaned: '孤儿',
    }

    const css = `
.ma-page{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;color:inherit}
.ma-card{border:1px solid rgba(127,127,127,.28);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.ma-card h3{margin:0;font-size:13px;font-weight:600;opacity:.85}
.ma-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ma-row.between{justify-content:space-between}
.ma-row.top{align-items:flex-start}
.ma-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;opacity:.75;word-break:break-all}
.ma-chips{display:flex;flex-wrap:wrap;gap:6px}
.ma-chip{border:1px solid rgba(127,127,127,.3);border-radius:999px;padding:1px 9px;font-size:11.5px;opacity:.85;cursor:default}
.ma-chip b{font-weight:600;opacity:1}
.ma-btn{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:7px;padding:4px 11px;font-size:12px;cursor:pointer;font-family:inherit}
.ma-btn:hover:not(:disabled){background:rgba(127,127,127,.14)}
.ma-btn:disabled{opacity:.45;cursor:default}
.ma-btn.primary{border-color:rgba(80,140,255,.75);color:rgb(80,140,255)}
.ma-btn.danger{border-color:rgba(220,90,90,.6);color:rgb(220,90,90)}
.ma-btn.small{padding:2px 8px;font-size:11.5px}
.ma-input{width:96px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:7px;padding:3px 8px;font-size:12px;font-family:inherit}
.ma-input.wide{width:100%;box-sizing:border-box;padding:6px 9px}
.ma-textarea{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:8px;padding:7px 9px;font-size:12.5px;font-family:inherit}
.ma-list{display:flex;flex-direction:column;max-height:420px;overflow:auto;border-top:1px solid rgba(127,127,127,.22)}
.ma-item{display:flex;gap:10px;align-items:flex-start;padding:8px 2px;border-bottom:1px solid rgba(127,127,127,.16)}
.ma-item .ma-main{flex:1;min-width:0}
.ma-item .ma-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ma-item .ma-sub{font-size:11.5px;opacity:.62;word-break:break-all}
.ma-item .ma-actions{display:flex;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.ma-pill{flex:none;font-size:11px;border-radius:999px;padding:1px 8px;border:1px solid rgba(127,127,127,.35);opacity:.9}
.ma-pill.active{border-color:rgba(60,180,120,.6);color:rgb(60,180,120)}
.ma-pill.suggested{border-color:rgba(230,170,60,.7);color:rgb(210,150,40)}
.ma-pill.conflict{border-color:rgba(230,120,60,.7);color:rgb(220,120,60)}
.ma-pill.deleted_pending,.ma-pill.orphaned,.ma-pill.superseded{opacity:.55}
.ma-detail{border:1px dashed rgba(127,127,127,.35);border-radius:8px;padding:10px 12px;margin:0 0 10px;display:flex;flex-direction:column;gap:8px;font-size:12.5px}
.ma-detail pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;opacity:.9;max-height:220px;overflow:auto}
.ma-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:11.5px;opacity:.8}
.ma-hint{font-size:11.5px;opacity:.62}
.ma-error{color:rgb(220,90,90);font-size:12px}
.ma-ok{color:rgb(60,180,120);font-size:12px}
`

    if (
      typeof document !== 'undefined'
      && document.querySelector(`style[data-plugin-css="${NS}/panel.css"]`) === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = `${NS}/panel.css`
      tag.textContent = css
      document.head.appendChild(tag)
    }

    /* ------------------------------- 宿主调用 ------------------------------- */

    function api(op, payload, timeoutMs) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = controller === undefined
        ? undefined
        : setTimeout(() => controller.abort(), timeoutMs || 20000)
      return fetch(API, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        // 自定义头是宿主侧「没有 Origin 时也认这条请求」的凭据（见 isTrustedRequest）
        headers: { 'content-type': 'application/json', 'x-dsh-memory-agent': 'panel' },
        body: JSON.stringify(Object.assign({ op }, payload || {})),
        signal: controller === undefined ? undefined : controller.signal,
      })
        .then((response) => response.json())
        .then((body) => {
          if (body && body.ok) return body.data
          throw new Error((body && body.error) || '请求失败')
        })
        .finally(() => {
          if (timer !== undefined) clearTimeout(timer)
        })
    }

    function splitTags(text) {
      return String(text || '')
        .split(/[,，\s]+/)
        .map((item) => item.trim())
        .filter((item) => item !== '')
    }

    /* --------------------------------- 组件 --------------------------------- */

    function MemorySection() {
      const [status, setStatus] = useState(null)
      const [draft, setDraft] = useState(null)
      const [query, setQuery] = useState('')
      const [results, setResults] = useState(null)
      const [guidance, setGuidance] = useState('')
      const [form, setForm] = useState({ summary: '', tags: '' })
      const [detail, setDetail] = useState(null)
      const [preview, setPreview] = useState(null)
      const [digestSlots, setDigestSlots] = useState(null)
      const [queryLog, setQueryLog] = useState(null)
      const [pendingForget, setPendingForget] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')

      const load = useCallback(() => {
        setBusy((current) => current || 'load')
        setError('')
        return api('status')
          .then((data) => {
            setStatus(data)
            setDraft({
              requireConfirmation: data.config.requireConfirmation,
              defaultBudget: data.config.defaultBudget,
              maxTopK: data.config.maxTopK,
              redactSecrets: data.config.redactSecrets !== false,
              injectEnabled: data.config.injectEnabled !== false,
              injectBudgetChars: data.config.injectBudgetChars ?? 1500,
            })
          })
          .catch((e) => setError(e.message))
          .finally(() => setBusy((current) => (current === 'load' ? '' : current)))
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const run = (label, op, payload, doneText) => {
        setBusy(label)
        setError('')
        setNotice('')
        return api(op, payload, op === 'rebuild' ? 60000 : 20000)
          .then((data) => {
            setNotice(typeof doneText === 'function' ? doneText(data) : (doneText || '完成'))
            return load()
          })
          .catch((e) => setError(e.message))
          .finally(() => setBusy(''))
      }

      const doSearch = (override) => {
        const text = typeof override === 'string' ? override : query
        if (text.trim() === '') return
        setBusy('search')
        setError('')
        setNotice('')
        setGuidance('')
        api('search', { query: text, top_k: 20 })
          .then((data) => {
            setResults(data.hits)
            setGuidance(typeof data.guidance === 'string' ? data.guidance : '')
          })
          .catch((e) => setError(e.message))
          .finally(() => setBusy(''))
      }

      const doExport = () => {
        setBusy('export')
        setError('')
        setNotice('')
        api('export', {}, 60000)
          .then((data) => {
            const bundle = data.bundle
            const json = JSON.stringify(bundle, null, 2)
            try {
              if (typeof Blob === 'function' && typeof URL !== 'undefined' && typeof document !== 'undefined') {
                const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
                const anchor = document.createElement('a')
                anchor.href = url
                anchor.download = `dsh-memory-${String(bundle.exported_at || '').slice(0, 10)}.json`
                if (typeof anchor.click === 'function') anchor.click()
                if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
                setNotice(`已导出 ${bundle.entries.length} 条（${bundle.files.length} 个文件）${bundle.truncated ? '，已达体积上限' : ''}`)
              } else {
                setNotice(`导出完成：${bundle.entries.length} 条（当前环境不支持直接下载）`)
              }
            } catch (e) {
              setError(`导出失败：${e.message}`)
            }
          })
          .catch((e) => setError(e.message))
          .finally(() => setBusy(''))
      }

      const doPreview = () => {
        setBusy('preview')
        setError('')
        api('injectPreview', {})
          .then((data) => setPreview(data))
          .catch((e) => setError(e.message))
          .finally(() => setBusy(''))
      }

      const doDigest = () => {
        setBusy('digest')
        setError('')
        api('digestList', {})
          .then((data) => setDigestSlots(data.slots))
          .catch((e) => setError(e.message))
          .finally(() => setBusy(''))
      }

      const doDigestRebuild = (key) => {
        setBusy('digestRebuild')
        setError('')
        setNotice('')
        return api('digestRebuild', key ? { key } : {})
          .then((data) => {
            setNotice(`已重建 ${data.rebuilt} 个槽位的当前认知`)
            return doDigest()
          })
          .catch((e) => setError(e.message))
          .finally(() => setBusy(''))
      }

      const doQueryLog = () => {
        setBusy('queryLog')
        setError('')
        api('queryLog', {})
          .then((data) => setQueryLog(data))
          .catch((e) => setError(e.message))
          .finally(() => setBusy(''))
      }

      const openDetail = (id) => {
        if (detail !== null && detail.entry.id === id) {
          setDetail(null)
          return
        }
        setBusy('detail')
        api('detail', { id })
          .then((data) => setDetail(data))
          .catch((e) => setError(e.message))
          .finally(() => setBusy(''))
      }

      const counts = status === null ? null : status.counts
      const entries = status === null ? [] : status.entries
      const sessions = status === null || status.sessions === undefined ? [] : status.sessions
      // 检索日志只展示最近 20 条（后端 entries 时间正序，这里取尾部再倒序，最新在上）
      const queryLogEntries = queryLog === null || !Array.isArray(queryLog.entries)
        ? null
        : queryLog.entries.slice(-20).reverse()
      const busyNow = busy !== ''

      const renderDetail = (data) => {
        const entry = data.entry
        return h(
          'div',
          { className: 'ma-detail', key: `detail-${entry.id}` },
          h(
            'div',
            { className: 'ma-kv' },
            h('span', null, 'id'), h('span', null, entry.id),
            h('span', null, '路径'), h('span', null, entry.path),
            h('span', null, '状态'), h('span', null, `${STATUS_LABEL[entry.status] || entry.status}（${entry.status}）`),
            h('span', null, '时间'), h('span', null, entry.time),
            h('span', null, '置信度'), h('span', null, String(entry.confidence)),
            h('span', null, '来源'), h('span', null, entry.sources.map((source) => `${source.session_id}:${source.kind}`).join(', ') || '（无）'),
            entry.tags.length > 0 ? h('span', null, '标签') : null,
            entry.tags.length > 0 ? h('span', null, entry.tags.join(', ')) : null,
          ),
          h('div', { className: 'ma-hint' }, '摘要'),
          h('div', null, entry.summary),
          entry.variants.length > 0
            ? h(
              'div',
              null,
              h('div', { className: 'ma-hint' }, `冲突现场（${entry.variants.length} 条别的说法）`),
              ...entry.variants.map((variant, index) => h(
                'div',
                { key: `variant-${index}`, style: { opacity: 0.85 } },
                `· ${variant.value}（${variant.time}，${variant.source && variant.source.session_id ? variant.source.session_id : '未知来源'}）`,
              )),
            )
            : null,
          data.raw === null || data.raw === undefined
            ? null
            : h('div', null, h('div', { className: 'ma-hint' }, '原文预览'), h('pre', null, data.raw)),
        )
      }

      const entryRow = (entry) => {
        const isOpen = detail !== null && detail.entry.id === entry.id
        const actions = []
        actions.push(h(
          'button',
          { className: 'ma-btn small', key: 'detail', disabled: busyNow, onClick: () => openDetail(entry.id) },
          isOpen ? '收起' : '详情',
        ))
        if (entry.status === 'suggested') {
          actions.push(h(
            'button',
            { className: 'ma-btn small', key: 'confirm', disabled: busyNow, onClick: () => run('confirm', 'confirm', { id: entry.id }, '已确认，开始参与检索') },
            '确认',
          ))
        }
        if (entry.status === 'conflict') {
          actions.push(h(
            'button',
            { className: 'ma-btn small primary', key: 'keep', disabled: busyNow, onClick: () => run('resolve', 'resolve', { id: entry.id, action: 'keep' }, '已保留这条，其它说法转为历史') },
            '保留这条',
          ))
          actions.push(h(
            'button',
            { className: 'ma-btn small', key: 'drop', disabled: busyNow, onClick: () => run('resolve', 'resolve', { id: entry.id, action: 'drop' }, '已把这条转为历史') },
            '丢弃',
          ))
        }
        if (entry.status === 'deleted_pending') {
          actions.push(h(
            'button',
            { className: 'ma-btn small primary', key: 'restore', disabled: busyNow, onClick: () => run('restore', 'restore', { id: entry.id }, '已恢复，重新参与检索') },
            '恢复',
          ))
        } else {
          actions.push(h(
            'button',
            { className: 'ma-btn small danger', key: 'soft', disabled: busyNow, onClick: () => run('soft', 'softDelete', { id: entry.id }, '已软删（文件保留，可恢复）') },
            '软删',
          ))
        }

        return h(
          'div',
          { className: 'ma-item', key: entry.id },
          h('span', { className: `ma-pill ${entry.status}` }, STATUS_LABEL[entry.status] || entry.status),
          h(
            'div',
            { className: 'ma-main' },
            h('div', { className: 'ma-title' }, entry.title),
            h(
              'div',
              { className: 'ma-sub' },
              `${entry.path} · ${entry.time}`
                + (typeof entry.hit_count === 'number' && entry.hit_count > 0
                  ? ` · 命中 ${entry.hit_count} 次`
                  : ' · 还没被检索过'),
            ),
            isOpen ? renderDetail(detail) : null,
          ),
          h('div', { className: 'ma-actions' }, ...actions),
        )
      }

      const hitRow = (hit) => h(
        'div',
        { className: 'ma-item', key: hit.id },
        h('span', { className: 'ma-pill' }, hit.reason === 'alias' ? `别名 ${hit.score}` : hit.score),
        h(
          'div',
          { className: 'ma-main' },
          h('div', { className: 'ma-title' }, hit.title),
          h('div', { className: 'ma-sub' }, `${hit.path} · ${hit.type}`),
        ),
        h(
          'div',
          { className: 'ma-actions' },
          h(
            'button',
            { className: 'ma-btn small', disabled: busyNow, onClick: () => openDetail(hit.id) },
            detail !== null && detail.entry.id === hit.id ? '收起' : '详情',
          ),
        ),
      )

      const digestRow = (item) => h(
        'div',
        { className: 'ma-item', key: item.slot },
        h(
          'span',
          { className: 'ma-pill' },
          item.stale ? '已过期' : (item.updated_at === '' ? '未生成' : '最新'),
        ),
        item.conflict ? h('span', { className: 'ma-pill conflict' }, '冲突') : null,
        h(
          'div',
          { className: 'ma-main' },
          h('div', { className: 'ma-title' }, item.slot),
          h(
            'div',
            { className: 'ma-sub' },
            `条目 ${item.entries} · 历史 ${item.history} · `
              + (item.updated_at === '' ? '还没有当前认知' : `更新于 ${item.updated_at.slice(0, 10)}`),
          ),
          typeof item.text === 'string' && item.text !== ''
            ? h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.9, maxHeight: 220, overflow: 'auto' } }, item.text)
            : null,
        ),
        h(
          'div',
          { className: 'ma-actions' },
          h(
            'button',
            { className: 'ma-btn small', disabled: busyNow, onClick: () => doDigestRebuild(item.slot) },
            '重建',
          ),
        ),
      )

      const logRow = (record, index) => h(
        'div',
        { className: 'ma-item', key: `qlog-${index}` },
        h(
          'span',
          { className: record.hits === 0 ? 'ma-pill conflict' : 'ma-pill' },
          String(record.hits),
        ),
        h(
          'div',
          { className: 'ma-main' },
          h('div', { className: 'ma-title' }, record.query),
          h('div', { className: 'ma-sub' }, String(record.at || '').slice(0, 10)),
        ),
      )

      return h(
        'div',
        { className: 'ma-page' },

        /* ---------- 概览 ---------- */
        h(
          'div',
          { className: 'ma-card' },
          h(
            'div',
            { className: 'ma-row between' },
            h('h3', null, '记忆库'),
            h('button', { className: 'ma-btn', disabled: busyNow, onClick: load }, busy === 'load' ? '读取中…' : '刷新'),
          ),
          h('div', { className: 'ma-path' }, status === null ? '读取中…' : status.root),
          counts === null ? null : h(
            'div',
            { className: 'ma-chips' },
            h('span', { className: 'ma-chip' }, '全部 ', h('b', null, String(counts.total))),
            h('span', { className: 'ma-chip' }, '可检索 ', h('b', null, String(counts.active))),
            h('span', { className: 'ma-chip' }, '待确认 ', h('b', null, String(counts.suggested))),
            h('span', { className: 'ma-chip' }, '冲突 ', h('b', null, String(counts.conflict))),
            h('span', { className: 'ma-chip' }, '待清理 ', h('b', null, String(counts.deleted_pending))),
            h('span', { className: 'ma-chip' }, '孤儿 ', h('b', null, String(counts.orphaned))),
          ),
          error === '' ? null : h('div', { className: 'ma-error' }, error),
          notice === '' ? null : h('div', { className: 'ma-ok' }, notice),
        ),

        /* ---------- 搜索 ---------- */
        h(
          'div',
          { className: 'ma-card' },
          h('h3', null, '搜索'),
          h(
            'div',
            { className: 'ma-row' },
            h('input', {
              className: 'ma-input wide',
              type: 'text',
              placeholder: '搜索记忆，例如：索引 或 pnpm 包管理器',
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') doSearch()
              },
            }),
            h(
              'button',
              {
                className: 'ma-btn primary',
                disabled: busyNow || query.trim() === '',
                onClick: doSearch,
              },
              busy === 'search' ? '搜索中…' : '搜索',
            ),
            results === null
              ? null
              : h(
                'button',
                { className: 'ma-btn', disabled: busyNow, onClick: () => { setResults(null); setQuery('') } },
                '清除结果',
              ),
          ),
          results === null
            ? h('div', { className: 'ma-hint' }, '和模型用的是同一套 BM25 检索，搜到的不一致就是 bug。')
            : results.length === 0
              ? h(
                'div',
                { className: 'ma-card' },
                h('div', { className: 'ma-hint' }, guidance === '' ? '没有命中。' : guidance),
                h(
                  'div',
                  { className: 'ma-row' },
                  h('span', { className: 'ma-hint' }, '试试这些标签：'),
                  ...(status !== null && status.facets !== undefined
                    ? status.facets.tags.slice(0, 8).map((tag) => h(
                      'button',
                      {
                        className: 'ma-btn small',
                        key: `tag-${tag.name}`,
                        disabled: busyNow,
                        onClick: () => {
                          setQuery(tag.name)
                          doSearch(tag.name)
                        },
                      },
                      `${tag.name}(${tag.count})`,
                    ))
                    : [h('span', { className: 'ma-hint', key: 'notags' }, '（库里还没有标签）')]),
                ),
              )
              : h('div', { className: 'ma-list' }, ...results.map(hitRow)),
        ),

        /* ---------- 新建 ---------- */
        h(
          'div',
          { className: 'ma-card' },
          h('h3', null, '写一条记忆'),
          h('textarea', {
            className: 'ma-textarea',
            placeholder: '一句话说清要记住的事，例如：本项目用 pnpm，不要用 npm',
            value: form.summary,
            onChange: (event) => setForm(Object.assign({}, form, { summary: event.target.value })),
          }),
          h(
            'div',
            { className: 'ma-row' },
            h('input', {
              className: 'ma-input',
              type: 'text',
              placeholder: '标签，逗号分隔',
              value: form.tags,
              onChange: (event) => setForm(Object.assign({}, form, { tags: event.target.value })),
            }),
            h(
              'button',
              {
                className: 'ma-btn primary',
                disabled: busyNow || form.summary.trim() === '',
                onClick: () => {
                  run('create', 'create', { summary: form.summary, tags: splitTags(form.tags) }, '已写入')
                    .then(() => setForm({ summary: '', tags: '' }))
                },
              },
              busy === 'create' ? '写入中…' : '写入记忆',
            ),
            h('span', { className: 'ma-hint' }, '手写的记忆直接生效；模型写的那条才受「写入需要确认」约束。'),
          ),
        ),

        /* ---------- 行为设置 ---------- */
        h(
          'div',
          { className: 'ma-card' },
          h('h3', null, '行为设置'),
          h(
            'div',
            { className: 'ma-row between' },
            h(
              'div',
              null,
              h('div', null, '写入需要确认'),
              h('div', { className: 'ma-hint' }, '打开后模型写的新记忆先落「待确认」，确认后才进检索，挡住模型把猜测当事实。'),
            ),
            h('input', {
              type: 'checkbox',
              checked: draft === null ? false : draft.requireConfirmation === true,
              disabled: draft === null || busyNow,
              onChange: (event) => setDraft(Object.assign({}, draft, { requireConfirmation: event.target.checked })),
            }),
          ),
          h(
            'div',
            { className: 'ma-row between' },
            h(
              'div',
              null,
              h('div', null, '自动沉淀'),
              h('div', { className: 'ma-hint' }, '从会话里自动提炼你明确表达过的事实/偏好，只写「待确认」，不会直接进检索。默认关，先观察准确率再打开。'),
            ),
            h('input', {
              type: 'checkbox',
              checked: draft === null ? false : draft.autoSettleEnabled === true,
              disabled: draft === null || busyNow,
              onChange: (event) => setDraft(Object.assign({}, draft, { autoSettleEnabled: event.target.checked })),
            }),
          ),
          h(
            'div',
            { className: 'ma-row between' },
            h(
              'div',
              null,
              h('div', null, '默认阅读预算（token）'),
              h('div', { className: 'ma-hint' }, 'memory_assemble 不给 budget 时用它；按 1 字≈0.62 token 估，偏保守。'),
            ),
            h('input', {
              className: 'ma-input',
              type: 'number',
              min: 50,
              max: 20000,
              step: 50,
              value: draft === null ? '' : String(draft.defaultBudget),
              disabled: draft === null || busyNow,
              onChange: (event) => setDraft(Object.assign({}, draft, { defaultBudget: Number(event.target.value) })),
            }),
          ),
          h(
            'div',
            { className: 'ma-row between' },
            h(
              'div',
              null,
              h('div', null, '检索条数上限（top_k）'),
              h('div', { className: 'ma-hint' }, '模型要求更多也不会超过这个数，最大 200。'),
            ),
            h('input', {
              className: 'ma-input',
              type: 'number',
              min: 1,
              max: 200,
              step: 5,
              value: draft === null ? '' : String(draft.maxTopK),
              disabled: draft === null || busyNow,
              onChange: (event) => setDraft(Object.assign({}, draft, { maxTopK: Number(event.target.value) })),
            }),
          ),
          h(
            'div',
            { className: 'ma-row between' },
            h(
              'div',
              null,
              h('div', null, '写入前脱敏'),
              h('div', { className: 'ma-hint' }, '把 sk- 密钥、GitHub token、私钥块、URL 里的密码、身份证号在落盘前打码。'),
            ),
            h('input', {
              type: 'checkbox',
              checked: draft === null ? true : draft.redactSecrets !== false,
              disabled: draft === null || busyNow,
              onChange: (event) => setDraft(Object.assign({}, draft, { redactSecrets: event.target.checked })),
            }),
          ),
          h(
            'div',
            { className: 'ma-row between' },
            h(
              'div',
              null,
              h('div', null, '常驻注入'),
              h('div', { className: 'ma-hint' }, '每轮自动把最相关的记忆摘要带进上下文，不用模型主动检索；空库时什么都不会注入。'),
            ),
            h('input', {
              type: 'checkbox',
              checked: draft === null ? true : draft.injectEnabled !== false,
              disabled: draft === null || busyNow,
              onChange: (event) => setDraft(Object.assign({}, draft, { injectEnabled: event.target.checked })),
            }),
          ),
          h(
            'div',
            { className: 'ma-row between' },
            h(
              'div',
              null,
              h('div', null, '注入字符预算'),
              h('div', { className: 'ma-hint' }, '注入文本的硬顶（含标题行）；超预算按「命中优先 + 最近更新」保留并给省略提示。范围 200–8000。'),
            ),
            h('input', {
              className: 'ma-input',
              type: 'number',
              min: 200,
              max: 8000,
              step: 100,
              value: draft === null ? '' : String(draft.injectBudgetChars),
              disabled: draft === null || busyNow,
              onChange: (event) => setDraft(Object.assign({}, draft, { injectBudgetChars: Number(event.target.value) })),
            }),
          ),
          h(
            'div',
            { className: 'ma-row' },
            h(
              'button',
              {
                className: 'ma-btn primary',
                disabled: draft === null || busyNow,
                onClick: () => {
                  if (draft === null) return
                  run('save', 'config.set', { config: draft }, '已保存，立即生效')
                },
              },
              busy === 'save' ? '保存中…' : '保存设置',
            ),
            h('span', { className: 'ma-hint' }, '存到记忆库根目录的 config.json，不用重启。'),
          ),
        ),

        /* ---------- 常驻注入 ---------- */
        h(
          'div',
          { className: 'ma-card' },
          h(
            'div',
            { className: 'ma-row between' },
            h('h3', null, '常驻注入'),
            h('span', { className: 'ma-hint' }, '模型没调用任何工具时也能看到的记忆摘要'),
          ),
          h(
            'div',
            { className: 'ma-row' },
            h(
              'button',
              { className: 'ma-btn primary', disabled: busyNow, onClick: doPreview },
              busy === 'preview' ? '生成中…' : '预览注入',
            ),
            preview === null
              ? h('span', { className: 'ma-hint' }, '点一下看看本轮会注入什么、占多少字符。')
              : h(
                'span',
                { className: 'ma-hint' },
                `${preview.enabled ? '已启用' : '已停用'} · ${preview.chars}/${preview.budget} 字符 · 收 ${preview.included} 条 · 省略 ${preview.omitted} 条（候选 ${preview.total} 条）`,
              ),
          ),
          preview === null
            ? null
            : preview.text === ''
              ? h('div', { className: 'ma-hint' }, '本轮不会注入任何内容（空库、开关已关或预算内放不下任何一条）。')
              : h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.9, maxHeight: 220, overflow: 'auto' } }, preview.text),
        ),

        /* ---------- 当前认知 ---------- */
        h(
          'div',
          { className: 'ma-card' },
          h(
            'div',
            { className: 'ma-row between' },
            h('h3', null, '当前认知'),
            h(
              'div',
              { className: 'ma-row' },
              h(
                'button',
                { className: 'ma-btn', disabled: busyNow, onClick: doDigest },
                busy === 'digest' ? '加载中…' : '刷新槽位',
              ),
              h(
                'button',
                { className: 'ma-btn primary', disabled: busyNow, onClick: () => doDigestRebuild() },
                busy === 'digestRebuild' ? '重建中…' : '重建全部',
              ),
            ),
          ),
          h('div', { className: 'ma-hint' }, '每个槽位一段合成认知；组装与注入都会优先用它；条目更新后标记过期、读取时自动重建。'),
          digestSlots === null
            ? h('div', { className: 'ma-hint' }, '还没加载过。点「刷新槽位」看看每个槽位的当前认知。')
            : digestSlots.length === 0
              ? h('div', { className: 'ma-hint' }, '还没有槽位（写入时给 key 就会有）。')
              : h('div', { className: 'ma-list' }, ...digestSlots.map(digestRow)),
        ),

        /* ---------- 检索日志 ---------- */
        h(
          'div',
          { className: 'ma-card' },
          h(
            'div',
            { className: 'ma-row between' },
            h('h3', null, '检索日志'),
            h(
              'button',
              { className: 'ma-btn', disabled: busyNow, onClick: doQueryLog },
              busy === 'queryLog' ? '加载中…' : '刷新日志',
            ),
          ),
          h(
            'div',
            { className: 'ma-hint' },
            '模型和面板每次检索都会记一条；零命中 = 问了但库没命中，是记忆库该补内容的信号。',
          ),
          queryLog === null
            ? h('div', { className: 'ma-hint' }, '还没加载过。点「刷新日志」看看最近都查了什么。')
            : queryLogEntries === null || queryLogEntries.length === 0
              ? h('div', { className: 'ma-hint' }, '还没有检索记录')
              : h('div', { className: 'ma-list' }, ...queryLogEntries.map(logRow)),
        ),

        /* ---------- 维护 ---------- */
        h(
          'div',
          { className: 'ma-card' },
          h(
            'div',
            { className: 'ma-row between' },
            h('h3', null, '维护'),
            h(
              'div',
              { className: 'ma-row' },
              h(
                'button',
                { className: 'ma-btn', disabled: busyNow, onClick: () => run('rebuild', 'rebuild', {}, (d) => `索引已重建：${d.entry_count} 条（扫描 ${d.scanned}，跳过 ${d.skipped}）`) },
                busy === 'rebuild' ? '重建中…' : '重建索引',
              ),
              h(
                'button',
                { className: 'ma-btn danger', disabled: busyNow, onClick: () => run('purge', 'purgeDeleted', {}, (d) => `已清理 ${d.removed_count} 个文件`) },
                busy === 'purge' ? '清理中…' : '清理已软删',
              ),
              h(
                'button',
                { className: 'ma-btn', disabled: busyNow, onClick: doExport },
                busy === 'export' ? '导出中…' : '导出备份',
              ),
            ),
          ),
          h('div', { className: 'ma-hint' }, '索引只是缓存，删了能重建；「清理」只删已软删的 episodes/raw，共享 topics 永远保留。'),
        ),

        /* ---------- 条目列表 ---------- */
        h(
          'div',
          { className: 'ma-card' },
          h('h3', null, `最近 ${entries.length} 条${counts !== null && counts.total > entries.length ? `（共 ${counts.total} 条）` : ''}`),
          entries.length === 0
            ? h('div', { className: 'ma-hint' }, '还没有记忆。上面「写一条记忆」或者在对话里让模型写。')
            : h('div', { className: 'ma-list' }, ...entries.map(entryRow)),
        ),

        /* ---------- 按会话忘却 ---------- */
        sessions.length === 0
          ? null
          : h(
            'div',
            { className: 'ma-card' },
            h('h3', null, '按会话忘却'),
            h('div', { className: 'ma-hint' }, '一次会话衍生的记忆可以整批忘掉：episodes/raw 标待清理，共享 topics 只解绑来源。'),
            h(
              'div',
              { className: 'ma-list' },
              ...sessions.map((session) => h(
                'div',
                { className: 'ma-item', key: `session-${session.session_id}` },
                h('span', { className: 'ma-pill' }, String(session.entries)),
                h(
                  'div',
                  { className: 'ma-main' },
                  h('div', { className: 'ma-title' }, session.session_id),
                  h('div', { className: 'ma-sub' }, `可检索 ${session.active} · 待清理 ${session.deleted}`),
                ),
                h(
                  'div',
                  { className: 'ma-actions' },
                  pendingForget === session.session_id
                    ? h(
                      'button',
                      {
                        className: 'ma-btn small danger',
                        disabled: busyNow,
                        onClick: () => {
                          run('forget', 'forgetSession', { session_id: session.session_id, scope: 'include_shared_unlink' }, (d) => `已忘却：episodes ${d.deleted_episode_count}、raw ${d.deleted_raw_count}、解绑 ${d.unlinked_topic_count}、孤儿 ${d.orphaned_topic_count}`)
                            .then(() => setPendingForget(''))
                        },
                      },
                      '确认忘却',
                    )
                    : h(
                      'button',
                      { className: 'ma-btn small', disabled: busyNow, onClick: () => setPendingForget(session.session_id) },
                      '忘却…',
                    ),
                ),
              )),
            ),
          ),
      )
    }

    /* -------------------------------- 插件出口 -------------------------------- */

    function apply(ctx) {
      const register = () => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'memory-agent',
        order: 60,
        label: () => '记忆',
      }, MemorySection))
      if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-memory-agent: settings section')
      else register()
    }

    exports.name = 'dsh-memory-agent'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
