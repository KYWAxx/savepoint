import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const toasts: string[] = []
const NOW = 1_800_000_000_000
const PROG = '/home/u/.claude/progress/-home-u-proj.abcd1234.md'
const LATEST = '/home/u/.claude/progress/-home-u-proj.md'
const SAVE = '# task\nnext step: render v3\n' + 'x'.repeat(300)

// The world beneath the plugin: a 120k context, one project dir, a fake disk.
function world($: Engine, on: On, opts: { saveAgeMin?: number; hasSave?: boolean } = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/u' })
  mock.store(on)
  const files = new Map<string, { text: string; mtimeMs: number }>()
  if (opts.hasSave !== false) files.set(PROG, { text: SAVE, mtimeMs: NOW - (opts.saveAgeMin ?? 2) * 60000 })
  const compacted: { core: number } = { core: 0 }
  toasts.length = 0

  on('session.cwd', () => ({ value: '/home/u/proj' }))
  on('session.id', () => ({ value: 'abcd1234-0000-4000-8000-000000000000' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [] } }))
  on('fs.stat', (_$, e) => {
    const f = files.get(e.path)
    if (!f) throw new Error('ENOENT')
    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    const f = files.get(e.path)
    if (!f) throw new Error('ENOENT')
    return { value: f.text }
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, { text: e.text, mtimeMs: clock.now() })
    return { value: undefined }
  })
  // Core's compaction stands in as "summary": anything reaching it was NOT a savepoint answer.
  on('session.compact', (_$, e) => {
    compacted.core += 1
    return { messages: [{ role: 'user', text: 'SUMMARY', toolUses: [] }] }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => { toasts.push(String((e as { text?: string }).text ?? e)); return { value: undefined } })
  const after: string[] = []
  // The engine's /compact: raise the compaction as core does and keep what it answers.
  on('command.run', { command: 'compact' }, async (_$, e) => {
    const r = await $.session.compact({ instructions: e.args, messages: [] } as never)
    if (r.messages) after.push(...r.messages.map(m => m.text))
    return { text: 'compacted' }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return <Box key="engine" /> })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  return { clock, files, compacted, toasts, after }
}

async function finishStep($: Engine, answer = 'Rendered and checked.\n✓ step done · saved · good time to reset (ctx 120k)') {
  // The kit raises turn.complete at run time; its Engine type lists only turn.abort.
  const turn = ($ as unknown as { turn: { complete: (input: unknown) => Promise<unknown> } }).turn
  await turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
}

// Runs the command, then lets the deferred compaction land; answers what the person would see.
async function reset($: Engine, w: { clock: { advance: (ms: number) => Promise<void> }; toasts: string[] }, args = 'reset') {
  const text = (await $.command.run({ command: 'savepoint', args } as never)).text ?? ''
  await w.clock.advance(100)
  return [text, ...w.toasts].join(' | ')
}

test('fresh save + finished step: resets to the checkpoint alone and archives the rest', async ($, on) => {
  const w = world($, on)
  await finishStep($)
  const text = await reset($, w)
  expect(text).toContain('BONFIRE LIT')
  expect(w.compacted.core).toBe(0)
  expect(w.after.length).toBe(1)
  expect(w.after[0]).toContain('next step: render v3')
  const archives = [...w.files.keys()].filter(p => p.includes('.archive/'))
  expect(archives.length).toBe(1)
  expect(w.files.get(archives[0]!)!.text).toContain('# savepoint archive')
})

test('stale save: refused, conversation untouched', async ($, on) => {
  const w = world($, on, { saveAgeMin: 40 })
  await finishStep($)
  expect(await reset($, w)).toContain('checkpoint is 40m old')
  expect(w.compacted.core).toBe(0)
})

test('no save at all: refused', async ($, on) => {
  const w = world($, on, { hasSave: false })
  await finishStep($)
  expect(await reset($, w)).toContain('no checkpoint saved')
})

test('work after the save: refused', async ($, on) => {
  const w = world($, on)
  await finishStep($)
  await $.tool.call({ tool: 'Edit', file_path: '/home/u/proj/a.py', old_string: 'a', new_string: 'b' } as never)
  expect(await reset($, w)).toContain('work happened after the last checkpoint')
  expect(w.compacted.core).toBe(0)
})

test('writing the checkpoint itself does not count as unsaved work', async ($, on) => {
  const w = world($, on)
  await $.tool.call({ tool: 'Write', file_path: PROG, content: SAVE } as never)
  await finishStep($)
  expect(await reset($, w)).toContain('BONFIRE LIT')
})

test('a shell save spelled ~/ or $HOME/ also does not count as unsaved work', async ($, on) => {
  const w = world($, on)
  await $.tool.call({ tool: 'Bash', command: "cat >> ~/.claude/progress/-home-u-proj.abcd1234.md <<'EOF'\nstep done\nEOF" } as never)
  await $.tool.call({ tool: 'Bash', command: 'echo ok >> "$HOME/.claude/progress/-home-u-proj.abcd1234.md"' } as never)
  await finishStep($)
  expect(await reset($, w)).toContain('BONFIRE LIT')
})

test('mid-step (no step-done line): refused; force waives only that check', async ($, on) => {
  const w = world($, on)
  await finishStep($, 'Still debugging the mask, next I try v4.')
  expect(await reset($, w)).toContain('did not mark a finished step')
  expect(await reset($, w, 'reset force')).toContain('BONFIRE LIT')
})

test('a mark reply, then a plain reply with no mark and no work: reset is still allowed', async ($, on) => {
  const w = world($, on)
  await finishStep($)
  await finishStep($, 'Sure: the mask uses a 3px feather.')
  expect(await reset($, w)).toContain('BONFIRE LIT')
})

test('a mark reply, then a work tool call: reset is refused', async ($, on) => {
  const w = world($, on)
  await finishStep($)
  await $.tool.call({ tool: 'Bash', command: 'make render' } as never)
  await finishStep($, 'Ran the render.')
  expect(await reset($, w)).not.toContain('BONFIRE LIT')
  expect(w.compacted.core).toBe(0)
})

test('a typed /compact savepoint reset without arming is refused, not summarized', async ($, on) => {
  const w = world($, on)
  const r = await $.session.compact({ instructions: 'savepoint reset', messages: [] } as never)
  expect(r.skip).toContain('not armed')
  expect(w.compacted.core).toBe(0)
})

test('a normal /compact or auto-compact passes straight through', async ($, on) => {
  const w = world($, on)
  const r = await $.session.compact({ instructions: 'keep the plan', messages: [] } as never)
  expect(r.messages?.[0]?.text).toBe('SUMMARY')
  expect(w.compacted.core).toBe(1)
})

test('the band never shows over a running turn, even when the engine says idle', async ($, on) => {
  world($, on)
  await finishStep($)
  const turn = ($ as unknown as { turn: { start: (input: unknown) => Promise<unknown> } }).turn
  const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20 } } as never
  for (const surface of ['terminal', 'desktop'] as const) {
    const idle = await $.ui.mount({ plugin: 'savepoint', surface, ...(BAND as object) } as never)
    expect(await idle.find({ type: 'Text', text: /SAVEPOINT/ })).toBeDefined()
    await idle.unmount()
  }
  await turn.start({ text: 'go', turnId: 't2' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const busy = await $.ui.mount({ plugin: 'savepoint', surface, ...(BAND as object) } as never)
    expect(await busy.find({ type: 'Text', text: /SAVEPOINT/ })).toBeUndefined()
    await busy.unmount()
  }
})

test('another chat in the same directory saving does not make this chat resettable', async ($, on) => {
  const w = world($, on, { hasSave: false })
  w.files.set(LATEST, { text: SAVE, mtimeMs: NOW })
  w.files.set('/home/u/.claude/progress/-home-u-proj.ffff9999.md', { text: SAVE, mtimeMs: NOW })
  await finishStep($)
  expect(await reset($, w)).toContain('no checkpoint saved')
  expect(w.compacted.core).toBe(0)
})

test('a save to this chat\'s file is copied to the shared latest file', async ($, on) => {
  const w = world($, on, { hasSave: false })
  w.files.set(PROG, { text: SAVE + 'mine', mtimeMs: NOW })
  await $.tool.call({ tool: 'Write', file_path: PROG, content: SAVE + 'mine' } as never)
  expect(w.files.get(LATEST)?.text).toContain('mine')
})

test('writing the shared latest file does not count as unsaved work', async ($, on) => {
  const w = world($, on)
  await finishStep($)
  await $.tool.call({ tool: 'Write', file_path: LATEST, content: SAVE } as never)
  expect(await reset($, w)).toContain('BONFIRE LIT')
})

const HISTORY = '/home/u/.claude/progress/-home-u-proj.history.md'

test('an over-cap save is trimmed, old sections go to history, the mirror gets the trimmed copy', async ($, on) => {
  const w = world($, on, { hasSave: false })
  const big = '# task\n' + ['## one', '## two', '## three'].map(h => `${h}\n${h[3]}`.padEnd(3500, '.') + '\n').join('')
  w.files.set(PROG, { text: big, mtimeMs: NOW })
  await $.tool.call({ tool: 'Write', file_path: PROG, content: big } as never)
  const kept = w.files.get(PROG)!.text
  expect(kept.startsWith('# task\n')).toBe(true)
  expect(kept).toContain('## three')
  expect(kept).toContain('## two')
  expect(kept).not.toContain('## one')
  expect(kept.length).toBeLessThanOrEqual(8000)
  const hist = w.files.get(HISTORY)!.text
  expect(hist).toContain('<!-- moved from ' + PROG)
  expect(hist).toContain('## one')
  expect(hist).not.toContain('## two')
  expect(w.files.get(LATEST)?.text).toBe(kept)
})

test('an under-cap save is left alone and no history file is written', async ($, on) => {
  const w = world($, on, { hasSave: false })
  const small = SAVE + '\n## a\nx\n## b\ny\n'
  w.files.set(PROG, { text: small, mtimeMs: NOW })
  await $.tool.call({ tool: 'Write', file_path: PROG, content: small } as never)
  expect(w.files.get(PROG)?.text).toBe(small)
  expect(w.files.has(HISTORY)).toBe(false)
  expect(w.files.get(LATEST)?.text).toBe(small)
})
