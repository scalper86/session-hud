import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChangedFile, FileDiff, Step, Turn, Usage } from '../types'

const PANE = 'work'
const PANE_TITLE = '작업'
const KIND_KO: Record<string, string> = {
  five_hour: '5시간',
  seven_day: '7일',
  spend_limit: '지출 한도',
}
const WARN_AT = [80, 90]
const BAR_CELLS = 10
// 막대의 빈 칸 색: 반투명 회색이라 밝은 테마와 어두운 테마 모두에서 보인다.
const TRACK = '#8080804d'
// diff 블록 배경: 반투명이라 밝은·어두운 테마 모두에서 글자가 읽힌다.
const ADD_BG = '#2ea04333'
const REMOVE_BG = '#f8514933'
const HUNK_BG = '#8080801f'

// 프롬프트 위 띠가 읽는 최신 사용량. 값이 바뀌면 띠가 다시 그려진다.
const latest = atom({ plugin: 'session-hud', key: 'usage' } as const, null)
// 이번 세션에서 Edit·Write로 바뀐 파일. 항목의 필드가 바뀌면 꼬리표도 바꾼다.
const changed = atom({ plugin: 'session-hud', key: 'files' } as const, [], { shape: 'files-1' })
// 파일별로 이번 세션에 쌓인 diff(unified-diff 헝크). 최근 파일 일부만 보관한다.
const diffs = atom({ plugin: 'session-hud', key: 'diffs' } as const, [], { shape: 'diffs-1' })
// 패널에서 diff를 펼친 파일. null이면 목록을 보여 준다.
const selected = atom({ plugin: 'session-hud', key: 'selected' } as const, null)
// 작업 타임라인: 요청(턴)마다 도구 호출 단계를 모은다. 최근 것만 보관한다.
const turns = atom({ plugin: 'session-hud', key: 'turns' } as const, [], { shape: 'turns-1' })
// 다음 할 일 추천과, 추천을 만드는 중인지.
const suggestions = atom({ plugin: 'session-hud', key: 'suggestions' } as const, [], {
  shape: 'suggestions-1',
})
const isSuggesting = atom({ plugin: 'session-hud', key: 'isSuggesting' } as const, false)
// 방금 끝난 작업이 일단락됐는지(추천 모델의 판단). 클리어 권장에 쓴다.
const isWrapped = atom({ plugin: 'session-hud', key: 'isWrapped' } as const, false)
// "나중에"를 누른 권장. 같은 권장은 컨텍스트가 10%p 더 오를 때까지 다시 띄우지 않는다.
const dismissed = atom({ plugin: 'session-hud', key: 'dismissed' } as const, '')
const TURNS_KEPT = 20
const STEPS_KEPT = 60
// 타임라인에 넣지 않는 도구: 앱이 화면을 꾸리려고 부르는 것들.
const QUIET_TOOL = /^mcp__ccd_/

// 도구 호출에서 무엇을 대상으로 했는지 한 줄로 뽑는다.
function stepTarget(input: unknown, short: (path: string) => string): string {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const v = fields[key]
    if (typeof v === 'string' && v !== '') return short(v)
  }
  for (const key of ['command', 'pattern', 'url', 'query', 'description', 'prompt', 'skill']) {
    const v = fields[key]
    if (typeof v === 'string' && v !== '') return v.replace(/\s+/g, ' ').trim().slice(0, 80)
  }

  return ''
}

// 도구 이름을 짧게: mcp__server__tool → tool.
function toolName(tool: string): string {
  const parts = tool.split('__')

  return parts.length >= 3 ? (parts[parts.length - 1] ?? tool) : tool
}

function summary(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line === '') return '(이어서 진행)'

  return line.length > 48 ? `${line.slice(0, 47)}…` : line
}

function clock(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}초`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분 ${sec % 60}초`

  return `${Math.floor(min / 60)}시간 ${min % 60}분`
}

function stepMs(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}초`

  return clock(ms)
}

// diff 화면에서 맨 위에 보이는 줄. 휠을 굴리면 이 값만 바뀐다.
const diffTop = atom({ plugin: 'session-hud', key: 'diffTop' } as const, 0)
// 마지막으로 그린 diff의 줄 수와 보이는 줄 수. 스크롤 범위를 정할 때 쓴다.
let diffView = { rows: 0, window: 0 }
const DIFF_FILES = 60

// diff를 줄 단위로 펼치고, 줄마다 그 줄이 시작하는 옛·새 줄 번호를 붙인다.
type DiffRow = { text: string; kind: 'hunk' | 'context' | 'remove' | 'add' | 'other'; old: number; neu: number }

function diffRows(diff: string): DiffRow[] {
  const out: DiffRow[] = []
  let old = 1
  let neu = 1
  for (const text of diff.split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (head !== null) {
      old = Number(head[1])
      neu = Number(head[2])
      out.push({ text, kind: 'hunk', old, neu })
      continue
    }
    const kind = text.startsWith('+') ? 'add' : text.startsWith('-') ? 'remove' : text.startsWith(' ') ? 'context' : 'other'
    out.push({ text, kind, old, neu })
    if (kind !== 'add' && kind !== 'other') old += 1
    if (kind !== 'remove' && kind !== 'other') neu += 1
  }

  return out
}

const DIFF_CHARS = 40000

type Hunk = {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly string[]
}

function hunksText(patch: readonly Hunk[]): string {
  return patch
    .map(h => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`)
    .join('\n')
}

// 새로 만든 파일에 diff가 없으면 내용 전체를 추가된 줄로 만든다.
function createdText(content: string): string {
  const rows = content.replace(/\n$/, '').split('\n')

  return `@@ -0,0 +1,${rows.length} @@\n${rows.map(r => `+${r}`).join('\n')}`
}

// 너무 길면 오래된 헝크부터 버린다. 헝크 중간에서 자르지 않는다.
function capDiff(text: string): { text: string; isCut: boolean } {
  if (text.length <= DIFF_CHARS) return { text, isCut: false }
  const hunks = text.split(/\n(?=@@ )/)
  while (hunks.length > 1 && hunks.join('\n').length > DIFF_CHARS) hunks.shift()
  const kept = hunks.join('\n')

  return { text: kept.length > DIFF_CHARS ? '' : kept, isCut: true }
}

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

// 띠에 쓰는 짧은 초기화 시각: "4시간 31분 후", "4일 후".
function untilShort(resetsAt: string | undefined, now: number): string {
  if (resetsAt === undefined) return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const min = Math.max(0, Math.round((at - now) / 60000))
  if (min < 60) return `${min}분 후`
  const hours = Math.floor(min / 60)
  if (hours < 24) return min % 60 === 0 ? `${hours}시간 후` : `${hours}시간 ${min % 60}분 후`

  return `${Math.round(hours / 24)}일 후`
}

// 예산 금액: 정수면 소수점을 빼고, 아니면 두 자리까지.
function formatUsd(usd: number): string {
  return Number.isInteger(usd) ? String(usd) : usd.toFixed(2)
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
      note: untilShort(l.resetsAt, now),
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
      `이 세션 비용(API 요금 환산, 구독 요금제는 따로 청구되지 않음): $${u.cost.usd.toFixed(2)}${budgetUsd > 0 ? ` / 예산 $${formatUsd(budgetUsd)}` : ''}`,
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
let shouldSuggest = true

// 마지막으로 시작한 추천 요청의 번호. 늦게 온 옛 추천이 새 추천을 덮지 않게 한다.
let suggestRun = 0

const SUGGEST_SYSTEM = [
  '당신은 개발자가 Claude Code에게 다음에 시킬 일을 짧게 추천하는 도우미입니다.',
  '최대 3개를 추천합니다. 각 추천은 한국어 한 문장, 40자 이내, Claude에게 하는 요청 형태("…해 줘")로 씁니다.',
  '방금 끝난 작업에서 자연스럽게 이어지는 일(검증, 테스트, 마무리, 남은 부분)을 우선합니다.',
  '번호, 기호, 따옴표, 설명 없이 한 줄에 하나씩만 씁니다. 추천할 것이 없으면 아무것도 쓰지 않습니다.',
  '맨 첫 줄에는 반드시 "상태: 일단락" 또는 "상태: 진행 중"을 씁니다.',
  '요청한 작업이 끝나 다음에 다른 주제로 넘어가도 될 때만 "일단락"입니다. 같은 작업이 이어지면 "진행 중"입니다.',
].join('\n')

// 첫 줄의 "상태: 일단락/진행 중"을 읽는다.
function parseWrapped(text: string): boolean {
  const head = text.split('\n').find(line => /상태\s*[:：]/.test(line)) ?? ''

  return /일단락/.test(head)
}

function parseSuggestions(text: string): string[] {
  return text
    .split('\n')
    .filter(line => !/상태\s*[:：]/.test(line))
    .map(line => line.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').replace(/^["'“”]|["'“”]$/g, '').trim())
    .filter(line => line !== '' && line.length <= 80)
    .slice(0, 3)
}

async function suggest($: EngineInterface, request: string, answer: string): Promise<void> {
  const run = ++suggestRun
  await update($, isSuggesting, () => true)
  try {
    const files = (await read($, changed)).slice(0, 15).map(f => `- ${f.path} (+${f.added} −${f.removed})`)
    const prompt = [
      `사용자의 요청:\n${request.slice(0, 2000) || '(이어서 진행)'}`,
      `Claude의 마지막 답변:\n${answer.slice(-3000) || '(없음)'}`,
      `이번 세션에서 바뀐 파일:\n${files.join('\n') || '(없음)'}`,
    ].join('\n\n')
    const reply = await $.model.complete({
      model: 'haiku',
      system: SUGGEST_SYSTEM,
      prompt,
      maxTokens: 300,
      effort: 'low',
      timeoutMs: 20000,
    })
    if (run !== suggestRun) return
    await update($, suggestions, () => (reply.isAnswered ? parseSuggestions(reply.text) : []))
    await update($, isWrapped, () => reply.isAnswered && parseWrapped(reply.text))
  } catch {
    if (run === suggestRun) await update($, suggestions, () => [])
  } finally {
    if (run === suggestRun) await update($, isSuggesting, () => false)
  }
}

// 컨텍스트 관리 권장: 언제 압축하고 언제 클리어할지 판단한다.
//  - 90% 이상: 곧 자동 압축되니 지금 압축 (급함)
//  - 50% 이상이고 방금 작업이 일단락: 다음 작업은 클리어하고 새로 시작
//  - 기준 이상이고 이미 2번 이상 압축: 요약이 쌓여 흐려지니 클리어
//  - 기준 이상: 한 번 압축
const CLEAR_WHEN_WRAPPED = 50
const URGENT = 90

type Advice = { kind: 'compact' | 'clear'; text: string; isUrgent: boolean; key: string }

function advise(ctx: number | undefined, wrapped: boolean, compactions: number): Advice | null {
  if (ctx === undefined || contextWarn <= 0) return null
  const bucket = Math.floor(ctx / 10)
  if (ctx >= URGENT) {
    return {
      kind: wrapped ? 'clear' : 'compact',
      text: wrapped
        ? `컨텍스트 ${ctx}% · 작업이 일단락됐으니 클리어하고 새로 시작하는 게 좋습니다.`
        : `컨텍스트 ${ctx}% · 곧 자동 압축됩니다. 지금 한 번 압축하세요.`,
      isUrgent: true,
      key: `${wrapped ? 'clear' : 'compact'}:${bucket}`,
    }
  }
  if (wrapped && ctx >= CLEAR_WHEN_WRAPPED) {
    return {
      kind: 'clear',
      text: `컨텍스트 ${ctx}% · 작업이 일단락됐습니다. 다음 작업은 클리어하고 시작하는 게 좋습니다.`,
      isUrgent: false,
      key: `clear:${bucket}`,
    }
  }
  if (ctx >= contextWarn && compactions >= 2) {
    return {
      kind: 'clear',
      text: `컨텍스트 ${ctx}% · 이미 ${compactions}번 압축했습니다. 클리어하고 새로 시작하는 게 좋습니다.`,
      isUrgent: false,
      key: `clear:${bucket}`,
    }
  }
  if (ctx >= contextWarn) {
    return {
      kind: 'compact',
      text: `컨텍스트 ${ctx}% · 한 번 압축하세요.`,
      isUrgent: false,
      key: `compact:${bucket}`,
    }
  }

  return null
}

// 이 세션에서 압축한 횟수(메인 대화만). 클리어하면 0으로 돌아간다.
let compactions = 0

async function patchTurn($: EngineInterface, id: string, change: (turn: Turn) => Turn): Promise<void> {
  await update($, turns, list => list.map(t => (t.id === id ? change(t) : t)))
}

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

  // 컨텍스트는 토스트 대신 띠에 압축·클리어 권장과 확인 버튼을 띄운다(advise 참고).

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
  diffText: string,
): Promise<void> {
  const count = countPatch(patch)
  const added = count.added === 0 && count.removed === 0 ? fallbackAdded : count.added
  const name = shortPath(path)
  if (diffText !== '') {
    await update($, diffs, list => {
      const old = list.find(d => d.path === name)
      const merged = capDiff(old === undefined ? diffText : `${old.diff}\n${diffText}`).text
      const next: FileDiff = { path: name, diff: merged }

      return [next, ...list.filter(d => d.path !== name)].slice(0, DIFF_FILES)
    })
  }
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
  shouldSuggest = options.suggestNextSteps !== false

  // 지금 진행 중인 요청(턴). 메인 대화의 턴만 센다.
  let currentTurn: string | null = null

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'session-hud',
      description: '사용량·비용·변경 파일을 자세히 보여 주고 작업 패널을 연다',
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
      const patch = ran.result.structuredPatch
      await record($, ran.result.filePath, patch, false, 0, hunksText(patch))
    }

    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    if (ran.result.staged !== true) {
      const isNew = ran.result.type === 'create'
      const content = ran.result.content
      const rows = content === '' ? 0 : content.replace(/\n$/, '').split('\n').length
      const patch = ran.result.structuredPatch
      const diffText =
        patch.length > 0 ? hunksText(patch) : isNew && content !== '' ? createdText(content) : ''
      await record($, ran.result.filePath, patch, isNew, isNew ? rows : 0, diffText)
    }

    return ran
  })

  // 요청이 시작되면 타임라인에 새 칸을 연다. 이전 추천은 지운다.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      currentTurn = e.turnId
      const turn: Turn = {
        id: e.turnId,
        text: summary(e.text),
        startedAt: await $.clock.now(),
        files: (await read($, changed)).length,
        steps: [],
      }
      await update($, turns, list => [...list, turn].slice(-TURNS_KEPT))
      suggestRun += 1
      await update($, suggestions, () => [])
      await update($, isSuggesting, () => false)
      await update($, isWrapped, () => false)
    }

    return next(e)
  })

  // 메인 대화의 압축 횟수를 센다.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && done.skip === undefined) {
      compactions += 1
      await update($, dismissed, () => '')
    }

    return done
  })

  // 클리어하면 대화 기록에 묶인 것(작업 타임라인·추천·압축 횟수)을 처음부터 다시 센다.
  // 디스크의 파일은 그대로 바뀐 상태이므로 변경 파일 목록은 남긴다.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      compactions = 0
      currentTurn = null
      suggestRun += 1
      await update($, turns, () => [])
      await update($, suggestions, () => [])
      await update($, isSuggesting, () => false)
      await update($, isWrapped, () => false)
      await update($, dismissed, () => '')
    }

    return next(e)
  })

  // 도구 호출 하나하나를 진행 중인 요청의 단계로 기록한다. 하위 에이전트의 호출은 뺀다.
  on('tool.call', async ($, e, next) => {
    const turnId = currentTurn
    const agentId = (e as { agentId?: string }).agentId
    if (turnId === null || agentId !== undefined || QUIET_TOOL.test(e.tool)) return next(e)

    const step: Step = {
      id: e.tool_use_id ?? `${e.tool}-${await $.clock.now()}`,
      tool: toolName(e.tool),
      target: stepTarget(e, shortPath),
      startedAt: await $.clock.now(),
      status: 'run',
    }
    await patchTurn($, turnId, t => ({ ...t, steps: [...t.steps, step].slice(-STEPS_KEPT) }))
    const ran = await next(e)
    const ms = (await $.clock.now()) - step.startedAt
    const status = ran.deny !== undefined || ran.isError === true ? 'fail' : 'ok'
    await patchTurn($, turnId, t => ({
      ...t,
      steps: t.steps.map(s => (s.id === step.id ? { ...s, status, ms } : s)),
    }))

    return ran
  })

  // 오래 걸린 턴이 끝나면 알린다. 하위 에이전트의 턴과 직접 중단한 턴은 뺀다.
  on('turn.complete', async ($, e, next) => {
    const isMain = e.agentId === undefined
    if (isMain) {
      const fileCount = (await read($, changed)).length
      await patchTurn($, e.turnId, t => ({
        ...t,
        ms: e.durationMs,
        reason: e.isAborted ? 'aborted' : e.reason,
        files: Math.max(0, fileCount - t.files),
        // 끝났는데 결과가 오지 않은 단계는 중단된 것으로 본다.
        steps: t.steps.map(s => (s.status === 'run' ? { ...s, status: 'fail' as const } : s)),
      }))
      if (currentTurn === e.turnId) currentTurn = null
      if (shouldSuggest && !e.isAborted && e.reason === 'answer') {
        const turn = (await read($, turns)).find(t => t.id === e.turnId)
        void suggest($, turn?.text ?? '', e.answer)
      }
    }
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
    const { Box, Button, Text } = $.ui.resolve(e)
    const isTerminal = e.surface === 'terminal'
    const advice = advise(contextPercent(u), await read($, isWrapped), compactions)
    const showAdvice = advice !== null && (await read($, dismissed)) !== advice.key

    // 권장한 일을 실행한다. 버튼을 누른 것이 확인이고, 클리어는 대화를 잃으니 한 번 더 묻는다.
    const act = async (kind: 'compact' | 'clear') => {
      if (kind === 'clear') {
        const answer = await $.ui
          .ask('대화를 비우고 새로 시작할까요? 지금까지의 대화 내용은 Claude가 더는 기억하지 못합니다.', [
            '클리어',
            '취소',
          ])
          .catch(() => '취소')
        if (answer !== '클리어') return
      }
      await update($, dismissed, () => advice?.key ?? '')
      await $.command.run({ command: kind })
    }
    const costLevel: Level | undefined =
      u.cost === undefined || budgetUsd <= 0 ? undefined : level((u.cost.usd / budgetUsd) * 100)

    // 막대: 터미널은 가는 선(━), 그 밖의 화면은 두꺼운 칸(█)으로 그린다.
    // 빈 칸은 반투명 회색으로 칠해 밝은·어두운 테마 어디서나 트랙이 보이게 한다.
    const bar = (key: string, percent: number | undefined, color: string) => {
      const filled =
        percent === undefined
          ? 0
          : Math.min(BAR_CELLS, Math.max(0, Math.round((percent / 100) * BAR_CELLS)))
      const glyph = isTerminal ? '━' : '█'

      return (
        <Box key={`${key}-bar`} flexDirection="row" flexShrink={0}>
          <Text mono color={color}>
            {glyph.repeat(filled)}
          </Text>
          <Text mono color={isTerminal ? undefined : TRACK} dimColor={isTerminal}>
            {glyph.repeat(BAR_CELLS - filled)}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap="lg" rowGap="xs">
        {meters(u, now).map(m => {
          const color = m.percent === undefined ? 'inactive' : level(m.percent)

          return (
            <Box key={m.key} flexDirection="row" alignItems="center" columnGap="sm" flexShrink={0}>
              <Text weight="medium">{m.label}</Text>
              {bar(m.key, m.percent, color)}
              <Text weight="bold" tabular color={color}>
                {m.percent === undefined ? '–' : `${m.percent}%`}
              </Text>
              {m.note === '' ? null : (
                <Text dimColor size="footnote">
                  {m.note}
                </Text>
              )}
            </Box>
          )
        })}
        {u.cost === undefined ? null : (
          // 세션 비용은 API 요금으로 환산한 값이다. 구독 요금제에서는 따로 청구되지 않는다.
          <Box key="cost" flexDirection="row" alignItems="center" columnGap="sm" flexShrink={0}>
            <Text weight="medium">API 환산</Text>
            <Text weight="bold" tabular color={costLevel ?? 'text'}>
              {`$${u.cost.usd.toFixed(2)}`}
            </Text>
            {budgetUsd > 0 ? (
              <Text dimColor tabular size="footnote">{`/ 예산 $${formatUsd(budgetUsd)}`}</Text>
            ) : null}
            {budgetUsd > 0 && u.cost.usd >= budgetUsd ? (
              <Text color="error" weight="semibold" size="footnote">
                초과
              </Text>
            ) : null}
          </Box>
        )}
        {files.length === 0 ? null : (
          <Box key="files" flexDirection="row" alignItems="center" columnGap="sm" flexShrink={0}>
            <Button
              key="open-files"
              label={`변경 ${files.length}개`}
              plain
              onPress={async () => {
                hasOpenedPane = true
                await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
              }}
            />
            <Text weight="bold" tabular color="success">{`+${sum.added}`}</Text>
            {sum.removed === 0 ? null : (
              <Text weight="bold" tabular color="error">{`−${sum.removed}`}</Text>
            )}
          </Box>
        )}
        {!showAdvice || advice === null ? null : (
          <Box key="advice" width="100%" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap="sm">
            <Text weight="semibold" color={advice.isUrgent ? 'error' : 'warning'}>
              {advice.kind === 'clear' ? '⟲ 클리어 권장' : '⇣ 압축 권장'}
            </Text>
            <Text>{advice.text}</Text>
            <Button
              key={`advice-do-${advice.kind}`}
              label={advice.kind === 'clear' ? '클리어' : '지금 압축'}
              variant="primary"
              onPress={() => act(advice.kind)}
            />
            {advice.kind === 'clear' ? (
              <Button key="advice-compact" label="압축만" onPress={() => act('compact')} />
            ) : null}
            <Button key="advice-later" label="나중에" onPress={() => update($, dismissed, () => advice.key)} />
          </Box>
        )}
      </Box>
    )
  })

  // diff 화면에서는 휠을 직접 받아 diff 줄만 옮긴다. 머리줄은 그대로 남는다.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if ((await read($, selected)) === null) return next(e)
    const maxTop = Math.max(0, diffView.rows - diffView.window)
    await update($, diffTop, top => Math.min(maxTop, Math.max(0, top + e.by)))

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const files = await read($, changed)
    const sum = totals(files)
    const open = await read($, selected)

    // 파일 하나를 고르면 그 파일의 diff를 펼친다.
    const file = open === null ? undefined : files.find(f => f.path === open)
    if (open !== null && file !== undefined) {
      const entry = (await read($, diffs)).find(d => d.path === open)
      const slash = open.lastIndexOf('/')
      // 머리줄(목록 버튼·파일 이름·경로)은 고정하고, 그 아래 diff 줄만 직접 스크롤한다.
      // 트리가 창 높이를 넘지 않으니 패널 자체는 움직이지 않고, 휠은 ui.scroll 훅이 받는다.
      const rows = entry === undefined ? [] : diffRows(entry.diff)
      const window = Math.max(3, e.props.scroll.bodyRows - (slash < 0 ? 3 : 4) - (file.edits > 1 ? 1 : 0))
      const maxTop = Math.max(0, rows.length - window)
      const top = Math.min(maxTop, Math.max(0, await read($, diffTop)))
      diffView = { rows: rows.length, window }
      // 줄 번호 칸 너비: 보이는 줄 가운데 가장 큰 번호에 맞춘다.
      const numWidth = Math.max(
        2,
        ...rows.slice(top, top + window).map(r => String(Math.max(r.old, r.neu)).length),
      )
      const back = async () => {
        await update($, diffTop, () => 0)
        await update($, selected, () => null)
      }

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" columnGap="sm">
            <Button key="back" label="← 목록" hotkey="b" onPress={back} />
            <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Text weight="semibold" wrap="truncate-start">
                {open.slice(slash + 1)}
              </Text>
            </Box>
            <Box flexShrink={0} flexDirection="row" columnGap="xs">
              <Text tabular size="footnote" color="success">{`+${file.added}`}</Text>
              <Text tabular size="footnote" color="error" dimColor={file.removed === 0}>
                {`−${file.removed}`}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row" columnGap="sm">
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              {slash < 0 ? null : (
                <Text dimColor size="caption" wrap="truncate-start">
                  {open.slice(0, slash + 1)}
                </Text>
              )}
            </Box>
            {rows.length > window ? (
              <Box flexShrink={0}>
                <Text dimColor tabular size="caption">
                  {`${top + 1}–${Math.min(rows.length, top + window)} / ${rows.length}줄`}
                </Text>
              </Box>
            ) : null}
          </Box>
          {file.edits > 1 ? (
            <Text dimColor size="caption">{`이번 세션의 수정 ${file.edits}회를 순서대로 모았습니다.`}</Text>
          ) : null}
          <Box flexDirection="column" height={window} overflow="hidden">
            {rows.length === 0 ? <Text dimColor>보관된 변경 내용이 없습니다.</Text> : null}
            {rows.slice(top, top + window).map((r, i) => {
              const key = `row:${top + i}`
              // 헝크 머리(@@)는 줄 번호만 알려 주는 얇은 구분선으로 그린다.
              if (r.kind === 'hunk') {
                return (
                  <Box key={key} flexDirection="row" height={1} overflow="hidden" backgroundColor={HUNK_BG}>
                    <Text dimColor tabular wrap="truncate-end" backgroundColor={HUNK_BG}>
                      {` ⋯ ${r.neu}행부터 `.padEnd(e.props.bodyColumns, ' ')}
                    </Text>
                  </Box>
                )
              }
              const isAdd = r.kind === 'add'
              const isRemove = r.kind === 'remove'
              const bg = isAdd ? ADD_BG : isRemove ? REMOVE_BG : undefined
              const mark = isAdd ? '+' : isRemove ? '−' : ' '
              const oldNo = isAdd || r.kind === 'other' ? '' : String(r.old)
              const newNo = isRemove || r.kind === 'other' ? '' : String(r.neu)
              const text = r.kind === 'other' ? r.text : r.text.slice(1)

              return (
                <Box key={key} flexDirection="row" height={1} overflow="hidden" backgroundColor={bg}>
                  <Box width={numWidth} flexShrink={0} justifyContent="flex-end">
                    <Text dimColor tabular mono size="footnote" backgroundColor={bg}>
                      {oldNo}
                    </Text>
                  </Box>
                  <Box width={numWidth + 1} flexShrink={0} justifyContent="flex-end">
                    <Text dimColor tabular mono size="footnote" backgroundColor={bg}>
                      {newNo}
                    </Text>
                  </Box>
                  <Box width={3} flexShrink={0} justifyContent="center">
                    <Text
                      mono
                      weight="bold"
                      color={isAdd ? 'success' : isRemove ? 'error' : undefined}
                      backgroundColor={bg}
                    >
                      {mark}
                    </Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                    <Text mono wrap="truncate-end" backgroundColor={bg}>
                      {(text === '' ? ' ' : text).padEnd(e.props.bodyColumns, ' ')}
                    </Text>
                  </Box>
                </Box>
              )
            })}
          </Box>
        </Box>
      )
    }

    // 목록 화면: 위쪽은 작업(진행 상황·다음 할 일·지난 작업), 아래쪽은 변경 파일.
    // 두 구역의 높이를 나눠 고정해, 패널 하나를 위아래로 나눈 것처럼 보이게 한다.
    const body = Math.max(12, e.props.scroll.bodyRows)
    const workRows = Math.max(7, Math.floor(body * 0.55))
    const filesRows = Math.max(3, body - workRows - 1)

    const allTurns = await read($, turns)
    const last = allTurns[allTurns.length - 1]
    const past = allTurns.slice(0, -1).reverse().slice(0, 3)
    const ideas = await read($, suggestions)
    const isThinking = await read($, isSuggesting)
    const ideaRows = 1 + Math.max(1, ideas.length)
    const pastRows = past.length === 0 ? 0 : 1 + past.length
    const stepRows = Math.max(2, workRows - 2 - ideaRows - pastRows)
    const steps = last === undefined ? [] : last.steps.slice(-stepRows)
    const isRunning = last !== undefined && last.ms === undefined

    const icon = (status: Step['status']) =>
      status === 'run' ? (
        <Text color="warning">●</Text>
      ) : status === 'ok' ? (
        <Text color="success">✓</Text>
      ) : (
        <Text color="error">✗</Text>
      )

    const turnState =
      last === undefined
        ? ''
        : isRunning
          ? `● 진행 중 · ${last.steps.length}단계`
          : last.reason === 'aborted'
            ? `■ 중단됨 · ${clock(last.ms ?? 0)}`
            : `✓ 끝남 · ${clock(last.ms ?? 0)} · ${last.steps.length}단계`

    const listed = files.slice(0, Math.max(1, filesRows - 1))
    const addWidth = Math.max(2, ...listed.map(f => String(f.added).length)) + 1
    const removeWidth = Math.max(2, ...listed.map(f => String(f.removed).length)) + 1

    return (
      <Box flexDirection="column">
        <Box key="work" flexDirection="column" height={workRows} overflow="hidden">
          {last === undefined ? (
            <Text dimColor>아직 기록된 작업이 없습니다.</Text>
          ) : (
            <Box flexDirection="row" alignItems="center" columnGap="sm">
              <Box flexShrink={0}>
                <Text weight="semibold" color={isRunning ? 'warning' : last.reason === 'aborted' ? 'error' : 'success'}>
                  {turnState}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                <Text dimColor wrap="truncate-end">
                  {last.text}
                </Text>
              </Box>
            </Box>
          )}
          {steps.map(s => (
            <Box key={`step:${s.id}`} flexDirection="row" alignItems="center" columnGap="sm">
              <Box width={2} flexShrink={0}>
                {icon(s.status)}
              </Box>
              <Box width={7} flexShrink={0} overflow="hidden">
                <Text weight="medium" size="footnote" wrap="truncate-end">
                  {s.tool}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                <Text dimColor size="footnote" wrap="truncate-start">
                  {s.target}
                </Text>
              </Box>
              <Box flexShrink={0}>
                <Text dimColor tabular size="caption">
                  {s.status === 'run' ? '실행 중' : stepMs(s.ms ?? 0)}
                </Text>
              </Box>
            </Box>
          ))}

          <Box key="ideas-head" flexDirection="row" marginTop={1} columnGap="sm">
            <Text weight="semibold">다음 할 일 추천</Text>
            {isThinking ? (
              <Text dimColor size="caption">
                만드는 중…
              </Text>
            ) : null}
          </Box>
          {ideas.length === 0 ? (
            <Text dimColor size="footnote">
              {isThinking
                ? '방금 끝난 작업을 보고 추천을 고르고 있습니다.'
                : shouldSuggest
                  ? '작업이 끝나면 여기에 추천이 나옵니다.'
                  : '설정에서 추천이 꺼져 있습니다.'}
            </Text>
          ) : (
            ideas.map((idea, i) => (
              <Box key={`idea:${i}`} flexDirection="row" columnGap="sm">
                <Text color="success">→</Text>
                <Button
                  key={`idea-${i}`}
                  label={idea}
                  plain
                  hotkey={String(i + 1)}
                  onPress={async () => {
                    await $.prompt.fill({ text: idea, mode: 'replace' })
                  }}
                />
              </Box>
            ))
          )}

          {past.length === 0 ? null : (
            <Box key="past-head" marginTop={1}>
              <Text weight="semibold">지난 작업</Text>
            </Box>
          )}
          {past.map(t => (
            <Box key={`turn:${t.id}`} flexDirection="row" alignItems="center" columnGap="sm">
              <Box width={2} flexShrink={0}>
                {t.reason === 'aborted' || t.reason === 'error' ? (
                  <Text color="error">■</Text>
                ) : (
                  <Text dimColor>✓</Text>
                )}
              </Box>
              <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                <Text size="footnote" wrap="truncate-end">
                  {t.text}
                </Text>
              </Box>
              <Box flexShrink={0}>
                <Text dimColor tabular size="caption">
                  {`${clock(t.ms ?? 0)} · ${t.steps.length}단계${t.files > 0 ? ` · 파일 ${t.files}` : ''}`}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>

        <Box key="divider" height={1} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {'─'.repeat(Math.max(10, e.props.bodyColumns))}
          </Text>
        </Box>

        <Box key="files" flexDirection="column" height={filesRows} overflow="hidden">
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap="md">
            <Box flexDirection="row" alignItems="center" columnGap="sm">
              <Text weight="semibold">변경 파일</Text>
              {files.length === 0 ? null : (
                <Text dimColor tabular size="footnote">{`${files.length}개`}</Text>
              )}
              {files.length === 0 ? null : (
                <Text tabular size="footnote" color="success">{`+${sum.added}`}</Text>
              )}
              {files.length === 0 ? null : (
                <Text tabular size="footnote" color="error" dimColor={sum.removed === 0}>
                  {`−${sum.removed}`}
                </Text>
              )}
            </Box>
            {files.length === 0 ? null : (
              <Button
                key="clear"
                label="비우기"
                onPress={async () => {
                  await update($, changed, () => [])
                  await update($, diffs, () => [])
                  await update($, selected, () => null)
                }}
              />
            )}
          </Box>
          {files.length === 0 ? <Text dimColor size="footnote">아직 변경된 파일이 없습니다.</Text> : null}
          {listed.map(f => {
            const isOutside = /^([A-Za-z]:)?\//.test(f.path)
            const slash = f.path.lastIndexOf('/')
            const name = f.path.slice(slash + 1)
            const dir = slash < 0 ? '' : f.path.slice(0, slash + 1)

            return (
              <Box key={f.path} flexDirection="row" alignItems="center" columnGap="sm">
                <Box width={addWidth} flexShrink={0} justifyContent="flex-end">
                  <Text tabular size="footnote" color="success">{`+${f.added}`}</Text>
                </Box>
                <Box width={removeWidth} flexShrink={0} justifyContent="flex-end">
                  <Text tabular size="footnote" color="error" dimColor={f.removed === 0}>
                    {`−${f.removed}`}
                  </Text>
                </Box>
                <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                  <Button
                    key={`open:${f.path}`}
                    label={f.path}
                    plain
                    onPress={async () => {
                      await update($, diffTop, () => 0)
                      await update($, selected, () => f.path)
                    }}
                  >
                    <Text dimColor>{dir}</Text>
                    <Text dimColor={isOutside}>{name}</Text>
                  </Button>
                </Box>
                {f.edits > 1 ? (
                  <Box flexShrink={0}>
                    <Text dimColor size="caption">{`${f.edits}회`}</Text>
                  </Box>
                ) : null}
                {f.isNew ? (
                  <Box flexShrink={0}>
                    <Text color="success" size="caption">
                      새 파일
                    </Text>
                  </Box>
                ) : null}
              </Box>
            )
          })}
          {files.length > listed.length ? (
            <Text dimColor size="caption">{`외 ${files.length - listed.length}개`}</Text>
          ) : null}
        </Box>
      </Box>
    )
  })
}
