/**
 * Dependency graph model and transitive-closure counting.
 *
 * npm dependency graphs contain cycles (e.g. many `@babel/*` packages, or
 * `readable-stream` <-> `string_decoder` in older trees), so a naive
 * memoized DFS gives wrong counts. We condense the graph into strongly
 * connected components (Tarjan), then propagate reachable-node bitsets in
 * reverse topological order over the resulting DAG.
 */

export interface GraphNode {
  /** Unique id, usually `name@version`. */
  id: string;
  name: string;
  version: string;
  /** True when this node is the project root or a workspace package. */
  isRoot?: boolean;
  /** True when this node is only reachable via dev dependencies of the root. */
  dev?: boolean;
  /** Indices (into the graph's node array) of resolved dependencies. */
  deps: number[];
}

export interface DepCounts {
  /** Number of resolved direct dependencies. */
  direct: number;
  /** Number of distinct packages reachable through dependencies (direct + indirect). */
  transitive: number;
}

/** Tarjan's strongly-connected-components algorithm (iterative, stack-safe). */
function stronglyConnectedComponents(nodes: GraphNode[]): {
  componentOf: Int32Array;
  componentCount: number;
} {
  const n = nodes.length;
  const index = new Int32Array(n).fill(-1);
  const lowlink = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const componentOf = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  let nextIndex = 0;
  let componentCount = 0;

  // Explicit DFS stack of [node, positionInDepsList] to avoid recursion limits.
  const callStack: Array<[number, number]> = [];

  for (let start = 0; start < n; start++) {
    if (index[start] !== -1) continue;
    callStack.push([start, 0]);
    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const v = frame[0];
      if (frame[1] === 0) {
        index[v] = nextIndex;
        lowlink[v] = nextIndex;
        nextIndex++;
        stack.push(v);
        onStack[v] = 1;
      }
      let advanced = false;
      while (frame[1] < nodes[v].deps.length) {
        const w = nodes[v].deps[frame[1]];
        frame[1]++;
        if (index[w] === -1) {
          callStack.push([w, 0]);
          advanced = true;
          break;
        } else if (onStack[w]) {
          lowlink[v] = Math.min(lowlink[v], index[w]);
        }
      }
      if (advanced) continue;
      // All deps of v processed.
      if (lowlink[v] === index[v]) {
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          componentOf[w] = componentCount;
        } while (w !== v);
        componentCount++;
      }
      callStack.pop();
      if (callStack.length > 0) {
        const parent = callStack[callStack.length - 1][0];
        lowlink[parent] = Math.min(lowlink[parent], lowlink[v]);
      }
    }
  }

  return { componentOf, componentCount };
}

function popcount(word: number): number {
  let v = word - ((word >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Compute direct and transitive dependency counts for every node.
 * The transitive count is the number of *distinct* packages reachable via
 * dependency edges, excluding the node itself (i.e. direct + indirect).
 */
export function computeCounts(nodes: GraphNode[]): DepCounts[] {
  const n = nodes.length;
  const { componentOf, componentCount } = stronglyConnectedComponents(nodes);

  // Tarjan emits components in reverse topological order: when component c
  // is finished, every component it can reach has a smaller id. So a simple
  // ascending sweep over component ids processes dependencies first.
  const words = Math.ceil(n / 32) || 1;
  const reach: Uint32Array[] = new Array(componentCount);
  const membersOf: number[][] = Array.from({ length: componentCount }, () => []);
  for (let v = 0; v < n; v++) membersOf[componentOf[v]].push(v);

  for (let c = 0; c < componentCount; c++) {
    const bits = new Uint32Array(words);
    for (const v of membersOf[c]) {
      bits[v >>> 5] |= 1 << (v & 31);
      for (const w of nodes[v].deps) {
        const wc = componentOf[w];
        if (wc !== c) {
          const other = reach[wc];
          for (let i = 0; i < words; i++) bits[i] |= other[i];
        }
      }
    }
    reach[c] = bits;
  }

  const result: DepCounts[] = new Array(n);
  for (let v = 0; v < n; v++) {
    const bits = reach[componentOf[v]];
    let total = 0;
    for (let i = 0; i < words; i++) total += popcount(bits[i]);
    const direct = new Set(nodes[v].deps.filter((d) => d !== v)).size;
    result[v] = { direct, transitive: total - 1 }; // exclude the node itself
  }
  return result;
}
