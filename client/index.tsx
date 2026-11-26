/**
 * Browser half of the LangGraph panel.
 *
 * Two slot contributions that share one id:
 * - `main` key `langgraph`: the panel listing registered graphs and drawing the
 *   selected graph's topology.
 * - `sidebar.panellist` id `langgraph`: the launcher row that selects it.
 *
 * The panel reads the Host plugin's authenticated routes (registered through
 * `ctx.connection.fetch.register`, owner-only): `GET /api/plugins/langgraph/ui` for
 * the registry and thread counts, and `GET /api/plugins/langgraph/topology?graph=`
 * for one drawable graph. Runtime dependencies are `react` and
 * `react/jsx-runtime` only; the Web shell seeds both into the module table.
 * @module @lzn1998/dsh-langgraph/client
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

/** The main-panel key and the sidebar-list id: one identity for both seats. */
const PANEL_ID = 'langgraph'

/** Host routes served by the plugin's owner-only fetch registrations. */
const UI_URL = '/api/plugins/langgraph/ui'
const TOPOLOGY_URL = '/api/plugins/langgraph/topology'

/** Refresh cadence for the registry and thread counts. */
const POLL_MS = 5000

/** The injected stylesheet's ownership id. */
const STYLE_ID = '@lzn1998/dsh-langgraph/client.css'

/** One registered graph as `GET /ui` reports it. */
interface GraphItem {
  id: string
  description?: string
  input?: unknown
  error?: string
}

/** The registry plus durable-thread counts. */
interface UiPayload {
  graphs: GraphItem[]
  threads: { total: number; byGraph: Record<string, number>; durable: boolean }
}

/** One drawable node. */
interface TopologyNode {
  id: string
  type?: string
  name?: string
  description?: string
}

/** One drawable edge; `conditional` marks a branch. */
interface TopologyEdge {
  source: string
  target: string
  conditional?: boolean
}

/** One graph's drawable topology. */
interface TopologyPayload {
  graph: string
  description?: string
  input?: unknown
  nodes: TopologyNode[]
  edges: TopologyEdge[]
}

/** The context slice this plugin uses, declared structurally. */
export interface PanelContext {
  readonly slots: {
    inject(key: string, factory: () => () => void): () => void
    register(options: Readonly<Record<string, unknown>>, component: unknown): () => void
  }
}

/** Cordis services this browser plugin needs before it applies. */
export const inject = ['slots']

// ── host reads ───────────────────────────────────────────────────────────────

/** Read one JSON route, raising the Host's error message when it refuses. */
async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  const payload = await response.json().catch(() => ({})) as { error?: unknown }
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
  }
  return payload as T
}

/** One-line message for an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── topology layout ──────────────────────────────────────────────────────────

const NODE_WIDTH = 150
const NODE_HEIGHT = 44
const COLUMN_GAP = 82
const ROW_GAP = 34
const PADDING = 24

interface PlacedNode extends TopologyNode {
  x: number
  y: number
}

interface PlacedEdge {
  path: string
  conditional: boolean
}

interface Drawing {
  width: number
  height: number
  nodes: PlacedNode[]
  edges: PlacedEdge[]
}

/** Assign every node the BFS depth from `__start__` (unreachable nodes stay at 0). */
function levelsOf(topology: TopologyPayload): Map<string, number> {
  const levels = new Map<string, number>()
  const bySource = new Map<string, string[]>()
  for (const edge of topology.edges) {
    const targets = bySource.get(edge.source) ?? []
    targets.push(edge.target)
    bySource.set(edge.source, targets)
  }
  const start = topology.nodes.some(node => node.id === '__start__') ? '__start__' : topology.nodes[0]?.id
  if (start === undefined) return levels
  levels.set(start, 0)
  const queue = [start]
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const target of bySource.get(id) ?? []) {
      if (levels.has(target)) continue
      levels.set(target, (levels.get(id) ?? 0) + 1)
      queue.push(target)
    }
  }
  return levels
}

/** Place columns by depth and rows within a column, then route every edge. */
function drawTopology(topology: TopologyPayload): Drawing {
  const levels = levelsOf(topology)
  const columns = new Map<number, TopologyNode[]>()
  for (const node of topology.nodes) {
    const level = levels.get(node.id) ?? 0
    const column = columns.get(level) ?? []
    column.push(node)
    columns.set(level, column)
  }
  for (const column of columns.values()) {
    column.sort((left, right) => {
      const leftEnd = left.id === '__end__' ? 1 : 0
      const rightEnd = right.id === '__end__' ? 1 : 0
      return leftEnd - rightEnd
    })
  }
  const placed = new Map<string, PlacedNode>()
  const depths = [...columns.keys()].sort((left, right) => left - right)
  let maxRows = 0
  for (const depth of depths) {
    const column = columns.get(depth) ?? []
    maxRows = Math.max(maxRows, column.length)
    column.forEach((node, row) => {
      placed.set(node.id, {
        ...node,
        x: PADDING + depth * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + row * (NODE_HEIGHT + ROW_GAP),
      })
    })
  }
  const nodes = [...placed.values()]
  const edges: PlacedEdge[] = []
  for (const edge of topology.edges) {
    const source = placed.get(edge.source)
    const target = placed.get(edge.target)
    if (source === undefined || target === undefined) continue
    const sx = source.x + NODE_WIDTH
    const sy = source.y + NODE_HEIGHT / 2
    const tx = target.x
    const ty = target.y + NODE_HEIGHT / 2
    const bend = Math.max(40, Math.abs(tx - sx) / 2)
    let path
    if (tx > sx) {
      path = `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`
    } else if (tx === sx) {
      // Same column: leave to the right and come into the target's top edge.
      const center = target.x + NODE_WIDTH / 2
      path = `M ${sx} ${sy} C ${sx + 70} ${sy}, ${center + 70} ${target.y - 28}, ${center} ${target.y}`
    } else {
      path = `M ${sx} ${sy} C ${sx + bend} ${sy + 40}, ${tx - bend} ${ty + 40}, ${tx} ${ty}`
    }
    edges.push({ path, conditional: edge.conditional === true })
  }
  return {
    width: PADDING * 2 + Math.max(1, depths.length) * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP,
    height: PADDING * 2 + Math.max(1, maxRows) * (NODE_HEIGHT + ROW_GAP) - ROW_GAP,
    nodes,
    edges,
  }
}

/** Draw one topology as a small left-to-right diagram. */
function TopologyView({ topology }: { topology: TopologyPayload }) {
  const drawing = useMemo(() => drawTopology(topology), [topology])
  return (
    <div className="lg-topology">
      <svg viewBox={`0 0 ${drawing.width} ${drawing.height}`} role="img" aria-label={`${topology.graph} topology`}>
        <defs>
          <marker id="lg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" className="lg-arrow" />
          </marker>
        </defs>
        {drawing.edges.map((edge, index) => (
          <path
            key={`edge-${index}`}
            d={edge.path}
            className={edge.conditional ? 'lg-edge lg-edge-conditional' : 'lg-edge'}
            markerEnd="url(#lg-arrow)"
          />
        ))}
        {drawing.nodes.map(node => (
          <g key={node.id} transform={`translate(${node.x},${node.y})`}>
            <rect
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
              rx={10}
              className={node.id === '__start__' || node.id === '__end__' ? 'lg-node lg-node-terminal' : 'lg-node'}
            />
            <text x={NODE_WIDTH / 2} y={NODE_HEIGHT / 2 + 4} textAnchor="middle" className="lg-node-label">
              {node.id === '__start__' ? 'start' : node.id === '__end__' ? 'end' : node.name ?? node.id}
            </text>
            <title>{node.description ?? node.id}</title>
          </g>
        ))}
      </svg>
    </div>
  )
}

// ── panel ────────────────────────────────────────────────────────────────────

/** The panel body: registry on the left, selected topology on the right. */
function LangGraphPanel() {
  const [ui, setUi] = useState<UiPayload>()
  const [uiError, setUiError] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [topology, setTopology] = useState<TopologyPayload>()
  const [topologyError, setTopologyError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await readJson<UiPayload>(UI_URL)
      setUi(next)
      setUiError(undefined)
      setSelected(current => current !== undefined && next.graphs.some(graph => graph.id === current)
        ? current
        : next.graphs[0]?.id)
    } catch (error) {
      setUiError(messageOf(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [refresh])

  useEffect(() => {
    if (selected === undefined) {
      setTopology(undefined)
      return undefined
    }
    let live = true
    setBusy(true)
    setTopologyError(undefined)
    readJson<TopologyPayload>(`${TOPOLOGY_URL}?graph=${encodeURIComponent(selected)}`)
      .then(next => { if (live) setTopology(next) })
      .catch(error => {
        if (!live) return
        setTopology(undefined)
        setTopologyError(messageOf(error))
      })
      .finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [selected])

  const selectedGraph = ui?.graphs.find(graph => graph.id === selected)
  return (
    <section className="lg-panel" aria-label="LangGraph graphs">
      <header className="lg-header">
        <div>
          <h2 className="lg-title">LangGraph</h2>
          <p className="lg-muted">
            {ui === undefined
              ? 'Loading graphs…'
              : `${ui.graphs.length} graph${ui.graphs.length === 1 ? '' : 's'} · ${ui.threads.total} durable thread${ui.threads.total === 1 ? '' : 's'}`}
          </p>
        </div>
        <button type="button" className="lg-button" onClick={() => { void refresh() }}>Refresh</button>
      </header>

      {uiError !== undefined && <p className="lg-error">{uiError}</p>}

      <div className="lg-grid">
        <nav className="lg-list" aria-label="Registered graphs">
          {(ui?.graphs ?? []).map(graph => (
            <button
              key={graph.id}
              type="button"
              className={graph.id === selected ? 'lg-item lg-item-active' : 'lg-item'}
              onClick={() => setSelected(graph.id)}
            >
              <span className="lg-item-id">{graph.id}</span>
              <span className="lg-item-meta">
                {graph.error ?? `${ui?.threads.byGraph[graph.id] ?? 0} thread${(ui?.threads.byGraph[graph.id] ?? 0) === 1 ? '' : 's'}`}
              </span>
              {graph.error === undefined && graph.description !== undefined && (
                <span className="lg-item-desc">{graph.description}</span>
              )}
            </button>
          ))}
          {ui !== undefined && ui.graphs.length === 0 && <p className="lg-muted">No graphs registered.</p>}
        </nav>

        <div className="lg-canvas">
          {topologyError !== undefined && <p className="lg-error">{topologyError}</p>}
          {busy && <p className="lg-muted">Loading topology…</p>}
          {!busy && topology !== undefined && <TopologyView topology={topology} />}
          {!busy && topology === undefined && topologyError === undefined && (
            <p className="lg-muted">Select a graph to see its nodes and edges.</p>
          )}
        </div>
      </div>

      <footer className="lg-footer">
        {selectedGraph?.description ?? 'Runs appear as langgraph_run rows in Trajectory.'}
      </footer>
    </section>
  )
}

/** Sidebar launcher icon: one node feeding two others. */
function LangGraphIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="9" width="6" height="6" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="16" y="2" width="6" height="6" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="16" y="16" width="6" height="6" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 12h4v-7h4M12 12v7h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────

const PANEL_CSS = `
.lg-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 18px 20px; gap: 14px; color: inherit; font: inherit; }
.lg-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.lg-title { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: .01em; }
.lg-muted { margin: 2px 0 0; opacity: .62; font-size: 12px; }
.lg-error { margin: 0; padding: 8px 10px; border-radius: 8px; font-size: 12px; color: #ffb4ab; background: rgba(255, 80, 70, .12); border: 1px solid rgba(255, 80, 70, .28); white-space: pre-wrap; }
.lg-button { border: 1px solid color-mix(in srgb, currentColor 22%, transparent); background: transparent; color: inherit; border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer; }
.lg-button:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.lg-grid { display: grid; grid-template-columns: minmax(190px, 250px) minmax(0, 1fr); gap: 14px; min-height: 0; flex: 1; }
.lg-list { display: flex; flex-direction: column; gap: 6px; overflow: auto; padding-right: 2px; }
.lg-item { display: flex; flex-direction: column; gap: 2px; text-align: left; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); background: transparent; color: inherit; border-radius: 10px; padding: 8px 10px; font: inherit; cursor: pointer; }
.lg-item:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.lg-item-active { border-color: color-mix(in srgb, currentColor 40%, transparent); background: color-mix(in srgb, currentColor 9%, transparent); }
.lg-item-id { font-size: 13px; font-weight: 600; }
.lg-item-meta { font-size: 11px; opacity: .58; }
.lg-item-desc { font-size: 11px; opacity: .72; line-height: 1.35; }
.lg-canvas { min-height: 0; overflow: auto; border: 1px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 12px; padding: 12px; }
.lg-topology { min-width: min-content; }
.lg-topology svg { display: block; max-width: 100%; height: auto; overflow: visible; }
.lg-node { fill: color-mix(in srgb, currentColor 7%, transparent); stroke: color-mix(in srgb, currentColor 38%, transparent); stroke-width: 1.2; }
.lg-node-terminal { fill: transparent; stroke-dasharray: 4 4; }
.lg-node-label { fill: currentColor; font-size: 12px; font-weight: 550; }
.lg-edge { fill: none; stroke: color-mix(in srgb, currentColor 42%, transparent); stroke-width: 1.4; }
.lg-edge-conditional { stroke-dasharray: 6 4; }
.lg-arrow { fill: color-mix(in srgb, currentColor 55%, transparent); }
.lg-footer { font-size: 11px; opacity: .55; border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); padding-top: 9px; }
`

/** Inject the panel stylesheet once per page. */
function installStyles(): void {
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@lzn1998/dsh-langgraph'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
}

/**
 * Contribute the panel and its sidebar launcher. `slots.inject` waits for each
 * slot's declaration, so activation order does not matter; the disposers
 * belong to this plugin's fiber.
 * @param ctx - browser context carrying the slot registry.
 */
export function apply(ctx: PanelContext): void {
  installStyles()
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, LangGraphPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 32,
    label: 'LangGraph',
  }, LangGraphIcon))
}
