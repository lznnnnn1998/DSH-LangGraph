# PLAN-COMPOSE — 运行时图组合（JSON IR）

> 状态：讨论稿（2026-11-27）。
> **如果对话被压缩，先读这个文件。** 它记录了目标、已定决策、IR、编译器、失败恢复和 M1–M5。
> 当前版本 `1.0.1`。M1–M5 全部本地完成并验证后再 push；期间不 push、不打 tag、不发 npm。

## 0. 如果对话被压缩

1. 读本文件。
2. 读 `docs/DETAIL.md` 的 thread / checkpointer / trace 部分，和 `index.js` 的 `compile` / `executeRun` / `manageThreads`。
3. `git log --oneline` 看最后一个 M 的 commit。
4. 从第一个未完成的 M 继续。
5. **不要 push**，直到 M5 全部验证完。

## 1. 一句话

让模型在任务执行中，用一份**严格 JSON IR** 组合一张 session 拥有的图；插件用**确定性编译器**（无模型）把它翻译成 LangGraph `StateGraph`，用现有 checkpointer / helpers / trace 运行；失败时给出失败前的**两个 superstep**、依赖/SCC 和状态，模型选择 resume / edit / replay，或为失败节点之后的下游 **fork 一份新 spec** 重新组合。

## 2. 约束与非目标

- 不改 DSH / LangGraph 源码；纯插件。
- 不用 `dsh-graph-loop`。
- 不写 `graphs/*.js`；不执行模型写的 JS；不做 HMR。
- v1 只支持 JSON IR；YAML / S-expression / 矩阵是后续的前端或视图，不是 v1。
- 不支持 LangGraph Platform / Studio、token 流式、向量检索。
- IR → StateGraph 的翻译是确定性的，不调用模型；`description` 只给人看。
- M1–M5 期间不 push、不打 tag、不发 npm；全部完成并验证后一起 push。
- 运行时图仍然是“注册 entry + build(api)”，复用现有 runtime；不新建第二套执行器。

### 2.1 设计原则

- **结构在接缝，散文在节点。** 图只管阶段、依赖、分支、并行、gate、state、持久化；节点内部是模型可自由发挥的 brief。
- **默认不 compose。** 普通 agent loop 是退路；只有需要持久/并行/审批/分支时才上图。
- **coarse-first。** 默认 4–8 个阶段节点；开放工作用 `agent`，单次判断用 `model`，人工确认用 `gate`，已知原子动作用 `tool`。
- **JSON 是执行契约，不是模型的思考格式。** 模型可以先写散文计划，再序列化骨架；编译器不解析 brief。
- **过度分解是主要失败模式。** 用 prompt + lint + 预算一起防。

## 3. 已定决策（含本轮批复）

| # | 决策 |
|---|---|
| D1 | v1 节点：`tool` / `model` / `agent` / `gate` / `map` / `set`；`subagent` M4；`subgraph` 后置。`agent` 是“留白”的开放工作单元。 |
| D2 | `map` 聚合 v1 用 `append`（完成顺序）；`indexed`（按输入顺序落位）M4.1。 |
| D3 | 允许多条无条件出边 = **静态 fan-out**；复用 `map` 的 writer/reducer 校验、隐式 join、trace、失败/SCC；`map` 是动态 fan-out。 |
| D4 | 失败恢复：返回失败前的**两个 superstep** + 依赖/SCC + 状态；模型选择 retry/edit/replay，或为下游 fork 新 spec。运行时不自动改图。 |
| D5 | 循环图**不禁止**；用 SCC 分析，循环作为一个恢复单元；`maxSteps` 兜底。 |
| D6 | 独立 `langgraph_compose` 工具；新存储域 `langgraph_specs`。 |
| D7 | M1–M5 五个小版本；本地 commit，最后一起 push。 |

### D3：静态 fan-out 和 map 复用什么

| | 静态 fan-out | `map` |
|---|---|---|
| 语法 | 同一节点多条无条件 `edges` | `do: "map"` + `over` |
| 后继 | 固定的不同节点 | 同一个 body 按 item 重复 |
| fan-out 机制 | `addEdge` 多个后继 | `Send` |
| join | 隐式：多入边节点等所有前驱 | 隐式：`out` 的 reducer 聚合 |
| state 合并 | 多分支写同一字段必须有可合并 reducer | `out` 字段必须有可合并 reducer |
| 复用 | writer/reducer 校验、reducer 实现、join、trace、失败/SCC、run report | 同左 |
| 差异 | 无 `Send`；分支节点固定 | 动态数量；item/index |

实现上只有 `addEdge` 和 `Send` 的区别；校验、聚合、报告、恢复共用一套。

### D4 / D5：失败恢复与循环

- “失败前的两个 superstep”不是“两个节点”：一个 superstep 可能包含静态 fan-out 的多个分支、map 的一批 item、或一次 loop 迭代。返回失败边界 checkpoint + 前两个 checkpoint（最多 3 个），带 `tasks` / `errors` / `next` / 有界的 `values`。
- “失败节点后的图全重写”由**模型**完成：读取失败结果里的依赖/SCC/下游，调用 `langgraph_compose` 写一份新的下游 spec，用当前 state 作为 input 跑新 thread。运行时**不原地改图**；旧 thread/spec 保留。
- 依赖分析：编译器计算 SCC（强连通分量）和可达集；失败结果包含 `failedScc`、`upstream`、`downstream`、`pending`。循环是一个 SCC，恢复以 SCC 为单元。
- 不禁止循环图的理由：LangGraph 的 repair/refine loop 是核心能力；SCC 让“下游重写”和“前两步”有明确定义。
- 仅当用户明确要求简化时才退回“只允许结构化 loop（body + condition + maxIterations）”，不作为默认。

## 4. 架构与复用

### 4.1 新文件

```
compose/constants.js  IR 常量、预算、节点字段表
compose/schema.js     手写严格校验（精确 path）+ JSON Schema 子集
compose/guard.js      结构化 guard 求值（不 eval）
compose/template.js   $state 引用 / prompt parts 解析
compose/analysis.js   SCC / 可达集 / writer-reducer 分析
compose/build.js      buildSpecGraph(api, spec) -> StateGraph
compose/nodes.js      tool/model/gate/map/set（M4: agent/subagent）执行器
compose/specs.js      langgraph_specs 域 + hash + owner + CRUD
compose/resolve.js    resolveEntry(id, sessionId) = registry + spec store
compose/tool.js       langgraph_compose 工具
index.js              resolve / compose tool / prompt / UI / failure wrapper
index.d.ts            GraphSpec 类型
test/fixtures/specs/  七个示例的 JSON spec（conformance）
docs/COMPOSE.md       IR、节点、生命周期、限制
```

### 4.2 复用表

| 现有部分 | 在 compose 里的角色 | 改动 |
|---|---|---|
| `compile`（[index.js:716](index.js:716)） | 编译 spec entry | 不变；`entry.build` 调 `buildSpecGraph` |
| `executeRun`（[index.js:785](index.js:785)） | 跑 / interrupt / replay / thread | M5 加 try/catch，返回结构化失败 |
| `withThreadLock` | 同 thread 串行 | 不变 |
| `DshCheckpointSaver` | 持久线程、interrupt、时间旅行、pending writes | 不变 |
| `DshStore` | 长时记忆 | 不变 |
| `helpers`（[index.js:397](index.js:397)） | 节点动作 | 不变 |
| `dsh-trace` | 节点/工具/模型 trace | 不变；M5 加 run report |
| `manageThreads`（[index.js:1018](index.js:1018)） | state/history/edit/topology/delete | 用 `resolveEntry` 解析 spec id |
| `topologyOf`（[index.js:730](index.js:730)） | 拓扑 | 不变 |
| `startBackgroundRun` | 后台 | 不变；M5 失败字段 |
| `scan` / `registry`（[index.js:341](index.js:341)） | 注册图 | 加 spec resolve；spec 不进全局 prompt |
| `threadConflict`（[index.js:310](index.js:310)） | 线程所有权 | spec id 照常工作 |
| `test/support/harness.js` | 测试 | 复用 |

### 4.3 运行流

```
模型 -> langgraph_compose({ spec 或 path })
      -> parse / validate
      -> 存不可变 spec（内容 hash id，session 拥有）
      -> 返回 { graph, name, topology, warnings }

模型 -> langgraph_run({ graph: id, input, thread?, run_in_background? })
      -> resolveEntry(id, sessionId)
      -> compile(entry, saver, helpers, store)
      -> executeRun -> checkpoint / interrupt / failed / completed
```

## 5. IR

### 5.1 顶层

```ts
type GraphSpec = {
  ir: 1
  name?: string
  description?: string
  state: Record<string, StateField>
  nodes: Node[]
  edges: Edge[]
  output?: string[]
  maxSteps?: number
}

type StateField = {
  type: 'string' | 'number' | 'boolean' | 'json' | 'string[]' | 'number[]'
  default: unknown
  reducer?: 'replace' | 'append' | 'add' | 'max' | 'min' | 'merge'
}
```

- `default` 必填，类型必须匹配。
- reducer 兼容：`replace` 任意；`append` 数组；`add/max/min` 数字；`merge` `json` 对象。
- 不允许 `any`；不允许隐式转换。
- `maxSteps` 默认 25，上限 200；映射到 `recursionLimit`。
- `output` 是返回给模型的字段列表；省略时返回全部（有界）。

### 5.2 节点（v1）

```ts
type ToolNode = {
  id: string; do: 'tool'; tool: string
  args: Record<string, Value>
  out: Record<string, Transform>
}

type ModelNode = {
  id: string; do: 'model'
  prompt: Part[]
  system?: string
  schema?: JsonSchema
  out: Record<string, Transform>
}

type GateNode = {
  id: string; do: 'gate'
  question: string
  options?: string[]
  out: Record<string, Transform>
}

type MapNode = {
  id: string; do: 'map'
  over: string
  body: ToolNode | ModelNode | AgentNode | SubagentNode
  maxItems?: number
  maxConcurrency?: number
}

type SetNode = {
  id: string; do: 'set'
  values: Record<string, Value>
}

type AgentNode = {
  id: string; do: 'agent'
  prompt: Part[]          // 散文 brief；编译器不解析
  tools: string[]
  out: Record<string, Transform>
}

type Part = string | { '$state': string }
type Value = unknown | { '$state': string }
```

M4 增加：

```ts
type SubagentNode = {
  id: string; do: 'subagent'
  prompt: Part[]
  schema?: JsonSchema
  out: Record<string, Transform>
}
```

规则：

- `tool` 的 `tool` 必须在当前 agent 可见工具里；compose 时和 run 时都校验。
- `model` 的 `prompt` 是 parts 数组；`schema` 存在时输出按 JSON 解析并校验。
- `gate` 调 `interrupt({ question, options })`；resume 值经 `out` 写入 state。
- `map` 的 `body` 不允许 `gate`；v1 不允许嵌套 `map`。
- `set` 只写字面量 / `$state`，不做算术。
- `out` 的 key 必须是已声明的 state 字段。
- `agent` 的 `prompt` 是散文 brief；模型在节点内用 `tools` 自行决定步骤；编译器不解析 brief。
- `tool` 只用于原子、已知动作；不要每个工具调用一个节点；开放工作优先 `agent`。
- `model` 用 prompt 做一次判断；`schema` 只在需要路由标签时使用。

### 5.3 Transform

`text` / `lines` / `json` / `bool` / `number` / `first` / `count`。

- `text`：整个文本。
- `lines`：按 `\n` 切分，去掉末尾空行。
- `json`：`JSON.parse`；失败即节点失败。
- `bool`：只接受 JSON boolean 或文本 `true` / `false`（不区分大小写）。
- `number`：只接受有限数字；否则失败。
- `first`：第一行 / 第一个元素。
- `count`：行数 / 元素数。
- M4 可选 `json.<path>` 提取嵌套字段。

### 5.4 Guard

```ts
type Guard = true | false | { op: GuardOp, args: Operand[] }
type Operand = unknown | { '$state': string }
type GuardOp = 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte'
             | 'exists' | 'and' | 'or' | 'not'
```

- 只支持这些 op；没有字符串表达式，不 eval。
- `$state` 路径支持点号进入 `json` 字段。
- 缺失 / 类型不匹配：比较返回 false；`exists` 返回 false；不抛错。
- `gt/gte/lt/lte` 只接受数字。
- 编译期能做类型检查的（state 已知）就拒绝，运行期保底。

### 5.5 边

```ts
type Edge = { from: NodeId | 'START'; to: NodeId | 'END'; when?: Guard }
```

每个节点的出边只能是以下三种之一：

1. **sequence**：恰好一条无条件边；
2. **choice**：一条或多条条件边（`when` 必填）；按数组顺序求值，先匹配先走；
3. **parallel**：两条或更多无条件边 = 静态 fan-out；后继在同一 superstep 并行。

v1 不允许同一节点混合无条件边和条件边。`START` 只能无条件边；`END` 不能有出边。没有出边的节点是 terminal，给 lint 警告（建议显式连 `END`）。

**join**：一个节点有多条入边时，LangGraph 自动等所有前驱完成；不需要新语法。

**循环**：允许；由 `maxSteps` / `recursionLimit` 兜底；编译器计算 SCC，给 lint 警告（SCC 没有条件出口、没有计数器）。

### 5.6 静态 fan-out 的校验

- 对每个 state 字段，收集可能写它的节点（`out` + `set`）。
- 同一并行组（同一 superstep）里多于一个 writer 时，该字段必须使用可合并 reducer：`append` / `add` / `max` / `min` / `merge`；`replace` 拒绝。
- `map` 的 `out` 字段同样要求可合并 reducer。
- 这套分析同时服务静态 fan-out 和 map。

### 5.7 map

- `over` 必须是数组类型字段（`string[]` / `number[]`；M4 可扩展 `json` 数组）。
- 编译器给 body 注入隐藏的 `item` / `index`；body 用 `$state` 读取。
- body 的 `out` 写父 state；reducer 聚合。
- `maxItems` 默认 50，上限 100；超限拒绝，不截断。
- `maxConcurrency` 默认 8，上限 16；传给 invoke 配置。
- v1 `append` 是完成顺序；需要输入顺序时用 M4.1 的 `indexed`。
- body 失败时错误带 `itemIndex`；已完成的 item 在 checkpoint 里，resume 只重跑 pending。

### 5.8 spec id / 版本

- `SPEC_PREFIX = 'lg_adhoc_'`。
- id = 前缀 + 规范化 JSON 的 sha256（取 24 hex）。
- 规范化：对象 key 排序、数组顺序保留、包含 `ir`。
- 同一份 spec 幂等；改一个字段就是新 id。
- spec 不可变；`description` / `name` 也是内容的一部分（改了就新 id，简单优先）。
- 记录里存 `compilerVersion`；`ir: 1` 由当前编译器支持；破坏性变更才升 `ir`。

## 6. 编译器

```
parseSpec(input)              // 已是 JS 对象；JSON.parse 在工具边界
validateSpec(spec, { tools }) // zod + 语义检查
buildSpecGraph(api, spec)     // Annotation.Root + addNode/addEdge/addConditionalEdges
compile                       // 现有 compile({ checkpointer, store })
```

### 6.1 校验规则

- 唯一节点 id；不能叫 `START` / `END`。
- 至少一条 `START` 出边；`START` 无入边；START 边无条件；`END` 无出边；边引用存在。
- state 引用存在：`args` / `prompt` / `guard` / `out` / `set`。
- transform 与 state 类型兼容；reducer 与类型兼容。
- 工具可见；`agent` 的 `tools` 可见。
- `map` 的 `over` 是数组；body 类型合法；`maxItems` 在范围内。
- 边规则：sequence / choice / parallel；不允许混合。
- 静态 fan-out 的 writer/reducer 分析。
- SCC/可达集；循环不拒绝，但给 warning。
- 预算：节点 ≤ 64，边 ≤ 128，state 字段 ≤ 64，spec JSON ≤ 256KB。
- 错误格式：`{ path, message, expected? }`，例如 `nodes[2].do`、`edges[3].to`。

### 6.2 构建

- `Annotation.Root` 从 `state` 生成；reducer 用固定实现。
- 每个节点包一层：catch 错误并附加 `error.nodeId`（map body 附 `itemIndex`）。
- `tool` -> `helpers.callTool`；`model` -> `helpers.callModel`（或 chatModel + schema）；`gate` -> `interrupt`；`set` -> 直接写；`map` -> `Send`；M4 `agent`/`subagent` -> 现有 helper。
- `prompt` parts 解析：string 原样；`$state` 取值；数组用 `\n` join；对象 JSON.stringify。
- 条件边：按数组顺序求值，返回目标；`END` 作为结束。
- 静态 fan-out：多个 `addEdge`。
- 循环：正常建边；SCC 分析只用于报告/恢复。
- 编译器无模型、无随机、无 I/O；同一 spec 永远同一张图。

## 7. spec 存储与 resolve

### 7.1 `langgraph_specs`

```ts
DOMAIN = {
  name: 'langgraph_specs',
  version: 1,
  layout: 'per-record',
  tables: {
    specs: {
      valueSchema: z.object({
        spec: z.unknown(),          // 规范化后的 GraphSpec
        source: z.unknown().nullable(), // 原始 JSON / 文件文本，供审计
        sessionId: z.string().nullable(),
        createdAt: z.number(),
        compilerVersion: z.number(),
      }),
    },
  },
}
```

- key = spec id（`lg_adhoc_` + hex，安全字符）。
- `saveSpec(spec, { sessionId, source })`：规范化、hash、幂等写入；每 session 上限 64，超出拒绝。
- `getSpec(id, sessionId)`：owner 检查。
- `listSpecs(sessionId, { limit })`：按 `createdAt` 倒序。
- `deleteSpec(id, sessionId, { deleteThreads })`：有 thread 引用时拒绝，除非显式删线程。
- 无 storage domain 时用内存 Map；thread 本来也是内存，文档写清。
- 不做后台 GC；显式删除 + 上限。

### 7.2 resolveEntry

```js
async function resolveEntry(id, sessionId) {
  const registered = registry.get(id)
  if (registered !== undefined) return registered
  if (!id.startsWith(SPEC_PREFIX)) return undefined
  const spec = await specStore.get(id, sessionId)
  if (spec === undefined) return undefined
  return {
    id,
    name: spec.name,
    description: spec.description,
    input: inputSchemaOf(spec),
    build: api => buildSpecGraph(api, spec),
  }
}
```

- spec entry 缓存（id -> entry）；spec 不可变，安全。
- `runGraph` / `manageThreads` / `topology` / UI 路由都用 `resolveEntry`。
- `registry` 仍只放注册图；spec 不进全局 prompt 列表。
- `langgraph_threads` 的 `state/history/edit/topology/delete` 对 spec id 照常工作。
- 线程记录里的 `graph` 就是 spec id；`threadConflict` 照常。

### 7.3 本地文件

- `langgraph_compose({ action: 'compose', path: '...' })`：读工作区内 `.lg.json`，parse、validate、store；`source` 存原始文本。
- 路径必须落在 session cwd（或允许的根）内；否则拒绝，让模型用 `read` 工具读文本再传 `spec`。
- **恢复时不重读文件**：thread 用存储的 spec；文件改了就是新 spec / 新线程。
- 文件只是源，不是运行时状态；不写 `graphs/*.js`。

## 8. compose 工具

### 8.1 参数

```ts
{
  action: 'describe' | 'validate' | 'compose' | 'list' | 'get' | 'delete' | 'fork'
  spec?: GraphSpec
  path?: string
  graph?: string
  from?: string          // fork: 失败节点
  limit?: number
  delete_threads?: boolean
}
```

### 8.2 行为

- `describe`：按需返回 IR schema + 一个最小例子；**不放进工具定义**，避免每轮 token。
- `validate`：parse + validate；返回 `{ ok, errors, topology?, warnings }`；不存储、不执行。
- `compose`：validate + store + 返回 `{ graph, name, topology, warnings }`；不执行。
- `list`：本 session 的 spec 摘要（id、name、description、createdAt、thread 数）。
- `get`：返回 spec JSON（owner）。
- `delete`：owner；有 thread 引用时拒绝，除非 `delete_threads`。
- `fork`（M5）：加载 spec，计算 `from` 的下游/SCC，返回新 spec 骨架 + 当前 state；模型编辑后另存新 spec。
- 工具描述保持短；机制细节在 `describe`。

## 9. 运行、失败与恢复

### 9.1 运行

- `langgraph_run({ graph: id })` 走现有路径；`resolveEntry` 解析 spec。
- 线程 id 自动生成；`claimThread({ graph: id, sessionId })`。
- 每个 superstep checkpoint；`interrupt` 返回 `status: 'interrupted'` + payload + thread。
- 前台阻塞本 turn；长图用 `run_in_background`。
- 模型看不到中间 state；要看用 `langgraph_threads state/history`。
- 图没有 `gate` 时模型不能中途介入；这是“图是承诺”的取舍。

### 9.2 失败结果

M5 在 `executeRun` 外包一层 try/catch；节点包装器附加 `error.nodeId`，map body 附加 `itemIndex`。失败结果：

```json
{
  "status": "failed",
  "graph": "lg_adhoc_7f3a...",
  "thread": "lg_lg_adhoc_7f3a..._...",
  "checkpoint": "1ef...",
  "failedNode": "read",
  "failedScc": ["read", "judge", "retry"],
  "pending": ["read"],
  "downstream": ["read", "judge", "retry", "gate", "END"],
  "upstream": ["START", "scan"],
  "lastSupersteps": [
    {
      "step": 2,
      "source": "loop",
      "next": ["read"],
      "tasks": [{ "id": "judge", "error": null }],
      "values": { "verdict": "large" }
    },
    {
      "step": 1,
      "source": "loop",
      "next": ["read"],
      "tasks": [{ "id": "scan", "error": null }],
      "values": { "pattern": "**/*.js" }
    },
    {
      "step": 0,
      "source": "input",
      "next": ["scan"],
      "tasks": [],
      "values": { "pattern": "**/*.js" }
    }
  ],
  "error": { "name": "ToolError", "message": "read: ENOENT", "node": "read", "itemIndex": 7 },
  "state": { "pattern": "**/*.js", "files": ["a.js"], "reports": ["..."], "verdict": "large", "approved": false },
  "hint": "transient -> resume; state -> edit/replay; graph -> fork downstream and compose"
}
```

- `lastSupersteps` 是失败边界 + 前两个 checkpoint（最多 3 个）；`values` 有界/按 `output` 选择。
- `failedNode` 来自节点包装器；`failedScc` / `upstream` / `downstream` / `pending` 来自编译期的 SCC/可达分析。
- `error` 保留原始 name/message；`itemIndex` 只在 map body。
- 后台 job 的最终结果带同样字段（有界）。
- `hint` 是恢复协议，不自动执行。

### 9.3 恢复路径

1. **retry / resume**：瞬态错误；`langgraph_run({ graph, thread })` 从断点重跑 pending 节点；循环状态/计数器保留。
2. **edit / replay**：state 错；`langgraph_threads edit` 在失败边界 checkpoint 改值，再 replay。
3. **fork 下游 + compose**：spec 逻辑错。`langgraph_compose({ action: 'fork', graph, from: failedNode })` 返回下游骨架（复制 state schema、下游节点/边，`START` 边指向 pending/后继）；模型编辑后另存新 spec，用当前 state 作为 input 跑新 thread。旧 thread/spec 保留。
4. **fork SCC + compose**：循环内部失败；以 SCC 为单元重写 loop body/exit，保留 loop state。
5. 运行时**不自动改图**；所有重写都是新的不可变 spec，可审计、可复现。

### 9.4 循环 / SCC

- 编译器用 Tarjan 计算 SCC，缩点成 DAG。
- 失败在循环内：`failedScc` 是循环单元；`downstream` 包含 SCC 的剩余部分和出口路径；`lastSupersteps` 是最近两次迭代。
- 允许任意循环；`maxSteps` / `recursionLimit` 兜底。
- lint：SCC 没有条件出口、没有计数器、没有 `maxSteps` -> warning。
- 如果用户要求简化：只允许结构化 `loop` node（body + condition + maxIterations），拒绝任意回边；这是 fallback，不是默认。

### 9.5 成功

- `status: 'completed'`；`state`（按 `output` 选择，有界）+ `thread`。
- spec 保留；同 session 可复用（新线程或同线程新 input）。
- 成功 != 正确；图里应有 verify 节点或模型自查。
- 跨 session 复用 = 显式提升；v1 不做自动 `graphs/*.js` 写入。
- 提升方式：`config.specs`（如果以后支持无文件注册）或人工生成的 JS module（独立包 / `config.graphs`），需要重启；不是运行时动作。

### 9.6 at-least-once

- 失败节点可能已经产生副作用；resume 会重跑它。破坏性操作要幂等或加 `gate`。
- 静态 fan-out 的已完成分支在 checkpoint 里，不会重跑；失败分支会重跑。
- map 的已完成 item 在 checkpoint 里，pending item 重跑；`append` 可能重复，恢复时用 `edit` 修正或使用幂等工具。

## 10. Prompt / 模型策略

系统 prompt 的 `tool:langgraph` 段落改：

- 现在：`langgraph_run` 只跑注册图，不能定义图。
- 改为：可以用 `langgraph_compose` 组合一张 **session 拥有的**图。
- 何时 compose：
  - ≥3 个有依赖的步骤；
  - 需要分支 / 重试；
  - 需要跨 turn / 跨进程持久；
  - 需要 fan-out + 聚合；
  - 需要人工 gate。
- 何时不 compose：
  - 1–2 步、纯线性；
  - 已注册图匹配时优先注册图；
  - 只是想把一次工具调用包装得“正式”。

- compose 不是文件、不是 `graphs/*.js`、不是 DSH Session；不可变；改图要新 compose。
- 失败恢复：读 `lastSupersteps` 和依赖信息；retry / edit / replay / fork 下游。
- spec 列表不在全局 prompt；用 `langgraph_compose list` 或 `langgraph_run` 无参列表。
- `langgraph_run` 描述：`graph` 可以是注册 id 或 composed id；无参列出。
- `langgraph_threads` 描述：对 composed 图同样适用。
- 测试：section 文本/顺序、工具描述、无编造 id、no push。

### 10.1 coarse-first

- **结构在接缝，散文在节点。** 图只管阶段、依赖、分支、并行、gate、state、持久化；节点内部是模型可自由发挥的 brief。
- 默认 **4–8 个阶段节点**，不是“一个工具一个节点”。
- 开放工作 → `agent`；单次判断 → `model`；人工确认 → `gate`；已知原子动作 → `tool`。
- **“how” 写在节点 brief 里，“what/when” 写在图的边上。**
- 默认不 compose；探索性/线性任务用普通工具。模型永远可以退回普通 agent loop。
- `validate` / `compose` 返回 **advisory warnings**，不是硬错误；硬错误只有 schema/引用/预算。

### 10.2 过度分解 lint（warning）

- >12 个节点；
- 连续 >8 个节点的线性链；
- 一个 `tool` 节点的 `args` 全是字面量、且只调用一次；
- 一个 `model` 节点的输出只接到一个 `tool` 节点；
- 1–2 步线性图。

建议：合并成 `agent` 节点；1–2 步图用普通工具。

## 11. 里程碑

### M1 — IR schema + 编译器内核（1.1.0）

- 文件：`compose/schema.js`、`compose/guard.js`、`compose/template.js`、`compose/analysis.js`、`compose/build.js`、`compose/nodes.js`。
- 范围：`tool/model/agent/gate/set`；sequence / choice / 静态 fan-out / join；state/reducer/transform/guard；SCC 分析。
- 测试：`test/compose-schema.test.js`、`compose-guard.test.js`、`compose-build.test.js`、`compose-analysis.test.js`。
- 验收：`scan-report`、`approval-gate`、`ask-tools` 以 spec 构建并在单测里跑；diamond 静态 fan-out；SCC。
- 无用户可见工具。
- 本地 commit：`feat: add the graph spec compiler core`。

### M2 — spec 存储 + resolve（1.2.0）

- 文件：`compose/specs.js`、`compose/resolve.js`；`index.js`。
- 范围：`langgraph_specs` 域、hash、owner、CRUD、内存 fallback、`resolveEntry`、thread/topology 接入。
- 测试：`test/compose-store.test.js`、`compose-resolve.test.js`。
- 验收：save/get/list/delete；重启后 resolve；`manageThreads`/`topology` 认 spec id。
- 本地 commit：`feat: store and resolve composed graph specs`。

### M3 — compose 工具 + run 接入（1.3.0）

- 文件：`compose/tool.js`、`index.js`、prompt。
- 范围：`describe/validate/compose/list/get/delete`；`langgraph_run` 跑 spec id；no-arg 列表；prompt 的 coarse-first；过度分解 lint（advisory）。
- 测试：`test/compose-tool.test.js`、`compose-run.test.js`、`compose-prompt.test.js`。
- 验收：compose → run → interrupt → resume → history/edit/replay；background；非法 spec；owner；工具可见性。
- 本地 commit：`feat: compose and run session-owned graphs`。

### M4 — map + subagent（1.4.0）

- 文件：`compose/nodes.js`、`compose/build.js`、`compose/analysis.js`、tests。
- 范围：`map`/Send、item/index、maxItems/maxConcurrency、append；`subagent`（`agent` 已在 v1）。
- 测试：`test/compose-map.test.js`、`compose-parallel.test.js`、`compose-conformance.test.js`。
- 验收：`ask-workspace`、`ask-tools`、`ask-subagent`；diamond；map 聚合；分支/item 失败。
- 本地 commit：`feat: add fan-out and agent nodes to composed graphs`。

### M5 — 失败/恢复/报告/prompt/docs（1.5.0）

- 文件：`compose/analysis.js`、`compose/tool.js`（fork）、`index.js`（failure wrapper）、prompt、docs、`index.d.ts`、`PLAN.md`。
- 范围：结构化失败、lastSupersteps、SCC/downstream、fork 骨架、run report、lint、文档、发布准备。
- 测试：`test/compose-failure.test.js`、`compose-recovery.test.js`、`compose-cycle.test.js`、`compose-prompt.test.js`；私有矩阵。
- 验收：失败字段；resume/edit/fork/re-compose；循环/SCC；文档示例；全部测试。
- 本地 commit：`feat: recover composed graphs from failures`。
- 最终：全部验证完再 push。

## 12. 测试计划

- **单元**：schema / guard / template / build / analysis / store / lint。
- **conformance**：七个示例图逐个写成 spec；v1 先 `scan-report`、`typed-report`、`approval-gate`、`ask-workspace`、`ask-tools`（agent）；M4 补 `ask-subagent`、`ask-user`。
- **集成**：compose → run → interrupt → resume → history/edit/replay；background；owner；工具可见性；path；缺失 spec。
- **失败/循环**：静态 fan-out 分支失败；map item 失败；loop 内失败；recursionLimit；fork 下游；re-compose。
- **prompt**：section 文本/顺序、工具描述、coarse-first；私有矩阵（compose-worthy / simple / registered）。
- **过度确定化**：普通 agent loop vs 粗粒度图（agent）vs 细粒度图（tool）；成功率、token、时间、过度分解率。
- **文档**：示例可跑。

## 13. 待定 / 风险

- `fork` 放 M5 还是 M6。
- `indexed` map 的排序语义（M4.1）。
- `maxConcurrency` 默认值（8）。
- `path` 的根目录（session cwd / workspace root）。
- `describe` 返回的 schema 大小；工具定义保持小。
- 版本号（建议 1.1.0，M5 再 bump）。
- 循环：SCC（推荐）vs 结构化 loop（fallback）。
- 静态 fan-out 是否允许混条件边（v1 禁止）。
- `agent`/`subagent` 是否 M4 或 M4.1。
- 私有矩阵的范围。
- 过度确定化：把每一步写成 `tool` 节点会压扁模型能力；用 `agent` + coarse-first + lint 防。若私有矩阵显示粗粒度图无优势，继续收紧 compose 触发。
- `langgraph_run` 无参是否列 composed spec（建议列）。
- spec 的 `name` 是可选人类标签；id 是 hash。

## 14. Definition of Done

- `npm test` 全绿；typecheck 绿；client build（若改 UI）。
- conformance 全部通过；失败/循环矩阵通过；prompt 矩阵通过。
- 文档：`docs/COMPOSE.md`、`README.md`、`docs/DETAIL.md`、`docs/ECOSYSTEM.md`、`docs/CONTEXT.md`、`PLAN.md`、`index.d.ts`。
- 无 TODO / 无 `graphs/*.js` 写入 / 无模型翻译。
- **不 push、不打 tag、不发 npm**，直到用户明确说可以。

## 附录 A：IR 示例

```json
{
  "ir": 1,
  "name": "scan-report",
  "description": "Scan JS files, read them in parallel, judge the size.",
  "state": {
    "pattern":  { "type": "string",   "default": "**/*.js" },
    "files":    { "type": "string[]", "default": [] },
    "reports":  { "type": "string[]", "default": [], "reducer": "append" },
    "verdict":  { "type": "string",   "default": "" },
    "approved": { "type": "boolean",  "default": false }
  },
  "nodes": [
    {
      "id": "scan",
      "do": "tool",
      "tool": "glob",
      "args": { "pattern": { "$state": "pattern" } },
      "out": { "files": "lines" }
    },
    {
      "id": "read",
      "do": "map",
      "over": "files",
      "body": {
        "do": "tool",
        "tool": "read",
        "args": { "path": { "$state": "item" } },
        "out": { "reports": "text" }
      }
    },
    {
      "id": "judge",
      "do": "model",
      "prompt": ["Is this a large project? ", { "$state": "reports" }],
      "out": { "verdict": "text" }
    },
    {
      "id": "gate",
      "do": "gate",
      "question": "Continue?",
      "out": { "approved": "bool" }
    }
  ],
  "edges": [
    { "from": "START", "to": "scan" },
    { "from": "scan", "to": "read" },
    { "from": "read", "to": "judge" },
    { "from": "judge", "to": "gate", "when": { "eq": ["verdict", "large"] } },
    { "from": "judge", "to": "END", "when": true },
    { "from": "gate", "to": "END" }
  ]
}
```

## 附录 B：静态 fan-out 示例

```json
{
  "ir": 1,
  "name": "parallel-scan",
  "state": {
    "all": { "type": "string[]", "default": [], "reducer": "append" },
    "summary": { "type": "string", "default": "" }
  },
  "nodes": [
    { "id": "left",  "do": "tool", "tool": "read", "args": { "path": "a.txt" }, "out": { "all": "text" } },
    { "id": "right", "do": "tool", "tool": "read", "args": { "path": "b.txt" }, "out": { "all": "text" } },
    { "id": "join",  "do": "model",
      "prompt": ["Combine: ", { "$state": "all" }],
      "out": { "summary": "text" } }
  ],
  "edges": [
    { "from": "START", "to": "left" },
    { "from": "START", "to": "right" },
    { "from": "left",  "to": "join" },
    { "from": "right", "to": "join" },
    { "from": "join",  "to": "END" }
  ]
}
```

`left` 和 `right` 在同一个 superstep 并行；`join` 有多条入边，LangGraph 等两边都完成；`all` 用 `append` 合并。没有 `START -> split` 的中转节点：`START` 本身允许多条无条件出边。

## 附录 C：SCC / 恢复示例

```
START -> scan -> read -> judge
judge -[large]-> gate -> END
judge -[small]-> END
judge -[retry]-> read
```

- SCC：`{read, judge}`（read -> judge -> read）。
- `scan` 是 upstream；`gate` / `END` 是 downstream。
- 失败在 `read`：`failedScc = [read, judge]`；`downstream = [read, judge, gate, END]`；`lastSupersteps` 是最近两次迭代。
- 恢复：retry 同一 thread；或 fork `{read, judge}` 的 loop body 重新 compose；或 fork `gate`/`END` 的下游。

## 附录 D：术语

| 术语 | 含义 |
|---|---|
| IR | 严格 JSON 的图定义（`GraphSpec`）。 |
| spec | 存进 `langgraph_specs` 的不可变 IR 记录。 |
| composed graph | 由 spec 生成的图；id 是 `lg_adhoc_<hash>`；session 拥有。 |
| registered graph | `graphs/*.js` 或 `config.graphs` 里的图。 |
| static fan-out | 一个节点多条无条件出边，后继并行。 |
| map | 对数组动态 fan-out，`Send`。 |
| agent | 散文 brief + tools 的节点；模型在节点内自行决定步骤，是“留白”单元。 |
| coarse-first | 默认 4–8 个阶段节点；开放工作用 agent，不把每个工具调用写成节点。 |
| lint | compose/validate 的 advisory warning：节点过多、线性过长、过度分解。 |
| join | 多入边节点等所有前驱；LangGraph 隐式。 |
| SCC | 强连通分量；循环/loop 的恢复单元。 |
| superstep | LangGraph 的一次执行步；可能包含多个并行任务。 |
| failedScc / downstream / upstream | 失败节点所在的循环单元 / 之后可达的节点 / 之前已完成的节点。 |
| fork | 从失败节点生成下游 spec 骨架；模型编辑后另存新 spec。 |
| compilerVersion | spec 记录里的编译器版本，用于迁移。 |
