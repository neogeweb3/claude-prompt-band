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

// Background work that outlives the step it was started in counts as a step of its own on the row:
// a plan whose steps are all done while a shell or agent it started still runs is not 100% (Neo,
// 2026-10-09: a dev server neo-mate started while reproducing a bug, left on after all three steps
// were done, read 3/3 · 100% beside 后台 1 个任务在跑). Work still inside the step that started it is
// that step's, already shown by its ▶ and clock, and is not counted twice (the same day, a Codex review
// run in the background under its own step "Codex 外审一轮" read right as 8/11). Each such task weighs
// what an average step of the plan weighs, and is done once it no longer runs. The time left still
// comes from the steps alone: a background task gives no minutes.
// A step of the plan is running now
const anyActive = (goal) => goal.tasks.some((t) => t.status === 'active' && !t.replaced)

// The plan's background work that counts as steps of its own: work still running while no step of the
// plan runs, and work that had ended so (\`own\`, settled when it ended). Work running while a step runs
// belongs to that step, whichever step launched it (Neo, 2026-10-09: a test run started eight seconds
// before Claude moved from step 2 to step 3 read as a step of its own, 3/7, and 有点懵逼)
export const ownWork = (goal) => (Array.isArray(goal.bg) ? goal.bg : []).filter((b) => !b.outside && (b.status === 'running' ? !anyActive(goal) : b.own))

export function shown(goal) {
  const p = progress(goal)
  const bg = ownWork(goal)
  if (!bg.length) return p
  const each = p.n ? p.total / p.n : 1
  const doneB = bg.filter((b) => b.status === 'done').length
  const total = p.total + each * bg.length
  const doneW = p.doneW + each * doneB
  return { ...p, total, doneW, doneN: p.doneN + doneB, n: p.n + bg.length, pct: Math.round((100 * doneW) / total), fraction: doneW / total }
}

// Fold what the last turn left running (classic.Stop's background_tasks: only work still in flight)
// into the plan's own list. `seen` maps each task id to { at, step, unknown }: when it started and
// the step running then (from the background tool call that launched it, or the log's record of
// it), or `unknown` when neither is on record. A task started before the plan began, or of unknown
// start, is `outside` the plan: listed in its card, never counted, never holding it open (a server
// left on by an earlier plan; 2026-10-09, after an update reloaded the mod, one such server was
// taken for new and filed under the running step). A task of the plan's still running once its step
// is no longer running (done, dropped, or none at all) becomes work of its own (`own`, kept from
// then on). A task that no longer runs is done, at the time its notification gives (`ended`, from
// the log) or else now. Returns how many of the plan's tasks still run.
export function foldBackground(goal, list, seen, now, ended = new Map()) {
  const running = new Set(list.map((b) => String(b.id)))
  const bg = Array.isArray(goal.bg) ? goal.bg : (goal.bg = [])
  for (const b of list) {
    const id = String(b.id)
    if (bg.some((x) => x.id === id)) continue
    const from = seen.get(id) || { at: now, step: 0, unknown: true }
    const outside = !!from.unknown || from.at < goal.startedAt
    bg.push({ id, title: String(b.description || b.command || b.type || '后台任务').replace(/\s+/g, ' ').trim().slice(0, 80), kind: String(b.type || ''), status: 'running', startedAt: from.unknown ? 0 : from.at, step: from.step || 0, ...(outside ? { outside: true } : {}) })
  }
  placeBackground(goal, seen)
  const active = anyActive(goal)
  for (const x of bg) {
    if (x.status !== 'running') continue
    // it ended: a step of its own only if it ran on with no step of the plan running
    if (!running.has(x.id)) Object.assign(x, { status: 'done', doneAt: Math.max(x.startedAt || 0, Math.min(now, ended.get(x.id) || now)), own: !x.outside && !active })
  }
  return bg.filter((x) => x.status === 'running' && !x.outside).length
}

// Tasks filed before their start was on record (1.8.22 took a server from an earlier plan for new
// across an update) put right from what `seen` now says (the log): their real start, and outside
// the plan if that was before it began
export function placeBackground(goal, seen) {
  for (const x of Array.isArray(goal.bg) ? goal.bg : []) {
    // 1.8.21-1.8.25 made work that outlived the step launching it a step of its own for good; work
    // that ended while some step ran was that step's
    if (x.status === 'done' && x.own && x.doneAt && stepAt(goal, x.doneAt - 1)) delete x.own
    const from = seen.get(x.id)
    if (x.status !== 'running' || x.outside || !from || from.unknown) continue
    x.startedAt = from.at
    if (from.at < goal.startedAt) { x.outside = true; delete x.own }
  }
}

// How many of the plan's own background tasks still run, as last seen
export const planRunning = (goal) => (Array.isArray(goal.bg) ? goal.bg : []).filter((x) => x.status === 'running' && !x.outside).length

// The step a finished background task ran under: the one its run overlapped most (a run launched a few
// seconds before Claude moved to the next step, or ending a few seconds after, belongs where it spent
// its time; neo-mate 2026-10-09: a unit-test run began 3s before step 5 and ran 26m in it); 0 if none
export function mainStep(goal, b, now) {
  let best = 0
  let most = 0
  for (const t of goal.tasks) {
    if (t.replaced || !t.startedAt) continue
    const end = t.doneAt || now
    const overlap = Math.min(b.doneAt || now, end) - Math.max(b.startedAt, t.startedAt)
    if (overlap > most) { most = overlap; best = t.id }
  }
  return best
}

// The step of the plan running at time `at`, or 0
export function stepAt(goal, at) {
  const t = goal.tasks.find((x) => !x.replaced && x.startedAt && x.startedAt <= at && (x.status === 'active' || (x.doneAt && at < x.doneAt)))
  return t ? t.id : 0
}

// When a background task was launched, read from the chat's log: the tool result that names its id
// ("Command running in background with ID: …"); 0 when the log does not have it
export function launchInLog(text, id) {
  if (!text || !id) return 0
  let from = 0
  for (;;) {
    const i = text.indexOf(id, from)
    if (i < 0) return 0
    const start = text.lastIndexOf('\n', i) + 1
    const end = text.indexOf('\n', i)
    from = end < 0 ? text.length : end
    try {
      const d = JSON.parse(text.slice(start, end < 0 ? undefined : end))
      const content = d && d.message && d.message.content
      if (Array.isArray(content) && content.some((c) => c && c.type === 'tool_result' && JSON.stringify(c.content || '').includes(id))) {
        const at = Date.parse(d.timestamp)
        if (at) return at
      }
    } catch {
      // not a whole JSON line, or not this kind; read on
    }
    if (end < 0) return 0
  }
}

// When a background task really ended, from the chat's log: the notification it woke the session
// with ("<task-id>ID</task-id>"), queued the moment it ended. The next Stop may come much later: a
// round of review that ended at 09:17 was taken to end at 20:24, its turn having died on an expired
// login at 09:19 with no Stop (2026-10-09). 0 if the log has none at or after `after`.
export function endInLog(text, id, after) {
  if (!text || !id) return 0
  for (const line of text.split('\n')) {
    if (!line.includes(`<task-id>${id}</task-id>`)) continue
    try {
      const at = Date.parse(JSON.parse(line).timestamp)
      if (at && at >= (after || 0)) return at
    } catch {
      // not a whole JSON line; read on
    }
  }
  return 0
}

// The time left for the whole plan, the way evidence-based scheduling does it (FogBugz, Joel
// Spolsky 2007): whoever does the work estimates each step, and the estimates are corrected by how
// they have held up. Claude gives each step its minutes; a step done shows what it really took, and
// the steps left are scaled by the plan's own record, all the minutes it estimated for the steps
// done against all they really took (a sum, not an average of each step's ratio, so the long steps
// count for more than a one-minute read that took two: the minute is too coarse to say much). Until
// the steps done were estimated at CORRECT_AFTER together, Claude's minutes are taken as given.
// A step with no minutes (a plan from before Claude gave them) goes by its size, at the pace of the
// steps done.
const CORRECT_AFTER = 5 * 60000
function expectation(goal) {
  const tasks = live(goal)
  const timed = tasks.filter((t) => t.status === 'done' && !t.untimed && t.doneAt > t.startedAt)
  const took = (t) => t.doneAt - t.startedAt
  const est = timed.filter((t) => t.minutes)
  const said = est.reduce((a, t) => a + t.minutes * 60000, 0)
  // held to between a quarter and twice. Claude's minutes run long: in the ledger of 2026-10-10
  // (201 steps, 6 chats) a step said at under 30 minutes took a tenth of them at the median, one at
  // 30 or more about two thirds. Replayed on that ledger (the steps done so far in a chat predicting
  // its next three to five), a floor of a half came out 3.8 times off, a quarter 2.2, a tenth 1.6;
  // but a tenth from the short steps would cut a long one after them far too short, and across all
  // of a chat's steps left the quarter is about as good as the half (2.4 against 2.2)
  const scale = said > 0 && said >= CORRECT_AFTER ? Math.min(2, Math.max(0.25, est.reduce((a, t) => a + took(t), 0) / said)) : 1
  const sized = timed.filter((t) => !t.minutes)
  const w = sized.reduce((a, t) => a + weight(t), 0)
  const pace = sized.length >= 2 && w ? sized.reduce((a, t) => a + took(t), 0) / w : 0
  // an answer to "how much longer" is already today's word: taken as given, never scaled (scaled,
  // a 4-minute answer read as 20 seconds, so the step was late again at once and asked again, every
  // 15 seconds: 6 forks in a row, 2026-10-08)
  return (t) => (t.estAt ? t.estAt - t.startedAt + t.span : t.minutes ? t.minutes * 60000 * scale : pace * weight(t))
}

// The running one counts down from what it is expected to take. Past that, it is late, and a late
// step is not about to end: task times have a long tail (Bernhardsson 2019: the median close to
// the estimate, the mean 1.8 times it), the longer one has overrun the longer it tends to go on,
// and neither Jira's 0 nor Jenkins' "N/A" says anything true. So until Claude gives it new minutes,
// a late step is taken to need as long again as it has overrun. The time left reads at least a
// minute while work is left.
export function eta(goal, now) {
  const p = progress(goal)
  if (goal.status !== 'running' || p.doneW >= p.total) return null
  const want = expectation(goal)
  let ms = 0
  for (const t of live(goal)) {
    if (t.status === 'done') continue
    const w = want(t)
    if (!w) return null
    const ran = t.status === 'active' ? Math.max(0, now - t.startedAt) : 0
    ms += ran <= w ? w - ran : ran - w
  }
  ms = Math.max(60000, Math.round(ms))
  return { ms, at: now + ms }
}

// When to ask Claude how much longer the running step has, read after its next tool call (the
// mod can say nothing to it while it waits, idle, on background work). Late: once past what the
// step was expected to take. Early, for a step Claude gave EARLY_FROM or more: a quarter of the
// way into its estimate, and after an answer that moved the finish by more than a STEADY share of
// the estimate, a quarter of the way into the new one; an answer that kept it, and EARLY_MAX asks,
// end the early asks (Neo, 2026-10-08: ask before it is late, but not over and over).
// Returns { task, late } or null.
const EARLY_FROM = 10
const EARLY_MAX = 2
const STEADY = 0.2
// whatever else goes wrong, a step is asked at most ASK_MAX times, ASK_GAP apart
const ASK_MAX = 4
const ASK_GAP = 2 * 60000
export function askDue(goal, now) {
  if (goal.status !== 'running') return null
  const want = expectation(goal)
  for (const t of live(goal)) {
    if (t.status !== 'active') continue
    if ((t.asks || 0) >= ASK_MAX || (t.lastAskAt && now - t.lastAskAt < ASK_GAP)) continue
    const w = want(t)
    if (w > 0 && !t.overdueSaid && now - t.startedAt > w) return { task: t, late: true }
    const span = t.span || (t.minutes || 0) * 60000
    if (t.minutes >= EARLY_FROM && !t.steady && !t.asked && (t.checks || 0) < EARLY_MAX && now - (t.estAt || t.startedAt) >= span / 4) return { task: t, late: false }
  }
  return null
}

// An ask is going out for this step: count it
export function markAsked(t, late, now) {
  if (late) t.overdueSaid = true
  else Object.assign(t, { asked: true, checks: (t.checks || 0) + 1 })
  Object.assign(t, { asks: (t.asks || 0) + 1, lastAskAt: now })
}

// Claude's answer, "minutes" more from now, for a step under way: its estimate counts from now;
// one that moved the finish little says the step is on course, so it is asked early no more
export function reestimate(t, more, now) {
  const before = t.minutes ? t.startedAt + t.minutes * 60000 : 0
  const after = now + more * 60000
  Object.assign(t, {
    minutes: Math.round(((now - t.startedAt) / 60000 + more) * 10) / 10,
    estAt: now,
    span: more * 60000,
    asked: false,
    overdueSaid: false,
    steady: before > 0 && Math.abs(after - before) <= STEADY * (before - t.startedAt),
  })
}

// Minutes Claude expects a step to take: a number above 0, up to a day; 0 when not given
function minutesOf(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n * 10) / 10, 1440) : 0
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
      if (title) out.push({ title, size: 'M', minutes: 0 })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const title = clean(item.title ?? item.subject ?? item.name ?? item.task ?? item.description, 140)
    if (title) out.push({ title, size: sizeOf(item.size), minutes: minutesOf(item.minutes) })
  }
  return out.slice(0, 60)
}

function idsOf(input) {
  const raw = Array.isArray(input.ids) ? input.ids : input.id !== undefined ? [input.id] : []
  return raw.map((v) => Number(String(v).replace(/^#/, ''))).filter((n) => Number.isInteger(n) && n > 0)
}

function addTasks(goal, list, now, origin) {
  for (const t of list) {
    goal.tasks.push({ id: goal.nextId++, title: t.title, size: t.size, minutes: t.minutes || 0, said: t.minutes || 0, status: 'pending', by: '', addedAt: now, startedAt: 0, doneAt: 0, origin, note: '' })
  }
}

const WORD = { pending: 'todo', active: 'running', done: 'done', dropped: 'dropped' }

export function listText(goal) {
  const p = progress(goal)
  const lines = [`Plan: ${p.doneN} of ${p.n} tasks done, ${p.pct}% of the work.`]
  for (const t of goal.tasks) {
    if (t.replaced) continue
    const who = t.status === 'active' && t.by ? ` by ${t.by}` : ''
    const mins = t.minutes && t.status !== 'done' ? `, ~${t.minutes}m` : ''
    lines.push(`#${t.id} ${WORD[t.status] || t.status}  ${t.title} (${t.size}${mins})${who}`)
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
    if (action === 'done') {
      // A step marked done that never started, while the next one in the list started by itself:
      // that time was this step's, not the next one's (Claude did steps it added at the end before
      // the one the list put next: a real gate, 2026-10-08, ran its clock half an hour over
      // two other steps, which then read "—"). Only for a single step: a batch marked at the end
      // says nothing about when each ran.
      const auto = goal.tasks.find((t) => t.auto && t.status === 'active' && !ids.includes(t.id))
      const pending = tasks.filter((t) => t.status === 'pending')
      if (auto && pending.length === 1 && tasks.length === 1) {
        Object.assign(pending[0], { status: 'active', startedAt: auto.startedAt })
        Object.assign(auto, { status: 'pending', startedAt: 0, auto: false })
      }
      unstarted = tasks.filter((t) => t.status === 'pending').length
    }
    for (const t of tasks) {
      if (action === 'start') {
        t.status = 'active'
        t.startedAt = t.startedAt || now
        if (by) t.by = clean(by, 32)
        // how much longer it will take from now, given when it begins or again when that changes
        const more = minutesOf(input.minutes)
        if (more) reestimate(t, more, now)
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
    'Call action "plan" first with every task needed to meet the goal, in order, each sized S, M, or L, with the minutes you expect it to take. ' +
    'Call "start" with a task id when you begin it (set "by" to a subagent\'s short name when one does it) and "done" when it is finished. ' +
    'Call "add" for work you discover or when the goal check says the goal is not met yet, and "drop" for a task no longer needed. ' +
    'When a step will take longer or shorter than you said (a build or test suite running in the background, say), call "start" with its id and "minutes", how many more from now. ' +
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
            minutes: { type: 'number', description: 'How many minutes you expect the step to take; the time left on the row comes from these' },
          },
          required: ['title'],
        },
      },
      id: { type: 'number', description: 'For start, done, and drop: the task number' },
      ids: { type: 'array', items: { type: 'number' }, description: 'Several task numbers at once' },
      by: { type: 'string', description: 'For start: who does it, "main" or the subagent\'s short name' },
      minutes: { type: 'number', description: 'For start: how many more minutes from now you expect the step to take, when that has changed' },
      note: { type: 'string', description: 'For done or drop: one short line' },
    },
    required: ['action'],
  },
}

export function instruction(tool) {
  return (
    `Goal meter is on for this goal: the user watches your progress as a bar built from your task plan. ` +
    `Before you start the work, call ${tool} (load it with ToolSearch if it is deferred) with action "plan" and every task needed to meet the goal, in order, each sized S, M, or L, with the minutes you expect it to take. ` +
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
    `each with a short title in the user's language, a size S, M or L, and "minutes", how long you expect it to take. ` +
    `Keep every step title within 15 Chinese characters (or 30 Latin letters), one thing per step: the card that lists them cannot grow wider and cuts longer titles. ` +
    `This includes picking up earlier work: "continue", resuming from a handoff, or fixing what the user just reported. ` +
    `The first step starts by itself. Call "done" with a step's id the moment it is finished, one step at a time, each as it happens, never several at the end: ` +
    `the next step then starts by itself. Call "start" only to take up a step out of order. "add" new steps you discover, ` +
    `"drop" ones no longer needed. A new, unrelated request gets a new "plan". ` +
    `The time left on the row comes from those minutes: when a step will take longer or shorter than you said (a build or test suite running in the background, say), call "start" with its id and "minutes", how many more from now. ` +
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

// Asked a quarter of the way into a long step's estimate, before it can be late
export function earlyNudge(tool, t, now) {
  const ran = Math.round((now - t.startedAt) / 60000)
  return (
    `Step #${t.id} "${t.title}" of the progress row has run ${ran} of the ${t.minutes} minutes it was given. ` +
    `Call ${tool} with action "start", id ${t.id} and "minutes", how many more from now, even if your estimate still holds; ` +
    `the time left on the row comes from it. Do not mention this in your reply.`
  )
}

// Said once when the running step has gone past the time it was given: only Claude knows how much
// longer it has (a real chat, 2026-10-08, knew it was "watching 15 more minutes")
export function lateNudge(tool, t) {
  return (
    `Step #${t.id} "${t.title}" of the progress row has run past the time it was given. ` +
    `If it needs longer, call ${tool} with action "start", id ${t.id} and "minutes", how many more from now: the time left on the row comes from it. ` +
    `If it is about to finish, ignore this. Do not mention this in your reply.`
  )
}

// What the mod asks a fork of the conversation (its own transcript, same model, nothing shown to
// the person) while Claude sits idle and background work carries the running step: the time that
// has passed is not in the transcript, so the question says it
export function forkPrompt(t, now, background) {
  const ran = Math.round((now - t.startedAt) / 60000)
  const given = t.minutes ? `; you gave it ${t.minutes}` : ''
  const bg = background.length ? ` Work you started in the background is still running: ${background.join('; ')}.` : ''
  return (
    `(A question from the progress-row mod, not from the user; answer it and nothing else.) ` +
    `Step #${t.id} "${t.title}" of your task plan has run ${ran} minutes${given}.${bg} ` +
    `From what you know of that work, how many more minutes from now until this step is done? Reply with one number of minutes only.`
  )
}

// The minutes in a fork's reply: the first number in it, above 0 and up to a day; 0 when none
export function minutesIn(text) {
  const m = String(text || '').match(/\d+(?:\.\d+)?/)
  return m ? minutesOf(m[0]) : 0
}

// Said once in a chat, on a plan that came without minutes. A chat keeps the system prompt it began
// with, through restarts (2026-10-08: a chat in a restarted app still read the old one), so one that
// began before Claude was asked for minutes only hears of them here, in a tool's reply
export function minutesHint(tool, active) {
  const now = active ? `call ${tool} with action "start", id ${active.id} and "minutes", how many more from now, and ` : ''
  return (
    `\nThese steps have no "minutes", and the time left on the progress row comes from them: ${now}give every step "minutes", how long you expect it to take, in later plans. ` +
    `Do not mention this in your reply.`
  )
}

// One line of the estimate ledger for a step just finished: what Claude first said, what it came
// to after any new word, and what the step really took. Kept across chats so that, once there is
// enough of it, estimates can be corrected by Claude's own record by length of step and by model
// (evidence-based scheduling keeps such a history per estimator); nothing reads it yet.
export function ledgerLine(t, { now, session, model }) {
  return {
    at: new Date(now).toISOString(),
    session,
    model: model || '',
    said: t.said || 0,
    final: t.minutes || 0,
    tookMin: t.untimed ? null : Math.round(((t.doneAt || now) - t.startedAt) / 6000) / 10,
    untimed: !!t.untimed,
    reestimated: !!t.estAt,
    asks: t.asks || 0,
    size: t.size,
    title: String(t.title || '').slice(0, 40),
  }
}
