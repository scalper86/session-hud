export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: readonly Limit[]
  cost?: { usd: number }
}

export type ChangedFile = {
  path: string
  added: number
  removed: number
  edits: number
  isNew: boolean
}

export type FileDiff = { path: string; diff: string }

export type StepStatus = 'run' | 'ok' | 'fail'

export type Step = {
  id: string
  tool: string
  target: string
  startedAt: number
  ms?: number
  status: StepStatus
}

export type Turn = {
  id: string
  text: string
  startedAt: number
  ms?: number
  reason?: string
  paths: string[]
  steps: Step[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-hud': {
      usage: Usage | null
      files: Shaped<ChangedFile[]>
      diffs: Shaped<FileDiff[]>
      selected: string | null
      diffTop: number
      diffMode: 'changes' | 'full'
      fileText: { path: string; text: string } | null
      turns: Shaped<Turn[]>
      openTurns: Shaped<string[]>
      fileFilter: string | null
      suggestions: Shaped<string[]>
      isSuggesting: boolean
      filledIdea: number
      isWrapped: boolean
      dismissed: string
    }
  }
}
