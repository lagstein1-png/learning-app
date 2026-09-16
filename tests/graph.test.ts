import { describe, expect, it } from "vitest";
import { END, GraphDefinitionError, StateGraph } from "../src/orchestration/graph.js";
import { testObservability } from "./helpers/mocks.js";

interface Counter {
  readonly n: number;
  readonly path: readonly string[];
}

describe("StateGraph", () => {
  it("runs nodes in edge order, merges partial updates and records a trace", async () => {
    const graph = new StateGraph<Counter>("t")
      .setEntry("a")
      .addNode("a", (s) => Promise.resolve({ n: s.n + 1, path: [...s.path, "a"] }))
      .addEdge("a", "b")
      .addNode("b", (s) => Promise.resolve({ n: s.n * 10, path: [...s.path, "b"] }))
      .addEdge("b", END)
      .compile(testObservability());
    const run = await graph.invoke({ n: 1, path: [] });
    expect(run.state).toEqual({ n: 20, path: ["a", "b"] });
    expect(run.trace.map((t) => t.node)).toEqual(["a", "b"]);
    expect(run.trace.every((t) => t.durationMs >= 0)).toBe(true);
  });

  it("follows conditional edges and stops at the step limit when they loop", async () => {
    const graph = new StateGraph<Counter>("loop")
      .setEntry("inc")
      .addNode("inc", (s) => Promise.resolve({ n: s.n + 1 }))
      .addConditionalEdge("inc", (s) => (s.n >= 3 ? END : "inc"))
      .compile(testObservability(), 10);
    const run = await graph.invoke({ n: 0, path: [] });
    expect(run.state.n).toBe(3);

    const forever = new StateGraph<Counter>("forever")
      .setEntry("inc")
      .addNode("inc", (s) => Promise.resolve({ n: s.n + 1 }))
      .addConditionalEdge("inc", () => "inc")
      .compile(testObservability(), 5);
    await expect(forever.invoke({ n: 0, path: [] })).rejects.toThrow(/exceeded 5 steps/);
  });

  it("propagates node errors with the span recorded as failed", async () => {
    const spans: string[] = [];
    const obs = testObservability();
    const graph = new StateGraph<Counter>("boom")
      .setEntry("x")
      .addNode("x", () => Promise.reject(new Error("kaboom")))
      .addEdge("x", END)
      .compile(obs);
    await expect(graph.invoke({ n: 0, path: [] })).rejects.toThrow("kaboom");
    expect(obs.metrics().counters["span.graph.boom.x.error"]).toBe(1);
    expect(spans).toEqual([]);
  });

  it("refuses an invalid definition at compile time", () => {
    expect(() => new StateGraph<Counter>("x").compile(testObservability())).toThrow(GraphDefinitionError);
    expect(() => new StateGraph<Counter>("x").setEntry("missing").compile(testObservability())).toThrow(/entry node "missing"/);
    expect(() =>
      new StateGraph<Counter>("x")
        .setEntry("a")
        .addNode("a", (s) => Promise.resolve(s))
        .compile(testObservability()),
    ).toThrow(/no outgoing edge/);
    expect(() => new StateGraph<Counter>("x").addNode(END, (s) => Promise.resolve(s))).toThrow(/reserved/);
    expect(() =>
      new StateGraph<Counter>("x")
        .addNode("a", (s) => Promise.resolve(s))
        .addNode("a", (s) => Promise.resolve(s)),
    ).toThrow(/already defined/);
  });
});
