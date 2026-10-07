// Goal Meter's plan: the task list Claude keeps through the mod's own tool, and
// what the bar, the ETA, and the goal check read from it. Pure functions: no mods
// API calls here, so the harness tests can drive them directly.

export const SIZES = { S: 1, M: 2, L: 3 }

const STOP = /^(clear|stop|off|cancel|end|none|reset)$/i

export function isStopWord(text) {
  return STOP.test(String(text || '').trim())
}

export function titleOf(condition) {
  const line = String(condition || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || 'Goal'
  return line.length > 160 ? line.slice(0, 159) + '…' : line
}

export function newGoal({ sessionId, condition, now, cwd, kind = 'goal' }) {
  return {
    sessionId,
    kind,
    title: titleOf(condition),
    condition: String(condition || '').slice(0, 2000),
    cwd: cwd || '',
    startedAt: now,
    planAt: 0,
    endedAt: 0,
    status: 'running',
    active: true,
    lastTurnEnd: 0,
    interrupted: false,
    tasks: [],
    nextId: 1,
    firstPlan: 0,
    check: null,
    checks: 0,
    updatedAt: now,
  }
}

function sizeOf(v) {
  const s = String(v || '').trim().toUpperCase().charAt(0)
  return SIZES[s] ? s : 'M'
}

function clean(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function weight(t) {
  return SIZES[t.size] || 2
}

// Tasks still part of the plan: dropped and replaced ones don't count
export function live(goal) {
  return goal.tasks.filter((t) => t.status !== 'dropped' && !t.replaced)
}

// The step the row names: the one running, else the next one up; '' when none is left
export function currentStep(goal) {
  const tasks = live(goal)
  const t = tasks.find((x) => x.status === 'active') || tasks.find((x) => x.status === 'pending')
  return t ? t.title : ''
}

export function progress(goal) {
  const tasks = live(goal)
  const total = tasks.reduce((a, t) => a + weight(t), 0)
  const done = tasks.filter((t) => t.status === 'done')
  const doneW = done.reduce((a, t) => a + weight(t), 0)
  return {
    total,
    doneW,
    doneN: done.length,
    n: tasks.length,
    active: tasks.filter((t) => t.status === 'active'),
    pct: total ? Math.round((100 * doneW) / total) : 0,
    fraction: total ? doneW / total : 0,
  }
}

// The ETA at this goal's own pace: time since the plan per unit of finished
// work, times the work left. Nothing until two tasks are done.
export function eta(goal, now) {
  const p = progress(goal)
  if (goal.status !== 'running' || p.doneN < 2 || p.doneW <= 0 || p.doneW >= p.total) return null
  const since = goal.planAt || goal.startedAt
  const per = Math.max(0, now - since) / p.doneW
  const ms = Math.round(per * (p.total - p.doneW))
  return { ms, at: now + ms }
}

// Accepts [{ title, size }], plain strings, or the same as a JSON string
export function normalizeTasks(raw) {
  let list = raw
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      list = list.split(/\r?\n/)
    }
  }
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (typeof item === 'string') {
      const title = clean(item.replace(/^\s*[-*\d.)\]]+\s*/, ''), 140)
      if (title) out.push({ title, size: 'M' })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const title = clean(item.title ?? item.subject ?? item.name ?? item.task ?? item.description, 140)
    if (title) out.push({ title, size: sizeOf(item.size) })
  }
  return out.slice(0, 60)
}

function idsOf(input) {
  const raw = Array.isArray(input.ids) ? input.ids : input.id !== undefined ? [input.id] : []
  return raw.map((v) => Number(String(v).replace(/^#/, ''))).filter((n) => Number.isInteger(n) && n > 0)
}

function addTasks(goal, list, now, origin) {
  for (const t of list) {
    goal.tasks.push({ id: goal.nextId++, title: t.title, size: t.size, status: 'pending', by: '', addedAt: now, startedAt: 0, doneAt: 0, origin, note: '' })
  }
}

const WORD = { pending: 'todo', active: 'running', done: 'done', dropped: 'dropped' }

export function listText(goal) {
  const p = progress(goal)
  const lines = [`Plan: ${p.doneN} of ${p.n} tasks done, ${p.pct}% of the work.`]
  for (const t of goal.tasks) {
    if (t.replaced) continue
    const who = t.status === 'active' && t.by ? ` by ${t.by}` : ''
    lines.push(`#${t.id} ${WORD[t.status] || t.status}  ${t.title} (${t.size})${who}`)
  }
  return lines.join('\n')
}

// The next step to do starts by itself when nothing is under way (marked `auto`)
function autoStart(goal, now) {
  if (goal.status !== 'running') return
  const live = goal.tasks.filter((t) => !t.replaced && t.status !== 'dropped')
  if (live.some((t) => t.status === 'active')) return
  const next = live.find((t) => t.status === 'pending')
  if (next) Object.assign(next, { status: 'active', startedAt: now, auto: true })
}

// One call of the task tool. Returns { ok, text } and changes the goal in place.
export function applyAction(goal, input, { now, by = '' } = {}) {
  const action = String(input.action || 'show').toLowerCase()
  const fail = (msg) => ({ ok: false, text: `Goal meter: ${msg}\n${listText(goal)}` })
  let unstarted = 0
  if (action === 'plan' || action === 'add') {
    const list = normalizeTasks(input.tasks)
    if (!list.length) return fail(`"${action}" needs tasks: [{ "title": "...", "size": "S" | "M" | "L" }].`)
    if (action === 'plan' && goal.planAt) {
      // a new plan replaces the work not started yet; finished and running tasks stay
      for (const t of goal.tasks) if (t.status === 'pending') t.replaced = true
    }
    const first = !goal.planned && !goal.planAt
    addTasks(goal, list, now, first ? 'plan' : 'later')
    if (first) {
      goal.planAt = now
      goal.planned = true
      goal.firstPlan = list.length
    }
  } else if (action === 'start' || action === 'done' || action === 'drop') {
    const ids = idsOf(input)
    if (!ids.length) return fail(`"${action}" needs the task's id.`)
    const tasks = ids.map((id) => goal.tasks.find((t) => t.id === id && !t.replaced))
    const missing = ids.filter((id, i) => !tasks[i])
    if (missing.length) return fail(`no task #${missing.join(', #')}.`)
    if (action === 'done') unstarted = tasks.filter((t) => t.status === 'pending').length
    for (const t of tasks) {
      if (action === 'start') {
        t.status = 'active'
        t.startedAt = t.startedAt || now
        if (by) t.by = clean(by, 32)
      } else if (action === 'done') {
        // never started (marked done with others at the end, or skipped to): when it ran is not
        // known, so it shows no time rather than a made-up one
        if (t.status === 'pending') t.untimed = true
        t.status = 'done'
        t.startedAt = t.startedAt || now
        t.auto = false
        t.doneAt = now
        if (input.note) t.note = clean(input.note, 140)
      } else {
        t.status = 'dropped'
        t.doneAt = now
        t.note = clean(input.note || 'no longer needed', 140)
      }
    }
  } else if (action !== 'show') {
    return fail(`unknown action "${action}". Use plan, add, start, done, drop, or show.`)
  }
  // Steps run in order: whenever none is under way, the next one starts by itself, so a plan
  // marked only with "done" still times every step. A "start" of another step puts back the one
  // that started by itself, as if it never had.
  if (action === 'start') {
    const chosen = new Set(idsOf(input))
    for (const t of goal.tasks) if (t.auto && t.status === 'active' && !chosen.has(t.id)) Object.assign(t, { status: 'pending', startedAt: 0, auto: false })
  }
  if (action !== 'show') autoStart(goal, now)
  goal.updatedAt = now
  // done without a start: the row can only give such a step the time since the step before it
  // ended, so a batch marked at the end reads as one long step and the rest at 0s
  const hint = unstarted ? `\n${unstarted} step(s) marked done without having started show no time. Call "done" as each step finishes: the next one starts by itself.` : ''
  return { ok: true, text: listText(goal) + hint }
}

// The goal check's verdict, from the text the engine records for it. The shape
// is not documented, so this reads both a JSON-ish record and plain words.
export function parseCheck(text) {
  const t = String(text || '')
  const notMet = /"met"\s*:\s*false|\bmet\s*[=:]\s*false|\bnot\s+(?:yet\s+)?(?:been\s+)?(?:met|achieved|satisfied|complete)|\bunmet\b|\bnot\s+satisfied\b/i.test(t)
  const met = !notMet && /"met"\s*:\s*true|\bmet\s*[=:]\s*true|\b(?:condition|goal)\b[^.\n]{0,60}\b(?:is|was|has been)\s+(?:met|achieved|satisfied)\b/i.test(t)
  const m = t.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/) || t.match(/\breason\b[^:\n]{0,20}:\s*([\s\S]+)/i)
  const reason = clean(m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ') : '', 300)
  return { met, notMet, reason }
}

export const TOOL_SPEC = {
  name: 'tasks',
  description:
    'Goal meter: the task plan the user watches as a progress bar while a /goal runs. ' +
    'Call action "plan" first with every task needed to meet the goal, in order, each sized S, M, or L. ' +
    'Call "start" with a task id when you begin it (set "by" to a subagent\'s short name when one does it) and "done" when it is finished. ' +
    'Call "add" for work you discover or when the goal check says the goal is not met yet, and "drop" for a task no longer needed. ' +
    'Keep it accurate: the bar and the ETA come only from this list.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['plan', 'add', 'start', 'done', 'drop', 'show'] },
      goal: { type: 'string', description: 'For plan: a few words naming the whole task, in the user\'s language; shown on the progress row' },
      tasks: {
        type: 'array',
        description: 'For plan and add: the tasks in order.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'What the task delivers, in a few words' },
            size: { type: 'string', enum: ['S', 'M', 'L'], description: 'S: a few minutes. M: a solid chunk. L: the big piece.' },
          },
          required: ['title'],
        },
      },
      id: { type: 'number', description: 'For start, done, and drop: the task number' },
      ids: { type: 'array', items: { type: 'number' }, description: 'Several task numbers at once' },
      by: { type: 'string', description: 'For start: who does it, "main" or the subagent\'s short name' },
      note: { type: 'string', description: 'For done or drop: one short line' },
    },
    required: ['action'],
  },
}

export function instruction(tool) {
  return (
    `Goal meter is on for this goal: the user watches your progress as a bar built from your task plan. ` +
    `Before you start the work, call ${tool} (load it with ToolSearch if it is deferred) with action "plan" and every task needed to meet the goal, in order, each sized S, M, or L. ` +
    `Call "start" with a task's id when you begin it and "done" when it is finished. ` +
    `If you find more work, or the goal check says the goal is not met yet, call "add" with the new tasks. ` +
    `When a subagent does a task, call "start" with "by" set to its short name, and "done" when it reports back.`
  )
}

export function nudge(tool) {
  return `Reminder from the goal meter: this /goal has no task plan yet, so the user's progress bar is empty. Call ${tool} with action "plan" now (every task to meet the goal, in order, sized S, M, or L), then mark tasks as you go.`
}

export function strictDeny(tool) {
  return `Goal meter (strict): plan the goal before changing files. Call ${tool} with action "plan" first, then retry this.`
}

// Sent once in the system prompt (session side of the cache boundary, never changes), so the row
// fills in without a /goal: Claude plans any multi-step piece of work it takes on
export function autoPlan(tool) {
  return (
    `# Progress row\n` +
    `The user watches a progress row above the prompt, built from your task plan. ` +
    `When a request needs several steps of work (roughly three or more steps that use tools), call ${tool} ` +
    `before your first other tool call, with action "plan", "goal" (a few words naming the whole task, in the user's language) and the steps in order, ` +
    `each with a short title in the user's language and a size S, M or L. ` +
    `Keep every step title within 15 Chinese characters (or 30 Latin letters), one thing per step: the card that lists them cannot grow wider and cuts longer titles. ` +
    `This includes picking up earlier work: "continue", resuming from a handoff, or fixing what the user just reported. ` +
    `The first step starts by itself. Call "done" with a step's id the moment it is finished, one step at a time, each as it happens, never several at the end: ` +
    `the next step then starts by itself. Call "start" only to take up a step out of order. "add" new steps you discover, ` +
    `"drop" ones no longer needed. A new, unrelated request gets a new "plan". ` +
    `List only steps you do yourself, never one that waits on the user (their reply, a screenshot, a check on their side). ` +
    `Before you end your turn, every step is done or dropped, unless background work you started is still carrying it. ` +
    `Skip all of this for quick answers, single lookups and one-step edits.`
  )
}

// Said once in a turn that has run a few tools with no plan: the row shows only "working" until one exists
export function autoNudge(tool) {
  return (
    `This request is taking several tool calls and the progress row above the prompt has no plan to show. ` +
    `If more work is ahead, call ${tool} with action "plan" now (a "goal" and the steps), then mark the steps already finished as done. ` +
    `If you are about to answer, ignore this.`
  )
}
