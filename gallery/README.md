# The dsh-langgraph gallery

Six small graphs that each earn their keep at a real seam. Open
[`index.html`](index.html) for the visual gallery — it is a static page, no server or build
step. Every graph is a plain JSON spec, so it can be read, copied, reviewed, and shared
without shipping JavaScript.

| Graph | The seam | Gate | Tools | Spec |
|---|---|---|:---:|---|
| **Research brief** | fan out over files, extract one row per file, approve an outline, write | yes | `glob`, `read`, `write` | [`specs/research-brief.lg.json`](specs/research-brief.lg.json) |
| **Repo scan** | read a set of source files in parallel and synthesize one review | no | `glob`, `read`, `write` | [`specs/repo-scan.lg.json`](specs/repo-scan.lg.json) |
| **PR review** | read the current diff, draft a review, ask before posting | yes | `bash`, `write` | [`specs/pr-review.lg.json`](specs/pr-review.lg.json) |
| **Incident triage** | read many logs, classify, ask whether to page | yes | `glob`, `read`, `write` | [`specs/incident-triage.lg.json`](specs/incident-triage.lg.json) |
| **Data extract** | one JSON record per file, then one JSON array | no | `glob`, `read`, `write` | [`specs/data-extract.lg.json`](specs/data-extract.lg.json) |
| **Approval plan** | plan with tools, human approval, execute, write | yes | `glob`, `read`, `write`, `bash` | [`specs/approval-plan.lg.json`](specs/approval-plan.lg.json) |

The graphs are deliberately coarse: a map for real fan-out, an agent for open work, a gate
for a decision that should not be re-decided by a model. They are not a node catalogue.

## Run one

The spec is loaded from the session workspace. Validate first; `compose` stores an
immutable, session-owned graph; `run` starts a durable thread.

```js
langgraph_compose({ action: "validate", path: "gallery/specs/research-brief.lg.json" })
langgraph_compose({ action: "compose",  path: "gallery/specs/research-brief.lg.json" })
langgraph_run({ graph: "lg_adhoc_…", input: { pattern: "topics/*.txt" } })
```

A gate returns `status: "interrupted"`. Read the outline from the thread state, ask the
human, then resume the same thread with the raw answer:

```js
langgraph_run({ graph: "lg_adhoc_…", thread: "lg_lg_adhoc_…", resume: "Approve" })
```

The tools must be visible in the calling session. The gallery uses only `glob`, `read`,
`write`, and `bash`; the agent nodes list their own tools. A spec can be copied into any
workspace and edited as JSON.

## Why these six

They cover the shapes that actually change the work:

- **fan-out** over a list you do not know until runtime (research, repo scan, logs, data);
- **aggregation** after the fan-out;
- **human signatures** before an irreversible action (write, page, post);
- **open work inside a role** rather than one node per tool call (approval plan);
- **durable state** when the run must survive a turn or a Host restart.

## When not to use one

Do not start with a graph for a one- or two-step task, a single tool call, or a task a
registered graph already matches. The ordinary DSH loop is still the default. The plugin's
own comparison on a 12-topic brief is intentionally honest: the ordinary loop was
53s / 124K tokens; a forced coarse graph was 1m38s / 462K; the fine map graph was
55s / 226K. A graph is a seam tax, not a token discount.

## Make one

1. Copy a spec from [`specs/`](specs/).
2. Call `langgraph_compose({ action: "validate", spec })` and fix the IR paths it reports.
3. `compose` it, run it on a small input, and pin the prompt and expected output next to it.
4. Open a PR with the `.lg.json`, a short README row, and the validated output. No arbitrary
   JS is needed; a graph spec is reviewable data.
