import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChangedFile, Usage } from '../types'

const PANE = 'changed-files'
const PANE_TITLE = '변경 파일'
const KIND_KO: Record<string, string> = {
  five_hour: '5시간',
  seven_day: '7일',
  spend_limit: '지출 한도',
}
const WARN_AT = [80, 90]
const BAR_CELLS = 10

// 프롬프트 위 띠가 읽는 최신 사용량. 값이 바뀌면 띠가 다시 그려진다.
const latest = atom({ plugin: 'session-hud', key: 'usage' } as const, null)
// 이번 세션에서 Edit·Write로 바뀐 파일. 항목의 필드가 바뀌면 꼬리표도 바꾼다.
const changed = atom({ plugin: 'session-hud', key: 'files' } as const, [], { shape: 'files-1' })

// 한도 이름을 읽기 좋게 바꾼다. `seven_day_fable`처럼 모델별로 따로 오는
// 한도는 `7일(Fable)`로 따로 보여 준다.
function kindLabel(kind: string): string {
  const known = KIND_KO[kind]
  if (known !== undefined) return known
  const perModel = /^(five_hour|seven_day)_(.+)$/.exec(kind)
  if (perModel !== null) {
    const model = (perModel[2] ?? '').replaceAll('_', ' ')

    return `${KIND_KO[perModel[1] ?? ''] ?? ''}(${model.charAt(0).toUpperCase()}${model.slice(1)})`
  }

  return kind
}

type Patch = readonly { lines: readonly string[] }[]
type Level = 'success' | 'warning' | 'error'
type Meter = { key: string; label: string; percent?: number; note: string }

function contextPercent(u: Usage): number | undefined {
  if (u.context.percent !== undefined) return Math.round(u.context.percent)
  if (u.context.tokens !== undefined && u.context.window > 0) {
    return Math.round((u.context.tokens / u.context.window) * 100)
  }

  return undefined
}

function until(resetsAt: string | undefined, now: number): string {
  if (resetsAt === undefined) return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const min = Math.max(0, Math.round((at - now) / 60000))
  if (min < 60) return `${min}분 뒤 초기화`
  const hours = Math.floor(min / 60)
  if (hours < 48) return `${hours}시간 ${min % 60}분 뒤 초기화`

  return `${Math.floor(hours / 24)}일 뒤 초기화`
}

function tokens(n: number | undefined): string {
  if (n === undefined) return '?'

  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function took(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}초`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분 ${sec % 60}초`

  return `${Math.floor(min / 60)}시간 ${min % 60}분`
}

// 80% 미만은 초록, 80% 이상은 노랑, 90% 이상은 빨강.
function level(percent: number): Level {
  if (percent >= 90) return 'error'
  if (percent >= 80) return 'warning'

  return 'success'
}

function meters(u: Usage, now: number): Meter[] {
  const out: Meter[] = [{ key: 'context', label: '컨텍스트', percent: contextPercent(u), note: '' }]
  for (const l of u.rateLimits) {
    out.push({
      key: l.kind,
      label: kindLabel(l.kind),
      percent: Math.round(l.percentUsed),
      note: until(l.resetsAt, now),
    })
  }

  return out
}

function totals(files: readonly ChangedFile[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const f of files) {
    added += f.added
    removed += f.removed
  }

  return { added, removed }
}

function countPatch(patch: Patch): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of patch) {
    for (const row of hunk.lines) {
      if (row.startsWith('+')) added += 1
      else if (row.startsWith('-')) removed += 1
    }
  }

  return { added, removed }
}

function setting(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function detail(u: Usage, files: readonly ChangedFile[], budgetUsd: number, now: number): string {
  const ctx = contextPercent(u)
  const lines = [
    `컨텍스트: ${tokens(u.context.tokens)} / ${tokens(u.context.window)} 토큰${ctx === undefined ? '' : ` (${ctx}%)`}`,
  ]
  if (u.rateLimits.length === 0) lines.push('사용 한도: 표시할 값 없음')
  for (const l of u.rateLimits) {
    const left = until(l.resetsAt, now)
    lines.push(
      `${kindLabel(l.kind)} 한도: ${Math.round(l.percentUsed)}% 사용${left === '' ? '' : `, ${left}`}`,
    )
  }
  if (u.cost === undefined) lines.push('비용: 기록 없음')
  else {
    lines.push(
      `이 세션 비용: $${u.cost.usd.toFixed(2)}${budgetUsd > 0 ? ` / 예산 $${budgetUsd.toFixed(2)}` : ''}`,
    )
  }
  const sum = totals(files)
  lines.push(`변경 파일: ${files.length}개 (+${sum.added} −${sum.removed})`)

  return lines.join('\n')
}

// 설정 값. 0이면 해당 기능을 끈다. register가 불릴 때 채운다.
let budgetUsd = 5
let contextWarn = 80
let notifyAfterMs = 30000
let shouldOpenPane = true

// 같은 경고를 반복하지 않도록 마지막에 알린 단계를 기억한다.
const warned = new Map<string, number>()
let cwd = ''
let hasOpenedPane = false

function once(key: string, step: number): boolean {
  const last = warned.get(key) ?? 0
  warned.set(key, step)

  return step > last
}

function shortPath(path: string): string {
  const flat = path.replaceAll('\\', '/')
  const root = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
  if (root !== '' && flat.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return flat.slice(root.length + 1)
  }

  return flat
}

async function alert($: EngineInterface, text: string): Promise<void> {
  const sent = await $.ui.notify(text, { title: 'Claude Code' }).catch(() => undefined)
  if (sent === undefined || !sent.isSent) $.ui.toast(text, { timeoutMs: 8000 })
}

async function show($: EngineInterface, u: Usage): Promise<void> {
  const now = await $.clock.now()
  const snapshot: Usage = {
    context: { ...u.context },
    rateLimits: u.rateLimits.map(l => ({ ...l })),
    ...(u.cost === undefined ? {} : { cost: { usd: u.cost.usd } }),
  }
  await update($, latest, () => snapshot)

  // 사용 한도: 80%, 90%에서 한 번씩.
  for (const l of u.rateLimits) {
    const step = [...WARN_AT].reverse().find(at => l.percentUsed >= at) ?? 0
    if (once(`limit:${l.kind}`, step) && step > 0) {
      const left = until(l.resetsAt, now)
      $.ui.toast(
        `${kindLabel(l.kind)} 한도 ${Math.round(l.percentUsed)}% 사용${left === '' ? '' : ` · ${left}`}`,
      )
    }
  }

  // 컨텍스트: 설정한 선을 넘으면 한 번. 압축 뒤 다시 내려가면 다음에 또 알린다.
  const ctx = contextPercent(u)
  if (contextWarn > 0 && ctx !== undefined) {
    const step = ctx >= contextWarn ? 1 : 0
    if (once('context', step) && step > 0) {
      $.ui.toast(`컨텍스트 ${ctx}% 사용 · /compact 또는 새 세션을 권합니다`, { timeoutMs: 8000 })
    }
  }

  // 세션 예산: 80%에서 알림, 100%에서 경고.
  if (budgetUsd > 0 && u.cost !== undefined) {
    const usd = u.cost.usd
    const step = usd >= budgetUsd ? 2 : usd >= budgetUsd * 0.8 ? 1 : 0
    if (once('budget', step) && step > 0) {
      if (step === 2) {
        await alert(
          $,
          `세션 예산 $${budgetUsd.toFixed(2)}을 넘었습니다 (현재 $${usd.toFixed(2)}). 새 세션을 권합니다.`,
        )
      } else {
        $.ui.toast(`세션 예산의 80%를 썼습니다 ($${usd.toFixed(2)} / $${budgetUsd.toFixed(2)})`, {
          timeoutMs: 8000,
        })
      }
    }
  }
}

async function record(
  $: EngineInterface,
  path: string,
  patch: Patch,
  isNew: boolean,
  fallbackAdded: number,
): Promise<void> {
  const count = countPatch(patch)
  const added = count.added === 0 && count.removed === 0 ? fallbackAdded : count.added
  const name = shortPath(path)
  await update($, changed, list => {
    const old = list.find(f => f.path === name)
    const next: ChangedFile = {
      path: name,
      added: (old?.added ?? 0) + added,
      removed: (old?.removed ?? 0) + count.removed,
      edits: (old?.edits ?? 0) + 1,
      isNew: old?.isNew ?? isNew,
    }

    // 방금 바뀐 파일을 맨 위에 둔다.
    return [next, ...list.filter(f => f.path !== name)].slice(0, 300)
  })
  if (shouldOpenPane && !hasOpenedPane) {
    hasOpenedPane = true
    void $.ui.open({ id: PANE, title: PANE_TITLE })
  }
}

export const register: Register = (on, options) => {
  budgetUsd = setting(options.costBudgetUsd, 5)
  contextWarn = setting(options.contextWarnPercent, 80)
  notifyAfterMs = setting(options.notifyAfterSeconds, 30) * 1000
  shouldOpenPane = options.openPaneOnChange !== false

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'session-hud',
      description: '사용량·비용·변경 파일을 자세히 보여 주고 변경 파일 패널을 연다',
    })
    void $.session.usage().then(u => show($, u))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await show($, e)

    return next(e)
  })

  on('command.run', { command: 'session-hud' }, async $ => {
    const u = await $.session.usage()
    await show($, u)
    hasOpenedPane = true
    await $.ui.open({ id: PANE, title: PANE_TITLE })

    return { text: detail(u, await read($, changed), budgetUsd, await $.clock.now()) }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    if (ran.result.staged !== true) {
      await record($, ran.result.filePath, ran.result.structuredPatch, false, 0)
    }

    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    if (ran.result.staged !== true) {
      const isNew = ran.result.type === 'create'
      const rows = ran.result.content === '' ? 0 : ran.result.content.split('\n').length
      await record($, ran.result.filePath, ran.result.structuredPatch, isNew, isNew ? rows : 0)
    }

    return ran
  })

  // 오래 걸린 턴이 끝나면 알린다. 하위 에이전트의 턴과 직접 중단한 턴은 뺀다.
  on('turn.complete', async ($, e, next) => {
    const isMain = e.agentId === undefined
    if (isMain && !e.isAborted && notifyAfterMs > 0 && e.durationMs >= notifyAfterMs) {
      const files = await read($, changed)
      const head = e.reason === 'answer' ? '작업이 끝났습니다' : '작업이 중단되었습니다'
      const tail = files.length === 0 ? '' : ` · 변경 파일 ${files.length}개`
      void alert($, `${head} (${took(e.durationMs)})${tail}`)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, latest)
    if (e.props.hasSurvey || u === null) return next(e)

    const now = await $.clock.now()
    const files = await read($, changed)
    const sum = totals(files)
    const { Box, Text } = $.ui.resolve(e)
    const costLevel: Level | undefined =
      u.cost === undefined || budgetUsd <= 0 ? undefined : level((u.cost.usd / budgetUsd) * 100)

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
        <Text weight="bold" inverse>
          {' 사용량 '}
        </Text>
        {meters(u, now).map(m => {
          const color = m.percent === undefined ? 'inactive' : level(m.percent)
          const filled =
            m.percent === undefined
              ? 0
              : Math.min(BAR_CELLS, Math.max(0, Math.round((m.percent / 100) * BAR_CELLS)))

          return (
            <Box key={m.key} flexDirection="row" columnGap={1}>
              <Text weight="bold">{m.label}</Text>
              <Box flexDirection="row">
                <Text mono color={color}>
                  {'█'.repeat(filled)}
                </Text>
                <Text mono dimColor>
                  {'░'.repeat(BAR_CELLS - filled)}
                </Text>
              </Box>
              <Text weight="bold" tabular color={color}>
                {m.percent === undefined ? '?' : `${m.percent}%`}
              </Text>
              {m.note === '' ? null : <Text dimColor>{m.note}</Text>}
            </Box>
          )
        })}
        {u.cost === undefined ? null : (
          <Box key="cost" flexDirection="row" columnGap={1}>
            <Text weight="bold" tabular color={costLevel ?? 'text'}>
              {`$${u.cost.usd.toFixed(2)}`}
            </Text>
            {budgetUsd > 0 ? <Text dimColor>{`/ $${budgetUsd.toFixed(2)}`}</Text> : null}
          </Box>
        )}
        {files.length === 0 ? null : (
          <Box key="files" flexDirection="row" columnGap={1}>
            <Text weight="bold">{`변경 ${files.length}개`}</Text>
            <Text tabular color="success">{`+${sum.added}`}</Text>
            <Text tabular color="error">{`−${sum.removed}`}</Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const files = await read($, changed)
    const sum = totals(files)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 5)
    const shown = files.slice(0, room)

    if (files.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>아직 변경된 파일이 없습니다.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text weight="bold">{`파일 ${files.length}개`}</Text>
          <Text weight="bold" tabular color="success">{`+${sum.added}`}</Text>
          <Text weight="bold" tabular color="error">{`−${sum.removed}`}</Text>
          <Button key="clear" label="비우기" onPress={() => update($, changed, () => [])} />
        </Box>
        {shown.map(f => (
          <Box key={f.path} flexDirection="row" columnGap={1}>
            <Text tabular color="success">{`+${f.added}`}</Text>
            <Text tabular color="error">{`−${f.removed}`}</Text>
            <Text wrap="truncate-start">{f.path}</Text>
            {f.isNew ? <Text color="success">새 파일</Text> : null}
            {f.edits > 1 ? <Text dimColor>{`${f.edits}회`}</Text> : null}
          </Box>
        ))}
        {files.length > shown.length ? (
          <Text dimColor>{`… 외 ${files.length - shown.length}개`}</Text>
        ) : null}
      </Box>
    )
  })
}
