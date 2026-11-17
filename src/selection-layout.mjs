// Half of the native 48-unit grid matches the 24-unit arrangement gap.
export function snapGridPoint(point, step = 24) {
  return { x: Math.round(point.x / step) * step, y: Math.round(point.y / step) * step };
}

export function snapGridOffset(anchor, offset, step = 24) {
  const target = snapGridPoint({ x: anchor.x + offset.x, y: anchor.y + offset.y }, step);
  return { x: target.x - anchor.x, y: target.y - anchor.y };
}

export function layoutTrackCenters(sizes, gap = 24) {
  let start = 0;
  return sizes.map(size => {
    const center = start + size / 2;
    start += size + gap;
    return center;
  });
}

// Infer occupied tracks from the existing layout. Fractional tracks preserve
// deliberately centered short rows, while integer tracks retain interior holes.
export function alignedSelectionPositions(items, gap = 24) {
  if (items.length < 2) return null;
  const minimumOverlapRatio = 0.35;
  const centerToleranceRatio = 0.4;
  function collectBands(axis, dimension) {
    const ordered = [...items].sort((first, second) => first.position[axis] + first[dimension] / 2 - second.position[axis] - second[dimension] / 2);
    const bands = [];
    for (const node of ordered) {
      const start = node.position[axis], end = start + node[dimension];
      const previous = bands.at(-1);
      const overlap = previous && Math.min(previous.end, end) - Math.max(previous.start, start);
      if (previous && overlap > 0 && overlap >= Math.min(previous.end - previous.start, node[dimension]) * minimumOverlapRatio) {
        previous.items.push(node);
        previous.start = Math.max(previous.start, start);
        previous.end = Math.min(previous.end, end);
      } else bands.push({ start, end, items: [node] });
    }
    return bands;
  }
  const rows = collectBands('y', 'height'), columns = collectBands('x', 'width');
  const aligned = new Set();
  for (const band of [...rows, ...columns]) {
    if (band.items.length > 1) for (const node of band.items) aligned.add(node.id);
  }
  const longestRow = Math.max(...rows.map(band => band.items.length));
  const longestColumn = Math.max(...columns.map(band => band.items.length));
  function planForBands(horizontal) {
    const mainAxis = horizontal ? 'x' : 'y', crossAxis = horizontal ? 'y' : 'x';
    const mainSize = horizontal ? 'width' : 'height', crossSize = horizontal ? 'height' : 'width';
    const bands = horizontal ? rows : columns;
    if (Math.max(...bands.map(band => band.items.length)) < 2) return null;
    for (const band of bands) band.key = band.items.map(node => node.id).sort().join('\0');
    const reference = bands.reduce((best, band) => band.items.length > best.items.length
      || band.items.length === best.items.length && band.key < best.key ? band : best);
    const sourceCenter = node => node.position[mainAxis] + node[mainSize] / 2;
    const referenceItems = [...reference.items].sort((first, second) => sourceCenter(first) - sourceCenter(second));
    const referenceCenters = referenceItems.map(sourceCenter);
    if (referenceCenters.some((center, index) => index && center <= referenceCenters[index - 1])) return null;
    function fractionalTrack(center) {
      let lower = 0, upper = referenceCenters.length - 1;
      while (upper - lower > 1) {
        const middle = Math.floor((lower + upper) / 2);
        if (center >= referenceCenters[middle]) lower = middle;
        else upper = middle;
      }
      return lower + (center - referenceCenters[lower]) / (referenceCenters[lower + 1] - referenceCenters[lower]);
    }
    function atTrack(track, centers) {
      const lower = Math.max(0, Math.min(centers.length - 2, Math.floor(track)));
      return centers[lower] + (track - lower) * (centers[lower + 1] - centers[lower]);
    }
    const tracks = new Map(), sizes = referenceItems.map(node => node[mainSize]);
    const lines = bands.map(band => [...band.items].sort((first, second) => sourceCenter(first) - sourceCenter(second)));
    for (const line of lines) {
      let previous = -Infinity;
      for (const node of line) {
        const center = sourceCenter(node);
        let track = fractionalTrack(center);
        const nearest = Math.max(0, Math.min(referenceItems.length - 1, Math.round(track)));
        // Track-relative tolerance stays stable when the widest image changes.
        if (Math.abs(track - nearest) <= centerToleranceRatio + 0.000000001) track = nearest;
        if (track <= previous) return null;
        tracks.set(node.id, track);
        if (Number.isInteger(track) && track >= 0 && track < sizes.length) sizes[track] = Math.max(sizes[track], node[mainSize]);
        previous = track;
      }
    }
    const centers = layoutTrackCenters(sizes, gap);
    let extraGap = 0;
    for (const line of lines) for (let index = 1; index < line.length; index++) {
      const previous = line[index - 1], node = line[index];
      const firstTrack = tracks.get(previous.id), nextTrack = tracks.get(node.id);
      const required = (previous[mainSize] + node[mainSize]) / 2 + gap;
      extraGap = Math.max(extraGap, (required - atTrack(nextTrack, centers) + atTrack(firstTrack, centers)) / (nextTrack - firstTrack));
    }
    const spacedCenters = centers.map((center, index) => center + index * extraGap);
    const crossCenters = layoutTrackCenters(lines.map(line => Math.max(...line.map(node => node[crossSize]))), gap);
    const positions = new Map();
    for (const [index, line] of lines.entries()) for (const node of line) {
      positions.set(node.id, { [mainAxis]: atTrack(tracks.get(node.id), spacedCenters) - node[mainSize] / 2,
        [crossAxis]: crossCenters[index] - node[crossSize] / 2 });
    }
    const largest = items.reduce((best, node) => node.width * node.height > best.width * best.height ? node : best);
    const origin = positions.get(largest.id);
    const offset = { x: largest.position.x - origin.x, y: largest.position.y - origin.y };
    const stable = (previous, next) => Math.abs(previous - next) < 0.000001 ? previous : next;
    for (const node of items) {
      const position = positions.get(node.id);
      positions.set(node.id, { x: stable(node.position.x, position.x + offset.x), y: stable(node.position.y, position.y + offset.y) });
    }
    return positions;
  }
  let best = null, bestMovement = Infinity;
  const preferredHorizontal = longestRow >= longestColumn;
  // A layout that already satisfies either axis has zero movement and wins.
  for (const horizontal of [preferredHorizontal, !preferredHorizontal]) {
    const candidate = planForBands(horizontal);
    if (!candidate) continue;
    const movement = items.reduce((sum, node) => {
      const target = candidate.get(node.id);
      return sum + Math.abs(target.x - node.position.x) + Math.abs(target.y - node.position.y);
    }, 0);
    if (!best || movement === 0) { best = candidate; bestMovement = movement; }
    if (movement === 0) break;
  }
  return aligned.size >= Math.ceil(items.length * 2 / 3) || bestMovement === 0 ? best : null;
}

// Preserve recognizable arrangements before compacting scattered selections.
export function compactSelectionPositions(items, center, gap = 24) {
  if (!items.length) return new Map();
  const aligned = alignedSelectionPositions(items, gap);
  if (aligned) return aligned;
  const ordered = [...items].sort((first, second) => first.position.y - second.position.y || first.position.x - second.position.x);
  const columnCount = Math.ceil(Math.sqrt(ordered.length));
  const widths = Array(columnCount).fill(0), heights = [];
  for (const [index, node] of ordered.entries()) {
    const column = index % columnCount, row = Math.floor(index / columnCount);
    widths[column] = Math.max(widths[column], node.width);
    heights[row] = Math.max(heights[row] || 0, node.height);
  }
  const columns = layoutTrackCenters(widths, gap), rows = layoutTrackCenters(heights, gap);
  const width = widths.reduce((sum, value) => sum + value, 0) + gap * (widths.length - 1);
  const height = heights.reduce((sum, value) => sum + value, 0) + gap * (heights.length - 1);
  const left = Math.round(center.x - width / 2), top = Math.round(center.y - height / 2);
  const positions = new Map();
  for (const [index, node] of ordered.entries()) {
    positions.set(node.id, { x: left + columns[index % columnCount] - node.width / 2,
      y: top + rows[Math.floor(index / columnCount)] - node.height / 2 });
  }
  return positions;
}

export function selectionToolbarPosition(selection, canvas, size, obstacles = []) {
  const padding = 12;
  const leftLimit = canvas.left + padding;
  const rightLimit = Math.max(leftLimit, canvas.right - size.width - padding);
  const topLimit = canvas.top + 72;
  const bottomLimit = Math.max(topLimit, canvas.bottom - size.height - 80);
  if (!selection) return { left: leftLimit, top: topLimit };
  const centerX = (selection.left + selection.right) / 2;
  const centerY = (selection.top + selection.bottom) / 2;
  const candidates = [
    { left: centerX - size.width / 2, top: selection.top - size.height - padding },
    { left: centerX - size.width / 2, top: selection.bottom + padding },
    { left: selection.right + padding, top: centerY - size.height / 2 },
    { left: selection.left - size.width - padding, top: centerY - size.height / 2 },
  ];
  for (const obstacle of obstacles) {
    candidates.push({ left: centerX - size.width / 2, top: obstacle.top - size.height - padding });
    candidates.push({ left: obstacle.left - size.width - padding, top: centerY - size.height / 2 });
  }
  const overlap = (first, second) => Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left))
    * Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
  let best, bestScore = Infinity;
  for (const [index, candidate] of candidates.entries()) {
    const left = Math.max(leftLimit, Math.min(rightLimit, candidate.left));
    const top = Math.max(topLimit, Math.min(bottomLimit, candidate.top));
    const rect = { left, top, right: left + size.width, bottom: top + size.height };
    const blocked = obstacles.reduce((area, obstacle) => area + overlap(rect, obstacle), 0);
    const score = blocked * 10 + overlap(rect, selection) + Math.abs(left - candidate.left) + Math.abs(top - candidate.top) + index;
    if (score < bestScore) { bestScore = score; best = { left, top }; }
  }
  return best;
}
