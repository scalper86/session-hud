export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: readonly Limit[]
  cost?: { usd: number }
}

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': { usage: Usage | null }
  }
}
