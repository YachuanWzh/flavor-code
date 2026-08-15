import { beforeAll, describe, expect, it } from "vitest";

import { extract } from "../../../src/init/astgraph/extract.mjs";
import { initGrammars, parseSource } from "../../../src/init/astgraph/grammars.mjs";

await initGrammars();

const FIXTURE = `
import { helper } from "./util.js";

/** Says hello. */
export function greet(name: string): string {
  helper(name);
  return "hi " + name;
}

export class OrderService {
  cancel(id: number): void {
    helper(id);
  }
}

class LocalDao extends OrderService {
  find(): number { return this.cancel(1), 0; }
}

interface Repo { load(): void }

type Alias = string;

export const arrowFn = () => greet("x");

function privateFn() {
  greet("y");
  missingThing();
}
`;

describe("astgram grammar loading", () => {
  it("parses TypeScript source without errors", async () => {
    const tree = await parseSource(FIXTURE, "typescript");
    expect(tree.rootNode.type).toBe("program");
    expect(tree.rootNode.hasError).toBe(false);
  });
});

describe("astgraph TypeScript extractor", () => {
  let result;

  beforeAll(async () => { result = await extract(FIXTURE, "src/a.ts", "typescript"); });

  it("extracts top-level declaration nodes with location and export flags", () => {
    const names = new Map(result.nodes.map((node) => [node.name, node]));
    expect([...names.keys()]).toEqual(
      expect.arrayContaining(["greet", "OrderService", "LocalDao", "Repo", "Alias", "arrowFn", "privateFn", "cancel", "find"]),
    );
    const greet = names.get("greet");
    expect(greet.kind).toBe("function");
    expect(greet.isExported).toBe(true);
    expect(greet.startLine).toBe(5);
    expect(greet.endLine).toBe(8);
    expect(greet.docstring).toBe("Says hello.");
    const dao = names.get("LocalDao");
    expect(dao.isExported).toBe(false);
    expect(dao.kind).toBe("class");
    expect(names.get("cancel").kind).toBe("method");
    expect(names.get("Repo").kind).toBe("interface");
    expect(names.get("Alias").kind).toBe("type");
  });

  it("extracts intra-file call edges", () => {
    const byId = new Map(result.nodes.map((node) => [node.name, node.id]));
    const callEdges = result.edges.filter((edge) => edge.kind === "calls");
    // arrowFn → greet (intra-file)
    expect(callEdges).toContainEqual(expect.objectContaining({
      source: byId.get("arrowFn"), target: byId.get("greet"),
    }));
    // privateFn → greet (intra-file)
    expect(callEdges).toContainEqual(expect.objectContaining({
      source: byId.get("privateFn"), target: byId.get("greet"),
    }));
  });

  it("extracts extends/implements edges for intra-file types", () => {
    const byId = new Map(result.nodes.map((node) => [node.name, node.id]));
    expect(result.edges).toContainEqual(expect.objectContaining({
      source: byId.get("LocalDao"), target: byId.get("OrderService"), kind: "extends",
    }));
  });

  it("records cross-file references as unresolved", () => {
    const refs = result.refs;
    // import { helper } from "./util.js"
    expect(refs).toContainEqual(expect.objectContaining({
      referenceName: "helper", referenceKind: "import", moduleSpecifier: "./util.js",
    }));
    // missingThing() cannot be resolved anywhere
    expect(refs.some((ref) => ref.referenceName === "missingThing" && ref.referenceKind === "call")).toBe(true);
    // helper(...) calls resolve to the imported binding only at resolution time
    expect(refs.some((ref) => ref.referenceName === "helper" && ref.referenceKind === "call")).toBe(true);
  });
});
