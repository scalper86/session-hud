import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-hud',
  component: 'Pane',
  requestId: 'changed-files',
  props: {
    title: '변경 파일',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const USAGE = {
  startedAt: 0,
  context: { tokens: 170000, window: 200000, percent: 85 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 42 },
    { kind: 'seven_day_fable', percentUsed: 91 },
  ],
  cost: { usd: 6 },
}

test('an edit lands in the changed-files pane, on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'session-hud' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'client' as const } }))
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({
    result: {
      filePath: '/repo/src/app.ts',
      oldString: 'a',
      newString: 'b',
      originalFile: 'a',
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] },
      ],
      userModified: false,
      replaceAll: false,
    },
  }))

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/src/app.ts',
    old_string: 'a',
    new_string: 'b',
  })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /app\.ts/ }))?.text).toBe('src/app.ts')
    expect((await ui.find({ type: 'Text', text: /^파일/ }))?.text).toBe('파일 1개')
    expect((await ui.find({ type: 'Text', text: /^\+/ }))?.text).toBe('+2')
    await ui.unmount()
  }
})

test('budget, context and limit warnings fire once, and a Fable window gets its own label', async ($, on) => {
  const toasts: string[] = []
  const notices: string[] = []
  on('command.register', () => ({ value: { command: 'session-hud' } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    notices.push(e.text)

    return { value: { isSent: true, channel: 'client' as const } }
  })
  on('clock.now', () => ({ value: 0 }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({ context: USAGE.context, rateLimits: USAGE.rateLimits, cost: USAGE.cost, changed: ['cost'] })
  await $.session.measure({ context: USAGE.context, rateLimits: USAGE.rateLimits, cost: USAGE.cost, changed: ['cost'] })

  expect(toasts.filter(t => t.includes('7일(Fable) 한도 91%')).length).toBe(1)
  expect(toasts.filter(t => t.includes('컨텍스트 85%')).length).toBe(1)
  expect(notices.filter(t => t.includes('세션 예산 $5.00을 넘었습니다')).length).toBe(1)
})

test('a long turn that ends raises a notification, a short one does not', async ($, on) => {
  const notices: string[] = []
  on('ui.notify', (_, e) => {
    notices.push(e.text)

    return { value: { isSent: true, channel: 'client' as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.turn.complete({
    answer: 'ok',
    durationMs: 5000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await $.turn.complete({
    answer: 'ok',
    durationMs: 133000,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
  })
  // 알림은 기다리지 않고 보내므로 한 박자 쉰다.
  await Promise.resolve()
  await Promise.resolve()

  expect(notices.length).toBe(1)
  expect(notices[0]).toContain('작업이 끝났습니다 (2분 13초)')
})
