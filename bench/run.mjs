/**
 * A small, reproducible DSH benchmark.
 *
 *   DSH_ROOT=/path/to/deepseek-harness node bench/run.mjs
 *   DSH_ROOT=... node bench/run.mjs fanout official
 *
 * `official` uses the stock `headless` profile (no plugin). `plain` uses the
 * `lgh` profile with the plugin linked but asks for ordinary tools. `default`
 * leaves the tool choice to the plugin prompt. `coarse`/`fine` force the graph
 * conditions from the matrix. One run per cell; see docs/BENCHMARK.md.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'

const DSH = process.env.DSH_ROOT ?? '/Users/zhinan/deepseek-harness'
const WORK = process.env.BENCH_WORK ?? resolve(DSH, '.lg-bench/work')
const CLI = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts']

const TASKS = {
  fanout: {
    files: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [
      `item-0${i + 1}.txt`,
      `Score: ${[3, 5, 2, 7, 1, 8, 4, 6][i]}\n`,
    ])),
    expected: '36',
    output: 'result.txt',
    prompt: (dir, out, suffix) => `In ${dir} there are files named item-01.txt through item-08.txt. Read every file, sum the numeric values after \`Score:\`, and write only the sum to:\n${out}\n\n${suffix}`,
  },
  report: {
    files: {
      'alpha.txt': 'Project: Alpha\nOwner: Alice\nServices: 3\n',
      'beta.txt': 'Project: Beta\nOwner: Chen\nServices: 5\n',
      'gamma.txt': 'Project: Gamma\nOwner: Dana\nServices: 4\n',
    },
    expected: 'Beta: Chen',
    output: 'result.md',
    prompt: (dir, out, suffix) => `Read these three project files:\n- ${join(dir, 'alpha.txt')}\n- ${join(dir, 'beta.txt')}\n- ${join(dir, 'gamma.txt')}\n\nWhich project has the most services? Write exactly \`ProjectName: OwnerName\` (omit the word "Project" from the project name) to:\n${out}\n\n${suffix}`,
  },
}

const CONDITIONS = {
  official: {
    profile: 'headless',
    suffix: 'Use ordinary DSH tools.',
  },
  plain: {
    profile: 'lgh',
    suffix: 'Use ordinary DSH tools. Do not use `langgraph_compose` or `langgraph_run` for this task.',
  },
  default: {
    profile: 'lgh',
    suffix: '',
  },
  coarse: {
    profile: 'lgh',
    suffix: 'Use `langgraph_compose` to define a coarse LangGraph graph, then run it with `langgraph_run`. Keep the graph at the seams: put the open-ended work inside `agent` nodes; do not create one node per file or per tool call.',
  },
  fine: {
    profile: 'lgh',
    suffix: 'Use `langgraph_compose` to define a fine-grained LangGraph graph, then run it with `langgraph_run`. Model each concrete step as explicit `tool` or `model` nodes with explicit edges. Use `map` for the per-file work if it fits.',
  },
}

function parseJsonl(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* ignore non-JSON */ }
  }
  return events
}

function summarize(text) {
  const events = parseJsonl(text)
  let steps = 0
  let total = 0
  let input = 0
  let output = 0
  const tools = {}
  let final
  for (const event of events) {
    if (event.type === 'status' && event.phase === 'step_end' && event.usage) {
      steps += 1
      input += event.usage.inputTokens ?? 0
      output += event.usage.outputTokens ?? 0
      total += event.usage.totalTokens ?? 0
    }
    if (event.type === 'tool_call' && typeof event.tool === 'string') {
      tools[event.tool] = (tools[event.tool] ?? 0) + 1
    }
    if (event.type === 'final') final = event
  }
  return { steps, tokens: { input, output, total }, tools, final: final?.reason ?? null }
}

async function runCell(taskName, conditionName) {
  const task = TASKS[taskName]
  const condition = CONDITIONS[conditionName]
  if (!task || !condition) throw new Error(`unknown task/condition ${taskName}/${conditionName}`)
  const root = resolve(WORK, `${taskName}-${conditionName}`)
  const output = join(root, task.output)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  for (const [name, content] of Object.entries(task.files)) {
    await writeFile(join(root, name), content, 'utf8')
  }
  const suffix = condition.suffix
  const prompt = task.prompt(root, output, suffix).trim()
  const started = Date.now()
  const child = spawn(process.execPath, [...CLI, '--profile', condition.profile, 'headless', '--json', '--permission-mode', 'workspace-write', '--approval-policy', 'never', prompt], {
    cwd: DSH,
    env: { ...process.env },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise(resolve => child.on('close', resolve))
  const seconds = Math.round((Date.now() - started) / 1000)
  const summary = summarize(stdout)
  let result
  try { result = (await readFile(output, 'utf8')).trim() } catch { result = undefined }
  const success = result !== undefined && result.includes(task.expected)
  return { task: taskName, condition: conditionName, profile: condition.profile, success, seconds, steps: summary.steps, tokens: summary.tokens, tools: summary.tools, result: result?.slice(0, 120) ?? null, exit: code, stderr: stderr.slice(-300) }
}

const [taskArg, conditionArg] = process.argv.slice(2)
const pairs = taskArg && conditionArg
  ? [[taskArg, conditionArg]]
  : Object.keys(TASKS).flatMap(task => ['official', 'plain', 'default'].map(condition => [task, condition]))
const results = []
for (const [task, condition] of pairs) {
  process.stderr.write(`\n== ${task} / ${condition} ==\n`)
  const result = await runCell(task, condition)
  results.push(result)
  process.stderr.write(JSON.stringify(result) + '\n')
}
console.log(JSON.stringify(results, null, 2))
