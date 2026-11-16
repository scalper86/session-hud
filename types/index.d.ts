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

declare module 'claude-code' {
  interface PluginState {
    'session-hud': { usage: Usage | null; files: Shaped<ChangedFile[]> }
  }
}
