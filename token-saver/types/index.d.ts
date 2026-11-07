export type Limit = { label: string; percent: number; resetsAt?: number }
export type Snap = { tokens: number | null; limits: Limit[] }

export type Settings = {
  effort: 'cap' | 'free'
  routine: 'off' | 'sonnet' | 'haiku'
  compactAt: number
  subagent: 'inherit' | 'haiku' | 'sonnet' | 'opus'
  forkGuard: boolean
  notes: boolean
}

export type Stats = { compacts: number; switches: number; denied: number }

declare module 'claude-code' {
  interface PluginState {
    'token-saver': {
      usage: Snap
      isCompacting: boolean
      settings: Settings | null
      isMenuOpen: boolean
      isBoosted: boolean
      stats: Stats
    }
  }
}
