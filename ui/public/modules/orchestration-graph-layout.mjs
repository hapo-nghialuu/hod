const ROW_GAP = 110;
const MIN_HEIGHT = 340;
const BAND_X = Object.freeze([18, 50, 82]);
const WORKER_X = 74;
const NODE_HEIGHT = 88;
const NODE_VERTICAL_PADDING = 32;
const DESKTOP_NODE_WIDTH = 24;
const MOBILE_NODE_WIDTH = 84;
const BAND_HEADER = 28;
const BAND_GAP = 28;

function rowsFor(count, columns) {
  return Math.ceil(count / columns);
}

function rowGeometry(rowCount) {
  const contentHeight = Math.max(0, rowCount - 1) * ROW_GAP + NODE_HEIGHT;
  const contentSpan = contentHeight + NODE_VERTICAL_PADDING * 2;
  const height = Math.max(MIN_HEIGHT, contentSpan);
  const top = (height - contentSpan) / 2 + NODE_VERTICAL_PADDING;
  return { height, y: (row) => top + row * ROW_GAP };
}

function placeBand(group, rowStart, geometry, width) {
  group.forEach((node, index) => {
    node.position.desktop = {
      x: BAND_X[index % BAND_X.length],
      y: geometry.y(rowStart + Math.floor(index / BAND_X.length)),
      width,
      height: NODE_HEIGHT,
    };
  });
}

function layoutGroup(nodes) {
  const advisors = nodes.filter((node) => node.role === 'advisor');
  const controllers = nodes.filter((node) => node.role === 'controller' || node.role === 'unmapped');
  const workers = nodes.filter((node) => node.role === 'worker');
  const bottom = nodes.filter((node) => node.role === 'reviewer' || node.role === 'tester');
  const advisorRows = rowsFor(advisors.length, BAND_X.length);
  const middleRows = Math.max(1, controllers.length, workers.length);
  const bottomRows = rowsFor(bottom.length, BAND_X.length);
  const desktop = rowGeometry(advisorRows + middleRows + bottomRows);
  const middleStart = advisorRows;
  const bottomStart = middleStart + middleRows;

  for (const node of nodes) node.position = {
    desktop: { x: 50, y: 50, width: DESKTOP_NODE_WIDTH, height: NODE_HEIGHT },
    mobile: { x: 50, y: 50, width: MOBILE_NODE_WIDTH, height: NODE_HEIGHT },
  };
  placeBand(advisors, 0, desktop, DESKTOP_NODE_WIDTH);
  const controllerOffset = Math.max(0, (middleRows - controllers.length) / 2);
  controllers.forEach((node, index) => {
    node.position.desktop = {
      x: 20, y: desktop.y(middleStart + controllerOffset + index), width: DESKTOP_NODE_WIDTH, height: NODE_HEIGHT,
    };
  });
  workers.forEach((node, index) => {
    node.position.desktop = {
      x: WORKER_X, y: desktop.y(middleStart + index),
      width: DESKTOP_NODE_WIDTH, height: NODE_HEIGHT,
    };
  });
  placeBand(bottom, bottomStart, desktop, DESKTOP_NODE_WIDTH);

  const mobile = rowGeometry(Math.max(1, nodes.length));
  [...advisors, ...controllers, ...workers, ...bottom].forEach((node, index) => {
    node.position.mobile = { x: 50, y: mobile.y(index), width: MOBILE_NODE_WIDTH, height: NODE_HEIGHT };
  });
  return {
    height: desktop.height,
    mobileHeight: mobile.height,
    lanes: {
      advisor: desktop.y(0), controller: desktop.y(middleStart),
      worker: desktop.y(middleStart), review: desktop.y(bottomStart),
    },
  };
}

function groupsByWorkspace(nodes) {
  const groups = []; const byWorkspace = new Map();
  for (const node of nodes) {
    const workspaceId = node.workspaceId ?? null;
    let group = byWorkspace.get(workspaceId);
    if (!group) { group = []; byWorkspace.set(workspaceId, group); groups.push({ workspaceId, nodes: group }); }
    group.push(node);
  }
  return groups;
}

function offsetGroup(group, layout, desktopOffset, mobileOffset) {
  for (const node of group) {
    node.position.desktop.y += desktopOffset;
    node.position.mobile.y += mobileOffset;
  }
  return Object.fromEntries(Object.entries(layout.lanes).map(([name, y]) => [name, y + desktopOffset]));
}

function sectionBounds(top, height) { return { top, bottom: top + height, height }; }

export function layoutOrchestrationNodes(nodes) {
  const groups = groupsByWorkspace(nodes);
  if (groups.length <= 1) {
    const layout = layoutGroup(nodes);
    return { ...layout, sections: groups.length ? [{ workspaceId: groups[0].workspaceId,
      bounds: { desktop: sectionBounds(0, layout.height), mobile: sectionBounds(0, layout.mobileHeight) } }] : [] };
  }
  let desktopCursor = 0; let mobileCursor = 0; const sections = []; let lanes;
  for (const { workspaceId, nodes: group } of groups) {
    const layout = layoutGroup(group);
    const desktopTop = desktopCursor; const mobileTop = mobileCursor;
    const desktopOffset = desktopTop + BAND_HEADER; const mobileOffset = mobileTop + BAND_HEADER;
    const adjustedLanes = offsetGroup(group, layout, desktopOffset, mobileOffset);
    lanes ??= adjustedLanes;
    const desktopHeight = BAND_HEADER + layout.height; const mobileHeight = BAND_HEADER + layout.mobileHeight;
    sections.push({ workspaceId, lanes: Object.fromEntries(Object.entries(layout.lanes).map(([name, y]) => [name, y + desktopOffset])),
      bounds: { desktop: sectionBounds(desktopTop, desktopHeight), mobile: sectionBounds(mobileTop, mobileHeight) } });
    desktopCursor += desktopHeight + BAND_GAP; mobileCursor += mobileHeight + BAND_GAP;
  }
  return { height: desktopCursor - BAND_GAP, mobileHeight: mobileCursor - BAND_GAP, lanes, sections };
}
