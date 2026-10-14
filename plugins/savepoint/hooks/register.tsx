import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { SavepointTurn, SavepointWork } from '../types'

// SAVEPOINT: checkpoint each finished step, then reset the context to that save.
// A reset is a compaction this mod answers itself (no summary model call): the
// conversation becomes one message, the progress file's tail. Safeguards, all
// checked by canReset() and again inside the compaction hook:
//   1 a person asks (band button or /savepoint reset); auto-compact is untouched
//   2 the progress file exists, has content, and was saved within freshMin
//   3 no Edit/Write/NotebookEdit/Bash/Agent finished after that save
//   4 nothing in flight (turn, tool call, subagent)
//   5 the last reply ended with the step-done line (`force` waives this one only)
//   6 the full conversation is archived to a file before it is replaced


const stepDone = atom({ plugin: 'savepoint', key: 'stepDone' } as const, false)
const work = atom({ plugin: 'savepoint', key: 'work' } as const, { inFlight: 0, lastWorkAt: 0 } as SavepointWork)
const isHidden = atom({ plugin: 'savepoint', key: 'isHidden' } as const, false)
const isResetting = atom({ plugin: 'savepoint', key: 'isResetting' } as const, false)
const archivePath = atom({ plugin: 'savepoint', key: 'archivePath' } as const, '')
const litAt = atom({ plugin: 'savepoint', key: 'litAt' } as const, 0)
// Turns in flight, by id. The band also checks the engine's isWorking, but that prop can
// lag an async draw; reading this atom while drawing redraws the band the moment a turn starts.
const turns = atom({ plugin: 'savepoint', key: 'turns' } as const, [] as SavepointTurn[])

// The bonfire. Every row is 11 columns, centered on column 5 over the logs.
type Blaze = 'embers' | 'steady' | 'tall' | 'roaring'
const LOGS = '  _/\\_/\\_  '
const FIRE: Record<Blaze, string[]> = {
  embers: ['           ', '           ', '     .     ', '   . \' .   ', LOGS],
  steady: ['           ', '     (     ', '    ) )    ', '   ( ( )   ', LOGS],
  tall: ['     )     ', '    ( (    ', '   ) ) (   ', '  ( ( ) )  ', LOGS],
  roaring: ['   ) ( )   ', '  ( ) ( (  ', ' ) ( ) ) ( ', ' ( ( ) ( ) ', LOGS],
}
// Tip to base; the last is the logs.
const HEAT: Record<Blaze, string[]> = {
  embers: ['#555555', '#555555', '#ff7a33', '#c2410c', '#6b4423'],
  steady: ['#fff3a0', '#ffe066', '#ffb703', '#fb8500', '#8b5a2b'],
  tall: ['#ffe066', '#ffb703', '#fb8500', '#f3722c', '#8b5a2b'],
  roaring: ['#ffb703', '#fb8500', '#f94144', '#d00000', '#8b5a2b'],
}
const LORE: Record<Blaze, string> = {
  embers: 'rested. the thread picks up where you left it.',
  steady: 'the fire burns steady.',
  tall: 'the fire grows tall. rest soon.',
  roaring: 'THE FIRE ROARS. rest now or lose the thread.',
}
const LIT_MS = 3 * 60_000
const mirror = (row: string) => row.replace(/[()]/g, c => (c === '(' ? ')' : '('))
const blaze = (k: number, o: { wrapK: number; hardK: number }): Blaze =>
  k >= o.hardK ? 'roaring' : k >= o.wrapK ? 'tall' : 'steady'
const fireText = (b: Blaze) => FIRE[b].join('\n')

const DONE_MARK = /✓ step done/
const WORK_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'Agent'])
const MIN_SAVE_BYTES = 200
const RESET_TOKEN = 'savepoint reset'
const ARM_MS = 60_000
const SUBMIT_DELAY_MS = 50
// A turn whose turn.complete never arrived stops hiding the band after this long.
const STALE_TURN_MS = 30 * 60_000

type $ = EngineInterface
type Verdict = { ok: true; ageMin: number } | { ok: false; why: string; fix: string; canSave: boolean }

type Opts = { progressDir: string; switchK: number; wrapK: number; hardK: number; freshMin: number; restoreChars: number; guard: boolean; restoreOnClear: boolean; who: string }

// One save file per session, `<dir-slug>.<session>.md`, so two chats in one directory never
// overwrite (or reset to) each other's save. `<dir-slug>.md` is a copy of the newest save from
// any session there: what a fresh session reads on boot, never what a reset trusts.
async function dirBase($: $, o: Opts) {
  const home = (await $.env.get('HOME')) ?? ''
  const dir = o.progressDir.replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')
  return `${dir}/${(await $.session.cwd()).replace(/[^A-Za-z0-9]+/g, '-')}`
}

async function progressPath($: $, o: Opts, sessionId?: string) {
  const id = sessionId ?? (await $.session.id())
  return `${await dirBase($, o)}.${id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}.md`
}

async function latestPath($: $, o: Opts) {
  return `${await dirBase($, o)}.md`
}

async function contextK($: $, o: Opts) {
  const { context } = await $.session.usage()
  return context.tokens === undefined ? undefined : Math.floor(context.tokens / 1000)
}

async function statSave($: $, o: Opts) {
  try {
    return await $.fs.stat(await progressPath($, o))
  } catch {
    return undefined
  }
}

async function canReset($: $, o: Opts, force: boolean): Promise<Verdict> {
  const save = await statSave($, o)
  if (save === undefined || save.size < MIN_SAVE_BYTES) {
    return { ok: false, why: 'no checkpoint saved for this directory', fix: 'ask Claude to checkpoint', canSave: true }
  }
  const now = await $.clock.now()
  const ageMin = (now - save.mtimeMs) / 60000
  if (ageMin > o.freshMin) {
    return { ok: false, why: `checkpoint is ${Math.round(ageMin)}m old`, fix: 'ask Claude to checkpoint again', canSave: true }
  }
  const w = await read($, work)
  if (w.inFlight > 0) {
    return { ok: false, why: `${w.inFlight} tool call(s) still running`, fix: 'wait for them to finish', canSave: false }
  }
  if (w.lastWorkAt > save.mtimeMs) {
    return { ok: false, why: 'work happened after the last checkpoint', fix: 'ask Claude to checkpoint again', canSave: true }
  }
  if (!force && !(await read($, stepDone))) {
    return { ok: false, why: 'last reply did not mark a finished step', fix: 'finish the step, or `/savepoint reset force` if it is already done', canSave: false }
  }
  return { ok: true, ageMin }
}

async function restoreText($: $, o: Opts, header: string, sessionId?: string) {
  const path = await progressPath($, o, sessionId)
  let txt: unknown
  try {
    txt = await $.fs.read(path)
  } catch {
    return undefined
  }
  if (typeof txt !== 'string') return undefined
  if (txt.length > o.restoreChars) txt = '…(older entries trimmed)…\n' + txt.slice(-o.restoreChars)
  return `${header} Resume state from ${path}. Trust it, verify only the files/commands it names, then continue with its next step if ${o.who}'s prompt asks to continue:\n\n${txt}`
}

async function archive($: $, o: Opts, messages: readonly SessionMessage[]) {
  const dir = await dirBase($, o)
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  const path = `${dir}.archive/${stamp}.md`
  const body = messages
    .map(m => {
      const tools = m.toolUses.map(t => `  - ${t.tool} ${JSON.stringify(t.input).slice(0, 400)}`).join('\n')
      return `## ${m.role}\n\n${m.text}${tools ? `\n\n${tools}` : ''}`
    })
    .join('\n\n')
  await $.fs.write(path, `# savepoint archive ${stamp}\n\n${body}\n`)
  return path
}

// A shell save may spell the path as ~/…, $HOME/… or ${HOME}/…, so match every form.
function isProgressWrite(input: Record<string, unknown>, path: string, home: string) {
  if (input.file_path === path) return true
  if (typeof input.command !== 'string') return false
  const rest = home && path.startsWith(`${home}/`) ? path.slice(home.length) : undefined
  const forms = rest === undefined ? [path] : [path, `~${rest}`, `$HOME${rest}`, `\${HOME}${rest}`]
  return forms.some(f => (input.command as string).includes(f))
}

async function refresh($: $, o: Opts) {
  const k = await contextK($, o)
  if (k === undefined) return $.ui.status(undefined)
  const save = await statSave($, o)
  const fresh = save !== undefined && ((await $.clock.now()) - save.mtimeMs) / 60000 <= o.freshMin
  const tier = k >= o.hardK ? ' · ) ( ) roaring' : k >= o.wrapK ? ' · ( ( tall' : ''
  $.ui.status(`bonfire ${k}k${tier}${fresh ? ' · ✓ saved' : ''}`)
}

// A compaction a plugin raises itself skips that plugin's own hooks, and the engine
// refuses a compaction or a prompt under a held turn (a command, a press). So a reset arms a one-shot flag and runs the real
// `/compact <token>` a moment later, outside that turn and our session.compact hook answers it.
async function reset($: $, o: Opts, force: boolean) {
  const v = await canReset($, o, force)
  if (!v.ok) return `Not reset: ${v.why}. To fix: ${v.fix}.`
  await update($, isResetting, () => true)
  $.clock.after(ARM_MS, () => void update($, isResetting, () => false))
  $.clock.after(SUBMIT_DELAY_MS, () => void $.command.run({ command: 'compact', args: RESET_TOKEN }))
  return 'Resetting to savepoint…'
}

async function mirrorLatest($: $, path: string, latest: string) {
  try {
    const txt = await $.fs.read(path)
    if (typeof txt === 'string' && txt.length >= MIN_SAVE_BYTES) await $.fs.write(latest, txt)
  } catch {
    // No save landed (a failed write, a shell line that only read it): nothing to copy.
  }
}

async function askSave($: $, o: Opts) {
  return $.prompt.submit({
    text: `checkpoint: update ${await progressPath($, o)} now (task, key paths, what changed, exact next step). Do nothing else.`,
  })
}

export const register: Register = (on, options) => {
  const o: Opts = {
    progressDir: String(options.progressDir ?? '~/.claude/progress'),
    switchK: Number(options.switchK ?? 60),
    wrapK: Number(options.wrapK ?? 110),
    hardK: Number(options.hardK ?? 150),
    freshMin: Number(options.freshMin ?? 15),
    restoreChars: Number(options.restoreChars ?? 6000),
    guard: options.guard !== false,
    restoreOnClear: options.restoreOnClear !== false,
    who: String(options.userName ?? 'the user'),
  }
  // The session a /clear just ended, until the next prompt restores its save.
  let clearedFrom: string | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'savepoint',
      description: 'Show savepoint status, or `reset` (add `force` to skip the step-done check) to reset context to the last checkpoint',
      argumentHint: '[reset [force]]',
    })
    void refresh($, o)
    return next(e)
  })

  on('command.run', { command: 'savepoint' }, async ($, e) => {
    const args = e.args.trim().split(/\s+/)
    if (args[0] === 'reset') return { text: await reset($, o, args[1] === 'force') }
    const v = await canReset($, o, false)
    const k = await contextK($, o)
    const path = await progressPath($, o)
    const b = k === undefined ? 'steady' : blaze(k, o)
    const state = v.ok
      ? `✓ ready to rest (checkpoint ${Math.round(v.ageMin)}m old) · /savepoint reset`
      : `not ready: ${v.why} (${v.fix})`
    // Command output renders as markdown: fence the art so `\_` and leading spaces survive.
    return { text: `\n\`\`\`\n${fireText(b)}\n\`\`\`\nSAVEPOINT · bonfire ${k ?? '?'}k · ${LORE[b]}\n${state}\n${path}` }
  })

  // Safeguard 1: only our own reset is answered; /compact and auto-compact pass through.
  on('session.compact', async ($, e, next) => {
    if (e.instructions !== RESET_TOKEN || e.agentId !== undefined) return next(e)
    if (!(await read($, isResetting))) return { skip: 'savepoint: reset not armed (use /savepoint reset)' }
    await update($, isResetting, () => false)
    // Re-check everything but the step mark (checked when armed): work may have started since.
    const v = await canReset($, o, true)
    if (!v.ok) return { skip: `savepoint: ${v.why}` }
    const archived = await archive($, o, e.messages)
    await update($, archivePath, () => archived)
    const text = await restoreText($, o, `[savepoint reset · previous conversation archived at ${archived}]`)
    if (text === undefined) return { skip: 'savepoint: progress file unreadable' }
    await update($, stepDone, () => false)
    const now = await $.clock.now()
    await update($, litAt, () => now)
    $.ui.toast(`◇ BONFIRE LIT ◇  rested at your savepoint · archive: ${archived}`)
    return { messages: [{ role: 'user', text, toolUses: [] }] }
  }).catch(($, e, next) =>
    // Fail closed for our own reset (never fall through to a summary compaction); others pass.
    e.instructions === RESET_TOKEN ? { skip: 'savepoint: reset check failed, conversation left as is' } : next(e),
  )

  on('tool.call', async ($, e, next) => {
    if (!WORK_TOOLS.has(String(e.tool))) return next(e)
    const path = await progressPath($, o)
    const latest = await latestPath($, o)
  const home = (await $.env.get('HOME')) ?? ''
  const input = e as unknown as Record<string, unknown>
  const isSave = isProgressWrite(input, path, home)
  // A write to the shared copy is a save too (never work), though only this session's file counts for a reset.
  const counts = !isSave && !isProgressWrite(input, latest, home)
    await update($, work, w => ({ ...w, inFlight: w.inFlight + 1 }))
    try {
      return await next(e)
    } finally {
      const now = await $.clock.now()
      await update($, work, w => ({
        inFlight: Math.max(0, w.inFlight - 1),
        lastWorkAt: counts ? now : w.lastWorkAt,
      }))
      if (counts) await update($, stepDone, () => false)
      if (isSave) await mirrorLatest($, path, latest)
    }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, isHidden, () => false)
    if (e.origin.kind !== 'composer') return next(e)
    const context = [...(e.context ?? [])]

    if (o.restoreOnClear && clearedFrom !== undefined) {
      const from = clearedFrom
      clearedFrom = undefined
      const text = await restoreText($, o, '[savepoint restore after /clear]', from)
      if (text !== undefined) context.push(text)
    }

    const k = o.guard ? await contextK($, o) : undefined
    if (k !== undefined && k >= o.switchK) context.push(guardNote(k, await progressPath($, o), o))

    return next({ ...e, context })
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, turns, t => [...t.filter(x => now - x.at < STALE_TURN_MS), { id: e.turnId, at: now }])
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, turns, t => t.filter(x => x.id !== e.turnId))
    if (e.agentId === undefined) {
      // The mark persists until work happens: an unmarked reply (plain Q&A) must not clear it.
      if (DONE_MARK.test(e.answer.slice(-400))) await update($, stepDone, () => true)
      void refresh($, o)
    }
    return next(e)
  })

  on('session.measure', ($, e, next) => {
    void refresh($, o)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // Held in this process, not $.store: the store is shared by every session, so another
    // chat's next prompt would take the restore. A /clear keeps the process under a new id.
    if (e.reason === 'clear') clearedFrom = e.sessionId
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    // Never over a live reply or a running tool: read our own state first, before any other await.
    const active = await read($, turns)
    const { inFlight } = await read($, work)
    const now = await $.clock.now()
    if (inFlight > 0 || active.some(x => now - x.at < STALE_TURN_MS)) return next(e)
    const k = await contextK($, o)
    const lit = (await read($, litAt)) > 0 && now - (await read($, litAt)) < LIT_MS
    const { Box, Button, Text } = $.ui.resolve(e)
    // Each draw mirrors the flames, so the fire flickers without leaving center.
    const flip = Math.floor(now / 1000) % 2 === 1
    const fire = (b: Blaze) => (
      <Box key="fire" flexDirection="column" width={11} flexShrink={0}>
        {FIRE[b].map((row, i) => (
          <Text key={`f${i}`} color={HEAT[b][i]} bold={b === 'roaring' && i < 4}>
            {flip && i < 4 ? mirror(row) : row}
          </Text>
        ))}
      </Box>
    )

    if (lit) {
      return (
        <Box flexDirection="row" gap={2}>
          {fire('embers')}
          <Box key="say" flexDirection="column" justifyContent="flex-end">
            <Text key="t" color="#ffb703" bold>◇ BONFIRE LIT ◇</Text>
            <Text key="l" dimColor>{LORE.embers}</Text>
            <Text key="a" dimColor>archive · {await read($, archivePath)}</Text>
            <Box key="btn"><Button key="ok" label="Onward" onPress={() => update($, litAt, () => 0)} /></Box>
          </Box>
        </Box>
      )
    }

    const done = await read($, stepDone)
    const quiet = k === undefined || k < o.switchK || (!done && k < o.hardK) || (await read($, isHidden))
    if (quiet) return next(e)

    const b = blaze(k, o)
    const v = await canReset($, o, false)
    return (
      <Box flexDirection="row" gap={2}>
        {fire(b)}
        <Box key="say" flexDirection="column" justifyContent="flex-end">
          <Text key="t">
            <Text key="n" color="#ffb703" bold>SAVEPOINT</Text>
            <Text key="k" color={HEAT[b][2]}> · bonfire {k}k</Text>
          </Text>
          <Text key="l" color={b === 'roaring' ? HEAT[b][2] : undefined} dimColor={b !== 'roaring'}>{LORE[b]}</Text>
          {v.ok ? (
            <Text key="s" color="green">✓ step saved {Math.round(v.ageMin)}m ago</Text>
          ) : (
            <Text key="s" dimColor>{v.why}</Text>
          )}
          <Box key="btn" gap={1}>
            {v.ok && <Button key="reset" variant="primary" label="Rest at bonfire" onPress={() => reset($, o, false).then(t => $.ui.toast(t))} />}
            {!v.ok && v.canSave && <Button key="save" label="Kindle a save" onPress={() => void askSave($, o)} />}
            <Button key="later" label="Later" onPress={() => update($, isHidden, () => true)} />
          </Box>
        </Box>
      </Box>
    )
  })
}

function guardNote(k: number, prog: string, o: { wrapK: number; hardK: number; who: string }) {
  const done =
    `A step counts as DONE when its result just landed and checked out (rendered and looked at, tests/QC passed, ` +
    `shipped, or ${o.who} approved it) and nothing is half-finished or mid-debug. Step boundaries, not project ` +
    `switches, are the reset points.`
  const say = `"✓ step done · saved · good time to reset (ctx ${k}k) · type /savepoint reset"`
  if (k >= o.hardK) {
    return `[savepoint ${k}k OVER BUDGET] Before anything else, update ${prog} (task, key paths, what changed, exact next ` +
      `step). Do only small, finishing work this turn. If the step is done, end with one line: ${say}; otherwise end with ` +
      `"ctx ${k}k, checkpoint saved, mid-step: finish before reset."`
  }
  if (k >= o.wrapK) {
    return `[savepoint ${k}k] Context is getting expensive. ${done} If a step is DONE by the end of this reply, update ` +
      `${prog} and end with one line: ${say}. If mid-step, steer toward finishing it and don't open new threads. If ` +
      `${o.who}'s prompt starts a different deliverable (or says "new task:"), don't start it: checkpoint and end with ${say}.`
  }
  return `[savepoint ${k}k] ${done} If a step is DONE by the end of this reply, update ${prog} and end with one line: ` +
    `${say}. If ${o.who}'s prompt starts a different deliverable (or says "new task:"), checkpoint first and end with ` +
    `${say}. Mid-step, or ${o.who} says "same thing": say nothing about this note.`
}
