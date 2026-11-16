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
  const read: string[] = []
  on('fs.read', (_, e) => {
    read.push(e.path)

    return { value: 'b\nc\nd\n' }
  })
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
    // 바뀐 줄만 볼 때는 바뀌지 않은 줄 d가 없고, 파일 전체 보기를 누르면 보인다.
    expect(await ui.find({ type: 'Text', text: /^d\s*$/ })).toBeUndefined()
    await ui.press({ key: 'show-whole' })
    // 엔진이 경로를 운영체제 형식으로 바꿔 넘기므로 끝부분으로 비교한다.
    expect(read.some(path => path.replaceAll('\\', '/').endsWith('/repo/src/app.ts'))).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^d\s*$/ }))?.text?.trim()).toBe('d')
    await ui.press({ key: 'show-changes' })
    expect(await ui.find({ type: 'Text', text: /^d\s*$/ })).toBeUndefined()
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
    // 비용·예산 항목은 띠에 그리지 않는다.
    expect(await ui.find({ type: 'Text', text: /API 환산|예산/ })).toBeUndefined()

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

test('a limit past its reset shows 0%, and a session with only tasks still gets a pane button and a reopened pane', async ($, on) => {
  const opened: string[] = []
  const now = Date.parse('2026-11-16T10:00:00Z')
  on('command.register', () => ({ value: { command: 'session-hud' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'client' as const } }))
  on('clock.now', () => ({ value: now }))
  const limits = [
    { kind: 'five_hour', percentUsed: 97, resetsAt: '2026-11-16T09:59:00Z' },
    { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-11-20T00:00:00Z' },
  ]
  on('clock.every', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { ...USAGE, rateLimits: limits } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  await $.turn.start({ text: 'README 바꿔 줘', turnId: 't1' })
  await $.session.measure({
    context: USAGE.context,
    rateLimits: limits,
    cost: USAGE.cost,
    changed: ['context', 'rateLimits', 'cost'],
  })

  // 다시 불러온 뒤(session.start)에도 작업 기록이 있으면 패널을 다시 연다.
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  expect(opened).toContain('work')
  opened.length = 0

  const ui = await $.ui.mount({
    plugin: 'session-hud',
    surface: 'desktop',
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
  // 초기화 시각이 지난 5시간 한도는 0%로, 아직인 7일 한도는 그대로.
  expect(await ui.find({ type: 'Text', text: /^97%$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^0%$/ }))?.text).toBe('0%')
  expect((await ui.find({ type: 'Text', text: /^40%$/ }))?.text).toBe('40%')

  // 바뀐 파일이 없어도 작업이 있으면 패널을 여는 칩이 있다.
  await ui.press({ key: 'open-files' })
  expect(opened).toContain('work')
  await ui.unmount()
})

test('every item is on screen from the start, with placeholders until values arrive', async ($, on) => {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'session-hud' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  // 기록이 없어도 세션이 시작되면 패널이 뜬다.
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  expect(opened).toContain('work')

  const band = await $.ui.mount({
    plugin: 'session-hud',
    surface: 'desktop',
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
  // 값이 없어도 컨텍스트·5시간·7일 막대와 작업 칩이 자리를 지킨다.
  expect(await band.find({ type: 'Text', text: '컨텍스트' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '5시간' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '7일' })).toBeDefined()
  expect((await band.find({ key: 'open-files' }))?.props.label).toBe('작업 0개 · 변경 0개')
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: '지난 작업 0개' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '아직 변경된 파일이 없습니다.' })).toBeDefined()
  await pane.unmount()
})

test('budget, context and limit warnings fire once, and a Fable window gets its own label', { options: { costBudgetUsd: 5 } }, async ($, on) => {
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
  // 추천을 고르면 입력창에 넣지 않고 바로 메시지로 보낸다.
  on('prompt.submit', (_, e) => {
    filled.push(e.text)

    return { text: e.text }
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

    // 큰 틀만 보인다: 상태와 갈래별 개수. 세부 단계는 접혀 있다가 누르면 펼쳐진다.
    expect((await ui.find({ type: 'Text', text: /^✓ 끝남/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^명령 1$/ }))?.text).toBe('명령 1')
    expect(await ui.find({ type: 'Text', text: /^npm test$/ })).toBeUndefined()
    await ui.press({ key: 'toggle:t1' })
    expect((await ui.find({ type: 'Text', text: /^npm test$/ }))?.text).toBe('npm test')
    await ui.press({ key: 'toggle:t1' })
    expect(await ui.find({ key: 'idea-0' })).toBeDefined()
    await ui.press({ key: 'idea-1' })
    await ui.unmount()
  }
  expect(filled).toContain('변경 사항을 커밋해 줘')
})

// 병렬 처리: 한 요청 안에서 도구 여러 개가 동시에 돌 때.
test('parallel tool calls show as running together, then fold into one summary', { options: { suggestNextSteps: false } }, async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let now = 0
  on('clock.now', () => ({ value: (now += 100) }))
  on('command.register', () => ({ value: { command: 'session-hud' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'client' as const } }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // 모든 도구가 gate가 열릴 때까지 끝나지 않는다: 셋이 동시에 실행 중인 상태를 만든다.
  on('tool.call', async () => {
    await gate

    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '테스트와 빌드를 같이 돌려 줘', turnId: 'p1' })
  const calls = [
    $.tool.call({ tool: 'Bash', command: 'npm test' }),
    $.tool.call({ tool: 'Bash', command: 'npm run build' }),
    $.tool.call({ tool: 'Grep', pattern: 'TODO' }),
    // 하위 에이전트 안의 호출은 메인 작업 목록에 넣지 않는다.
    $.tool.call({ tool: 'Bash', command: 'echo sub', agentId: 'a1' }),
  ]
  for (let i = 0; i < 200; i += 1) await Promise.resolve()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // 접혀 있어도 지금 도는 단계는 보이고, 동시에 몇 개 도는지 알려 준다.
    expect((await ui.find({ type: 'Text', text: /동시 실행 중/ }))?.text).toBe('● 3개 동시 실행 중')
    expect((await ui.find({ type: 'Text', text: /^npm test$/ }))?.text).toBe('npm test')
    expect((await ui.find({ type: 'Text', text: /^npm run build$/ }))?.text).toBe('npm run build')
    expect((await ui.find({ type: 'Text', text: /^TODO$/ }))?.text).toBe('TODO')
    expect(await ui.find({ type: 'Text', text: /^echo sub$/ })).toBeUndefined()
    await ui.unmount()
  }

  release()
  await Promise.all(calls)
  await $.turn.complete({ answer: '둘 다 통과했습니다.', durationMs: 4200, isAborted: false, turnId: 'p1', reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // 끝나면 큰 틀만: 상태 한 줄과 갈래별 개수. 실행 중 표시는 사라진다.
    expect((await ui.find({ type: 'Text', text: /^✓ 끝남/ }))?.text).toBe('✓ 끝남 · 4초')
    expect((await ui.find({ type: 'Text', text: /^명령 2/ }))?.text).toBe('명령 2 · 검색 1')
    expect(await ui.find({ type: 'Text', text: /동시 실행 중/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^npm test$/ })).toBeUndefined()
    await ui.unmount()
  }
})

// 지난 작업을 누르면 그 작업에서 바꾼 파일만 보여 준다.
test('pressing a past task narrows the file list to the files it changed', { options: { suggestNextSteps: false } }, async ($, on) => {
  let now = 0
  on('clock.now', () => ({ value: (now += 100) }))
  on('command.register', () => ({ value: { command: 'session-hud' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'client' as const } }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) => {
    const filePath = (e as { file_path?: string }).file_path ?? '/repo/x.ts'

    return {
      result: {
        filePath,
        oldString: 'a',
        newString: 'b',
        originalFile: 'a',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
        userModified: false,
        replaceAll: false,
      },
    }
  })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const edit = (file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })

  await $.turn.start({ text: '로그인 고쳐 줘', turnId: 'f1' })
  await edit('/repo/src/login.ts')
  await $.turn.complete({ answer: '고쳤습니다.', durationMs: 1000, isAborted: false, turnId: 'f1', reason: 'answer' })
  await $.turn.start({ text: '헤더 정리해 줘', turnId: 'f2' })
  await edit('/repo/src/header.tsx')
  await $.turn.complete({ answer: '정리했습니다.', durationMs: 1000, isAborted: false, turnId: 'f2', reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ key: 'open:src/login.ts' })).toBeDefined()
    expect(await ui.find({ key: 'open:src/header.tsx' })).toBeDefined()

    // 작업마다 번호가 붙고, 파일을 바꾼 작업은 작업명이 누를 수 있는 버튼이 된다.
    // 그 아래에는 변경 안내(파일 수와 줄 수)가 글자로 붙는다.
    expect((await ui.find({ type: 'Text', text: /^#1$/ }))?.text).toBe('#1')
    expect((await ui.find({ key: 'files-of:f1' }))?.props.label).toBe('로그인 고쳐 줘')
    expect((await ui.find({ type: 'Text', text: /^파일 1개/ }))?.text).toBe('파일 1개 +1 −1')

    await ui.press({ key: 'files-of:f1' })
    expect((await ui.find({ type: 'Text', text: /바꾼 파일$/ }))?.text).toBe('#1 작업에서 바꾼 파일')
    expect((await ui.find({ type: 'Text', text: /^✓ 파일/ }))?.text).toBe('✓ 파일 1개 +1 −1')
    expect(await ui.find({ key: 'open:src/login.ts' })).toBeDefined()
    expect(await ui.find({ key: 'open:src/header.tsx' })).toBeUndefined()

    await ui.press({ key: 'files-all' })
    expect(await ui.find({ key: 'open:src/header.tsx' })).toBeDefined()
    await ui.unmount()
  }
})

// 지난 작업은 최근 3개만 보이고, 나머지는 접어 둔다.
test('only the three latest past tasks show until the rest are unfolded', { options: { suggestNextSteps: false } }, async ($, on) => {
  let now = 0
  on('clock.now', () => ({ value: (now += 100) }))
  on('command.register', () => ({ value: { command: 'session-hud' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'client' as const } }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  for (let i = 1; i <= 6; i += 1) {
    await $.turn.start({ text: `요청 ${i}번`, turnId: `t${i}` })
    await $.turn.complete({ answer: '됐습니다.', durationMs: 1000, isAborted: false, turnId: `t${i}`, reason: 'answer' })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // 마지막 작업 #6, 지난 작업 5개 중 최근 3개(#5, #4, #3)만 보인다.
    expect((await ui.find({ type: 'Text', text: /^지난 작업/ }))?.text).toBe('지난 작업 5개')
    for (const i of [6, 5, 4, 3]) expect(await ui.find({ type: 'Text', text: `요청 ${i}번` })).toBeDefined()
    for (const i of [2, 1]) expect(await ui.find({ type: 'Text', text: `요청 ${i}번` })).toBeUndefined()
    expect((await ui.find({ key: 'past-more' }))?.props.label).toBe('▸ 이전 작업 2개 더 보기')

    await ui.press({ key: 'past-more' })
    for (const i of [2, 1]) expect(await ui.find({ type: 'Text', text: `요청 ${i}번` })).toBeDefined()
    expect((await ui.find({ key: 'past-more' }))?.props.label).toBe('▾ 이전 작업 접기')

    await ui.press({ key: 'past-more' })
    expect(await ui.find({ type: 'Text', text: '요청 1번' })).toBeUndefined()
    await ui.unmount()
  }
})
