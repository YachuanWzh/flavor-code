// Mind map tree layout. Pure and deterministic.
// Loadable from Node (module.exports) and the browser (window.MindmapLayout).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MindmapLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LEVEL_X = 220; // horizontal distance per depth level
  const NODE_H = 44;   // vertical slot per leaf

  function leafCount(node) {
    if (!node.children || node.children.length === 0) return 1;
    return node.children.reduce((sum, c) => sum + leafCount(c), 0);
  }

  // Distribute root children left/right, balancing total leaf count.
  function splitSides(children) {
    const right = [];
    const left = [];
    let rightLeaves = 0;
    let leftLeaves = 0;
    for (const c of children) {
      const n = leafCount(c);
      if (rightLeaves <= leftLeaves) { right.push(c); rightLeaves += n; }
      else { left.push(c); leftLeaves += n; }
    }
    return { right, left };
  }

  function visit(node, depth, side, top, parentId, nodes, links) {
    const leaves = leafCount(node);
    nodes.push({
      id: node.id,
      label: node.label,
      kind: node.kind || 'note',
      state: node.state || 'open',
      note: node.note || '',
      x: side * depth * LEVEL_X,
      y: top + (leaves * NODE_H) / 2,
      side,
    });
    links.push({ from: parentId, to: node.id });
    let childTop = top;
    for (const c of node.children || []) {
      visit(c, depth + 1, side, childTop, node.id, nodes, links);
      childTop += leafCount(c) * NODE_H;
    }
  }

  function layout(rootNode) {
    const nodes = [];
    const links = [];
    if (!rootNode) return { nodes, links };
    nodes.push({
      id: rootNode.id,
      label: rootNode.label,
      kind: rootNode.kind || 'topic',
      state: rootNode.state || 'open',
      note: rootNode.note || '',
      x: 0,
      y: 0,
      side: 0,
    });
    const { right, left } = splitSides(rootNode.children || []);
    for (const [side, group] of [[1, right], [-1, left]]) {
      const total = group.reduce((sum, c) => sum + leafCount(c), 0);
      let top = -(total * NODE_H) / 2;
      for (const c of group) {
        visit(c, 1, side, top, rootNode.id, nodes, links);
        top += leafCount(c) * NODE_H;
      }
    }
    return { nodes, links };
  }

  return { layout, leafCount, splitSides };
});
