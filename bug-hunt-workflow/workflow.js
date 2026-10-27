export const meta = {
  name: 'bug-hunt',
  description: 'Chunked bug hunt: fresh hunter agent per code chunk, then fresh skeptic agents try to refute every finding (lens-diverse panel for severe or cross-boundary claims)',
  whenToUse: 'Bug hunting over a codebase or a large diff; args = { root, chunks: [{id, files, note?}], focus?, escalateAll? } or refute-only: { root, findings: [...] }',
  phases: [
    { title: 'Hunt', detail: 'one clean-context agent per chunk' },
    { title: 'Refute', detail: '1 skeptic per finding; 3 lens-diverse skeptics for critical/high or external-dependency claims' },
  ],
}

const ROOT = (args && args.root) || '.'
const CHUNKS = (args && args.chunks) || []
const GIVEN_FINDINGS = (args && args.findings) || null
const FOCUS = (args && args.focus) || 'any real defect: logic errors, wrong conditions, off-by-one, null/undefined handling, error handling gaps, race conditions, resource leaks, security issues, wrong API usage, broken edge cases'
const ESCALATE_ALL = !!(args && args.escalateAll)

if (!CHUNKS.length && !(GIVEN_FINDINGS && GIVEN_FINDINGS.length)) throw new Error('pass args.chunks (full run) or args.findings (refute-only run)')

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    files_read: { type: 'array', items: { type: 'string' }, description: 'Plain file paths only, no annotations' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string' },
          description: { type: 'string' },
          trigger: { type: 'string', description: 'Concrete input/state that makes it fail, and the wrong result' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          evidence: { type: 'string', description: 'The relevant code, quoted verbatim (short)' },
          external_dependency: { type: 'boolean', description: 'true if the claim relies on behaviour of code/data outside this repository (another service, DB contents, external system)' },
        },
        required: ['file', 'line', 'title', 'description', 'trigger', 'severity', 'evidence', 'external_dependency'],
      },
    },
  },
  required: ['files_read', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['refuted', 'confirmed', 'uncertain'] },
    reasoning: { type: 'string' },
    counter_evidence: { type: 'string', description: 'file:line references that support the verdict' },
  },
  required: ['verdict', 'reasoning', 'counter_evidence'],
}

// Distinct lenses: three copies of one prompt mostly repeat the same shallow check.
const LENSES = {
  standard: 'Trace the trigger: look for upstream guards, validation, callers that can never pass that input, type/framework guarantees, defaults, tests that cover the case, or code that makes the path unreachable.',
  trace: 'Follow the execution/data path END TO END, step by step, until the claimed failure would actually materialise: across method boundaries, into persistence (does the row/file/request really get written or sent?), and into other repositories on disk if the claim depends on them. Do not stop at the first plausible step — the claim is wrong if any later step never happens.',
  crosscheck: 'Cross-check intent and context: docs, code comments, README, sibling variants (PROD vs DEV, other services, other similar files), tests and config. Decide whether the behaviour is deliberate and documented, and whether the claim\'s premises (names, values, enum members, column contents) are actually true.',
}

const needsPanel = (f) => ESCALATE_ALL || f.severity === 'critical' || f.severity === 'high' || f.external_dependency === true

const refutePrompt = (f, lens) => `A different agent claims the following bug exists. Your ONLY job is to try to prove it WRONG. You did not write this claim and have no reason to defend it. Repository root: ${ROOT}

Claim${f.chunk ? ` (from slice ${f.chunk})` : ''}:
- Location: ${f.file}:${f.line}
- Title: ${f.title}
- Severity claimed: ${f.severity}
- Description: ${f.description}
- Trigger: ${f.trigger}
- Quoted evidence: ${f.evidence}

How to work (${lens} lens):
- Open the file yourself; check the quoted code really exists at that location.
- ${LENSES[lens]}
- verdict = "refuted" if you find concrete evidence the bug cannot happen as described (or the code is not there).
- verdict = "confirmed" if you traced the path and the failure really occurs.
- verdict = "uncertain" only if it depends on something you cannot see (runtime config, external service).
- Cite file:line for everything in counter_evidence. Do not modify any file. Do not open any .env* file.`

// disputed = a skeptic refuted it while another confirmed: never settle that by majority, a single well-traced refutation may be the right one.
const decide = (vs) => {
  const refuted = vs.filter(v => v.verdict === 'refuted').length
  const confirmed = vs.filter(v => v.verdict === 'confirmed').length
  if (!vs.length) return 'uncertain'
  if (refuted && confirmed) return 'disputed'
  if (refuted * 2 > vs.length) return 'refuted'
  if (confirmed * 2 > vs.length) return 'confirmed'
  return 'uncertain'
}

const judge = (f) => {
  const lenses = needsPanel(f) ? ['standard', 'trace', 'crosscheck'] : ['standard']
  return parallel(lenses.map((lens) => () =>
    agent(refutePrompt(f, lens), { label: `refute:${f.file.split('/').pop()}:${f.line}:${lens}`, phase: 'Refute', schema: VERDICT_SCHEMA })
      .then(v => v && { ...v, lens })))
    .then((votes) => {
      const vs = votes.filter(Boolean)
      return { ...f, status: decide(vs), panel: lenses.length > 1, votes: vs }
    })
}

const order = { critical: 0, high: 1, medium: 2, low: 3 }
const bySeverity = (a, b) => order[a.severity] - order[b.severity]
const bucket = (all) => ({
  confirmed: all.filter(f => f.status === 'confirmed').sort(bySeverity),
  disputed: all.filter(f => f.status === 'disputed').sort(bySeverity),
  uncertain: all.filter(f => f.status === 'uncertain').sort(bySeverity),
  refuted: all.filter(f => f.status === 'refuted'),
})

if (GIVEN_FINDINGS && GIVEN_FINDINGS.length) {
  const judged = await parallel(GIVEN_FINDINGS.map((f) => () => judge(f)))
  return { ...bucket(judged.filter(Boolean)), coverage: [] }
}

const results = await pipeline(
  CHUNKS,
  (chunk) => agent(huntPrompt(chunk), { label: `hunt:${chunk.id}`, phase: 'Hunt', schema: FINDINGS_SCHEMA }),
  (hunt, chunk) => {
    if (!hunt) { log(`hunt:${chunk.id} returned nothing (skipped or failed)`); return { chunk: chunk.id, failed: true, files_read: [], judged: [] } }
    log(`${chunk.id}: ${hunt.findings.length} finding(s), ${hunt.findings.filter(needsPanel).length} to panel, ${hunt.files_read.length}/${chunk.files.length} files read`)
    return parallel(hunt.findings.map((f) => () => judge({ ...f, chunk: chunk.id })))
      .then((judged) => ({
        chunk: chunk.id,
        failed: false,
        files_read: hunt.files_read,
        unread: chunk.files.filter(x => !hunt.files_read.some(r => r.replace(/\\/g, '/').toLowerCase().includes(x.replace(/\\/g, '/').toLowerCase()))),
        judged: judged.filter(Boolean),
      }))
  },
)

function huntPrompt(chunk) {
  return `You are hunting for bugs in ONE slice of a codebase. Repository root: ${ROOT}

Your slice (${chunk.id})${chunk.note ? ` — ${chunk.note}` : ''}:
${chunk.files.map(f => `- ${f}`).join('\n')}

Rules:
- Read EVERY file of your slice in full. List what you actually read in files_read.
- You may open other files (callers, definitions, types, config) to understand behaviour, but only REPORT bugs located in your slice.
- Look for: ${FOCUS}.
- Report only concrete defects with a specific trigger (input/state → wrong outcome). No style issues, no "could be refactored", no missing-test notes, no speculation about code you have not read.
- Quote the offending code verbatim in evidence and give the exact line.
- Set external_dependency=true when the claim depends on what code or data outside this repository does (another service writes/doesn't write something, DB contents, external API).
- An empty findings list is a valid answer. Do not invent bugs to fill a quota, and do not stop early either: finish the whole slice.
- Do not modify any file.`
}

const chunks = results.filter(Boolean)
return {
  ...bucket(chunks.flatMap(c => c.judged)),
  coverage: chunks.map(c => ({ chunk: c.chunk, failed: c.failed, files_read: c.files_read.length, unread: c.unread || [] })),
}
