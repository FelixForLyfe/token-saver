import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, PluginOptions, Register, SessionRateLimit } from 'claude-code'

import type { Settings, Snap, Stats } from '../types'

const usageAtom = atom({ plugin: 'token-saver', key: 'usage' } as const, { tokens: null, limits: [] } as Snap)
const compactingAtom = atom({ plugin: 'token-saver', key: 'isCompacting' } as const, false)
const settingsAtom = atom({ plugin: 'token-saver', key: 'settings' } as const, null as Settings | null)
const menuAtom = atom({ plugin: 'token-saver', key: 'isMenuOpen' } as const, false)
const statsAtom = atom({ plugin: 'token-saver', key: 'stats' } as const, { compacts: 0, switches: 0, denied: 0 } as Stats)
const PANE = 'token-saver-usage'
const boostAtom = atom({ plugin: 'token-saver', key: 'isBoosted' } as const, false)

const DAY_MS = 24 * 60 * 60 * 1000
const EFFORT_ORDER: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
const NOTES_MARK = '## Standing notes'

const COMPACT_INSTRUCTIONS = [
  'Keep what the work still needs and drop the rest:',
  'the current task and exactly where it stands, open TODOs, decisions made and why,',
  'every file path touched or still to touch, commands that worked and errors still unresolved,',
  "and the person's stated preferences. Leave out finished side threads and raw tool output.",
].join(' ')

// Module variables start over on a reload; the live settings come back from $.store.
const run = { lastCompactAt: 0, isCompacting: false }
const base = {
  settings: { effort: 'cap', routine: 'sonnet', compactAt: 150000, subagent: 'sonnet', forkGuard: true, notes: true } as Settings,
  effortCap: 'high',
  exploreModel: 'haiku',
  forkGuardTokens: 100000,
  notesDir: 'D:/Claude/token-saver-notes',
}

function numberOption(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function textOption(options: PluginOptions, key: string, fallback: string): string {
  const value = options[key]
  return typeof value === 'string' ? value : fallback
}

function capEffort<T extends string | number | undefined>(effort: T, cap: string): T | string {
  if (typeof effort !== 'string') return effort
  const at = EFFORT_ORDER.indexOf(effort)
  const limit = EFFORT_ORDER.indexOf(cap)
  return limit >= 0 && at > limit ? cap : effort
}

function thousands(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`
}

function cycle<T>(list: readonly T[], value: T): T {
  const at = list.indexOf(value)
  return list[(at + 1) % list.length] as T
}

function limitLabel(kind: string): string {
  const name = kind.toLowerCase()
  if (name.includes('five') || name.includes('5h')) return '5h'
  if (name.includes('seven') || name.includes('7d') || name.includes('week')) return '7d'
  return name.replace(/_/g, ' ')
}

function countdown(ms: number): string {
  const minutes = Math.ceil(ms / 60_000)
  if (minutes <= 0) return 'now'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d${hours}h`
  return hours > 0 ? `${hours}h${String(minutes % 60).padStart(2, '0')}` : `${minutes}m`
}

function cells(fraction: number): string {
  const on = Math.max(0, Math.min(5, Math.round(fraction * 5)))
  return '▰'.repeat(on) + '▱'.repeat(5 - on)
}

function tone(fraction: number): 'success' | 'warning' | 'error' {
  return fraction >= 0.95 ? 'error' : fraction >= 0.8 ? 'warning' : 'success'
}

function compactLabel(tokens: number): string {
  return tokens <= 0 ? 'off' : thousands(tokens)
}

// $-taking helpers live at the top level: the validator follows $ only into
// functions declared here.
async function contextTokens($: Engine): Promise<number | undefined> {
  const { context } = await $.session.usage()
  return context.tokens
}

// The live settings: the menu's choices, remembered across sessions, over the plugin options.
async function current($: Engine): Promise<Settings> {
  const live = await read($, settingsAtom)
  if (live !== null) return live as unknown as Settings
  const stored = (await $.store.get('settings')) as Partial<Settings> | null | undefined
  const merged = { ...base.settings, ...(stored !== null && typeof stored === 'object' ? stored : {}) }
  await update($, settingsAtom, () => merged)
  return merged
}

async function change($: Engine, patch: Partial<Settings>): Promise<void> {
  const next = { ...(await current($)), ...patch }
  await update($, settingsAtom, () => next)
  await $.store.set('settings', next)
}

async function refreshUsage($: Engine): Promise<void> {
  const usage = await $.session.usage()
  const snap: Snap = {
    tokens: usage.context.tokens ?? null,
    limits: usage.rateLimits.map(limit => {
      const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
      return { label: limitLabel(limit.kind), percent: Math.round(limit.percentUsed), ...(Number.isNaN(resetsAt) ? {} : { resetsAt }) }
    }),
  }
  if (JSON.stringify(snap) === JSON.stringify(await read($, usageAtom))) return
  await update($, usageAtom, () => snap)
}

async function notesPath($: Engine): Promise<string> {
  const id = String(await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '')
  return `${base.notesDir.replace(/[\\/]+$/, '')}/${id}.md`
}

// The usage report as lines of text: the transcript (/saver) and the settings panel share it.
function reportLines(snap: Snap, live: Settings, stats: Stats, now: number): string[] {
  const limit = live.compactAt > 0 ? live.compactAt : 200000
  const line = (name: string, fraction: number, detail: string) => {
    const filled = Math.max(0, Math.min(20, Math.round(fraction * 20)))
    const pct = `${Math.round(fraction * 100)}%`.padStart(4)
    return `${name.padEnd(8)} ${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}  ${detail}`
  }
  const names: Record<string, string> = { '5h': '5-hour', '7d': 'Week' }
  return [
    ...(snap.tokens === null ? [] : [line('Context', snap.tokens / limit, `${thousands(snap.tokens)} of ${thousands(limit)}${live.compactAt > 0 ? ', auto-compacts there' : ', auto-compact off'}`)]),
    ...snap.limits.map(item => line(names[item.label] ?? item.label, item.percent / 100, item.resetsAt === undefined ? '' : `resets in ${countdown(item.resetsAt - now)}`)),
    `Saved this session: ${stats.compacts} compacts, ${stats.switches} steps on ${live.routine === 'off' ? 'the main model' : live.routine}, ${stats.denied} forks refused`,
  ]
}

async function usageText($: Engine): Promise<string> {
  await refreshUsage($)
  const snap = await read($, usageAtom)
  const live = await current($)
  const stats = (await read($, statsAtom)) as unknown as Stats
  return ['Usage', ...reportLines(snap, live, stats, await $.clock.now())].join('\n')
}

async function bump($: Engine, key: keyof Stats) {
  await update($, statsAtom, v => ({ ...(v as unknown as Stats), [key]: (v as unknown as Stats)[key] + 1 }))
}

async function compact($: Engine) {
  try {
    const done = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
    if (done.skip !== undefined) $.ui.toast(`token-saver: compact skipped (${done.skip})`)
    else {
      $.ui.toast('token-saver: compacted the conversation to save tokens')
      await bump($, 'compacts')
    }
  } catch {
    // A headless session (the desktop app's Code tab, the SDK) compacts only
    // inside a turn, so it gets the person's own /compact, queued until idle.
    try {
      await $.command.run({ command: 'compact', args: COMPACT_INSTRUCTIONS })
    } catch (error) {
      $.ui.toast(`token-saver: could not compact, type /compact (${String(error)})`)
    }
  } finally {
    run.lastCompactAt = await $.clock.now()
    run.isCompacting = false
    await update($, compactingAtom, () => false)
    await refreshUsage($)
  }
}

// Saves the summary of a compaction into the session's notes file, above the
// standing notes Claude keeps there, so the summary survives even a second compaction.
async function saveNotes($: Engine, summary: string): Promise<void> {
  const path = await notesPath($)
  const old = await $.fs.read(path).catch(() => '')
  const text = typeof old === 'string' ? old : ''
  const at = text.indexOf(NOTES_MARK)
  const standing = at >= 0 ? text.slice(at) : `${NOTES_MARK}\n(Claude: one short line per lasting rule, preference or decision.)\n`
  const stamp = new Date(await $.clock.now()).toISOString()
  const head = `# token-saver notes\n\n## Last compaction summary (${stamp})\n\n${summary.slice(0, 12000)}\n\n`
  await $.fs.write(path, head + standing)
}

// One line, once per step of the weekly limit, remembered across sessions.
async function paceNote($: Engine, limits: readonly SessionRateLimit[], step: number) {
  const week = limits.find(limit => limit.kind === 'seven_day')
  if (week === undefined || week.resetsAt === undefined) return
  const resetAt = Date.parse(week.resetsAt)
  if (Number.isNaN(resetAt)) return

  const bucket = Math.floor(week.percentUsed / step)
  const key = `pace:${Math.round(resetAt / (7 * DAY_MS))}`
  const seen = Number((await $.store.get(key)) ?? -1)
  if (bucket <= seen) return
  await $.store.set(key, bucket)
  if (bucket === 0) return

  const now = await $.clock.now()
  const elapsedDays = Math.min(7, Math.max(0, (now - (resetAt - 7 * DAY_MS)) / DAY_MS))
  const evenPace = Math.round((elapsedDays / 7) * 100)
  const daysLeft = Math.max(7 - elapsedDays, 0.25)
  const perDay = Math.max(0, Math.round((100 - week.percentUsed) / daysLeft))
  const day = Math.min(7, Math.floor(elapsedDays) + 1)
  const verdict =
    week.percentUsed > evenPace + 5
      ? `running fast, about ${perDay}% a day left to last until reset`
      : `on pace, about ${perDay}% a day available`

  $.ui.toast(`token-saver pace: weekly ${week.percentUsed}% used, day ${day} of 7 (even pace ${evenPace}%): ${verdict}`)
}

export const register: Register = (on, options) => {
  const cooldownMs = numberOption(options, 'compactCooldownMinutes', 10) * 60_000
  const paceStep = numberOption(options, 'paceStepPercent', 5)
  const showBar = options.showBar !== false

  base.effortCap = textOption(options, 'effortCap', 'high')
  base.exploreModel = textOption(options, 'exploreModel', 'haiku')
  base.forkGuardTokens = numberOption(options, 'forkGuardTokens', 100000)
  base.notesDir = textOption(options, 'notesDir', 'D:/Claude/token-saver-notes')
  const routine = textOption(options, 'routineModel', 'sonnet')
  const subagent = textOption(options, 'subagentModel', 'sonnet')
  base.settings = {
    effort: base.effortCap === 'max' ? 'free' : 'cap',
    routine: routine === 'off' || routine === 'haiku' ? routine : 'sonnet',
    compactAt: numberOption(options, 'compactAtTokens', 150000),
    subagent: subagent === 'inherit' || subagent === 'haiku' || subagent === 'opus' ? subagent : 'sonnet',
    forkGuard: base.forkGuardTokens > 0,
    notes: options.notesDefault !== false,
  }

  // 1. Keep context small: compact once a finished turn leaves it over the limit.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      if (showBar) await refreshUsage($)
      if (await read($, boostAtom)) await update($, boostAtom, () => false)
    }
    if (e.agentId !== undefined || e.isAborted || run.isCompacting) return done

    const { compactAt } = await current($)
    if (compactAt <= 0) return done
    const tokens = await contextTokens($)
    const now = await $.clock.now()
    if (tokens === undefined || tokens < compactAt || now - run.lastCompactAt < cooldownMs) return done

    run.isCompacting = true
    // session.compact rejects while a turn runs; this fires once it has ended.
    $.clock.after(300, () => void compact($))
    return done
  })

  // After any compaction of the main conversation, keep its summary in the notes file.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || done.skip !== undefined) return done
    if (!(await current($)).notes) return done
    const summary = done.messages.find(message => message.role === 'user' && message.text.trim() !== '')
    if (summary !== undefined) await saveNotes($, summary.text).catch(() => undefined)
    return done
  })

  // The notes file in the system prompt: a stable line, read after a compaction, kept up as rules appear.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!(await current($)).notes) return result
    const path = await notesPath($)
    const text =
      `token-saver notes file: ${path}. After a context compaction, read it before continuing (it holds the last summary and the standing notes). ` +
      `When the person states a lasting rule or preference, or a real decision is made, add one short line under "${NOTES_MARK}" in that file (create it if missing). Keep it short.`
    return { sections: [...result.sections, { id: 'token-saver:notes', text, scope: 'session' as const }] }
  })

  // 3 and 4. Cheaper model for steps that follow a tool result, and a cap on effort.
  // A boost for one turn keeps Opus and lifts the cap.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    const live = await current($)
    const isBoosted = await read($, boostAtom)
    const isRoutine = !isBoosted && e.index > 0 && live.routine !== 'off' && /opus/i.test(e.model)
    const model = isRoutine ? live.routine : e.model
    if (isRoutine) await bump($, 'switches')
    const effort = isBoosted || live.effort === 'free' ? e.effort : capEffort(e.effort, base.effortCap)
    return yield* next({ ...e, model, ...(effort !== e.effort ? { effort: effort as typeof e.effort } : {}) })
  })

  // 5. Subagents: a cheaper model by default, and no fork of a big conversation.
  on('agent.spawn', async ($, e, next) => {
    if (e.resume !== undefined || e.isTeammate === true) return next(e)
    const live = await current($)

    if (e.fork) {
      if (!live.forkGuard || e.parentAgentId !== undefined) return next(e)
      const tokens = await contextTokens($)
      if (tokens === undefined || tokens < base.forkGuardTokens) return next(e)
      await bump($, 'denied')
      return {
        deny:
          `token-saver: a fork would copy about ${thousands(tokens)} tokens of this conversation into the subagent. ` +
          'Start a fresh subagent instead (give it a subagent_type) with a short self-contained prompt: the goal, ' +
          'the file paths it needs, and what it should report back.',
      }
    }

    if (e.model !== undefined) return next(e)
    const model = e.subagentType === 'Explore' ? base.exploreModel : live.subagent
    return model === 'inherit' ? next(e) : next({ ...e, model })
  }).catch(($, e, next) => next(e))

  // 6. A hand note on pacing whenever weekly usage passes another step.
  on('session.measure', async ($, e, next) => {
    const done = await next(e)
    if (showBar) await refreshUsage($)
    if (paceStep > 0 && e.changed.includes('rateLimits')) await paceNote($, e.rateLimits, paceStep)
    return done
  })

  // The bar: one compact row above the prompt; the gear opens a bordered
  // settings panel where every option is shown and the active one is lit.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!showBar || e.props.hasSurvey) return next(e)
    const snap = await read($, usageAtom)
    const live = await current($)
    const isOpen = await read($, menuAtom)
    const isBoosted = await read($, boostAtom)
    const isCompacting = await read($, compactingAtom)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const limit = live.compactAt > 0 ? live.compactAt : 200000
    const ctx = snap.tokens === null ? 0 : snap.tokens / limit
    const theirs = await next(e)

    const press = () => {
      void update($, compactingAtom, () => true)
      $.clock.after(1, () => {
        run.isCompacting = true
        return compact($)
      })
    }
    const set = (patch: Partial<Settings>) => () => void change($, patch)

    const choice = (id: string, label: string, isActive: boolean, onPress: () => void) => (
      <Button key={id} plain onPress={onPress}>
        {isActive ? (
          <Text bold color="suggestion">{`[● ${label}]`}</Text>
        ) : (
          <Text dimColor>{`[  ${label}]`}</Text>
        )}
      </Button>
    )
    const row = (id: string, title: string, hint: string, choices: JSX.Element[]) => (
      <Box key={id} flexDirection="row" columnGap={1}>
        <Box width={15}><Text bold>{title}</Text></Box>
        {choices}
        <Text dimColor>  {hint}</Text>
      </Box>
    )
    const names: Record<string, string> = { '5h': '5-hour', '7d': 'Week' }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          {snap.tokens === null ? '' : (
            <Text>
              <Text dimColor>Context </Text>
              <Text color={tone(ctx)}>{cells(ctx)}</Text> {thousands(snap.tokens)}
              <Text dimColor> / {live.compactAt > 0 ? thousands(live.compactAt) : 'no limit'}</Text>
            </Text>
          )}
          {snap.limits.map(item => (
            <Text key={item.label}>
              <Text dimColor>{names[item.label] ?? item.label} </Text>
              <Text color={tone(item.percent / 100)}>{cells(item.percent / 100)}</Text> {item.percent}%
              <Text dimColor>{item.resetsAt === undefined ? '' : `  resets in ${countdown(item.resetsAt - now)}`}</Text>
            </Text>
          ))}
          {isCompacting || e.props.isWorking ? '' : (
            <Button key="compact" plain onPress={press}>
              <Text inverse={ctx >= 0.7} color={ctx >= 0.7 ? 'warning' : undefined} dimColor={ctx < 0.7}>{' Compact '}</Text>
            </Button>
          )}
          {isCompacting ? <Text color="warning">Compacting…</Text> : ''}
          <Button key="menu" plain onPress={() => void update($, menuAtom, v => !v)}>
            <Text inverse={isOpen} dimColor={!isOpen}>{isOpen ? ' ⚙ Settings ▴ ' : ' ⚙ Settings '}</Text>
          </Button>
        </Box>
        {isOpen ? (
          <Box flexDirection="column" paddingX={1}>
            <Box flexDirection="row" columnGap={2}>
              <Text bold color="suggestion">Token saver</Text>
              <Text dimColor>{reportLines(snap, live, (await read($, statsAtom)) as unknown as Stats, now).filter(text => text.startsWith('Saved')).join('')}</Text>
            </Box>
            {row('effort', 'Effort', 'capped keeps /effort from going above the cap', [
              choice('effort-cap', `Capped (${base.effortCap})`, live.effort === 'cap', set({ effort: 'cap' })),
              choice('effort-free', 'Free', live.effort === 'free', set({ effort: 'free' }))
            ])}
            {row('boost', 'Boost', 'next turn only: Opus and full effort', [
              choice('boost-off', 'Off', !isBoosted, () => void update($, boostAtom, () => false)),
              choice('boost-on', 'On', isBoosted, () => void update($, boostAtom, () => true))
            ])}
            {row('routine', 'Routine steps', 'model for simple follow-up steps', [
              choice('routine-sonnet', 'Sonnet', live.routine === 'sonnet', set({ routine: 'sonnet' })),
              choice('routine-haiku', 'Haiku', live.routine === 'haiku', set({ routine: 'haiku' })),
              choice('routine-off', 'Off', live.routine === 'off', set({ routine: 'off' }))
            ])}
            {row('compactAt', 'Auto-compact', 'when the context reaches', [100000, 150000, 200000, 0].map(n =>
              choice(`compact-${n}`, compactLabel(n), live.compactAt === n, set({ compactAt: n }))
            ))}
            {row('subagent', 'Subagents', 'default model they run on', (['sonnet', 'haiku', 'opus', 'inherit'] as const).map(m =>
              choice(`sub-${m}`, m, live.subagent === m, set({ subagent: m }))
            ))}
            {row('forkGuard', 'Fork guard', '', [
              choice('fork-on', 'On', live.forkGuard, set({ forkGuard: true })),
              choice('fork-off', 'Off', !live.forkGuard, set({ forkGuard: false })),
              <Text key="notes-title" bold>  Notes file</Text>,
              choice('notes-on', 'On', live.notes, set({ notes: true })),
              choice('notes-off', 'Off', !live.notes, set({ notes: false }))
            ])}
          </Box>
        ) : (
          ''
        )}
        {theirs}
      </Box>
    )
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'saver', description: 'Usage and token-saver panel' })
    return next(e)
  })

  // /saver opens the panel; /usage opens it too, beside the built-in screen.
  on('command.run', { command: 'saver' }, async $ => ({ text: await usageText($) }))
  on('command.run', { command: 'usage' }, async ($, e, next) => {
    const text = await usageText($)
    const builtin = await next(e)
    return { ...builtin, text: builtin.text === undefined ? text : [text, builtin.text].join('\n\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, usageAtom)
    const live = await current($)
    const stats = (await read($, statsAtom)) as unknown as Stats
    const now = await $.clock.now()
    const limit = live.compactAt > 0 ? live.compactAt : 200000
    const bar = (fraction: number) => {
      const filled = Math.max(0, Math.min(24, Math.round(fraction * 24)))
      return '█'.repeat(filled) + '░'.repeat(24 - filled)
    }
    const meter = (name: string, fraction: number, detail: string, hint: string) => (
      <Box key={name} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" columnGap={2}>
          <Box width={9}><Text bold>{name}</Text></Box>
          <Text color={tone(fraction)}>{bar(fraction)}</Text>
          <Text bold>{Math.round(fraction * 100)}%</Text>
        </Box>
        <Text dimColor>{`${detail}${hint === '' ? '' : '  ·  ' + hint}`}</Text>
      </Box>
    )
    const names: Record<string, string> = { '5h': '5-hour', '7d': 'Week' }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="suggestion">Usage</Text>
        <Text> </Text>
        {snap.tokens === null ? '' : meter('Context', snap.tokens / limit, `${thousands(snap.tokens)} of ${live.compactAt > 0 ? thousands(live.compactAt) : '200k'} tokens`, live.compactAt > 0 ? `auto-compacts at ${thousands(live.compactAt)}` : 'auto-compact off')}
        {snap.limits.length === 0 ? <Text dimColor>No usage limits reported for this account.</Text> : ''}
        {snap.limits.map(item =>
          meter(names[item.label] ?? item.label, item.percent / 100, `${item.percent}% used`, item.resetsAt === undefined ? '' : `resets in ${countdown(item.resetsAt - now)}`)
        )}
        <Text bold color="suggestion">Saved this session</Text>
        <Text>{`${stats.compacts} compacts  ·  ${stats.switches} steps moved to ${live.routine === 'off' ? 'routine model (off)' : live.routine}  ·  ${stats.denied} forks refused`}</Text>
        <Text> </Text>
        <Text dimColor>Open Settings from the bar to change these.</Text>
      </Box>
    )
  })
}
