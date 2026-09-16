/**
 * A small typed state graph in the spirit of LangGraph.
 *
 * Nodes receive the whole state and return a partial update; edges are
 * either fixed or resolved from the state after a node runs. Every node
 * execution is a span, so the per-request trace shows exactly which nodes
 * ran, in what order, and how long each took. A step limit guards against
 * an edge resolver that loops.
 */
import type { Observability } from "../services/observability.js";

export const END = "__end__";

export type NodeFn<S extends object> = (state: S) => Promise<Partial<S>>;
export type EdgeResolver<S extends object> = (state: S) => string;

export interface NodeTrace {
  readonly node: string;
  readonly durationMs: number;
}

export interface GraphRun<S extends object> {
  readonly state: S;
  readonly trace: readonly NodeTrace[];
}

export class GraphDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphDefinitionError";
  }
}

export class StateGraph<S extends object> {
  private readonly nodes = new Map<string, NodeFn<S>>();
  private readonly edges = new Map<string, EdgeResolver<S>>();
  private entry: string | null = null;

  constructor(private readonly name: string) {}

  addNode(name: string, fn: NodeFn<S>): this {
    if (name === END) throw new GraphDefinitionError(`"${END}" is reserved`);
    if (this.nodes.has(name)) throw new GraphDefinitionError(`node "${name}" already defined`);
    this.nodes.set(name, fn);
    return this;
  }

  addEdge(from: string, to: string): this {
    this.edges.set(from, () => to);
    return this;
  }

  addConditionalEdge(from: string, resolver: EdgeResolver<S>): this {
    this.edges.set(from, resolver);
    return this;
  }

  setEntry(name: string): this {
    this.entry = name;
    return this;
  }

  compile(obs: Observability, maxSteps = 32): CompiledGraph<S> {
    if (this.entry === null) throw new GraphDefinitionError("entry node not set");
    if (!this.nodes.has(this.entry)) throw new GraphDefinitionError(`entry node "${this.entry}" not defined`);
    for (const name of this.nodes.keys()) {
      if (!this.edges.has(name)) throw new GraphDefinitionError(`node "${name}" has no outgoing edge`);
    }
    return new CompiledGraph(this.name, this.entry, new Map(this.nodes), new Map(this.edges), obs, maxSteps);
  }
}

export class CompiledGraph<S extends object> {
  constructor(
    private readonly name: string,
    private readonly entry: string,
    private readonly nodes: ReadonlyMap<string, NodeFn<S>>,
    private readonly edges: ReadonlyMap<string, EdgeResolver<S>>,
    private readonly obs: Observability,
    private readonly maxSteps: number,
  ) {}

  async invoke(initial: S): Promise<GraphRun<S>> {
    let state = initial;
    const trace: NodeTrace[] = [];
    let current = this.entry;
    let steps = 0;
    while (current !== END) {
      if (steps >= this.maxSteps) throw new Error(`graph "${this.name}" exceeded ${this.maxSteps} steps at node "${current}"`);
      const fn = this.nodes.get(current);
      const edge = this.edges.get(current);
      if (!fn || !edge) throw new Error(`graph "${this.name}" reached unknown node "${current}"`);
      const nodeName = current;
      const started = performance.now();
      const update = await this.obs.span(`graph.${this.name}.${nodeName}`, { step: steps }, () => fn(state));
      state = { ...state, ...update };
      trace.push({ node: nodeName, durationMs: Math.round((performance.now() - started) * 100) / 100 });
      current = edge(state);
      steps += 1;
    }
    return { state, trace };
  }
}
