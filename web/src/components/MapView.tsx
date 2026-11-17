/**
 * The map: items as boxes, one person's arrows between them. Arrows can be
 * drawn by dragging from one box to another, or by tapping one then the other.
 */
import dagre from '@dagrejs/dagre';
import { applyNodeChanges, Background, BaseEdge, Controls, EdgeLabelRenderer, getBezierPath, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelLinkInput, ParticipantModel } from '@shared/calc/types';
import type { WorkshopView } from '@shared/types';

export interface MapNodeData extends Record<string, unknown> {
  label: string;
  kind: 'goal' | 'state' | 'action';
  kindLabel: string;
  dim: boolean;
  hit: boolean;
  armed: boolean;
  flags: { text: string; plain?: boolean }[];
  connectable: boolean;
}

const NodeBox = memo(function NodeBox({ data, selected }: NodeProps<Node<MapNodeData>>) {
  return (
    <div className={`rf-node k-${data.kind} ${selected ? 'selected' : ''} ${data.dim ? 'dim' : ''} ${data.hit ? 'hit' : ''} ${data.armed ? 'armed' : ''}`}>
      <Handle type="target" position={Position.Left} isConnectable={data.connectable && data.kind !== 'action'} />
      <span className="rf-kind">{data.kindLabel}</span>
      {data.label}
      {data.flags.length > 0 && (
        <span className="rf-flags">
          {data.flags.map((f) => (
            <span key={f.text} className={`rf-flag ${f.plain ? 'plain' : ''}`}>
              {f.text}
            </span>
          ))}
        </span>
      )}
      <Handle type="source" position={Position.Right} isConnectable={data.connectable && data.kind !== 'goal'} />
    </div>
  );
});
const nodeTypes = { box: NodeBox };

export interface ArrowData extends Record<string, unknown> {
  text?: string;
  /** Accessible label of the missing-information marker; absent when nothing is missing. */
  ask?: string;
  onAsk?: (id: string) => void;
}

/** An arrow with, at most, one "?" marker: tap it to answer what the selected method still needs for this arrow. */
const ArrowEdge = memo(function ArrowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, data }: EdgeProps<Edge<ArrowData>>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={28} />
      {(data?.text || data?.ask) && (
        <EdgeLabelRenderer>
          <div className="edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            {data.text && <span className="edge-text">{data.text}</span>}
            {data.ask && (
              <button
                type="button"
                className="edge-ask"
                aria-label={data.ask}
                title={data.ask}
                onClick={(e) => {
                  e.stopPropagation();
                  data.onAsk?.(id);
                }}
              >
                ?
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
const edgeTypes = { arrow: ArrowEdge };

const W = 190;
const H = 58;

/** Rough left-to-right layout. Arrows shape it; where there are none, "came up under" hints do. */
export function layout(ids: string[], arrows: { from: string; to: string }[]): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 22, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  const present = new Set(ids);
  for (const id of ids) g.setNode(id, { width: W, height: H });
  for (const a of arrows) if (present.has(a.from) && present.has(a.to) && a.from !== a.to) g.setEdge(a.from, a.to);
  try {
    dagre.layout(g);
  } catch {
    /* fall through to whatever positions were assigned */
  }
  const out: Record<string, { x: number; y: number }> = {};
  ids.forEach((id, i) => {
    const n = g.node(id);
    out[id] = n && Number.isFinite(n.x) ? { x: n.x - W / 2, y: n.y - H / 2 } : { x: (i % 6) * (W + 30), y: Math.floor(i / 6) * (H + 30) };
  });
  return out;
}

export interface MapProps {
  view: WorkshopView;
  /** The model whose arrows are shown; null shows every proposed arrow without anyone's view. */
  model: ParticipantModel | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  canConnect: boolean;
  /** Tap-one-then-the-other mode. */
  tapConnect: boolean;
  onConnect: (from: string, to: string) => void;
  search: string;
  focusId: string | null;
  focusSteps: number;
  collapsed: Set<string>;
  showUnreviewed: boolean;
  showRejected: boolean;
  /** Arrows the selected method still needs information for → accessible label of the "?" marker. */
  missing?: Record<string, string>;
  onAsk?: (linkId: string) => void;
  /** Extra badges per node (e.g. "required, no action"). */
  badges: Record<string, string[]>;
  tidySignal: number;
  canSaveLayout: boolean;
  onSaveLayout?: (positions: Record<string, { x: number; y: number }>) => void;
  compact?: boolean;
}

function edgeStyle(l: ModelLinkInput | { relation: 'influence' | 'requirement'; stance: 'catalogue'; direction?: undefined }): { style: React.CSSProperties; label?: string; color: string } {
  const required = l.relation === 'requirement';
  const base = required ? '#b7791f' : 'var(--text)';
  if (l.stance === 'catalogue') return { color: '#8a8a99', style: { stroke: '#8a8a99', strokeWidth: 1.5 }, label: required ? 'required' : undefined };
  switch (l.stance) {
    case 'yes':
      if (l.direction === 'harms') return { color: '#c2410c', style: { stroke: '#c2410c', strokeWidth: 2 }, label: 'less likely' };
      return { color: required ? '#b7791f' : '#55556a', style: { stroke: base, strokeWidth: required ? 2.5 : 2, opacity: required ? 1 : 0.75 }, label: required ? 'required' : undefined };
    case 'conditional':
      return { color: '#7c3aed', style: { stroke: '#7c3aed', strokeWidth: 2, strokeDasharray: '8 4' }, label: required ? 'required, if…' : 'if…' };
    case 'unsure':
      return { color: '#8a8a99', style: { stroke: '#8a8a99', strokeWidth: 2, strokeDasharray: '2 5' }, label: 'not sure' };
    case 'no':
      return { color: '#c0c0cc', style: { stroke: '#c0c0cc', strokeWidth: 1.5, strokeDasharray: '1 6' }, label: 'rejected' };
    default:
      return { color: '#b0b0bf', style: { stroke: '#b0b0bf', strokeWidth: 1.5, strokeDasharray: '4 5' }, label: 'not reviewed' };
  }
}

function Inner(props: MapProps) {
  const { view, model, selectedId, onSelect, canConnect, tapConnect, onConnect, search, focusId, focusSteps, collapsed, showUnreviewed, showRejected, badges, tidySignal } = props;
  const flow = useReactFlow();
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  // React Flow measures each item and its connection points and keeps that on the item object.
  // Live updates rebuild our item list, so the rendered list is kept in state and new data is merged
  // INTO it — otherwise a measurement could be lost and items or arrows would silently not draw.
  const [rendered, setRendered] = useState<Node<MapNodeData>[]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const fitted = useRef(false);

  // Every item in view is on the map (including goal candidates not yet chosen); the model decides only the arrows.
  const items = useMemo(() => Object.values(view.nodes).filter((n) => n.status === 'active'), [view.nodes]);

  const arrows = useMemo(() => {
    if (model) {
      return model.links.filter((l) => l.stance === 'yes' || l.stance === 'conditional' || l.stance === 'unsure' || (l.stance === 'unstated' && showUnreviewed) || (l.stance === 'no' && showRejected));
    }
    return Object.values(view.links)
      .filter((l) => l.status === 'active' && view.nodes[l.from]?.status === 'active' && view.nodes[l.to]?.status === 'active')
      .map((l) => ({ id: l.id, from: l.from, to: l.to, relation: l.relation, stance: 'catalogue' as const }));
  }, [model, view.links, view.nodes, showUnreviewed, showRejected]);

  /** Arrows people actually hold, plus "came up under" hints, for layout, focus and collapse. */
  const structure = useMemo(() => {
    const held = arrows.filter((a) => a.stance === 'yes' || a.stance === 'conditional' || a.stance === 'catalogue').map((a) => ({ from: a.from, to: a.to }));
    const linked = new Set(held.flatMap((a) => [a.from, a.to]));
    const hints = items.filter((n) => n.elicitedFor && !linked.has(n.id)).map((n) => ({ from: n.id, to: n.elicitedFor! }));
    return [...held, ...hints];
  }, [arrows, items]);

  // Positions: saved ones first, then anything new gets a place; nothing already placed jumps around.
  const idsKey = items.map((n) => n.id).join(',');
  useEffect(() => {
    setPositions((prev) => {
      const missing = items.filter((n) => !prev[n.id] && !n.position);
      const next: Record<string, { x: number; y: number }> = {};
      const auto = missing.length ? layout(items.map((n) => n.id), structure) : {};
      for (const n of items) next[n.id] = prev[n.id] ?? n.position ?? auto[n.id] ?? { x: 0, y: 0 };
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);
  useEffect(() => {
    if (tidySignal === 0) return;
    setPositions(layout(items.map((n) => n.id), structure));
    setMoved(true);
    setTimeout(() => void flow.fitView({ duration: 300, padding: 0.15 }), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tidySignal]);

  // Which items are visible: focus on a neighbourhood, and fold away branches.
  const visible = useMemo(() => {
    const all = new Set(items.map((n) => n.id));
    let keep = all;
    if (focusId && all.has(focusId)) {
      keep = new Set([focusId]);
      let frontier = [focusId];
      for (let step = 0; step < focusSteps; step++) {
        const next: string[] = [];
        for (const a of structure) {
          for (const [x, y] of [
            [a.from, a.to],
            [a.to, a.from],
          ] as const) {
            if (frontier.includes(x) && !keep.has(y) && all.has(y)) {
              keep.add(y);
              next.push(y);
            }
          }
        }
        frontier = next;
      }
    }
    const hiddenBy = new Map<string, number>();
    const hidden = new Set<string>();
    for (const c of collapsed) {
      if (!all.has(c)) continue;
      // Everything that leads only into the folded item is tucked away.
      const upstream = new Set<string>();
      const stack = [c];
      while (stack.length) {
        const n = stack.pop()!;
        for (const a of structure) if (a.to === n && !upstream.has(a.from) && a.from !== c) (upstream.add(a.from), stack.push(a.from));
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of [...upstream]) {
          if (structure.some((a) => a.from === n && a.to !== c && !upstream.has(a.to))) {
            upstream.delete(n);
            changed = true;
          }
        }
      }
      hiddenBy.set(c, upstream.size);
      for (const n of upstream) hidden.add(n);
    }
    return { ids: new Set([...keep].filter((id) => !hidden.has(id))), hiddenBy };
  }, [items, structure, focusId, focusSteps, collapsed]);

  const needle = search.trim().toLowerCase();
  const hits = useMemo(() => new Set(needle ? items.filter((n) => n.label.toLowerCase().includes(needle)).map((n) => n.id) : []), [items, needle]);
  useEffect(() => {
    const first = [...hits].find((id) => visible.ids.has(id));
    if (needle && first) void flow.fitView({ nodes: [...hits].filter((id) => visible.ids.has(id)).map((id) => ({ id })), duration: 300, padding: 0.4, maxZoom: 1.2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle]);

  const nodes: Node<MapNodeData>[] = useMemo(
    () =>
      items
        .filter((n) => visible.ids.has(n.id))
        .map((n) => {
          const flags = (badges[n.id] ?? []).map((text) => ({ text }));
          const folded = visible.hiddenBy.get(n.id);
          if (folded) flags.push({ text: `+${folded} folded`, plain: true } as never);
          return {
            id: n.id,
            type: 'box',
            position: positions[n.id] ?? { x: 0, y: 0 },
            selected: selectedId === n.id,
            data: {
              label: n.label,
              kind: n.kind,
              kindLabel: view.config.labels[n.kind] + (n.kind === 'goal' && view.goal.nodeId !== n.id ? ' (candidate)' : ''),
              dim: !!needle && !hits.has(n.id),
              hit: hits.has(n.id),
              armed: armed === n.id,
              flags,
              connectable: canConnect,
            },
          };
        }),
    [items, visible, positions, selectedId, badges, view.config.labels, view.goal.nodeId, needle, hits, armed, canConnect],
  );

  useEffect(() => {
    setRendered((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return nodes.map((n) => {
        const o = old.get(n.id);
        return o ? { ...o, ...n } : n;
      });
    });
  }, [nodes]);

  const edges: Edge[] = useMemo(
    () =>
      arrows
        .filter((a) => visible.ids.has(a.from) && visible.ids.has(a.to))
        .map((a) => {
          const s = edgeStyle(a as ModelLinkInput);
          const selected = selectedId === a.id;
          return {
            id: a.id,
            type: 'arrow',
            className: `arrow-${a.stance}`,
            source: a.from,
            target: a.to,
            data: { text: s.label, ask: props.missing?.[a.id], onAsk: props.onAsk },
            selected,
            style: { ...s.style, ...(selected ? { strokeWidth: 3.5, opacity: 1 } : {}) },
            markerEnd: { type: MarkerType.ArrowClosed, color: s.color, width: 18, height: 18 },
            interactionWidth: 28,
          };
        }),
    [arrows, visible, selectedId, props.missing, props.onAsk],
  );

  useEffect(() => {
    if (!fitted.current && nodes.length > 0 && Object.keys(positions).length > 0) {
      fitted.current = true;
      setTimeout(() => void flow.fitView({ padding: 0.15, maxZoom: 1.1 }), 50);
    }
  }, [nodes.length, positions, flow]);

  const clickNode = useCallback(
    (id: string) => {
      if (tapConnect && canConnect) {
        if (!armed) return setArmed(id);
        if (armed !== id) onConnect(armed, id);
        return setArmed(null);
      }
      onSelect(id);
    },
    [tapConnect, canConnect, armed, onConnect, onSelect],
  );
  useEffect(() => {
    if (!tapConnect) setArmed(null);
  }, [tapConnect]);

  return (
    <>
      <ReactFlow
        nodes={rendered}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, n) => clickNode(n.id)}
        onEdgeClick={(_, e) => onSelect(e.id)}
        onPaneClick={() => {
          setArmed(null);
          onSelect(null);
        }}
        onNodesChange={(changes) => {
          setRendered((current) => applyNodeChanges(changes, current));
          setPositions((prev) => {
            let next = prev;
            for (const c of changes) {
              if (c.type === 'position' && c.position) {
                if (next === prev) next = { ...prev };
                next[c.id] = c.position;
              }
            }
            return next;
          });
          if (changes.some((c) => c.type === 'position' && c.dragging === false)) setMoved(true);

        }}
        onConnect={(c) => c.source && c.target && onConnect(c.source, c.target)}
        nodesConnectable={canConnect}
        nodesDraggable
        elementsSelectable
        onlyRenderVisibleElements={nodes.length > 80}
        minZoom={0.08}
        maxZoom={2}
        connectionRadius={36}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        fitView
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} position="bottom-right" />
        {!props.compact && nodes.length > 25 && <MiniMap pannable zoomable position="top-right" nodeStrokeWidth={3} style={{ width: 150, height: 100 }} />}
      </ReactFlow>
      {tapConnect && canConnect && (
        <div className="tap-hint card" role="status">
          {armed ? (
            <>
              From <strong>“{view.nodes[armed]?.label}”</strong> — now tap what it affects.{' '}
              <button className="btn btn-sm btn-ghost" onClick={() => setArmed(null)}>
                Cancel
              </button>
            </>
          ) : (
            'Tap the cause first, then tap what it affects.'
          )}
        </div>
      )}
      {props.canSaveLayout && moved && props.onSaveLayout && (
        <button
          className="btn btn-sm save-layout"
          onClick={() => {
            props.onSaveLayout!(positions);
            setMoved(false);
          }}
        >
          Keep this arrangement for everyone
        </button>
      )}
    </>
  );
}

export function MapView(props: MapProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
