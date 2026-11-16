import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Usage } from '../types'

const KIND_KO: Record<string, string> = {
  five_hour: '5시간',
  seven_day: '7일',
  seven_day_opus: '7일(Opus)',
  seven_day_sonnet: '7일(Sonnet)',
  spend_limit: '지출 한도',
}
const WARN_AT = [80, 90]
const BAR_CELLS = 10

// 프롬프트 위 띠가 읽는 최신 사용량. 값이 바뀌면 띠가 다시 그려진다.
const latest = atom({ plugin: 'usage-meter', key: 'usage' } as const, null)

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

function detail(u: Usage, now: number): string {
  const ctx = contextPercent(u)
  const lines = [
    `컨텍스트: ${tokens(u.context.tokens)} / ${tokens(u.context.window)} 토큰${ctx === undefined ? '' : ` (${ctx}%)`}`,
  ]
  if (u.rateLimits.length === 0) lines.push('사용 한도: 표시할 값 없음')
  for (const l of u.rateLimits) {
    const left = until(l.resetsAt, now)
    lines.push(
      `${KIND_KO[l.kind] ?? l.kind} 한도: ${Math.round(l.percentUsed)}% 사용${left === '' ? '' : `, ${left}`}`,
    )
  }
  lines.push(u.cost === undefined ? '비용: 기록 없음' : `이 세션 비용: $${u.cost.usd.toFixed(2)}`)

  return lines.join('\n')
}

// 80% 미만은 초록, 80% 이상은 노랑, 90% 이상은 빨강.
function level(percent: number): 'success' | 'warning' | 'error' {
  if (percent >= 90) return 'error'
  if (percent >= 80) return 'warning'

  return 'success'
}

type Meter = { key: string; label: string; percent?: number; note: string }

function meters(u: Usage, now: number): Meter[] {
  const out: Meter[] = [{ key: 'context', label: '컨텍스트', percent: contextPercent(u), note: '' }]
  for (const l of u.rateLimits) {
    out.push({
      key: l.kind,
      label: KIND_KO[l.kind] ?? l.kind,
      percent: Math.round(l.percentUsed),
      note: until(l.resetsAt, now),
    })
  }

  return out
}

// 한도별로 마지막에 알린 경고 단계(80, 90)를 기억해 같은 경고를 반복하지 않는다.
const warned = new Map<string, number>()

async function show($: EngineInterface, u: Usage): Promise<void> {
  const now = await $.clock.now()
  const snapshot: Usage = {
    context: { ...u.context },
    rateLimits: u.rateLimits.map(l => ({ ...l })),
    ...(u.cost === undefined ? {} : { cost: { usd: u.cost.usd } }),
  }
  await update($, latest, () => snapshot)

  for (const l of u.rateLimits) {
    const step = [...WARN_AT].reverse().find(at => l.percentUsed >= at) ?? 0
    const last = warned.get(l.kind) ?? 0
    if (step > last) {
      const left = until(l.resetsAt, now)
      $.ui.toast(
        `${KIND_KO[l.kind] ?? l.kind} 한도 ${Math.round(l.percentUsed)}% 사용${left === '' ? '' : ` · ${left}`}`,
      )
    }
    warned.set(l.kind, step)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-meter',
      description: '컨텍스트·사용 한도·비용을 자세히 보여 준다',
    })
    void $.session.usage().then(u => show($, u))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await show($, e)

    return next(e)
  })

  on('command.run', { command: 'usage-meter' }, async $ => {
    const u = await $.session.usage()
    await show($, u)

    return { text: detail(u, await $.clock.now()) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, latest)
    if (e.props.hasSurvey || u === null) return next(e)

    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

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
          <Text weight="bold" tabular>{`$${u.cost.usd.toFixed(2)}`}</Text>
        )}
      </Box>
    )
  })
}
