import {
  EPS,
  FaceDir,
  FaceSubdivision,
  MassingBox,
  MassingFace,
  MassingScaleConfig,
  MassingState,
  Rect2D,
  SplitAxis,
  Vec3,
} from './types';
import {
  dirToNormal,
  faceCenter3D,
  faceToCorners3D,
  mergeCoplanarRects2D,
  oppositeDir,
  rectsEqual,
  roundCoord,
  subtractRects2D,
} from './math2d';

let boxCounter = 1;
function nextBoxId(): string {
  return `box_${boxCounter++}`;
}

const ALL_DIRS: FaceDir[] = ['+y', '-y', '+z', '-z', '+x', '-x'];

export function createMassingFromBoxes(
  boxes: { min: Vec3; max: Vec3 }[]
): MassingState {
  boxCounter = 1;
  return {
    boxes: boxes.map((b) => ({
      id: nextBoxId(),
      min: [roundCoord(b.min[0]), Math.max(0, roundCoord(b.min[1])), roundCoord(b.min[2])],
      max: [roundCoord(b.max[0]), roundCoord(b.max[1]), roundCoord(b.max[2])],
      createdStep: 0,
    })),
    subdivisions: [],
    step: 0,
  };
}

export function boxFacePlane(box: MassingBox, dir: FaceDir): number {
  switch (dir) {
    case '+x': return box.max[0];
    case '-x': return box.min[0];
    case '+y': return box.max[1];
    case '-y': return box.min[1];
    case '+z': return box.max[2];
    case '-z': return box.min[2];
  }
}

export function boxFaceRect(box: MassingBox, dir: FaceDir): Rect2D {
  switch (dir) {
    case '+z':
    case '-z':
      return { u0: box.min[0], u1: box.max[0], v0: box.min[1], v1: box.max[1] };
    case '+x':
    case '-x':
      return { u0: box.min[2], u1: box.max[2], v0: box.min[1], v1: box.max[1] };
    case '+y':
    case '-y':
      return { u0: box.min[0], u1: box.max[0], v0: box.min[2], v1: box.max[2] };
  }
}

function makeBoxFromFaceExtrude(
  dir: FaceDir,
  plane: number,
  rect: Rect2D,
  distance: number,
  createdStep: number,
  minSize = 0.04
): MassingBox | null {
  if (Math.abs(distance) < minSize) return null;

  const n = dirToNormal(dir);
  const wA = plane;
  let wB = roundCoord(plane + distance * (n[0] + n[1] + n[2]));

  if ((dir === '+y' || dir === '-y') && wB < 0) {
    wB = 0;
  }

  const wMin = roundCoord(Math.min(wA, wB));
  const wMax = roundCoord(Math.max(wA, wB));
  if (wMax - wMin < minSize) return null;

  let min: Vec3;
  let max: Vec3;
  switch (dir) {
    case '+z':
    case '-z':
      min = [roundCoord(rect.u0), Math.max(0, roundCoord(rect.v0)), wMin];
      max = [roundCoord(rect.u1), roundCoord(rect.v1), wMax];
      break;
    case '+x':
    case '-x':
      min = [wMin, Math.max(0, roundCoord(rect.v0)), roundCoord(rect.u0)];
      max = [wMax, roundCoord(rect.v1), roundCoord(rect.u1)];
      break;
    case '+y':
    case '-y':
      min = [roundCoord(rect.u0), Math.max(0, wMin), roundCoord(rect.v0)];
      max = [roundCoord(rect.u1), wMax, roundCoord(rect.v1)];
      break;
  }

  if (max[0] - min[0] < minSize || max[1] - min[1] < minSize || max[2] - min[2] < minSize) {
    return null;
  }

  return { id: nextBoxId(), min, max, createdStep };
}

function boxesOverlap3D(a: MassingBox, b: MassingBox): boolean {
  return (
    a.min[0] < b.max[0] - EPS &&
    a.max[0] > b.min[0] + EPS &&
    a.min[1] < b.max[1] - EPS &&
    a.max[1] > b.min[1] + EPS &&
    a.min[2] < b.max[2] - EPS &&
    a.max[2] > b.min[2] + EPS
  );
}

export function subtractBox3D(source: MassingBox, cutter: MassingBox, minSize = 0.04): MassingBox[] {
  if (!boxesOverlap3D(source, cutter)) return [source];

  const ix0 = Math.max(source.min[0], cutter.min[0]);
  const ix1 = Math.min(source.max[0], cutter.max[0]);
  const iy0 = Math.max(source.min[1], cutter.min[1]);
  const iy1 = Math.min(source.max[1], cutter.max[1]);
  const iz0 = Math.max(source.min[2], cutter.min[2]);
  const iz1 = Math.min(source.max[2], cutter.max[2]);

  const pieces: MassingBox[] = [];
  const pushPiece = (min: Vec3, max: Vec3) => {
    const rMin: Vec3 = [roundCoord(min[0]), roundCoord(min[1]), roundCoord(min[2])];
    const rMax: Vec3 = [roundCoord(max[0]), roundCoord(max[1]), roundCoord(max[2])];
    if (
      rMax[0] - rMin[0] >= minSize &&
      rMax[1] - rMin[1] >= minSize &&
      rMax[2] - rMin[2] >= minSize
    ) {
      pieces.push({ id: nextBoxId(), min: rMin, max: rMax, createdStep: source.createdStep });
    }
  };

  pushPiece([source.min[0], source.min[1], source.min[2]], [ix0, source.max[1], source.max[2]]);
  pushPiece([ix1, source.min[1], source.min[2]], [source.max[0], source.max[1], source.max[2]]);
  pushPiece([ix0, source.min[1], source.min[2]], [ix1, iy0, source.max[2]]);
  pushPiece([ix0, iy1, source.min[2]], [ix1, source.max[1], source.max[2]]);
  pushPiece([ix0, iy0, source.min[2]], [ix1, iy1, iz0]);
  pushPiece([ix0, iy0, iz1], [ix1, iy1, source.max[2]]);

  return pieces;
}

function addDisjointBox(existing: MassingBox[], newBox: MassingBox, minSize = 0.04): MassingBox[] {
  let fragments: MassingBox[] = [newBox];
  for (const ex of existing) {
    const next: MassingBox[] = [];
    for (const frag of fragments) {
      next.push(...subtractBox3D(frag, ex, minSize));
    }
    fragments = next;
    if (fragments.length === 0) break;
  }
  return [...existing, ...fragments];
}

function carveFromBoxes(existing: MassingBox[], cutter: MassingBox, minSize = 0.04): MassingBox[] {
  const result: MassingBox[] = [];
  for (const b of existing) {
    result.push(...subtractBox3D(b, cutter, minSize));
  }
  return result;
}

function tryMergeAlignedPair(a: MassingBox, b: MassingBox): MassingBox | null {
  const eq = (u: number, v: number) => Math.abs(u - v) < 0.015;
  const createdStep = Math.max(a.createdStep, b.createdStep);

  if (eq(a.min[0], b.min[0]) && eq(a.max[0], b.max[0]) && eq(a.min[2], b.min[2]) && eq(a.max[2], b.max[2])) {
    if (eq(a.max[1], b.min[1]) || eq(b.max[1], a.min[1])) {
      return {
        id: a.id,
        min: [a.min[0], roundCoord(Math.min(a.min[1], b.min[1])), a.min[2]],
        max: [a.max[0], roundCoord(Math.max(a.max[1], b.max[1])), a.max[2]],
        createdStep,
      };
    }
  }
  if (eq(a.min[1], b.min[1]) && eq(a.max[1], b.max[1]) && eq(a.min[2], b.min[2]) && eq(a.max[2], b.max[2])) {
    if (eq(a.max[0], b.min[0]) || eq(b.max[0], a.min[0])) {
      return {
        id: a.id,
        min: [roundCoord(Math.min(a.min[0], b.min[0])), a.min[1], a.min[2]],
        max: [roundCoord(Math.max(a.max[0], b.max[0])), a.max[1], a.max[2]],
        createdStep,
      };
    }
  }
  if (eq(a.min[0], b.min[0]) && eq(a.max[0], b.max[0]) && eq(a.min[1], b.min[1]) && eq(a.max[1], b.max[1])) {
    if (eq(a.max[2], b.min[2]) || eq(b.max[2], a.min[2])) {
      return {
        id: a.id,
        min: [a.min[0], a.min[1], roundCoord(Math.min(a.min[2], b.min[2]))],
        max: [a.max[0], a.max[1], roundCoord(Math.max(a.max[2], b.max[2]))],
        createdStep,
      };
    }
  }
  return null;
}

function mergeTouchingAlignedBoxes(boxes: MassingBox[], protectedBoxIds: Set<string>): MassingBox[] {
  const list = boxes.map((b) => ({ ...b, min: [...b.min] as Vec3, max: [...b.max] as Vec3 }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < list.length && !changed; i++) {
      for (let j = i + 1; j < list.length && !changed; j++) {
        if (protectedBoxIds.has(list[i].id) || protectedBoxIds.has(list[j].id)) continue;
        const merged = tryMergeAlignedPair(list[i], list[j]);
        if (merged) {
          list[i] = merged;
          list.splice(j, 1);
          changed = true;
        }
      }
    }
  }
  return list;
}

function pruneSubdivisions(boxes: MassingBox[], subdivisions: FaceSubdivision[]): FaceSubdivision[] {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  return subdivisions.filter((sub) => byId.has(sub.boxId) && sub.rects.length > 0);
}

export function computeExposedFaces(state: MassingState): MassingFace[] {
  const faces: MassingFace[] = [];
  const subMap = new Map<string, Rect2D[]>();
  for (const sub of state.subdivisions) {
    subMap.set(`${sub.boxId}|${sub.dir}`, sub.rects);
  }

  for (const box of state.boxes) {
    for (const dir of ALL_DIRS) {
      const plane = boxFacePlane(box, dir);
      const baseRect = boxFaceRect(box, dir);
      const opp = oppositeDir(dir);

      const occluders: Rect2D[] = [];
      for (const other of state.boxes) {
        if (other.id === box.id) continue;
        const otherPlane = boxFacePlane(other, opp);
        if (Math.abs(otherPlane - plane) < 0.008) {
          occluders.push(boxFaceRect(other, opp));
        }
      }

      const customRects = subMap.get(`${box.id}|${dir}`);
      const candidateRects = customRects && customRects.length > 0 ? customRects : [baseRect];

      const visibleRects: Rect2D[] = [];
      for (const cr of candidateRects) {
        const pieces = subtractRects2D([cr], occluders);
        for (const p of pieces) {
          if (p.u1 - p.u0 > 0.03 && p.v1 - p.v0 > 0.03) {
            visibleRects.push(p);
          }
        }
      }

      const isGroundFace = dir === '-y' && Math.abs(plane) < 0.015;
      visibleRects.forEach((rect, idx) => {
        const corners = faceToCorners3D(dir, plane, rect);
        const center = faceCenter3D(dir, plane, rect);
        const normal = dirToNormal(dir);
        faces.push({
          id: `${box.id}|${dir}|${idx}|${roundCoord(rect.u0)}_${roundCoord(rect.v0)}_${roundCoord(rect.u1)}_${roundCoord(rect.v1)}`,
          boxId: box.id,
          dir,
          plane,
          rect,
          normal,
          corners,
          center,
          width: roundCoord(rect.u1 - rect.u0),
          height: roundCoord(rect.v1 - rect.v0),
          locked: isGroundFace,
          createdStep: box.createdStep,
        });
      });
    }
  }

  return faces;
}

export interface MergedExteriorPatch {
  dir: FaceDir;
  plane: number;
  rect: Rect2D;
}

export function computeMergedExteriorPatches(state: MassingState): MergedExteriorPatch[] {
  const faces = computeExposedFaces(state);
  const groups = new Map<string, { dir: FaceDir; plane: number; rects: Rect2D[] }>();

  for (const f of faces) {
    if (f.locked) continue;
    const key = `${f.dir}|${Math.round(f.plane * 100) / 100}`;
    let g = groups.get(key);
    if (!g) {
      g = { dir: f.dir, plane: f.plane, rects: [] };
      groups.set(key, g);
    }
    g.rects.push(f.rect);
  }

  const patches: MergedExteriorPatch[] = [];
  for (const g of groups.values()) {
    const merged = mergeCoplanarRects2D(g.rects);
    for (const r of merged) {
      patches.push({ dir: g.dir, plane: g.plane, rect: r });
    }
  }
  return patches;
}

export function computeInsetRect(rect: Rect2D, margin: number, minInner = 0.25): Rect2D | null {
  const w = rect.u1 - rect.u0;
  const h = rect.v1 - rect.v0;
  const maxMargin = Math.min(w, h) * 0.42;
  const m = roundCoord(Math.min(margin, maxMargin));
  if (w - 2 * m < minInner || h - 2 * m < minInner) return null;
  return {
    u0: roundCoord(rect.u0 + m),
    u1: roundCoord(rect.u1 - m),
    v0: roundCoord(rect.v0 + m),
    v1: roundCoord(rect.v1 - m),
  };
}

export interface OperationResult {
  state: MassingState;
  newFaceId: string | null;
}

export function applyExtrude(
  state: MassingState,
  face: MassingFace,
  distance: number,
  insetMargin = 0,
  scale?: MassingScaleConfig
): OperationResult {
  const minSize = scale ? Math.min(0.05, scale.minBoxSize * 0.25) : 0.05;
  if (face.locked || Math.abs(distance) < minSize) {
    return { state, newFaceId: face.id };
  }

  const step = state.step + 1;
  let targetRect = face.rect;

  if (insetMargin > 0.01 && distance > 0) {
    const inner = computeInsetRect(face.rect, insetMargin, scale ? scale.minBoxSize : 0.25);
    if (inner) targetRect = inner;
  }

  if (distance > 0) {
    const isDropToGround = face.dir === '-y' && face.plane - distance <= 0.03;
    const effectiveDist = isDropToGround ? face.plane : distance;
    const newBox = makeBoxFromFaceExtrude(face.dir, face.plane, targetRect, effectiveDist, step, minSize);
    if (!newBox) return { state, newFaceId: face.id };

    let nextBoxes = addDisjointBox(state.boxes, newBox, minSize);
    const nextSubs = pruneSubdivisions(nextBoxes, state.subdivisions);
    const protectedIds = new Set(nextSubs.map((s) => s.boxId));

    if (isDropToGround) {
      nextBoxes = mergeTouchingAlignedBoxes(nextBoxes, protectedIds);
    }

    const nextState: MassingState = {
      boxes: nextBoxes,
      subdivisions: pruneSubdivisions(nextBoxes, nextSubs),
      step,
    };

    const exposed = computeExposedFaces(nextState);
    if (isDropToGround) {
      const topFace = exposed.find(
        (f) => f.dir === '+y' && !f.locked && f.rect.u0 <= targetRect.u1 && f.rect.u1 >= targetRect.u0
      );
      return { state: nextState, newFaceId: topFace?.id ?? null };
    }

    const expectedPlane = boxFacePlane(newBox, face.dir);
    const followUp = exposed.find(
      (f) =>
        f.dir === face.dir &&
        Math.abs(f.plane - expectedPlane) < 0.02 &&
        rectsEqual(f.rect, targetRect, 0.04)
    );
    return { state: nextState, newFaceId: followUp?.id ?? null };
  } else {
    const cutter = makeBoxFromFaceExtrude(face.dir, face.plane, targetRect, distance, step, minSize);
    if (!cutter) return { state, newFaceId: face.id };

    const carved = carveFromBoxes(state.boxes, cutter, minSize);
    if (carved.length === 0) return { state, newFaceId: face.id };

    const nextSubs = pruneSubdivisions(carved, state.subdivisions);
    const nextState: MassingState = { boxes: carved, subdivisions: nextSubs, step };
    return { state: nextState, newFaceId: null };
  }
}

export function applySplitFace(
  state: MassingState,
  face: MassingFace,
  axis: SplitAxis,
  ratio = 0.5,
  scale?: MassingScaleConfig
): OperationResult {
  if (face.locked) return { state, newFaceId: face.id };

  const minPiece = scale ? Math.max(0.18, scale.minBoxSize * 0.7) : 0.4;
  const r = face.rect;
  const w = r.u1 - r.u0;
  const h = r.v1 - r.v0;
  const clampedRatio = Math.max(0.2, Math.min(0.8, ratio));

  let chosen: 'u' | 'v' | 'grid' = axis === 'auto' ? (w >= h ? 'u' : 'v') : axis;
  if (chosen === 'u' && w < minPiece * 2) chosen = 'v';
  if (chosen === 'v' && h < minPiece * 2) chosen = 'u';

  const newRects: Rect2D[] = [];
  if (chosen === 'grid' && w >= minPiece * 2 && h >= minPiece * 2) {
    const mu = roundCoord(r.u0 + w * 0.5);
    const mv = roundCoord(r.v0 + h * 0.5);
    newRects.push(
      { u0: r.u0, u1: mu, v0: r.v0, v1: mv },
      { u0: mu, u1: r.u1, v0: r.v0, v1: mv },
      { u0: r.u0, u1: mu, v0: mv, v1: r.v1 },
      { u0: mu, u1: r.u1, v0: mv, v1: r.v1 }
    );
  } else if (chosen === 'u' && w >= minPiece * 2) {
    const mu = roundCoord(r.u0 + w * clampedRatio);
    newRects.push(
      { u0: r.u0, u1: mu, v0: r.v0, v1: r.v1 },
      { u0: mu, u1: r.u1, v0: r.v0, v1: r.v1 }
    );
  } else if (h >= minPiece * 2) {
    const mv = roundCoord(r.v0 + h * clampedRatio);
    newRects.push(
      { u0: r.u0, u1: r.u1, v0: r.v0, v1: mv },
      { u0: r.u0, u1: r.u1, v0: mv, v1: r.v1 }
    );
  } else {
    return { state, newFaceId: face.id };
  }

  return replaceFaceSubdivisionRects(state, face, newRects, newRects[0]);
}

export function applyInsetFace(
  state: MassingState,
  face: MassingFace,
  margin: number,
  scale?: MassingScaleConfig
): OperationResult {
  if (face.locked) return { state, newFaceId: face.id };

  const r = face.rect;
  const inner = computeInsetRect(r, margin, scale ? scale.minBoxSize : 0.25);
  if (!inner) return { state, newFaceId: face.id };

  const borderAndInner: Rect2D[] = [
    inner,
    { u0: r.u0, u1: r.u1, v0: r.v0, v1: inner.v0 },
    { u0: r.u0, u1: r.u1, v0: inner.v1, v1: r.v1 },
    { u0: r.u0, u1: inner.u0, v0: inner.v0, v1: inner.v1 },
    { u0: inner.u1, u1: r.u1, v0: inner.v0, v1: inner.v1 },
  ].filter((p) => p.u1 - p.u0 > 0.03 && p.v1 - p.v0 > 0.03);

  return replaceFaceSubdivisionRects(state, face, borderAndInner, inner);
}

function replaceFaceSubdivisionRects(
  state: MassingState,
  face: MassingFace,
  replacements: Rect2D[],
  focusRect: Rect2D
): OperationResult {
  const parentBox = state.boxes.find((b) => b.id === face.boxId);
  if (!parentBox) return { state, newFaceId: face.id };

  const existingSub = state.subdivisions.find(
    (s) => s.boxId === face.boxId && s.dir === face.dir
  );
  const currentRects = existingSub ? existingSub.rects : [boxFaceRect(parentBox, face.dir)];

  const updatedRects: Rect2D[] = [];
  let replaced = false;
  for (const cr of currentRects) {
    if (!replaced && rectsEqual(cr, face.rect, 0.04)) {
      updatedRects.push(...replacements);
      replaced = true;
    } else {
      updatedRects.push(cr);
    }
  }
  if (!replaced) {
    const remaining: Rect2D[] = [];
    for (const cr of currentRects) {
      remaining.push(...subtractRects2D([cr], [face.rect]));
    }
    updatedRects.length = 0;
    updatedRects.push(...remaining, ...replacements);
  }

  const nextSubs = state.subdivisions.filter(
    (s) => !(s.boxId === face.boxId && s.dir === face.dir)
  );
  nextSubs.push({ boxId: face.boxId, dir: face.dir, rects: updatedRects });

  const nextState: MassingState = {
    boxes: state.boxes,
    subdivisions: nextSubs,
    step: state.step + 1,
  };

  const exposed = computeExposedFaces(nextState);
  const focusFace = exposed.find(
    (f) => f.boxId === face.boxId && f.dir === face.dir && rectsEqual(f.rect, focusRect, 0.04)
  );
  return { state: nextState, newFaceId: focusFace?.id ?? null };
}

export function computeStateBounds(state: MassingState): {
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
} {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const b of state.boxes) {
    minX = Math.min(minX, b.min[0]);
    maxX = Math.max(maxX, b.max[0]);
    minY = Math.min(minY, b.min[1]);
    maxY = Math.max(maxY, b.max[1]);
    minZ = Math.min(minZ, b.min[2]);
    maxZ = Math.max(maxZ, b.max[2]);
  }
  if (!Number.isFinite(minX)) return { minX: -1, maxX: 1, minY: 0, maxY: 1, minZ: -1, maxZ: 1 };
  return { minX, maxX, minY, maxY, minZ, maxZ };
}
