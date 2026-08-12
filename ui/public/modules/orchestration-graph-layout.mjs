const ROW_GAP = 110;
const MIN_HEIGHT = 340;
const BAND_X = Object.freeze([18, 50, 82]);
const WORKER_X = 74;
const NODE_HEIGHT = 88;
const NODE_VERTICAL_PADDING = 32;
const DESKTOP_NODE_WIDTH = 24;
const MOBILE_NODE_WIDTH = 84;

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

export function layoutOrchestrationNodes(nodes) {
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
