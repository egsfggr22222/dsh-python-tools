/**
 * dsh-python-tools — 浏览器半边：设置页里的「Python Tools」控制面板。
 *
 * 面板回答一个问题：**我现在装了哪些 Python 工具文件，哪些正在生效？**
 *
 *   · 列表    —— 每个已登记文件一行，带它声明的工具名与描述
 *   · 开关    —— 关掉 = 不注册它的工具与技能（文件还在，随时可开回来）
 *   · ✕       —— 撤销登记（等于 pytools remove），文件本身不删
 *   · 搜索框  —— 按文件名 / 工具名 / 描述筛选
 *
 * 所有状态由 Host 半边持有（registry.json），这里只是读写视图：
 * 每次操作后重新拉一次 `/api/dsh-python-tools-panel/list`，不做本地猜测。
 */
window.__ModuleLoader__.load({
  id: 'dsh-python-tools',
  factory(require) {
    const React = require('react')
    const { createElement: h, useEffect, useMemo, useState } = React

    /** Host 半边挂载的 API 前缀。 */
    const ROUTE = (() => {
      try {
        return new URL('api/dsh-python-tools-panel', document.baseURI).pathname
      } catch {
        return '/api/dsh-python-tools-panel'
      }
    })()

    const POLL_MS = 2500

    const CSS = `
.ptp_root { display: flex; flex-direction: column; gap: 14px; }
.ptp_head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.ptp_title { margin: 0; font-size: 16px; font-weight: 600; }
.ptp_desc { margin: 4px 0 0; font-size: 13px; opacity: .62; line-height: 1.5; }
.ptp_stats { display: flex; gap: 7px; flex-wrap: wrap; }
.ptp_chip { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: rgba(127,127,127,.14); }
.ptp_chip_on { background: rgba(64,180,120,.18); color: #3fbf78; }
.ptp_chip_off { background: rgba(200,120,60,.18); color: #d68b3c; }

.ptp_search { position: relative; }
.ptp_search input {
  width: 100%; box-sizing: border-box; height: 36px; padding: 0 34px 0 12px;
  border-radius: 8px; border: 1px solid rgba(127,127,127,.28);
  background: rgba(127,127,127,.08); color: inherit; font-size: 13px; outline: none;
}
.ptp_search input:focus { border-color: rgba(80,150,240,.65); }
.ptp_clear {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
  border: 0; background: transparent; cursor: pointer; font-size: 15px;
  line-height: 1; padding: 4px; color: inherit; opacity: .5;
}
.ptp_clear:hover { opacity: .95; }

/* 注册区：输入路径 + 注册按钮 */
.ptp_install { display: flex; gap: 8px; align-items: center; }
.ptp_install input {
  flex: 1 1 auto; min-width: 0; height: 36px; padding: 0 12px;
  border-radius: 8px; border: 1px solid rgba(127,127,127,.28);
  background: rgba(127,127,127,.08); color: inherit; font-size: 13px; outline: none;
  font-family: ui-monospace, Consolas, monospace;
}
.ptp_install input:focus { border-color: rgba(80,150,240,.65); }
.ptp_install button {
  flex: 0 0 auto; height: 36px; padding: 0 18px; border-radius: 8px; border: 0;
  cursor: pointer; background: #1f6feb; color: #fff; font-size: 13px;
}
.ptp_install button:hover { background: #2d7ff9; }
.ptp_install button:disabled { opacity: .55; cursor: not-allowed; }
.ptp_install_msg { font-size: 12px; margin-top: -6px; word-break: break-all; }
.ptp_install_ok { color: #3fbf78; }
.ptp_install_err { color: #e07070; }

.ptp_list { display: flex; flex-direction: column; gap: 8px; }
.ptp_item {
  display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px;
  border-radius: 10px; border: 1px solid rgba(127,127,127,.22);
  background: rgba(127,127,127,.05);
}
.ptp_item_off { opacity: .55; }
.ptp_main { flex: 1 1 auto; min-width: 0; }
.ptp_name { font-size: 14px; font-weight: 600; word-break: break-all; }
.ptp_note { font-size: 12px; opacity: .6; margin-top: 3px; }
.ptp_path { font-size: 11px; opacity: .42; margin-top: 3px; word-break: break-all;
  font-family: ui-monospace, Consolas, monospace; }
.ptp_tools { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; }
.ptp_tool {
  font-size: 11.5px; padding: 2px 8px; border-radius: 6px;
  background: rgba(90,140,220,.16); color: #7aa7e8;
  font-family: ui-monospace, Consolas, monospace;
}
.ptp_empty { padding: 34px 12px; text-align: center; font-size: 13px; opacity: .5; }

.ptp_side { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; padding-top: 2px; }
.ptp_switch {
  position: relative; width: 40px; height: 22px; border-radius: 999px;
  border: 0; padding: 0; cursor: pointer; flex: 0 0 auto;
  background: rgba(127,127,127,.35); transition: background .16s ease;
}
.ptp_switch_on { background: #3fbf78; }
.ptp_knob {
  position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; transition: transform .16s ease;
}
.ptp_switch_on .ptp_knob { transform: translateX(18px); }
.ptp_del {
  width: 26px; height: 26px; border-radius: 6px; border: 0; padding: 0;
  cursor: pointer; background: rgba(220,90,90,.16); color: #e07070;
  font-size: 14px; line-height: 1; display: flex; align-items: center; justify-content: center;
}
.ptp_del:hover { background: rgba(220,90,90,.32); }
.ptp_err { margin-top: 8px; font-size: 12px; color: #e07070; word-break: break-all; }
`

    const dict = {
      'page.title': 'Python 工具',
      'page.desc': '这些是登记进 pytools 的 Python 文件。关掉开关只让它暂时不生效，点 ✕ 才撤销登记；文件本身都不会被删除。',
      'stat.total': '共 {n} 个',
      'stat.on': '生效 {n}',
      'stat.off': '停用 {n}',
      'search.placeholder': '搜索文件名、工具名或描述…',
      'search.clear': '清空',
      'switch.on': '已启用（点击停用）',
      'switch.off': '已停用（点击启用）',
      'del.title': '撤销登记（不删除文件）',
      'empty.none': '还没有登记任何 Python 工具文件。在上面输入一个 .py 的完整路径就能登记。',
      'empty.filter': '没有匹配「{q}」的工具。',
      'error.badge': '读不到声明',
      'install.placeholder': '输入 .py 文件的完整路径，例如 C:\\my tools\\probe.py',
      'install.button': '注册',
      'install.busy': '注册中…',
      'install.ok': '已注册：{path}（{n} 个工具）',
      'install.fail': '注册失败：{message}',
    }

    const t = (key, vars) => {
      let text = dict[key] ?? key
      if (vars) {
        for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value))
      }
      return text
    }

    async function call(path, body) {
      const options = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      const response = await fetch(ROUTE + path, options)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    function Switch({ on, onClick, label }) {
      return h('button', {
        type: 'button',
        className: 'ptp_switch' + (on ? ' ptp_switch_on' : ''),
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        title: label,
        onClick,
      }, h('span', { className: 'ptp_knob' }))
    }

    function Item({ item, busy, onToggle, onRemove }) {
      const tools = item.tools || []
      return h('div', { className: 'ptp_item' + (item.disabled ? ' ptp_item_off' : '') },
        h('div', { className: 'ptp_main' },
          h('div', { className: 'ptp_name' }, item.label || item.path),
          item.note ? h('div', { className: 'ptp_note' }, item.note) : null,
          h('div', { className: 'ptp_path' }, item.path),
          tools.length > 0
            ? h('div', { className: 'ptp_tools' },
                ...tools.map((tool) => h('span', {
                  key: tool.name,
                  className: 'ptp_tool',
                  title: tool.description || '',
                }, tool.dshName || tool.name)))
            : null,
          item.error
            ? h('div', { className: 'ptp_err' }, `${t('error.badge')}：${item.error}`)
            : null),
        h('div', { className: 'ptp_side' },
          h(Switch, {
            on: !item.disabled,
            label: item.disabled ? t('switch.off') : t('switch.on'),
            onClick: () => { if (!busy) onToggle(item) },
          }),
          h('button', {
            type: 'button',
            className: 'ptp_del',
            title: t('del.title'),
            disabled: busy,
            onClick: () => { if (!busy) onRemove(item) },
          }, '✕')))
    }

    function Panel() {
      const [data, setData] = useState({ items: [], count: 0, enabled: 0, disabled: 0 })
      const [query, setQuery] = useState('')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [installPath, setInstallPath] = useState('')
      const [installing, setInstalling] = useState(false)
      const [installMsg, setInstallMsg] = useState({ kind: '', text: '' })

      const load = async () => {
        try {
          const next = await call('/list')
          setData(next)
          setError('')
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        }
      }

      useEffect(() => {
        void load()
        const timer = setInterval(() => {
          if (document.visibilityState === 'hidden') return
          void load()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [])

      const items = Array.isArray(data.items) ? data.items : []

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (needle === '') return items
        return items.filter((item) => {
          const haystack = [
            item.label ?? '',
            item.note ?? '',
            item.path ?? '',
            ...(item.tools || []).flatMap((tool) => [tool.name, tool.dshName, tool.description]),
            ...(item.skills || []).flatMap((skill) => [skill.name, skill.description]),
          ].join(' ').toLowerCase()
          return haystack.includes(needle)
        })
      }, [items, query])

      const toggle = async (item) => {
        setBusy(item.path)
        try {
          setData(await call('/toggle', { path: item.path, disabled: !item.disabled }))
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        } finally {
          setBusy('')
        }
      }

      const remove = async (item) => {
        setBusy(item.path)
        try {
          setData(await call('/remove', { path: item.path }))
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        } finally {
          setBusy('')
        }
      }

      /** 手动注册：输入 .py 路径，点按钮就登记。 */
      const doInstall = async () => {
        const target = installPath.trim()
        if (target === '' || installing) return
        setInstalling(true)
        setInstallMsg({ kind: '', text: '' })
        try {
          const response = await fetch(ROUTE + '/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: target }),
          })
          const payload = await response.json()
          if (!response.ok || payload?.ok === false) {
            setInstallMsg({
              kind: 'err',
              text: t('install.fail', { message: payload?.message ?? `HTTP ${response.status}` }),
            })
            return
          }
          setData(payload)
          const count = Array.isArray(payload?.installed?.tools) ? payload.installed.tools.length : 0
          setInstallMsg({
            kind: 'ok',
            text: t('install.ok', { path: payload?.installed?.path ?? target, n: count }),
          })
          setInstallPath('')
        } catch (problem) {
          setInstallMsg({ kind: 'err', text: t('install.fail', { message: String(problem?.message ?? problem) }) })
        } finally {
          setInstalling(false)
        }
      }

      return h('div', { className: 'ptp_root' },
        h('div', { className: 'ptp_head' },
          h('div', null,
            h('h2', { className: 'ptp_title' }, t('page.title')),
            h('p', { className: 'ptp_desc' }, t('page.desc'))),
          h('div', { className: 'ptp_stats' },
            h('span', { className: 'ptp_chip' }, t('stat.total', { n: data.count ?? items.length })),
            h('span', { className: 'ptp_chip ptp_chip_on' }, t('stat.on', { n: data.enabled ?? 0 })),
            h('span', { className: 'ptp_chip ptp_chip_off' }, t('stat.off', { n: data.disabled ?? 0 })))),

        h('div', { className: 'ptp_install' },
          h('input', {
            type: 'text',
            value: installPath,
            placeholder: t('install.placeholder'),
            spellCheck: false,
            onChange: (event) => setInstallPath(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void doInstall()
              }
            },
          }),
          h('button', {
            type: 'button',
            disabled: installing || installPath.trim() === '',
            onClick: () => void doInstall(),
          }, installing ? t('install.busy') : t('install.button'))),

        installMsg.text === '' ? null : h('div', {
          className: 'ptp_install_msg ' + (installMsg.kind === 'ok' ? 'ptp_install_ok' : 'ptp_install_err'),
        }, installMsg.text),

        h('div', { className: 'ptp_search' },
          h('input', {
            type: 'search',
            value: query,
            placeholder: t('search.placeholder'),
            onChange: (event) => setQuery(event.target.value),
          }),
          query === '' ? null : h('button', {
            type: 'button',
            className: 'ptp_clear',
            title: t('search.clear'),
            onClick: () => setQuery(''),
          }, '✕')),

        error === '' ? null : h('div', { className: 'ptp_err' }, error),

        items.length === 0
          ? h('div', { className: 'ptp_empty' }, t('empty.none'))
          : filtered.length === 0
            ? h('div', { className: 'ptp_empty' }, t('empty.filter', { q: query }))
            : h('div', { className: 'ptp_list' },
                ...filtered.map((item) => h(Item, {
                  key: item.path,
                  item,
                  busy: busy === item.path,
                  onToggle: toggle,
                  onRemove: remove,
                }))))
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-python-tools')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-python-tools: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-python-tools',
        order: 66,
        label: () => t('page.title'),
      }, () => h(Panel)))
    }

    return { inject: ['slots'], apply }
  },
})
