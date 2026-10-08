// Goal Meter: a progress bar built from Claude's own task plan, on by default.
// - The system prompt asks Claude to plan any multi-step task; a turn that runs a few tools with
//   no plan gets one hidden reminder. Until a plan exists the row says "working", never a /goal hint.
// - /goal also starts it. The mod asks Claude to plan the goal as sized tasks (S, M, L)
//   with the mod's tool, mcp__goal-meter__tasks, then mark each task started and
//   done. Claude Code stopped shipping a task-list tool after 2.1.229, so the mod
//   brings its own. A plan made outside a /goal shows the same way.
// - The band above the prompt: the bar (finished work out of the plan, weighted
//   by size), elapsed time, the ETA at this goal's own pace, what's running and
//   who runs it, the next tasks, and the goal check's latest "not met yet" reason.
// - The footer: "◎ goal 69% · ~15m" in every view, terminal and Desktop.
// - /goals: a pane with this chat's whole task list and every other chat's goal.
//   /goals hide|show (the band), /goals strict on|off, /goals clear.
// - Each chat writes ~/.claude/mods-data/goal-meter/<session>.json for /goals.
//   The mod sends no model requests of its own.

import { minutes, duration, clock, clip, bar, basename } from './fmt.mjs'
import { makeMasker } from './privacy.mjs'
import { rowOf, rowSvg, rowSpans, describe, stepsSvg, cropSvg, FRAME } from './row.mjs'
import { newGoal, applyAction, progress, eta, askDue, markAsked, minutesHint, earlyNudge, lateNudge, reestimate, forkPrompt, minutesIn, parseCheck, isStopWord, normalizeTasks, TOOL_SPEC, instruction, nudge, strictDeny, autoPlan, autoNudge, titleOf } from './plan.mjs'

const DIR = '/.claude/mods-data/goal-meter'
const PANE = 'goal-meter'
const RECENT_MS = 10 * 60000 // a finished goal stays on screen this long
const OTHERS_MS = 12 * 3600000 // other chats' goals shown in /goals
const REOPEN_MS = 5 * 60000 // a goal closed on its tasks reopens if Claude carries on this soon
const NUDGE_AFTER = 4 // tool calls into a goal with no plan before the reminder
const CELEBRATE_MS = 6000 // a finished plan's rainbow sweep plays only in renders this soon after
const AUTO_NUDGE_AT = 3 // tool calls into a turn with no plan before the reminder outside /goal
const WRITERS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

let G = null
let sessionId = ''
let home = ''
let cwd = ''
let now = 0
let toolName = 'mcp__goal-meter__tasks'
let commandName = 'goals'
let settings = { strict: false, ask: true }
let hidden = false
let nudged = false
let callsWithoutPlan = 0
let working = false // a main turn is running
let background = 0 // background tasks still in flight when the last turn stopped
let backgroundWork = [] // what they are, in a few words each
let forking = false // a fork of the conversation is asking how much longer
let askClock = false // the clock that checks for an ask while Claude waits; started the first time it does
let turnCalls = 0 // its tool calls so far, the mod's own left out
let turnNudged = false
let ops = [] // this turn's tool calls, newest last: the hover card's details while there is no plan
const OPS_KEEP = 8
let turnAt = 0 // when the running main turn started
let lastTurn = null // the latest finished turn that did work: { calls, ms, at }
let pendingGoal = null
let paneOpen = false
let others = []
let transcriptPath = ''
const agentNames = new Map()
const runningAgents = new Set()
let rec = { on: false, strict: false }
let mask = (s) => s

function goalFile(id) {
  return `${home}${DIR}/${id}.json`
}

function isRecent(g) {
  return g && g.status !== 'running' && g.endedAt && now - g.endedAt < RECENT_MS
}

function visibleTasks(g) {
  return g.tasks.filter((t) => !t.replaced && t.status !== 'dropped')
}

async function save($) {
  if (!G || !sessionId) return
  G.updatedAt = now
  try {
    await $.fs.write(goalFile(sessionId), JSON.stringify({ ...G, label: basename(cwd) }))
  } catch {
    // the pane falls back to this chat alone
  }
}

async function restore($) {
  try {
    const path = goalFile(sessionId)
    if (!(await $.fs.exists(path))) return
    const saved = JSON.parse(await $.fs.read(path))
    if (saved && Array.isArray(saved.tasks) && now - (saved.updatedAt || 0) < 24 * 3600000) G = saved
  } catch {
    G = null
  }
}

async function loadOthers($) {
  const dir = home + DIR
  const list = []
  try {
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name === sessionId + '.json') continue
      if (now - (entry.mtimeMs || 0) > OTHERS_MS) continue
      try {
        const g = JSON.parse(await $.fs.read(dir + '/' + entry.name))
        if (!g || !Array.isArray(g.tasks)) continue
        if (g.status !== 'running' && now - (g.endedAt || 0) > OTHERS_MS) continue
        list.push(g)
      } catch {
        // a file another chat is writing right now; next refresh reads it
      }
    }
  } catch {
    // no folder yet
  }
  others = list.sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.updatedAt - a.updatedAt)
}

async function readRecording($) {
  try {
    const path = (home || '.') + '/.claude/mods-data/recording.json'
    if (!(await $.fs.exists(path))) rec = { on: false, strict: false }
    else {
      const flag = JSON.parse(await $.fs.read(path))
      rec = { on: !!flag.on, strict: !!flag.on && !!flag.strict }
    }
  } catch {
    rec = { on: false, strict: false }
  }
  mask = rec.on ? makeMasker({ strict: rec.strict }) : (s) => s
}

async function registerCommand($) {
  const spec = { name: 'goals', description: 'Goal meter: this chat\'s goal task list and every chat\'s goal (/goals hide|show|strict on|off|clear)', argumentHint: '[hide|show|strict on|off|clear]', immediate: true }
  try {
    await $.command.register(spec)
    return 'goals'
  } catch {
    try {
      await $.command.register({ ...spec, name: 'goal-meter' })
      return 'goal-meter'
    } catch {
      return null
    }
  }
}

async function startGoal($, condition) {
  G = newGoal({ sessionId, condition, now, cwd })
  hidden = false
  nudged = false
  callsWithoutPlan = 0
  pendingGoal = null
  await save($)
  $.ui.invalidate('ui.render')
}

async function stopGoal($, status) {
  if (!G || G.status !== 'running') return
  G.status = status
  G.endedAt = now
  G.active = false
  await save($)
  $.ui.invalidate('ui.render')
}

async function finishGoal($, how) {
  if (!G || G.status !== 'running') return
  G.status = 'met'
  G.endedAt = now
  G.active = false
  G.finishedBy = how
  await save($)
  const took = minutes(G.endedAt - G.startedAt)
  $.ui.toast(`完成 ✓ ${clip(mask(G.title), 60)}，用时 ${took}`)
  $.ui.invalidate('ui.render')
}

async function serveTool($, e) {
  now = await $.clock.now()
  const action = String(e.action || 'show').toLowerCase()
  const first = normalizeTasks(e.tasks)[0]
  const named = typeof e.goal === 'string' && e.goal.trim() ? e.goal.trim() : ''
  // a new plan outside /goal: when there is none running, or Claude names a different task
  const fresh = !G || (G.status !== 'running' && (action === 'plan' || action === 'add')) ||
    (action === 'plan' && G.kind === 'plan' && named && titleOf(named) !== G.title)
  if (fresh) {
    if (!first) return { result: `Goal meter: no plan in this chat yet. Call action "plan" with the tasks first, each { "title": "...", "size": "S" | "M" | "L" }.` }
    // tracked like a /goal, named after the task Claude gave, else its first step; whether the chat
    // was already asked for minutes carries over
    const minutesAsked = !!(G && G.minutesAsked)
    G = newGoal({ sessionId, condition: named || first.title, now, cwd, kind: 'plan' })
    if (minutesAsked) G.minutesAsked = true
    hidden = false
  }
  const by = e.by ? String(e.by) : e.agentId ? agentNames.get(e.agentId) || 'agent' : ''
  const r = applyAction(G, e, { now, by })
  let text = r.text
  // a plan without minutes, once in a chat: ask for them in the reply
  if (r.ok && (action === 'plan' || action === 'add') && !G.minutesAsked && normalizeTasks(e.tasks).some((t) => !t.minutes)) {
    G.minutesAsked = true
    text += minutesHint(toolName, G.tasks.find((t) => t.status === 'active' && !t.replaced))
  }
  if (r.ok) {
    await save($)
    $.ui.invalidate('ui.render')
  }
  return { result: text }
}

// The goal check's verdict. Its row reaches session.append with no content (the
// payload is stored beside it, seen live 2026-10-02), so read the record from
// the end of the chat's log: a few lines, never the whole file (logs reach 200 MB).
async function lastGoalStatus($, since) {
  const path = transcriptPath
  if (!path) return null
  const windows = /^[A-Za-z]:/.test(path)
  const argv = windows
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Get-Content -LiteralPath '${path.replace(/'/g, "''")}' -Tail 12 -Encoding UTF8`]
    : ['tail', '-n', '12', path]
  let out = ''
  try {
    const r = await $.process.run(argv, { timeoutMs: 15000 })
    out = r.stdout || ''
  } catch {
    return null
  }
  const lines = out.split(/\r?\n/).filter((l) => l.includes('"goal_status"')).reverse()
  for (const line of lines) {
    try {
      const row = JSON.parse(line)
      const a = row.attachment
      if (!a || a.type !== 'goal_status') continue
      // an older check's record is not this check's verdict
      const ts = Date.parse(row.timestamp || '') || 0
      return ts && since && ts < since - 3000 ? null : a
    } catch {
      // a line cut by the tail
    }
  }
  return null
}

// The log is written a moment after the row reaches the hook: read it now, and
// again after 1.5 and 4 seconds when the verdict isn't there yet
async function onCheck($, message, at, attempt = 0) {
  if (!G || G.kind !== 'goal' || G.status !== 'running') return
  let verdict = await lastGoalStatus($, at)
  if (!verdict) {
    // a build that renders the verdict into the row itself
    const blocks = Array.isArray(message.content) ? message.content : []
    const c = parseCheck(blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n'))
    verdict = c.met ? { met: true } : c.notMet ? { met: false, reason: c.reason } : null
  }
  if (!verdict && attempt < 2) {
    $.clock.after(attempt ? 4000 : 1500, async () => {
      now = await $.clock.now()
      await onCheck($, message, at, attempt + 1).catch(() => {})
    })
    return
  }
  if (!verdict || verdict.sentinel) return // the row written when the goal is set
  if (verdict.met) return finishGoal($, 'check')
  G.check = { met: false, reason: clip(verdict.reason || 'no reason given', 300), at: now }
  G.checks += 1
  await save($)
  $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    now = await $.clock.now()
    home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    sessionId = await $.session.id()
    cwd = await $.session.cwd()
    // where Claude Code keeps this chat's log; a settings-hook event confirms it below
    transcriptPath = `${home}/.claude/projects/${String(cwd).replace(/[^A-Za-z0-9]/g, '-')}/${sessionId}.jsonl`
    const saved = await $.store.get('settings')
    if (saved && typeof saved === 'object') settings = { ...settings, ...saved }
    await readRecording($)
    try {
      const reg = await $.tool.register(TOOL_SPEC)
      if (reg && reg.tool) toolName = reg.tool
    } catch (err) {
      $.ui.log(`goal-meter: the task tool did not register (${err && err.message ? err.message : err})`)
    }
    commandName = (await registerCommand($)) || commandName
    await restore($)
    $.clock.every(15000, async () => {
      now = await $.clock.now()
      if (paneOpen) await loadOthers($)
      // a finished row says how long ago it finished, so it redraws too
      if (paneOpen || G || lastTurn) $.ui.invalidate('ui.render')
    })
    $.clock.every(10000, () => readRecording($).catch(() => {}))
    // a step's clock counts by the second, as the background-task panel's does
    $.clock.every(1000, async () => {
      if (!busy(G)) return
      now = await $.clock.now()
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  // On by default: the system prompt tells Claude to plan any multi-step task with the tool, so
  // the row fills in without anyone typing /goal. One fixed section, so the prompt cache holds.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!e.tools.includes(toolName)) return r
    return { sections: [...r.sections, { id: 'goal-meter:auto-plan', text: autoPlan(toolName), scope: 'session' }] }
  })

  // The tool sits in Claude's list from the start, not behind ToolSearch
  on('tool.describe', { tool: 'mcp__goal-meter__tasks' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  // /goal <condition> starts the meter and asks Claude to plan. The ask rides as
  // the command's hidden note, so the cached prefix is untouched.
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const args = String(e.args || '').trim()
    const r = await next(e)
    now = await $.clock.now()
    pendingGoal = null
    if (!args) return r
    if (isStopWord(args)) {
      await stopGoal($, 'stopped')
      return r
    }
    await startGoal($, args)
    const notes = r && Array.isArray(r.context) ? r.context : []
    return { ...(r || {}), context: [...notes, instruction(toolName)] }
  })

  // Fallback when /goal reaches the session without a command.run: remember it
  // here and start at turn.start, asking for the plan with an appended note.
  on('prompt.submit', async ($, e, next) => {
    const m = String(e.text || '').match(/^\s*\/goal\s+([\s\S]+)$/)
    if (m && !isStopWord(m[1])) pendingGoal = { args: m[1].trim(), at: await $.clock.now() }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    now = await $.clock.now()
    working = true
    turnCalls = 0
    ops = []
    turnAt = now
    turnNudged = false
    $.ui.invalidate('ui.render')
    if (pendingGoal && (!G || G.startedAt < pendingGoal.at)) {
      const args = pendingGoal.args
      await startGoal($, args)
      try {
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: instruction(toolName) }] } })
      } catch {
        // the nudge after a few tool calls is the second chance
      }
    }
    pendingGoal = null
    // closed on its tasks, but the goal loop carries on without a new prompt: reopen
    if (G && G.status === 'met' && G.finishedBy === 'tasks' && G.kind === 'goal' && !String(e.text || '').trim() && now - G.endedAt < REOPEN_MS) {
      G.status = 'running'
      G.endedAt = 0
      G.finishedBy = ''
    }
    if (G && G.status === 'running') {
      G.active = true
      G.interrupted = false
    }
    return next(e)
  })

  // The settings hooks' events carry the log's real path
  on('classic.Stop', async ($, e, next) => {
    if (e && typeof e.transcript_path === 'string' && e.transcript_path) transcriptPath = e.transcript_path
    // a turn that stops with shells or agents still running in the background is not done: the
    // step being worked on keeps its clock until they wake the next turn
    background = e && Array.isArray(e.background_tasks) ? e.background_tasks.length : 0
    backgroundWork = background ? e.background_tasks.map((b) => clip(String(b.description || ''), 80)).filter(Boolean).slice(0, 5) : []
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === toolName) return serveTool($, e)
    let op = null
    if (!e.agentId && e.tool !== 'ToolSearch') {
      turnCalls += 1
      op = { title: opLabel(e), at: await $.clock.now(), doneAt: 0 }
      ops = [...ops, op].slice(-OPS_KEEP)
      if (!(G && G.status === 'running')) $.ui.invalidate('ui.render')
    }
    // runs the call and marks its row in the card finished
    const run = async () => {
      try {
        return await next(e)
      } finally {
        if (op) {
          op.doneAt = await $.clock.now()
          if (!(G && G.status === 'running')) $.ui.invalidate('ui.render')
        }
      }
    }
    // time to ask how much longer the running step has (early on a long step, or once late), read
    // after this call's result and never shown to the person
    const at = await $.clock.now()
    const ask = !e.agentId && G && G.status === 'running' ? askDue(G, at) : null
    if (ask) {
      const t = ask.task
      markAsked(t, ask.late, at)
      await save($)
      const r = await run()
      if (!r || r.deny || !('result' in r)) return r
      return { ...r, context: [...(r.context || []), ask.late ? lateNudge(toolName, t) : earlyNudge(toolName, t, at)] }
    }
    // outside /goal: a turn a few tools deep with no plan gets one reminder, read after this
    // call's result and never shown to the person
    if (!e.agentId && !(G && G.status === 'running') && turnCalls >= AUTO_NUDGE_AT && !turnNudged) {
      turnNudged = true
      const r = await run()
      if (!r || r.deny || !('result' in r)) return r
      return { ...r, context: [...(r.context || []), autoNudge(toolName)] }
    }
    if (G && G.status === 'running' && G.kind === 'goal' && !(G.planned || G.planAt) && !e.agentId) {
      if (settings.strict && WRITERS.has(e.tool)) return { deny: strictDeny(toolName) }
      if (e.tool !== 'ToolSearch') callsWithoutPlan += 1
      if (callsWithoutPlan >= NUDGE_AFTER && !nudged) {
        nudged = true
        try {
          await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: nudge(toolName) }] } })
        } catch {
          // the band says the plan is missing either way
        }
        $.ui.invalidate('ui.render')
      }
    }
    return run()
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r && r.agentId) {
      agentNames.set(r.agentId, clip(e.name || e.description || e.subagentType || 'agent', 32))
      runningAgents.add(r.agentId)
      if (G && G.status === 'running') $.ui.invalidate('ui.render')
    }
    return r
  })

  // The goal check writes its verdict as an attachment row
  on('session.append', { door: 'attachment' }, async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && e.message && e.message.name === 'goal_status') {
      now = await $.clock.now()
      try {
        await onCheck($, e.message, now)
      } catch {
        // the row is stored whatever the parser makes of it
      }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    now = await $.clock.now()
    if (!e.agentId) {
      working = false
      if (turnCalls > 0) lastTurn = { calls: turnCalls, ms: now - (turnAt || now), at: now }
      $.ui.invalidate('ui.render')
      // the turn left background work running (classic.Stop, just before this, counted it)
      if (background && !askClock) {
        askClock = true
        $.clock.every(15000, () => idleAsk($).catch(() => {}))
      }
    }
    if (e.agentId) {
      runningAgents.delete(e.agentId)
      if (G && G.status === 'running') $.ui.invalidate('ui.render')
      return r
    }
    if (G && G.status === 'running') {
      G.active = false
      G.lastTurnEnd = now
      if (e.isAborted) G.interrupted = true
      const p = progress(G)
      // the turn ended with every task done: finished (the goal check's own
      // verdict, read from the log, usually closed it a moment earlier). Not while work the
      // turn started still runs in the background (classic.Stop, which comes just before this,
      // counted it): the turn that work wakes when it ends closes the plan instead
      if (e.reason === 'answer' && !e.isAborted && p.n > 0 && p.doneN === p.n && background === 0) await finishGoal($, 'tasks')
      else await save($)
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('command.run', { command: ['goals', 'goal-meter'] }, async ($, e) => {
    now = await $.clock.now()
    const [key, value] = String(e.args || '').trim().toLowerCase().split(/\s+/)
    if (key === 'ask') {
      settings.ask = value !== 'off'
      await $.store.set('settings', settings)
      $.ui.toast(`Asking how much longer while Claude waits on background work: ${settings.ask ? 'on' : 'off'}`)
      return {}
    }
    if (key === 'strict') {
      settings.strict = value !== 'off'
      await $.store.set('settings', settings)
      $.ui.toast(`Strict planning ${settings.strict ? 'on: no file edits in a /goal before the plan' : 'off'}`)
      return {}
    }
    if (key === 'hide' || key === 'show') {
      hidden = key === 'hide'
      $.ui.invalidate('ui.render')
      return {}
    }
    if (key === 'clear') {
      await stopGoal($, 'stopped')
      return {}
    }
    await loadOthers($)
    const surface = await $.session.surface()
    if (!surface) return { text: plainText() }
    paneOpen = true
    await $.ui.open({ id: PANE, title: 'Goal meter', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  // One row above the prompt, always there (idle when the chat has no goal), stacked on top of
  // whatever the hooks beneath drew (usage-band's row) and never in place of it
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if ((e.props && e.props.hasSurvey) || hidden) return below
    now = await $.clock.now() // the row's clock (ETA, the finish sweep) reads the time it is drawn at
    const el = $.ui.resolve(e)
    const mine = drawRow(el, e)
    if (!mine) return below
    if (!below) return mine
    return el.Box({ flexDirection: 'column', children: [mine, below] })
  })

  // The footer shows even when the band is hidden or collapsed
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const label = footerLabel()
    if (!label) return next(e)
    const modes = Array.isArray(e.props && e.props.modes) ? e.props.modes : []
    return next({ ...e, props: { ...e.props, modes: [...modes, label] } })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const el = $.ui.resolve(e)
    const width = Math.max(50, (e.props && e.props.bodyColumns) || 100)
    return drawPane(el, width, e.surface)
  })
}

// ---------- words ----------

function label(g) {
  return g.kind === 'plan' ? 'Plan' : 'Goal'
}

function paused(g) {
  return g.status === 'running' && !g.active && g.lastTurnEnd > 0
}

// Claude sits idle while background work it started carries the running step: nothing can be said
// to it, so at the times askDue names a fork of the conversation (its own transcript, same model,
// served from the prompt cache, shown to no one) is asked how much longer, and the answer is taken
// as Claude's own. Every ask goes into ~/.claude/mods-data/goal-meter/asks.jsonl with what it cost.
// `/goals ask off` turns it off.
async function idleAsk($) {
  if (!settings.ask || forking || !G || G.status !== 'running' || G.active || working || background === 0) return
  const at = await $.clock.now()
  const ask = askDue(G, at)
  if (!ask) return
  const t = ask.task
  markAsked(t, ask.late, at)
  await save($)
  forking = true
  const entry = { at: new Date(at).toISOString(), session: G.sessionId, step: t.title, ranMin: Math.round((at - t.startedAt) / 60000), givenMin: t.minutes || 0, late: ask.late }
  try {
    const r = await $.model.fork({ prompt: forkPrompt(t, at, backgroundWork) })
    entry.answered = r.isAnswered
    if (r.isAnswered) entry.reply = clip(String(r.text || ''), 200)
    else entry.reason = r.reason
    if (r.usage) entry.usage = r.usage
    const more = r.isAnswered ? minutesIn(r.text) : 0
    entry.moreMin = more
    if (more && G && t.status === 'active') {
      reestimate(t, more, await $.clock.now())
      await save($)
      $.ui.invalidate('ui.render')
    }
  } catch (err) {
    entry.error = clip(String(err && err.message ? err.message : err), 200)
  } finally {
    forking = false
    await logAsk($, entry)
  }
}

async function logAsk($, entry) {
  if (!home) return
  const path = `${home}${DIR}/asks.jsonl` // .jsonl: the plan list reads .json files only
  try {
    let old = ''
    try { old = await $.fs.read(path) } catch {}
    const lines = old.split('\n').filter(Boolean).slice(-299)
    await $.fs.write(path, [...lines, JSON.stringify(entry)].join('\n') + '\n')
  } catch {
    // the log is for looking back; the ask itself already counted
  }
}

// Something is still at work on the plan: a turn, or background tasks the last turn left running.
// Otherwise the clocks stand still and no time is left to estimate: the work waits on the person.
function busy(g) {
  return !!g && g.status === 'running' && (g.active || working || background > 0)
}

function headline(g, p) {
  if (g.status === 'met') return `done ✓ in ${minutes((g.endedAt || now) - g.startedAt)}`
  if (g.status !== 'running') return 'stopped'
  if (!(g.planned || g.planAt)) return 'planning…'
  return `${p.doneN} of ${p.n} tasks · ${p.pct}%`
}

function statsLine(g, p) {
  const parts = []
  if (g.status === 'running') {
    parts.push(`${minutes(now - g.startedAt)} elapsed`)
    const t = eta(g, now)
    if (t) parts.push(`about ${minutes(t.ms)} left (≈${clock(t.at)})`)
    else if ((g.planned || g.planAt) && p.doneN < 2) parts.push('ETA after 2 tasks finish')
  }
  if (g.firstPlan && p.n > g.firstPlan) parts.push(`plan grew ${g.firstPlan} → ${p.n}`)
  if (runningAgents.size && g.status === 'running') parts.push(`${runningAgents.size} agent${runningAgents.size === 1 ? '' : 's'} running`)
  if (g.interrupted && g.status === 'running') parts.push('interrupted')
  else if (paused(g) && p.doneN < p.n) parts.push('paused, waiting on you')
  if (g.checks) parts.push(`${g.checks} goal check${g.checks === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

function footerLabel() {
  if (!G) return ''
  const word = G.kind === 'plan' ? 'plan' : 'goal'
  if (G.status === 'running') {
    if (!(G.planned || G.planAt)) return `◎ ${word} · planning`
    const p = progress(G)
    const t = eta(G, now)
    return `◎ ${word} ${p.pct}%` + (t ? ` · ~${minutes(t.ms)}` : ` · ${p.doneN}/${p.n}`)
  }
  if (isRecent(G)) return G.status === 'met' ? `◎ ${word} done ✓` : `◎ ${word} stopped`
  return ''
}

function taskTail(t) {
  // a finished step shows its time, to the second (42s, 3m 05s, 1h 02m); one never started, a dash
  // never started, so its time is not known: a dash, not a made-up 0s
  if (t.status === 'done') return t.untimed ? '—' : duration(t.doneAt - t.startedAt)
  // the running step shows its clock alone: the ▶ already says it is under way
  // (stopped where the work stopped, when nothing runs any more)
  const at = busy(G) ? now : (G && G.lastTurnEnd) || now
  if (t.status === 'active') return (t.by ? t.by + ' · ' : '') + duration(Math.max(0, at - t.startedAt))
  if (t.status === 'dropped') return '已放弃' + (t.note ? '：' + t.note : '')
  return ''
}

// One tool call as a line of the card: what it did, in a few words
function opLabel(e) {
  const short = (v, n = 40) => clip(String(v || '').replace(/\s+/g, ' ').trim(), n)
  const file = (v) => basename(String(v || '')) || short(v)
  switch (e.tool) {
    case 'Bash': return e.description ? short(e.description) : '运行 ' + short(e.command, 32)
    case 'Read': return '读 ' + file(e.file_path)
    case 'Edit': case 'MultiEdit': return '改 ' + file(e.file_path)
    case 'Write': return '写 ' + file(e.file_path)
    case 'NotebookEdit': return '改 ' + file(e.notebook_path)
    case 'Grep': return '搜 ' + short(e.pattern, 30)
    case 'Glob': return '找 ' + short(e.pattern, 30)
    case 'Agent': case 'Task': return '派 ' + short(e.description || e.subagent_type || 'agent', 32)
    case 'WebSearch': return '搜网页 ' + short(e.query, 30)
    case 'WebFetch': return '读网页 ' + short(String(e.url || '').replace(/^https?:\/\//, ''), 30)
    case 'Skill': return '用 skill ' + short(e.skill, 30)
    default: {
      const name = String(e.tool || 'tool')
      return name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name
    }
  }
}

function opStep(o) {
  return o.doneAt
    ? { status: 'done', title: o.title, tail: duration(o.doneAt - o.at), op: true }
    : { status: 'active', title: o.title, tail: duration(now - o.at), op: true }
}

const ICON = { done: '✓', active: '▶', pending: '○', dropped: '×' }

function taskRow(el, t, width) {
  const { Box, Text } = el
  const tail = mask(taskTail(t))
  const title = mask(t.title)
  const icon = ICON[t.status] || '○'
  const lead = t.status === 'done'
    ? Text({ color: 'green', children: [`${icon} `] })
    : t.status === 'active'
      ? Text({ color: 'cyan', bold: true, children: [`${icon} `] })
      : Text({ dimColor: true, children: [`${icon} `] })
  const body = t.status === 'active'
    ? Text({ bold: true, wrap: 'truncate-end', children: [title] })
    : Text({ dimColor: t.status !== 'pending', wrap: 'truncate-end', children: [title] })
  const kids = [lead, body]
  if (tail) kids.push(Text({ dimColor: true, children: ['  ' + clip(tail, Math.max(10, Math.floor(width / 3)))] }))
  return Box({ flexDirection: 'row', children: kids })
}

// ---------- drawing ----------

function drawRow(el, e) {
  const p = G ? progress(G) : null
  const t = busy(G) ? eta(G, now) : null
  const work = working && !(G && G.status === 'running') ? { calls: turnCalls } : null
  const celebrate = !!G && G.status === 'met' && now - (G.endedAt || 0) < CELEBRATE_MS
  const r = rowOf(G ? { ...G, title: mask(G.title), celebrate, background: G.status === 'running' && !working ? background : 0 } : null, p, t ? t.ms : 0, work, lastTurn, now)
  if (!r) return null // a chat that has done nothing yet: no row at all
  const desk = e.surface === 'desktop' || e.surface === 'mobile'
  const width = Math.max(40, (e.props && e.props.bodyColumns) || 100)
  const planned = G && (r.state === 'running' || r.state === 'planning' || r.state === 'done' || r.state === 'stopped') ? visibleTasks(G) : []
  // no plan to show: the card lists this turn's latest operations instead, so hovering always
  // shows what Claude is doing, even in a chat where Claude never made a plan
  const steps = planned.length ? planned : (r.state === 'working' || r.state === 'last') ? ops.map(opStep) : []
  const list = steps.slice(0, 20).map((s) => stepRow(el, s, Math.min(60, width - 6)))
  // Collapsed to the one row; while the pointer rests on it the steps show in a card floating
  // right above it, as if the row grew upward: absolutely placed, so nothing moves (the surface
  // does it, no hook runs), and gone when the pointer leaves
  if (desk) {
    const row = rowSvg(r)
    const alt = describe(r)
    const centred = (kids) => el.Box({ flexDirection: 'row', justifyContent: 'center', paddingX: 1, children: kids })
    if (!steps.length) return centred([el.Svg({ source: row.svg, alt, width: row.width, height: row.height })])
    // The desktop lifts the card out into a popover and sets its left edge on the left edge of the
    // keyed Box it hangs under, whatever the alignment or offsets (renderer source, 2026-10-07);
    // the frame is always FRAME.w wide. So the keyed Box is exactly FRAME.w wide, centred: the
    // row is drawn into it, padded with blank room when narrower, and when wider the parts that
    // stick out are drawn as two more pieces of the same image on either side, outside the hover.
    const card = stepsSvg(steps.slice(0, 20).map((t) => ({ status: t.status === 'active' && !busy(G) ? 'paused' : t.status, title: mask(t.title), tail: mask(t.op ? t.tail : taskTail(t)) })))
    const pop = el.Box({ position: 'absolute', bottom: 1, left: 0, display: 'none', hover: { display: 'flex' }, children: [el.Svg({ source: card.svg, alt: steps.map((t) => t.title).join(', '), width: card.width, height: card.height })] })
    const span = Math.max(row.width, FRAME.w)
    const pad = (span - row.width) / 2
    const side = Math.floor((span - FRAME.w) / 2)
    // every Svg needs a non-blank alt, or the desktop drops it (why 1.8.1's spacer never showed)
    const piece = (x, w, a) => el.Svg({ source: cropSvg(row, x - pad, w), alt: a, width: w, height: row.height })
    const kids = [el.Box({ key: 'goal-row', children: [piece(side, FRAME.w, alt), pop] })]
    if (side > 0) {
      kids.unshift(piece(0, side, '…'))
      kids.push(piece(side + FRAME.w, span - side - FRAME.w, '…'))
    }
    return centred(kids)
  }
  const spans = rowSpans(r, width)
  const row = el.Box({ flexDirection: 'row', paddingX: 1, children: spans.map((sp, i) => el.Text({ key: 's' + i, color: sp.color, dimColor: sp.dim, wrap: 'truncate-end', children: [sp.text] })) })
  if (!list.length) return row
  const card = el.Box({ flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, children: list })
  const pop = el.Box({ position: 'absolute', bottom: 1, left: 0, width: '100%', display: 'none', hover: { display: 'flex' }, flexDirection: 'row', justifyContent: 'center', children: [card] })
  return el.Box({ key: 'goal-row', flexDirection: 'column', children: [row, pop] })
}

const STEP_HUE = { done: '#72cf9f' }


function stepRow(el, t, width) {
  const { Box, Text } = el
  const tail = mask(t.op ? t.tail : taskTail(t))
  const lead = t.status === 'done'
    ? Text({ color: STEP_HUE.done, children: ['✓ '] })
    : t.status === 'active'
      ? Text({ children: ['▶ '] })
      : Text({ dimColor: true, children: ['○ '] })
  const title = Text({ dimColor: t.status === 'done', wrap: 'truncate-end', children: [mask(t.title)] })
  const kids = [lead, title]
  if (tail) kids.push(Text({ dimColor: true, children: ['  ' + clip(tail, Math.max(10, Math.floor(width / 3)))] }))
  return Box({ flexDirection: 'row', children: kids })
}

async function openPane($) {
  now = await $.clock.now()
  await loadOthers($)
  paneOpen = true
  await $.ui.open({ id: PANE, title: 'Goal meter', focus: true, closeOnEscape: true })
}

function otherRow(el, g, width) {
  const { Box, Text } = el
  const p = progress(g)
  const name = clip(mask(`${g.label || basename(g.cwd)}: ${g.title}`), Math.max(16, Math.floor(width * 0.4)))
  let tail
  if (g.status === 'met') tail = 'done ✓'
  else if (g.status !== 'running') tail = 'stopped'
  else if (!(g.planned || g.planAt)) tail = 'planning'
  else {
    const t = eta(g, now)
    tail = `${p.pct}% · ${t ? '~' + minutes(t.ms) : p.doneN + '/' + p.n}`
  }
  const w = Math.max(8, Math.min(24, width - name.length - tail.length - 6))
  return Box({
    flexDirection: 'row',
    columnGap: 2,
    children: [
      Text({ wrap: 'truncate-end', children: [name] }),
      Text({ color: g.status === 'met' ? 'green' : 'cyan', children: [bar(p.fraction, w)] }),
      Text({ dimColor: true, children: [tail] }),
    ],
  })
}

function drawPane(el, width, surface) {
  const { Box, Text } = el
  const rows = []
  if (G) {
    const p = progress(G)
    // the same row as above the prompt, in usage-band's style
    const row = drawRow(el, { surface, props: { bodyColumns: width } })
    if (row) rows.push(row)
    const stats = statsLine(G, p)
    if (stats) rows.push(Text({ dimColor: true, children: [stats] }))
    rows.push(Text({ children: [' '] }))
    const tasks = G.tasks.filter((t) => !t.replaced)
    if (!tasks.length) rows.push(Text({ dimColor: true, children: ['No task plan yet.'] }))
    for (const t of tasks) rows.push(taskRow(el, t, width))
    if (G.check && G.check.reason) {
      rows.push(Text({ children: [' '] }))
      rows.push(Text(G.check.met === false ? { color: 'yellow', children: [`Last goal check: not met yet: ${mask(G.check.reason)}`] } : { dimColor: true, children: [`Last goal check: ${mask(G.check.reason)}`] }))
    }
  } else {
    rows.push(Text({ dimColor: true, children: ['这个对话还没有任务计划。Claude 接到多步任务时会自己列出来。'] }))
  }
  const rest = others.filter((g) => g.sessionId !== sessionId)
  rows.push(Text({ children: [' '] }))
  rows.push(Text({ bold: true, children: [`Other chats (${rest.length})`] }))
  if (!rest.length) rows.push(Text({ dimColor: true, children: ['No other chat has a goal in the last 12 hours.'] }))
  for (const g of rest.slice(0, 15)) rows.push(otherRow(el, g, width))
  rows.push(Text({ children: [' '] }))
  rows.push(Text({ dimColor: true, children: [`/${commandName} hide|show (the band) · /${commandName} strict ${settings.strict ? 'off' : 'on'} · /${commandName} ask ${settings.ask ? 'off' : 'on'} · /${commandName} clear`] }))
  return Box({ flexDirection: 'column', children: rows })
}

function plainText() {
  if (!G) return '这个对话还没有任务计划。'
  const p = progress(G)
  const lines = [`${label(G)}: ${mask(G.title)}`, `${headline(G, p)}  ${bar(p.fraction, 30)}`, statsLine(G, p)]
  for (const t of G.tasks.filter((x) => !x.replaced)) lines.push(`${ICON[t.status] || '○'} ${mask(t.title)}  ${mask(taskTail(t))}`)
  return lines.filter(Boolean).join('\n')
}
