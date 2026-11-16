import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-hud',
  component: 'Pane',
  requestId: 'work',
  props: {
    title: '작업',
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

    expect((await ui.find({ type: 'Text', text: /^app\.ts$/ }))?.text).toBe('app.ts')
    expect((await ui.find({ type: 'Text', text: /^1개$/ }))?.text).toBe('1개')
    expect((await ui.find({ type: 'Text', text: /^\+/ }))?.text).toBe('+2')

    // 파일을 누르면 diff가 펼쳐지고, 목록으로 돌아올 수 있다.
    await ui.press({ key: 'open:src/app.ts' })
    // diff는 줄마다 블록으로 그린다: 지운 줄 a, 더한 줄 b와 c.
    expect((await ui.find({ type: 'Text', text: /^−$/ }))?.text).toBe('−')
    expect((await ui.find({ type: 'Text', text: /^c\s*$/ }))?.text?.trim()).toBe('c')
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /^c\s*$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the band draws every meter on every surface', async ($, on) => {
  const opened: string[] = []
  const ran: string[] = []
  on('command.run', (_, e) => {
    ran.push(e.command)

    return { text: '' }
  })
  on('command.register', () => ({ value: { command: 'session-hud' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('tool.call', () => ({
    result: {
      filePath: '/repo/a.ts',
      oldString: 'a',
      newString: 'b',
      originalFile: 'a',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
      userModified: false,
      replaceAll: false,
    },
  }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'client' as const } }))
  on('clock.now', () => ({ value: 0 }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })

  await $.session.measure({
    context: USAGE.context,
    rateLimits: USAGE.rateLimits,
    cost: USAGE.cost,
    changed: ['context', 'rateLimits', 'cost'],
  })

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'session-hud',
      surface,
      component: 'AbovePrompt',
      requestId: 'band',
      props: {
        hasSurvey: false,
        isCollapsed: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 100,
        scroll: { offset: 0, bodyRows: 10 },
        view: {},
      },
    })

    expect((await ui.find({ type: 'Text', text: /^85%$/ }))?.text).toBe('85%')
    expect((await ui.find({ type: 'Text', text: /Fable/ }))?.text).toBe('7일(Fable)')
    expect((await ui.find({ type: 'Text', text: /^\$6\.00$/ }))?.text).toBe('$6.00')
    expect((await ui.find({ type: 'Text', text: /예산/ }))?.text).toBe('/ 예산 $5')
    expect((await ui.find({ type: 'Text', text: /^초과$/ }))?.text).toBe('초과')

    // 변경 칩을 누르면 변경 파일 패널이 열린다.
    const before = opened.length
    await ui.press({ key: 'open-files' })
    expect(opened.slice(before)).toContain('work')

    // 컨텍스트 85%: 압축 권장과 확인 버튼이 뜨고, 누르면 /compact가 실행된다.
    // 실행한 권장은 다시 띄우지 않으므로 마지막 화면에서만 누른다.
    expect((await ui.find({ type: 'Text', text: /한 번 압축하세요/ }))?.text).toContain('85%')
    if (surface === 'mobile') {
      await ui.press({ key: 'advice-do-compact' })
      expect(ran).toContain('compact')
      expect(await ui.find({ type: 'Text', text: /한 번 압축하세요/ })).toBeUndefined()
    }
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
  expect(notices.filter(t => t.includes('세션 예산 $5.00을 넘었습니다')).length).toBe(1)
})

test('a long turn that ends raises a notification, a short one does not', { options: { suggestNextSteps: false } }, async ($, on) => {
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

test('the work pane shows the steps of a turn and next-step ideas that fill the prompt', async ($, on) => {
  const filled: string[] = []
  let now = 1000
  on('clock.now', () => ({ value: (now += 500) }))
  on('command.register', () => ({ value: { command: 'session-hud' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'client' as const } }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: '1. 테스트를 실행해 줘\n- 변경 사항을 커밋해 줘',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '테스트 추가해 줘', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.turn.complete({
    answer: '추가했습니다.',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  for (let i = 0; i < 200; i += 1) await Promise.resolve()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /^npm test$/ }))?.text).toBe('npm test')
    expect((await ui.find({ type: 'Text', text: /^✓ 끝남/ }))?.text).toContain('1단계')
    expect(await ui.find({ key: 'idea-0' })).toBeDefined()
    await ui.press({ key: 'idea-1' })
    await ui.unmount()
  }
  expect(filled).toContain('변경 사항을 커밋해 줘')
})
