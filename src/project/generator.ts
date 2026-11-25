import * as THREE from 'three/webgpu';
import {
  FaceDir,
  LightingKey,
  MassingBox,
  MassingState,
  StyleKey,
} from '../core/types';
import {
  computeMergedExteriorPatches,
  computeStateBounds,
  MergedExteriorPatch,
} from '../core/massingEngine';
import {
  BotanicalFoliageBatcher,
  FoliagePaletteKind,
  MaterialGeometryBatcher,
} from '../building/geometryBatcher';
import { ShopfrontMaterials, ShopMatKey } from './materials';

export const GROUND_STORY_H = 3.8;
export const UPPER_STORY_H = 3.4;

export interface DynamicShopLight {
  light: THREE.PointLight;
  kind: 'interior' | 'lamp';
}

export interface ShopfrontBuildResult {
  group: THREE.Group;
  bounds: THREE.Box3;
  dynamicLights: DynamicShopLight[];
  stats: {
    stories: number;
    vitrines: number;
    tables: number;
  };
}

interface VerticalPatch {
  dir: '+z' | '-z' | '+x' | '-x';
  plane: number;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

interface PlacedCircle {
  x: number;
  z: number;
  r: number;
}

interface EntranceSpot {
  x: number;
  z: number;
  ox: number;
  oz: number;
  rx: number;
  rz: number;
}

function hash2(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/**
 * Local 2D->3D facade mapper where:
 *  - s in [0..width] runs left-to-right when viewing the facade from outside
 *  - y is world vertical elevation
 *  - d is outward offset along the exterior normal (d=0 is massing plane, d>0 projects out, d<0 recesses in)
 * Guarantees right × up === outward normal for ALL 4 vertical directions!
 */
class FacadeFrame {
  public readonly dir: '+z' | '-z' | '+x' | '-x';
  public readonly plane: number;
  public readonly u0: number;
  public readonly u1: number;
  public readonly width: number;
  public readonly ox: number;
  public readonly oz: number;
  public readonly rx: number;
  public readonly rz: number;
  public readonly yaw: number;
  public readonly isXAxisWall: boolean;

  constructor(dir: '+z' | '-z' | '+x' | '-x', plane: number, u0: number, u1: number) {
    this.dir = dir;
    this.plane = plane;
    this.u0 = u0;
    this.u1 = u1;
    this.width = u1 - u0;
    this.isXAxisWall = dir === '+x' || dir === '-x';

    if (dir === '+z') {
      this.ox = 0; this.oz = 1;
      this.rx = 1; this.rz = 0;
      this.yaw = 0;
    } else if (dir === '-z') {
      this.ox = 0; this.oz = -1;
      this.rx = -1; this.rz = 0;
      this.yaw = Math.PI;
    } else if (dir === '+x') {
      this.ox = 1; this.oz = 0;
      this.rx = 0; this.rz = -1;
      this.yaw = Math.PI * 0.5;
    } else {
      this.ox = -1; this.oz = 0;
      this.rx = 0; this.rz = 1;
      this.yaw = -Math.PI * 0.5;
    }
  }

  public pt(s: number, y: number, d: number): [number, number, number] {
    switch (this.dir) {
      case '+z': return [this.u0 + s, y, this.plane + d];
      case '-z': return [this.u1 - s, y, this.plane - d];
      case '+x': return [this.plane + d, y, this.u1 - s];
      case '-x': return [this.plane - d, y, this.u0 + s];
    }
  }

  public addBox(
    b: MaterialGeometryBatcher<ShopMatKey>,
    mat: ShopMatKey,
    s0: number,
    y0: number,
    d0: number,
    s1: number,
    y1: number,
    d1: number,
    uvScale = 1.0
  ): void {
    if (Math.abs(s1 - s0) < 1e-4 || Math.abs(y1 - y0) < 1e-4 || Math.abs(d1 - d0) < 1e-4) return;
    const p0 = this.pt(s0, y0, d0);
    const p1 = this.pt(s1, y1, d1);
    b.addBox(mat, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], uvScale);
  }

  public addBeveledBox(
    b: MaterialGeometryBatcher<ShopMatKey>,
    mat: ShopMatKey,
    s0: number,
    y0: number,
    d0: number,
    s1: number,
    y1: number,
    d1: number,
    bevel = 0.014,
    uvScale = 1.0
  ): void {
    const p0 = this.pt(s0, y0, d0);
    const p1 = this.pt(s1, y1, d1);
    b.addBeveledBox(mat, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], bevel, uvScale);
  }

  public addQuad(
    b: MaterialGeometryBatcher<ShopMatKey>,
    mat: ShopMatKey,
    s0: number,
    y0: number,
    s1: number,
    y1: number,
    d: number,
    exactUV = false,
    uvScale = 1.0
  ): void {
    const w = Math.abs(s1 - s0);
    const h = Math.abs(y1 - y0);
    if (w < 1e-4 || h < 1e-4) return;
    const p0 = this.pt(s0, y0, d);
    const p1 = this.pt(s1, y0, d);
    const p2 = this.pt(s1, y1, d);
    const p3 = this.pt(s0, y1, d);
    b.addQuad(mat, p0, p1, p2, p3, exactUV ? w : uvScale, exactUV ? h : uvScale);
  }
}

function pointInsideAnyBox(boxes: MassingBox[], x: number, y: number, z: number, pad = 0.02): boolean {
  for (const bx of boxes) {
    if (
      x > bx.min[0] - pad &&
      x < bx.max[0] + pad &&
      y > bx.min[1] - pad &&
      y < bx.max[1] + pad &&
      z > bx.min[2] - pad &&
      z < bx.max[2] + pad
    ) {
      return true;
    }
  }
  return false;
}

function pointNearAnyGroundBox(boxes: MassingBox[], x: number, z: number, margin: number): boolean {
  for (const bx of boxes) {
    if (bx.min[1] >= 2.2) continue;
    if (
      x > bx.min[0] - margin &&
      x < bx.max[0] + margin &&
      z > bx.min[2] - margin &&
      z < bx.max[2] + margin
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Counts stories, vitrines, and estimated sidewalk + interior tables synchronously for TopBar metrics.
 */
export function computeShopfrontMetrics(state: MassingState): {
  stories: number;
  vitrines: number;
  tables: number;
} {
  const bounds = computeStateBounds(state);
  const stories = Math.max(1, 1 + Math.round(Math.max(0, bounds.maxY - GROUND_STORY_H) / UPPER_STORY_H));
  const patches = computeMergedExteriorPatches(state);

  let vitrines = 0;
  let tables = 0;
  for (const p of patches) {
    if (p.dir === '+y' || p.dir === '-y') continue;
    if (p.rect.v0 < 0.15 && p.rect.v1 >= 2.2) {
      const w = p.rect.u1 - p.rect.u0;
      if (w >= 1.6) {
        const innerW = Math.max(0.8, w - 0.72);
        const bays = Math.max(1, Math.round(innerW / 2.65));
        const hasDoor = w >= 2.8 && (p.dir === '+z' || p.dir === '+x' || bays >= 2);
        vitrines += Math.max(1, bays - (hasDoor ? 1 : 0));
        if (p.dir === '+z' || p.dir === '+x') {
          tables += Math.max(1, Math.floor(w / 2.9));
        }
      }
    }
  }
  // Plus interior tables inside ground boxes
  for (const bx of state.boxes) {
    if (bx.min[1] < 0.15 && bx.max[1] >= 2.2) {
      const bw = bx.max[0] - bx.min[0];
      const bd = bx.max[2] - bx.min[2];
      if (bw >= 3.2 && bd >= 3.2) {
        tables += Math.max(1, Math.min(4, Math.floor((bw - 1.5) / 2.2)));
      }
    }
  }

  return { stories, vitrines: Math.max(1, vitrines), tables: Math.max(2, tables) };
}

function addBistroChair(
  b: MaterialGeometryBatcher<ShopMatKey>,
  cx: number,
  y0: number,
  cz: number,
  facingAngle: number,
  style: StyleKey
): void {
  const cos = Math.cos(facingAngle);
  const sin = Math.sin(facingAngle);
  const wx = (lx: number, lz: number) => cx + lx * cos - lz * sin;
  const wz = (lx: number, lz: number) => cz + lx * sin + lz * cos;

  const legMat: ShopMatKey = style === 'style-c' ? 'accentWood' : 'iron';
  const seatH = y0 + 0.45;

  // 4 tapered splayed chair legs
  const legOffsets: [number, number, number, number][] = [
    [-0.17, -0.17, -0.20, -0.20],
    [0.17, -0.17, 0.20, -0.20],
    [-0.17, 0.17, -0.19, 0.20],
    [0.17, 0.17, 0.19, 0.20],
  ];
  for (const [tx, tz, bx, bz] of legOffsets) {
    b.addOrientedCylinder(
      legMat,
      [wx(bx, bz), y0, wz(bx, bz)],
      [wx(tx, tz), seatH - 0.02, wz(tx, tz)],
      0.013,
      0.011,
      6
    );
  }
  // Cross stretcher ring under seat
  b.addOrientedCylinder(
    legMat,
    [wx(-0.18, -0.18), y0 + 0.19, wz(-0.18, -0.18)],
    [wx(0.18, 0.18), y0 + 0.19, wz(0.18, 0.18)],
    0.008,
    0.008,
    5
  );
  b.addOrientedCylinder(
    legMat,
    [wx(0.18, -0.18), y0 + 0.19, wz(0.18, -0.18)],
    [wx(-0.18, 0.18), y0 + 0.19, wz(-0.18, 0.18)],
    0.008,
    0.008,
    5
  );

  // Round rattan / upholstered bistro seat
  b.addCylinder(legMat, cx, seatH - 0.024, seatH, cz, 0.205, 0.205, 14);
  b.addCylinder(
    style === 'style-a' ? 'rattan' : 'chairAccent',
    cx,
    seatH,
    seatH + 0.026,
    cz,
    0.19,
    0.185,
    14
  );

  // Curved Parisian bentwood / iron backrest hoop (at local -z back of seat)
  const hoopPts: [number, number, number][] = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ang = Math.PI * t; // 0 -> PI across arch
    const lx = Math.cos(ang) * 0.18;
    const ly = seatH + Math.sin(ang) * 0.39;
    const lz = -0.17 - Math.sin(ang) * 0.045;
    hoopPts.push([wx(lx, lz), ly, wz(lx, lz)]);
  }
  b.addTube(legMat, hoopPts, 0.013, 14, 6);

  // Inner backrest woven / colored medallion slat (cleanly aligned in local chair coordinates!)
  const slatPts = (lx: number, ly: number, lz: number): [number, number, number] => [
    wx(lx, lz),
    ly,
    wz(lx, lz),
  ];
  const sw = 0.125;
  const sy0 = seatH + 0.19;
  const sy1 = seatH + 0.31;
  const szF = -0.192;
  const szB = -0.214;
  const slatMat: ShopMatKey = style === 'style-a' ? 'chairAccent' : 'rattan';
  b.addQuad(slatMat, slatPts(-sw, sy0, szF), slatPts(sw, sy0, szF), slatPts(sw, sy1, szF), slatPts(-sw, sy1, szF), 0.3, 0.3);
  b.addQuad(slatMat, slatPts(sw, sy0, szB), slatPts(-sw, sy0, szB), slatPts(-sw, sy1, szB), slatPts(sw, sy1, szB), 0.3, 0.3);
  b.addQuad(slatMat, slatPts(-sw, sy1, szF), slatPts(sw, sy1, szF), slatPts(sw, sy1, szB), slatPts(-sw, sy1, szB), 0.3, 0.1);
  b.addQuad(slatMat, slatPts(-sw, sy0, szB), slatPts(sw, sy0, szB), slatPts(sw, sy0, szF), slatPts(-sw, sy0, szF), 0.3, 0.1);
}

function addBistroTableSet(
  b: MaterialGeometryBatcher<ShopMatKey>,
  cx: number,
  y0: number,
  cz: number,
  facingAngle: number,
  style: StyleKey,
  withTwoChairs = true
): void {
  const tableH = y0 + 0.74;
  // Sculpted cast-iron 3-footed pedestal base
  for (let i = 0; i < 3; i++) {
    const a = facingAngle + (i * Math.PI * 2) / 3 + 0.35;
    const fx = cx + Math.cos(a) * 0.26;
    const fz = cz + Math.sin(a) * 0.26;
    b.addOrientedCylinder('iron', [fx, y0 + 0.015, fz], [cx, y0 + 0.14, cz], 0.024, 0.032, 7);
    b.addCylinder('iron', fx, y0, y0 + 0.028, fz, 0.032, 0.022, 8);
  }
  b.addCylinder('iron', cx, y0 + 0.08, tableH - 0.04, cz, 0.038, 0.028, 10);
  b.addCylinder('iron', cx, y0 + 0.14, y0 + 0.22, cz, 0.058, 0.044, 10);
  b.addCylinder('iron', cx, tableH - 0.05, tableH - 0.022, cz, 0.12, 0.16, 12);

  // Brass rimmed round marble bistro tabletop
  b.addCylinder('brass', cx, tableH - 0.024, tableH + 0.002, cz, 0.39, 0.39, 22);
  b.addCylinder('counterTop', cx, tableH - 0.018, tableH + 0.01, cz, 0.376, 0.372, 22);

  // Tiny tabletop café props: espresso cup & saucer, glowing glass votive candle, croissant plate
  const cOff = facingAngle + 0.4;
  const cupX = cx + Math.cos(cOff) * 0.17;
  const cupZ = cz + Math.sin(cOff) * 0.17;
  b.addCylinder('porcelain', cupX, tableH + 0.01, tableH + 0.022, cupZ, 0.055, 0.064, 12);
  b.addCylinder('porcelain', cupX, tableH + 0.022, tableH + 0.074, cupZ, 0.03, 0.038, 12);

  // Warm tabletop votive candle (shimmers in Evening!)
  const vOff = facingAngle - 1.1;
  const vx = cx + Math.cos(vOff) * 0.11;
  const vz = cz + Math.sin(vOff) * 0.11;
  b.addCylinder('brass', vx, tableH + 0.01, tableH + 0.03, vz, 0.032, 0.034, 10);
  b.addCylinder('warmGlow', vx, tableH + 0.03, tableH + 0.085, vz, 0.026, 0.028, 10);

  // Small porcelain pastry plate + croissant
  const pOff = facingAngle + 2.3;
  const px = cx + Math.cos(pOff) * 0.16;
  const pz = cz + Math.sin(pOff) * 0.16;
  b.addCylinder('porcelain', px, tableH + 0.01, tableH + 0.022, pz, 0.075, 0.088, 12);
  b.addSphere('pastryGold', px, tableH + 0.038, pz, 0.036, 10, 7);

  // Pair of Parisian bistro chairs flanking the table (facing snugly inward toward tabletop!)
  const cos = Math.cos(facingAngle);
  const sin = Math.sin(facingAngle);
  addBistroChair(b, cx - cos * 0.56, y0, cz - sin * 0.56, facingAngle - Math.PI * 0.5 + 0.18, style);
  if (withTwoChairs) {
    addBistroChair(b, cx + cos * 0.56, y0, cz + sin * 0.56, facingAngle + Math.PI * 0.5 - 0.14, style);
  }
}

function addChalkboardEasel(
  b: MaterialGeometryBatcher<ShopMatKey>,
  cx: number,
  y0: number,
  cz: number,
  yaw: number
): void {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const toW = (lx: number, ly: number, lz: number): [number, number, number] => [
    cx + lx * cos + lz * sin,
    y0 + ly,
    cz - lx * sin + lz * cos,
  ];

  // A-frame wooden legs & chalkboard frame (angled ±14° symmetrically)
  const tilt = 0.24;
  const boardH = 0.96;
  const boardW = 0.56;
  const cy = y0 + 0.56;

  // Front angled easel panel & chalkboard face
  const fCenter = toW(0, 0.56, 0.13);
  b.addRotatedBox('accentWood', fCenter[0], cy, fCenter[2], boardW + 0.08, boardH + 0.08, 0.036, -tilt, yaw, 0, 0.7);
  // Crisp chalkboard quad offset +0.024m outward along tilted front normal
  const nZ = Math.cos(tilt);
  const nY = Math.sin(tilt);
  const halfW = boardW * 0.45;
  const halfH = boardH * 0.44;
  const quadPt = (u: number, v: number, side: 1 | -1): [number, number, number] => {
    const lz = side * (0.13 - v * Math.sin(tilt) + 0.025 * nZ);
    const ly = 0.56 + v * Math.cos(tilt) + 0.025 * nY;
    return toW(u, ly, lz);
  };
  b.addQuad(
    'chalkboard',
    quadPt(-halfW, -halfH, 1),
    quadPt(halfW, -halfH, 1),
    quadPt(halfW, halfH, 1),
    quadPt(-halfW, halfH, 1),
    halfW * 2,
    halfH * 2
  );

  // Back angled easel panel
  const bCenter = toW(0, 0.56, -0.13);
  b.addRotatedBox('accentWood', bCenter[0], cy, bCenter[2], boardW + 0.08, boardH + 0.08, 0.036, tilt, yaw, 0, 0.7);
  b.addQuad(
    'chalkboard',
    quadPt(halfW, -halfH, -1),
    quadPt(-halfW, -halfH, -1),
    quadPt(-halfW, halfH, -1),
    quadPt(halfW, halfH, -1),
    halfW * 2,
    halfH * 2
  );

  // Feet extending neatly to y0
  for (const sx of [-boardW * 0.48, boardW * 0.48]) {
    b.addOrientedCylinder('accentWood', toW(sx, 0, 0.25), toW(sx, 1.05, 0.015), 0.018, 0.018, 6);
    b.addOrientedCylinder('accentWood', toW(sx, 0, -0.25), toW(sx, 1.05, -0.015), 0.018, 0.018, 6);
  }
  // Brass hinge cap & spreader bar
  b.addOrientedCylinder('brass', toW(-boardW * 0.46, 0.34, 0.17), toW(-boardW * 0.46, 0.34, -0.17), 0.006, 0.006, 5);
  b.addOrientedCylinder('brass', toW(boardW * 0.46, 0.34, 0.17), toW(boardW * 0.46, 0.34, -0.17), 0.006, 0.006, 5);
}

function addPottedLaurel(
  b: MaterialGeometryBatcher<ShopMatKey>,
  foliage: BotanicalFoliageBatcher,
  cx: number,
  y0: number,
  cz: number,
  seed: number,
  palette: FoliagePaletteKind
): void {
  // Architectural tapered planter box with stepped rim & brass band
  b.addBeveledBox('planterPot', cx - 0.23, y0, cz - 0.23, cx + 0.23, y0 + 0.44, cz + 0.23, 0.018, 0.8);
  b.addBeveledBox('planterPot', cx - 0.26, y0 + 0.42, cz - 0.26, cx + 0.26, y0 + 0.50, cz + 0.26, 0.014, 0.8);
  b.addBox('brass', cx - 0.242, y0 + 0.34, cz - 0.242, cx + 0.242, y0 + 0.365, cz + 0.242, 0.5);
  b.addBox('soil', cx - 0.21, y0 + 0.45, cz - 0.21, cx + 0.21, y0 + 0.495, cz + 0.21, 0.5);

  // Lush multi-tiered botanical bay laurel shrub/topiary
  foliage.addPottedPlant(cx, y0 + 0.48, cz, 0.72, seed, palette);
  foliage.addPottedPlant(cx, y0 + 0.72, cz, 0.56, seed + 37, palette);
}

type EndKind = 'convex' | 'concave' | 'flush';

/**
 * Classifies the left (s=0) or right (s=W) vertical edge of a facade patch at elevation yMid:
 * - 'concave': a perpendicular solid wall protrudes outward (d > 0) forming a 90° inner L-corner
 * - 'convex' : open air on both sides -> true 90° outer architectural corner
 * - 'flush'  : coplanar wall continues behind d = 0 (e.g. a height setback step)
 */
function classifyFacadeEnd(
  frame: FacadeFrame,
  end: 'left' | 'right',
  yMid: number,
  allBoxes: MassingBox[]
): EndKind {
  const sOut = end === 'left' ? -0.16 : frame.width + 0.16;
  const pFront = frame.pt(sOut, yMid, 0.16);
  if (pointInsideAnyBox(allBoxes, pFront[0], pFront[1], pFront[2], 0.01)) {
    return 'concave';
  }
  const pBack = frame.pt(sOut, yMid, -0.16);
  if (pointInsideAnyBox(allBoxes, pBack[0], pBack[1], pBack[2], 0.01)) {
    return 'flush';
  }
  return 'convex';
}

/**
 * Checks whether an upper cantilevered massing overhangs right above a ground storefront strip
 * (e.g. Corner Bistro's covered ground arcade), so we never hang outdoor awnings under an indoor ceiling!
 */
function hasOverheadCantilever(
  frame: FacadeFrame,
  s0: number,
  s1: number,
  shopTop: number,
  allBoxes: MassingBox[]
): boolean {
  const sMid = (s0 + s1) * 0.5;
  for (const sSample of [s0 + (s1 - s0) * 0.25, sMid, s0 + (s1 - s0) * 0.75]) {
    for (const dSample of [0.35, 0.85]) {
      const p = frame.pt(sSample, shopTop + 0.35, dSample);
      if (pointInsideAnyBox(allBoxes, p[0], p[1], p[2], 0.01)) return true;
    }
  }
  return false;
}

/**
 * Corner-aware horizontal molding / cornice box:
 * - Convex outer corners: Z-walls extend by exact `proj`, X-walls stop at 0 -> razor-sharp 90° miter!
 * - Concave inner corners: Z-walls reach 0, X-walls pull back by exact `proj` -> ZERO 90° inner overlap!
 */
function addCornerAwareCornice(
  b: MaterialGeometryBatcher<ShopMatKey>,
  frame: FacadeFrame,
  mat: ShopMatKey,
  y0: number,
  y1: number,
  dBack: number,
  proj: number,
  leftEnd: EndKind,
  rightEnd: EndKind,
  uvScale = 1.2
): void {
  const W = frame.width;
  let sA = 0;
  let sB = W;
  if (!frame.isXAxisWall) {
    if (leftEnd === 'convex') sA = -proj;
    if (rightEnd === 'convex') sB = W + proj;
  } else {
    if (leftEnd === 'concave') sA = proj + 0.002;
    else sA = 0.002;
    if (rightEnd === 'concave') sB = W - proj - 0.002;
    else sB = W - 0.002;
  }
  if (sB - sA < 0.04) return;
  frame.addBox(b, mat, sA, y0, dBack, sB, y1, proj, uvScale);
}

function addVintageStreetlamp(
  b: MaterialGeometryBatcher<ShopMatKey>,
  cx: number,
  y0: number,
  cz: number,
  style: StyleKey,
  dynamicLights: DynamicShopLight[]
): void {
  if (style === 'style-c') {
    // Sleek contemporary Tokyo Aoyama dark-bronze architectural streetlamp with warm vertical lantern head
    b.addBeveledBox('iron', cx - 0.14, y0, cz - 0.14, cx + 0.14, y0 + 0.14, cz + 0.14, 0.014, 0.6);
    b.addBox('iron', cx - 0.055, y0 + 0.14, cz - 0.055, cx + 0.055, y0 + 3.15, cz + 0.055, 0.8);
    // Warm cedar & dark-bronze lantern housing
    b.addBeveledBox('iron', cx - 0.13, y0 + 3.15, cz - 0.13, cx + 0.13, y0 + 3.21, cz + 0.13, 0.012, 0.6);
    b.addBox('lampGlobe', cx - 0.09, y0 + 3.21, cz - 0.09, cx + 0.09, y0 + 3.62, cz + 0.09, 0.5);
    // Corner bronze mullions around lantern
    for (const sx of [-0.105, 0.105]) {
      for (const sz of [-0.105, 0.105]) {
        b.addBox('iron', cx + sx - 0.014, y0 + 3.21, cz + sz - 0.014, cx + sx + 0.014, y0 + 3.62, cz + sz + 0.014, 0.4);
      }
    }
    b.addBeveledBox('iron', cx - 0.17, y0 + 3.62, cz - 0.17, cx + 0.17, y0 + 3.70, cz + 0.17, 0.016, 0.6);
    const ptLight = new THREE.PointLight('#ffbe6b', 0, 11.0, 1.75);
    ptLight.position.set(cx, y0 + 3.40, cz);
    dynamicLights.push({ light: ptLight, kind: 'lamp' });
    return;
  }

  // Classic Parisian / SoHo fluted cast-iron boulevard streetlamp with milk-glass globe
  b.addCylinder('iron', cx, y0, y0 + 0.18, cz, 0.20, 0.17, 8);
  b.addCylinder('iron', cx, y0 + 0.18, y0 + 0.72, cz, 0.15, 0.095, 8);
  b.addCylinder('brass', cx, y0 + 0.70, y0 + 0.76, cz, 0.11, 0.11, 10);
  b.addCylinder('iron', cx, y0 + 0.76, y0 + 3.28, cz, 0.068, 0.044, 10);
  b.addCylinder('brass', cx, y0 + 3.22, y0 + 3.30, cz, 0.072, 0.056, 12);

  // Ornate decorative collar + luminous frosted milk-glass globe + bronze crown finial
  b.addCylinder('iron', cx, y0 + 3.30, y0 + 3.40, cz, 0.06, 0.135, 12);
  b.addSphere('lampGlobe', cx, y0 + 3.58, cz, 0.21, 16, 12);
  b.addCylinder('iron', cx, y0 + 3.77, y0 + 3.84, cz, 0.11, 0.03, 10);
  b.addCylinder('brass', cx, y0 + 3.84, y0 + 3.98, cz, 0.022, 0.005, 8);

  // Subtle decorative iron scroll crossbars below lamp head
  b.addBox('iron', cx - 0.26, y0 + 3.16, cz - 0.016, cx + 0.26, y0 + 3.20, cz + 0.016, 0.5);
  b.addSphere('brass', cx - 0.26, y0 + 3.18, cz, 0.026, 8, 6);
  b.addSphere('brass', cx + 0.26, y0 + 3.18, cz, 0.026, 8, 6);

  const ptLight = new THREE.PointLight('#ffbe6b', 0, 11.5, 1.75);
  ptLight.position.set(cx, y0 + 3.42, cz);
  dynamicLights.push({ light: ptLight, kind: 'lamp' });
}

function addProjectingBladeSign(
  b: MaterialGeometryBatcher<ShopMatKey>,
  frame: FacadeFrame,
  sCorner: number,
  yCenter: number,
  style: StyleKey
): void {
  if (style === 'style-c') {
    // Sleek vertical Japanese wooden-and-washi backlit Andon lantern box sign!
    const signCenterD = 0.48;
    const halfH = 0.42;
    const halfD = 0.20;
    const halfT = 0.055;
    frame.addBox(b, 'iron', sCorner - 0.045, yCenter - halfH, 0.02, sCorner + 0.045, yCenter + halfH, 0.05, 0.5);
    frame.addBox(b, 'iron', sCorner - 0.02, yCenter + halfH - 0.08, 0.04, sCorner + 0.02, yCenter + halfH - 0.04, signCenterD, 0.5);
    frame.addBox(b, 'iron', sCorner - 0.02, yCenter - halfH + 0.04, 0.04, sCorner + 0.02, yCenter - halfH + 0.08, signCenterD, 0.5);
    frame.addBeveledBox(
      b,
      'accentWood',
      sCorner - halfT,
      yCenter - halfH,
      signCenterD - halfD,
      sCorner + halfT,
      yCenter + halfH,
      signCenterD + halfD,
      0.012,
      0.6
    );
    const fOff = halfT + 0.006;
    const fH = halfH - 0.032;
    const fD = halfD - 0.032;
    b.addQuad(
      'bladeSign',
      frame.pt(sCorner + fOff, yCenter - fH, signCenterD + fD),
      frame.pt(sCorner + fOff, yCenter - fH, signCenterD - fD),
      frame.pt(sCorner + fOff, yCenter + fH, signCenterD - fD),
      frame.pt(sCorner + fOff, yCenter + fH, signCenterD + fD),
      fD * 2,
      fH * 2
    );
    b.addQuad(
      'bladeSign',
      frame.pt(sCorner - fOff, yCenter - fH, signCenterD - fD),
      frame.pt(sCorner - fOff, yCenter - fH, signCenterD + fD),
      frame.pt(sCorner - fOff, yCenter + fH, signCenterD + fD),
      frame.pt(sCorner - fOff, yCenter + fH, signCenterD - fD),
      fD * 2,
      fH * 2
    );
    return;
  }

  // Iron wall mounting backplate (sits cleanly between ground cornice above & awning below!)
  frame.addBox(b, 'iron', sCorner - 0.05, yCenter - 0.28, 0.02, sCorner + 0.05, yCenter + 0.28, 0.05, 0.5);

  const signCenterD = 0.54;
  const signR = 0.27;
  frame.addBox(b, 'iron', sCorner - 0.018, yCenter + signR + 0.03, 0.04, sCorner + 0.018, yCenter + signR + 0.065, signCenterD + signR + 0.08, 0.5);
  frame.addBox(b, 'iron', sCorner - 0.016, yCenter - signR - 0.065, 0.04, sCorner + 0.016, yCenter - signR - 0.035, signCenterD + 0.12, 0.5);

  // Lower diagonal wrought-iron scroll strut (anchored cleanly below arm so it NEVER pierces the cornice above!)
  const pWall = frame.pt(sCorner, yCenter - signR - 0.22, 0.05);
  const pArm = frame.pt(sCorner, yCenter - signR - 0.05, signCenterD - 0.04);
  b.addOrientedCylinder('iron', pWall, pArm, 0.013, 0.013, 7);

  // Vertical brass suspension hangers
  frame.addBox(b, 'brass', sCorner - 0.015, yCenter + signR - 0.02, signCenterD - 0.12, sCorner + 0.015, yCenter + signR + 0.05, signCenterD - 0.085, 0.5);
  frame.addBox(b, 'brass', sCorner - 0.015, yCenter + signR - 0.02, signCenterD + 0.085, sCorner + 0.015, yCenter + signR + 0.05, signCenterD + 0.12, 0.5);

  // Brass double-sided illuminated sign housing
  const halfThick = 0.042;
  frame.addBeveledBox(
    b,
    'brass',
    sCorner - halfThick,
    yCenter - signR,
    signCenterD - signR,
    sCorner + halfThick,
    yCenter + signR,
    signCenterD + signR,
    0.012,
    0.6
  );

  // Two backlit sign faces strictly 6mm clear of bezel -> ZERO z-fighting
  const faceR = signR - 0.026;
  const fOff = halfThick + 0.006;

  b.addQuad(
    'bladeSign',
    frame.pt(sCorner + fOff, yCenter - faceR, signCenterD + faceR),
    frame.pt(sCorner + fOff, yCenter - faceR, signCenterD - faceR),
    frame.pt(sCorner + fOff, yCenter + faceR, signCenterD - faceR),
    frame.pt(sCorner + fOff, yCenter + faceR, signCenterD + faceR),
    faceR * 2,
    faceR * 2
  );
  b.addQuad(
    'bladeSign',
    frame.pt(sCorner - fOff, yCenter - faceR, signCenterD - faceR),
    frame.pt(sCorner - fOff, yCenter - faceR, signCenterD + faceR),
    frame.pt(sCorner - fOff, yCenter + faceR, signCenterD + faceR),
    frame.pt(sCorner - fOff, yCenter + faceR, signCenterD - faceR),
    faceR * 2,
    faceR * 2
  );
}

/**
 * Tailored Parisian / SoHo / Tokyo striped canvas awning with:
 * - Subtle realistic catenary fabric drape along the sloped canopy
 * - Clean triangulated side gussets (ZERO degenerate quads!)
 * - Exact 45° valley mitering at 90° concave inner corners (miterLeft / miterRight) -> ZERO awning collisions!
 * - Contrast-trimmed hanging valance apron & iron/brass scissor support arms anchored to wall piers!
 */
function addStripedAwning(
  b: MaterialGeometryBatcher<ShopMatKey>,
  frame: FacadeFrame,
  s0: number,
  s1: number,
  yMount: number,
  proj = 1.18,
  miterLeft = false,
  miterRight = false
): void {
  const awW = s1 - s0;
  if (awW < 1.05) return;
  const backD = 0.075;
  const frontD = backD + proj;
  const dropY = proj * Math.tan(0.41); // ~23.5° authentic Parisian shopfront slope
  const frontY = yMount - dropY;
  const thick = 0.032;
  const stripeUnit = 1.12;

  // Front edge s-bounds (clipped cleanly along 45° valley miter if meeting a perpendicular awning!)
  const fS0 = miterLeft ? s0 + proj : s0;
  const fS1 = miterRight ? s1 - proj : s1;
  if (fS1 <= fS0 + 0.15) return;

  // Retractable wall roller cassette bar
  frame.addBox(b, 'iron', s0 - (miterLeft ? 0 : 0.02), yMount - 0.038, 0.038, s1 + (miterRight ? 0 : 0.02), yMount + 0.042, backD + 0.022, 0.5);

  // Subtle multi-segment catenary drape across the canvas slope (looks like real tensioned fabric, not a rigid plank!)
  const slopeSegs = 4;
  const sagAmt = 0.035;
  const sampleRow = (t: number) => {
    const d = backD + proj * t;
    const y = yMount - dropY * t - Math.sin(t * Math.PI) * sagAmt;
    const rs0 = s0 + (fS0 - s0) * t;
    const rs1 = s1 + (fS1 - s1) * t;
    return { d, y, rs0, rs1 };
  };

  for (let i = 0; i < slopeSegs; i++) {
    const t0 = i / slopeSegs;
    const t1 = (i + 1) / slopeSegs;
    const r0 = sampleRow(t0);
    const r1 = sampleRow(t1);

    const tBL = frame.pt(r0.rs0, r0.y, r0.d);
    const tBR = frame.pt(r0.rs1, r0.y, r0.d);
    const tFR = frame.pt(r1.rs1, r1.y, r1.d);
    const tFL = frame.pt(r1.rs0, r1.y, r1.d);

    const bBL = frame.pt(r0.rs0, r0.y - thick, r0.d);
    const bBR = frame.pt(r0.rs1, r0.y - thick, r0.d);
    const bFR = frame.pt(r1.rs1, r1.y - thick, r1.d);
    const bFL = frame.pt(r1.rs0, r1.y - thick, r1.d);

    const uL0 = r0.rs0 / stripeUnit, uR0 = r0.rs1 / stripeUnit;
    const uL1 = r1.rs0 / stripeUnit, uR1 = r1.rs1 / stripeUnit;

    // Top striped canvas surface (continuous aligned stripes!)
    b.addQuadUV('awning', tFL, tFR, tBR, tBL, [uL1, t1], [uR1, t1], [uR0, t0], [uL0, t0]);
    // Underside canvas
    b.addQuadUV('awning', bBL, bBR, bFR, bFL, [uL0, t0], [uR0, t0], [uR1, t1], [uL1, t1]);
  }

  // Valley iron seam bar on mitered 90° inner corner
  if (miterLeft) {
    b.addOrientedCylinder('iron', frame.pt(s0, yMount + 0.01, backD), frame.pt(fS0, frontY + 0.01, frontD), 0.018, 0.018, 6);
  }
  if (miterRight) {
    b.addOrientedCylinder('iron', frame.pt(s1, yMount + 0.01, backD), frame.pt(fS1, frontY + 0.01, frontD), 0.018, 0.018, 6);
  }

  // Front sloped fold edge
  const tFL = frame.pt(fS0, frontY, frontD);
  const tFR = frame.pt(fS1, frontY, frontD);
  const bFL = frame.pt(fS0, frontY - thick, frontD);
  const bFR = frame.pt(fS1, frontY - thick, frontD);
  b.addQuadUV('awning', bFL, bFR, tFR, tFL, [fS0 / stripeUnit, 0], [fS1 / stripeUnit, 0], [fS1 / stripeUnit, 0.08], [fS0 / stripeUnit, 0.08]);

  // Tailored hanging valance apron along front leading edge + contrasting brass/iron hem piping
  const valH = 0.21;
  const vThick = 0.020;
  const vBotY = frontY - valH;
  const vfBL = frame.pt(fS0, vBotY, frontD);
  const vfBR = frame.pt(fS1, vBotY, frontD);
  const vfTR = frame.pt(fS1, frontY, frontD);
  const vfTL = frame.pt(fS0, frontY, frontD);
  const vbBL = frame.pt(fS0, vBotY, frontD - vThick);
  const vbBR = frame.pt(fS1, vBotY, frontD - vThick);
  const vbTR = frame.pt(fS1, frontY, frontD - vThick);
  const vbTL = frame.pt(fS0, frontY, frontD - vThick);

  const uFL = fS0 / stripeUnit, uFR = fS1 / stripeUnit;
  b.addQuadUV('awning', vfBL, vfBR, vfTR, vfTL, [uFL, 0], [uFR, 0], [uFR, 0.28], [uFL, 0.28]);
  b.addQuadUV('awning', vbBR, vbBL, vbTL, vbTR, [uFR, 0], [uFL, 0], [uFL, 0.28], [uFR, 0.28]);
  b.addQuad('awning', vbBL, vfBL, vfTL, vbTL, 0.2, 0.5);
  b.addQuad('awning', vfBR, vbBR, vbTR, vfTR, 0.2, 0.5);
  b.addQuad('awning', vbBL, vbBR, vfBR, vfBL, stripeUnit, 0.2);

  // Subtle dark tailored hem piping along bottom of valance + brass front tension rod
  frame.addBox(b, 'iron', fS0, vBotY - 0.014, frontD - vThick - 0.002, fS1, vBotY + 0.004, frontD + 0.002, 0.5);
  frame.addBox(b, 'brass', fS0 - (miterLeft ? 0 : 0.012), frontY - 0.028, frontD - 0.042, fS1 + (miterRight ? 0 : 0.012), frontY + 0.006, frontD - 0.020, 0.5);

  // Clean properly triangulated sloped fabric end-cap gussets (ONLY on non-mitered ends!)
  const gDrop = Math.min(dropY, 0.36);
  if (!miterLeft) {
    const gL0 = frame.pt(s0, yMount - gDrop, backD);
    const gL1 = frame.pt(s0, frontY - 0.02, frontD - 0.01);
    const gL2 = frame.pt(s0, yMount - 0.02, backD);
    b.addTriangleUV('awning', gL0, gL1, gL2, [0, 0], [1, 0], [0, 0.5]);
    b.addTriangleUV('awning', gL1, gL0, gL2, [1, 0], [0, 0], [0, 0.5]);
  }
  if (!miterRight) {
    const gR0 = frame.pt(s1, yMount - gDrop, backD);
    const gR1 = frame.pt(s1, frontY - 0.02, frontD - 0.01);
    const gR2 = frame.pt(s1, yMount - 0.02, backD);
    b.addTriangleUV('awning', gR1, gR0, gR2, [1, 0], [0, 0], [0, 0.5]);
    b.addTriangleUV('awning', gR0, gR1, gR2, [0, 0], [1, 0], [0, 0.5]);
  }

  // Slender matte wrought-iron diagonal support arms anchored cleanly to piers (never inside mitered valley!)
  const armPositions: number[] = [];
  if (!miterLeft) armPositions.push(s0 + 0.07);
  else if (fS0 + 0.14 < fS1 - 0.14) armPositions.push(fS0 + 0.14);
  if (fS1 - fS0 > 3.8) armPositions.push((fS0 + fS1) * 0.5);
  if (!miterRight) armPositions.push(s1 - 0.07);
  else if (fS1 - 0.14 > fS0 + 0.14) armPositions.push(fS1 - 0.14);

  for (const sa of armPositions) {
    const wallAnchor = frame.pt(sa, frontY - 0.38, 0.04);
    const outerJoint = frame.pt(sa, frontY - 0.028, frontD - 0.045);
    b.addOrientedCylinder('iron', wallAnchor, outerJoint, 0.015, 0.013, 7);
    frame.addBox(b, 'iron', sa - 0.032, frontY - 0.43, 0.02, sa + 0.032, frontY - 0.34, 0.056, 0.5);
  }
}

/**
 * Builds the ground-floor boutique shopfront along an exposed vertical patch (v0 < 0.15).
 * Fully 90°-corner aware: zero inner-corner awning, cornice, pier, or soffit clashes!
 */
function buildGroundStorefront(
  b: MaterialGeometryBatcher<ShopMatKey>,
  frame: FacadeFrame,
  v0: number,
  shopTop: number,
  style: StyleKey,
  showAwnings: boolean,
  allBoxes: MassingBox[],
  entrances: EntranceSpot[],
  hasSignAllowed: boolean
): number {
  const W = frame.width;
  const yMid = (v0 + shopTop) * 0.5;
  const leftEnd = classifyFacadeEnd(frame, 'left', yMid, allBoxes);
  const rightEnd = classifyFacadeEnd(frame, 'right', yMid, allBoxes);
  const coveredAbove = hasOverheadCantilever(frame, 0.2, W - 0.2, shopTop, allBoxes);

  const trimPad = frame.isXAxisWall ? 0.004 : 0.0;
  const sMin = trimPad;
  const sMax = W - trimPad;
  const usableW = sMax - sMin;

  // Very narrow wall sliver: clean solid shopfront pilaster
  if (usableW < 1.35) {
    frame.addBox(b, 'shopfront', sMin, v0, -0.24, sMax, shopTop, 0.015, 1.4);
    addCornerAwareCornice(b, frame, 'cornice', shopTop - 0.12, shopTop + 0.02, -0.02, coveredAbove ? 0.05 : 0.14, leftEnd, rightEnd, 1.2);
    return 0;
  }

  const pierW = Math.min(0.42, usableW * 0.14);
  const kickH = Math.min(0.66, (shopTop - v0) * 0.20);
  const friezeH = Math.min(0.80, (shopTop - v0) * 0.22);
  const friezeBot = shopTop - friezeH;
  const cornBot = shopTop - 0.16;

  // 1. Left & right corner architectural piers (pull X-wall piers flush inside concave corners -> ZERO overlap!)
  const pLeftS0 = frame.isXAxisWall && leftEnd === 'concave' ? 0.032 : sMin;
  const pRightS1 = frame.isXAxisWall && rightEnd === 'concave' ? W - 0.032 : sMax;
  frame.addBox(b, 'shopfront', pLeftS0, v0, -0.24, sMin + pierW, shopTop, 0.024, 1.4);
  frame.addBox(b, 'shopfront', sMax - pierW, v0, -0.24, pRightS1, shopTop, 0.024, 1.4);

  // Decorative molded capital & plinth blocks on corner piers (clear of concave inner walls!)
  const capL0 = leftEnd === 'concave' ? sMin + 0.06 : sMin;
  const capR1 = rightEnd === 'concave' ? sMax - 0.06 : sMax;
  if (sMin + pierW > capL0 + 0.05) {
    frame.addBox(b, 'cornice', capL0, v0, 0.024, sMin + pierW, v0 + 0.24, 0.054, 1.0);
    frame.addBox(b, 'cornice', capL0, friezeBot - 0.08, 0.024, sMin + pierW, friezeBot + 0.04, 0.064, 1.0);
  }
  if (capR1 > sMax - pierW + 0.05) {
    frame.addBox(b, 'cornice', sMax - pierW, v0, 0.024, capR1, v0 + 0.24, 0.054, 1.0);
    frame.addBox(b, 'cornice', sMax - pierW, friezeBot - 0.08, 0.024, capR1, friezeBot + 0.04, 0.064, 1.0);
  }

  // SoHo historic fluted cast-iron ground-floor columns & capitals on outer piers!
  if (style === 'style-b') {
    for (const [cS, endK] of [[sMin + pierW * 0.5, leftEnd], [sMax - pierW * 0.5, rightEnd]] as [number, EndKind][]) {
      if (endK === 'concave') continue;
      const pCol = frame.pt(cS, 0, 0.042);
      b.addCylinder('iron', pCol[0], v0 + 0.24, friezeBot - 0.10, pCol[2], 0.095, 0.085, 10);
      b.addCylinder('brass', pCol[0], friezeBot - 0.14, friezeBot - 0.08, pCol[2], 0.105, 0.115, 10);
    }
  }

  // 2. Continuous upper sign frieze band (between piers)
  frame.addBox(b, 'shopfront', sMin + pierW, friezeBot, -0.22, sMax - pierW, cornBot, 0.025, 1.4);
  // Lower architrave brass/steel molding below frieze
  frame.addBox(b, style === 'style-b' ? 'iron' : 'brass', sMin + pierW, friezeBot - 0.022, 0.025, sMax - pierW, friezeBot + 0.022, 0.054, 0.8);

  // 3. Corner-aware projecting ground-floor entablature cornice (100% flush outer miters, ZERO inner clashes!)
  const cornProj1 = coveredAbove ? 0.045 : 0.095;
  const cornProj2 = coveredAbove ? 0.065 : 0.155;
  addCornerAwareCornice(b, frame, 'cornice', cornBot, cornBot + 0.08, -0.02, cornProj1, leftEnd, rightEnd, 1.2);
  addCornerAwareCornice(b, frame, 'cornice', cornBot + 0.08, shopTop + 0.03, -0.02, cornProj2, leftEnd, rightEnd, 1.2);

  // Classic dentil molding teeth under Parisian ground entablature cornice
  if (style === 'style-a' && !coveredAbove && usableW >= 2.2) {
    const dentCount = Math.max(4, Math.floor((usableW - 0.3) / 0.24));
    for (let di = 0; di < dentCount; di++) {
      const ds = sMin + 0.15 + ((usableW - 0.3) * (di + 0.5)) / dentCount;
      frame.addBox(b, 'cornice', ds - 0.042, cornBot - 0.05, 0.025, ds + 0.042, cornBot + 0.005, 0.068, 0.6);
    }
  }

  // 4. Divide inner storefront span into architectural vitrine + entrance bays
  const inner0 = sMin + pierW;
  const inner1 = sMax - pierW;
  const innerW = inner1 - inner0;
  const bayCount = Math.max(1, Math.round(innerW / 2.6));
  const bayW = innerW / bayCount;
  const mullionW = 0.15;

  // Choose one recessed entrance bay on prominent street-facing or wide ground facades
  const isStreetSide = frame.dir === '+z' || frame.dir === '+x';
  const hasDoor = usableW >= 2.75 && (isStreetSide || bayCount >= 3);
  const doorBayIdx = hasDoor ? (bayCount % 2 === 1 ? Math.floor(bayCount / 2) : bayCount - 1) : -1;

  let vitrineCount = 0;

  for (let i = 0; i < bayCount; i++) {
    const b0 = inner0 + i * bayW;
    const b1 = inner0 + (i + 1) * bayW;

    // Intermediate mullion post between bays
    if (i > 0) {
      frame.addBox(b, 'shopfront', b0 - mullionW * 0.5, v0, -0.20, b0 + mullionW * 0.5, friezeBot, 0.022, 1.2);
      frame.addBox(b, 'brass', b0 - 0.018, v0 + kickH, 0.022, b0 + 0.018, friezeBot - 0.04, 0.036, 0.6);
      if (style === 'style-b') {
        const pCol = frame.pt(b0, 0, 0.038);
        b.addCylinder('iron', pCol[0], v0 + 0.18, friezeBot - 0.08, pCol[2], 0.072, 0.066, 10);
      }
    }

    const op0 = i === 0 ? b0 : b0 + mullionW * 0.5;
    const op1 = i === bayCount - 1 ? b1 : b1 - mullionW * 0.5;
    const opW = op1 - op0;

    if (i === doorBayIdx) {
      // === RECESSED BOUTIQUE ENTRANCE ALCOVE ===
      const recessD = -0.40;
      const doorTop = Math.min(friezeBot - 0.48, v0 + 2.38);

      // Recessed marble/tile threshold & alcove soffit
      frame.addBox(b, 'sidewalk', op0, v0, recessD, op1, v0 + 0.038, 0.01, 1.0);
      frame.addBox(b, 'shopfront', op0, friezeBot - 0.05, recessD, op1, friezeBot, 0.01, 1.0);
      const dMid = (op0 + op1) * 0.5;
      frame.addBox(b, 'warmGlow', dMid - 0.14, friezeBot - 0.068, recessD * 0.55 - 0.08, dMid + 0.14, friezeBot - 0.05, recessD * 0.55 + 0.08, 0.5);

      // Recessed side jamb paneling
      frame.addBox(b, 'shopfront', op0, v0 + 0.038, recessD, op0 + 0.06, friezeBot - 0.05, 0.0, 1.0);
      frame.addBox(b, 'shopfront', op1 - 0.06, v0 + 0.038, recessD, op1, friezeBot - 0.05, 0.0, 1.0);

      // Tokyo Kissa signature: authentic 3-panel indigo split Noren fabric entrance curtain clearly visible under canopy!
      if (style === 'style-c' && opW >= 1.0) {
        const rodY = Math.min(doorTop - 0.14, v0 + 2.22);
        const norenBot = rodY - 0.62;
        const norenD = 0.02;
        frame.addBox(b, 'iron', op0 + 0.03, rodY - 0.016, norenD - 0.016, op1 - 0.03, rodY + 0.016, norenD + 0.016, 0.4);
        const panels = opW >= 1.45 ? 3 : 2;
        const gap = 0.045;
        const pw = (opW - 0.14 - gap * (panels - 1)) / panels;
        for (let np = 0; np < panels; np++) {
          const ns0 = op0 + 0.07 + np * (pw + gap);
          const ns1 = ns0 + pw;
          b.addQuadUV(
            'noren',
            frame.pt(ns0, norenBot, norenD),
            frame.pt(ns1, norenBot, norenD),
            frame.pt(ns1, rodY - 0.01, norenD),
            frame.pt(ns0, rodY - 0.01, norenD),
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1]
          );
        }
      }

      // Framed boutique glass door (double-leaf if wide, single-leaf if compact)
      const d0 = op0 + 0.06;
      const d1 = op1 - 0.06;
      const isDouble = d1 - d0 >= 1.55;
      const frameD0 = recessD - 0.07;
      const frameD1 = recessD + 0.01;

      frame.addBox(b, 'shopfront', d0, v0 + 0.038, frameD0, d1, v0 + 0.44, frameD1, 1.0);
      frame.addBox(b, 'brass', d0 + 0.03, v0 + 0.05, frameD1, d1 - 0.03, v0 + 0.22, frameD1 + 0.012, 0.6);
      frame.addBox(b, 'shopfront', d0, doorTop - 0.07, frameD0, d1, doorTop + 0.04, frameD1, 1.0);
      frame.addBox(b, 'shopfront', d0, v0 + 0.038, frameD0, d0 + 0.09, friezeBot - 0.05, frameD1, 1.0);
      frame.addBox(b, 'shopfront', d1 - 0.09, v0 + 0.038, frameD0, d1, friezeBot - 0.05, frameD1, 1.0);

      if (isDouble) {
        const dm = (d0 + d1) * 0.5;
        frame.addBox(b, 'shopfront', dm - 0.045, v0 + 0.038, frameD0, dm + 0.045, doorTop, frameD1, 1.0);
        const hBot = v0 + 0.92;
        const hTop = v0 + 1.48;
        frame.addBox(b, 'brass', dm - 0.13, hBot, frameD1 + 0.045, dm - 0.10, hTop, frameD1 + 0.072, 0.4);
        frame.addBox(b, 'brass', dm + 0.10, hBot, frameD1 + 0.045, dm + 0.13, hTop, frameD1 + 0.072, 0.4);
        frame.addBox(b, 'brass', dm - 0.125, hBot + 0.04, frameD1, dm - 0.105, hBot + 0.07, frameD1 + 0.045, 0.4);
        frame.addBox(b, 'brass', dm - 0.125, hTop - 0.07, frameD1, dm - 0.105, hTop - 0.04, frameD1 + 0.045, 0.4);
        frame.addBox(b, 'brass', dm + 0.105, hBot + 0.04, frameD1, dm + 0.125, hBot + 0.07, frameD1 + 0.045, 0.4);
        frame.addBox(b, 'brass', dm + 0.105, hTop - 0.07, frameD1, dm + 0.125, hTop - 0.04, frameD1 + 0.045, 0.4);
      } else {
        frame.addBox(b, 'brass', d1 - 0.18, v0 + 0.95, frameD1 + 0.045, d1 - 0.15, v0 + 1.48, frameD1 + 0.072, 0.4);
        frame.addBox(b, 'brass', d1 - 0.175, v0 + 0.99, frameD1, d1 - 0.155, v0 + 1.02, frameD1 + 0.045, 0.4);
        frame.addBox(b, 'brass', d1 - 0.175, v0 + 1.41, frameD1, d1 - 0.155, v0 + 1.44, frameD1 + 0.045, 0.4);
      }

      const glassD = (frameD0 + frameD1) * 0.5;
      frame.addQuad(b, 'vitrineGlass', d0 + 0.09, v0 + 0.44, d1 - 0.09, doorTop - 0.07, glassD);
      frame.addQuad(b, 'vitrineGlass', d0 + 0.09, doorTop + 0.04, d1 - 0.09, friezeBot - 0.05, glassD);

      const entPt = frame.pt(dMid, v0, 0);
      entrances.push({
        x: entPt[0],
        z: entPt[2],
        ox: frame.ox,
        oz: frame.oz,
        rx: frame.rx,
        rz: frame.rz,
      });
    } else {
      // === CRYSTAL-CLEAR DISPLAY VITRINE BAY ===
      vitrineCount++;
      const sillTop = v0 + kickH;

      frame.addBox(b, 'shopfront', op0, v0, -0.20, op1, sillTop, 0.015, 1.3);
      if (opW > 0.7) {
        const panelCount = opW > 2.2 ? 2 : 1;
        const pw = (opW - 0.16 * (panelCount + 1)) / panelCount;
        for (let p = 0; p < panelCount; p++) {
          const p0 = op0 + 0.16 + p * (pw + 0.16);
          frame.addBox(b, 'shopfront', p0, v0 + 0.13, 0.015, p0 + pw, sillTop - 0.11, 0.038, 1.0);
          frame.addBox(b, 'brass', p0 + 0.04, v0 + 0.17, 0.038, p0 + pw - 0.04, sillTop - 0.15, 0.045, 0.6);
        }
      }
      frame.addBox(b, 'cornice', op0 - 0.02, sillTop - 0.03, -0.18, op1 + 0.02, sillTop + 0.04, 0.072, 1.0);

      frame.addBox(b, 'shopfront', op0, sillTop + 0.04, -0.15, op0 + 0.06, friezeBot, -0.02, 1.0);
      frame.addBox(b, 'shopfront', op1 - 0.06, sillTop + 0.04, -0.15, op1, friezeBot, -0.02, 1.0);
      frame.addBox(b, 'shopfront', op0, friezeBot - 0.06, -0.15, op1, friezeBot, -0.02, 1.0);

      const transomY = friezeBot - 0.48;
      frame.addBox(b, 'shopfront', op0 + 0.06, transomY - 0.035, -0.145, op1 - 0.06, transomY + 0.035, -0.025, 1.0);

      if (style === 'style-c') {
        const slats = Math.max(3, Math.floor(opW / 0.34));
        for (let sIdx = 1; sIdx < slats; sIdx++) {
          const sx = op0 + (opW * sIdx) / slats;
          frame.addBox(b, 'shopfront', sx - 0.018, transomY + 0.035, -0.13, sx + 0.018, friezeBot - 0.06, -0.04, 0.8);
        }
      } else {
        const subDivs = opW > 2.0 ? 3 : 2;
        for (let sIdx = 1; sIdx < subDivs; sIdx++) {
          const sx = op0 + (opW * sIdx) / subDivs;
          frame.addBox(b, 'shopfront', sx - 0.022, transomY + 0.035, -0.135, sx + 0.022, friezeBot - 0.06, -0.035, 0.8);
        }
      }

      frame.addQuad(b, 'vitrineGlass', op0 + 0.06, sillTop + 0.04, op1 - 0.06, transomY - 0.035, -0.085);
      frame.addQuad(b, 'vitrineGlass', op0 + 0.06, transomY + 0.035, op1 - 0.06, friezeBot - 0.06, -0.085);

      const shelfTop = sillTop + 0.06;
      frame.addBox(b, 'counterWood', op0 + 0.08, sillTop - 0.04, -0.54, op1 - 0.08, shelfTop, -0.20, 0.9);
      if (opW >= 1.25) {
        const wMid = (op0 + op1) * 0.5;
        const pStand = frame.pt(wMid - opW * 0.22, shelfTop, -0.36);
        b.addCylinder('brass', pStand[0], shelfTop, shelfTop + 0.11, pStand[2], 0.045, 0.022, 10);
        b.addCylinder('porcelain', pStand[0], shelfTop + 0.11, shelfTop + 0.135, pStand[2], 0.15, 0.15, 14);
        b.addSphere('pastryGold', pStand[0] - 0.05, shelfTop + 0.165, pStand[2], 0.048, 10, 8);
        b.addSphere('pastryGold', pStand[0] + 0.055, shelfTop + 0.165, pStand[2] + 0.02, 0.044, 10, 8);

        const pStand2 = frame.pt(wMid + opW * 0.20, shelfTop, -0.36);
        b.addCylinder('porcelain', pStand2[0], shelfTop, shelfTop + 0.025, pStand2[2], 0.13, 0.14, 12);
        b.addCylinder('bottleAmber', pStand2[0] - 0.04, shelfTop + 0.025, shelfTop + 0.24, pStand2[2], 0.038, 0.032, 10);
        b.addCylinder('bottleGreen', pStand2[0] + 0.05, shelfTop + 0.025, shelfTop + 0.21, pStand2[2], 0.034, 0.028, 10);

        const lampPos = frame.pt(wMid, transomY - 0.32, -0.38);
        b.addCylinder('brass', lampPos[0], lampPos[1] + 0.14, friezeBot - 0.04, lampPos[2], 0.008, 0.008, 6);
        b.addCylinder('brass', lampPos[0], lampPos[1], lampPos[1] + 0.15, lampPos[2], 0.14, 0.036, 14);
        b.addSphere('warmGlow', lampPos[0], lampPos[1] - 0.01, lampPos[2], 0.055, 10, 8);
      }
    }
  }

  // 5. Crisp gilded / backlit shopfront fascia sign board (mounted proudly on frieze!)
  if (hasSignAllowed && innerW >= 2.2) {
    const signW = Math.min(innerW - 0.36, 4.8);
    const signH = Math.min(friezeH - 0.22, 0.56);
    const sMid = (inner0 + inner1) * 0.5;
    const signY0 = friezeBot + (cornBot - friezeBot - signH) * 0.5;
    const signY1 = signY0 + signH;

    frame.addBox(b, 'brass', sMid - signW * 0.5 - 0.04, signY0 - 0.035, 0.025, sMid + signW * 0.5 + 0.04, signY1 + 0.035, 0.055, 0.8);
    frame.addQuad(b, 'fasciaSign', sMid - signW * 0.5, signY0, sMid + signW * 0.5, signY1, 0.062, true);

    if (!coveredAbove) {
      const lampCount = signW >= 3.4 ? 3 : 2;
      for (let l = 0; l < lampCount; l++) {
        const sl = sMid - signW * 0.35 + (signW * 0.7 * l) / Math.max(1, lampCount - 1);
        const p0 = frame.pt(sl, signY1 + 0.06, 0.03);
        const p1 = frame.pt(sl, signY1 + 0.14, 0.20);
        const p2 = frame.pt(sl, signY1 + 0.05, 0.28);
        b.addTube('brass', [p0, p1, p2], 0.011, 8, 6);
        b.addCylinder('brass', p2[0], p2[1] - 0.04, p2[1] + 0.02, p2[2], 0.055, 0.018, 10);
        b.addSphere('warmGlow', p2[0], p2[1] - 0.045, p2[2], 0.026, 8, 6);
      }
    }
  }

  // 6. Corner-aware Sloped Striped Canvas Awnings (Toggle B):
  // - NEVER hang outdoor awnings under a cantilevered arcade ceiling (e.g. Corner Bistro ground arcade!)
  // - NEVER hang deep awnings on narrow recessed side returns (< 2.2m with a concave inner corner!)
  // - At concave 90° inner corners: pull back cleanly clear of perpendicular wall OR 45° miter cleanly!
  const isNarrowRecessedCheek = W < 2.25 && (leftEnd === 'concave' || rightEnd === 'concave');
  if (showAwnings && !coveredAbove && !isNarrowRecessedCheek && innerW >= 1.55) {
    const yMount = friezeBot - 0.03;
    const awProj = style === 'style-c' ? 0.86 : 1.16;

    // Check if a perpendicular wall at a concave inner corner ALSO carries an exposed wide storefront awning!
    const perpWallHasAwning = (end: 'left' | 'right'): boolean => {
      if ((end === 'left' ? leftEnd : rightEnd) !== 'concave') return false;
      const sOut = end === 'left' ? -0.15 : W + 0.15;
      // Check if perpendicular protruding wall extends >= 2.25m outward AND is NOT covered by a cantilever!
      const pFar = frame.pt(sOut, yMid, 2.1);
      const pOver = frame.pt(end === 'left' ? 0.55 : W - 0.55, shopTop + 0.35, 0.85);
      return (
        pointInsideAnyBox(allBoxes, pFar[0], pFar[1], pFar[2], 0.02) &&
        !pointInsideAnyBox(allBoxes, pOver[0], pOver[1], pOver[2], 0.02)
      );
    };

    const miterL = leftEnd === 'concave' && perpWallHasAwning('left');
    const miterR = rightEnd === 'concave' && perpWallHasAwning('right');

    // Compute clean clash-free awning start/end along s
    const awStart = leftEnd === 'concave' ? (miterL ? 0.02 : Math.max(inner0, 0.16)) : inner0 + 0.04;
    const awEnd = rightEnd === 'concave' ? (miterR ? W - 0.02 : Math.min(inner1, W - 0.16)) : inner1 - 0.04;

    if (bayCount <= 2 || awEnd - awStart <= 5.4) {
      addStripedAwning(b, frame, awStart, awEnd, yMount, awProj, miterL, miterR);
    } else {
      for (let i = 0; i < bayCount; i++) {
        const b0 = i === 0 ? awStart : inner0 + i * bayW + 0.07;
        const b1 = i === bayCount - 1 ? awEnd : inner0 + (i + 1) * bayW - 0.07;
        addStripedAwning(b, frame, b0, b1, yMount, awProj, i === 0 && miterL, i === bayCount - 1 && miterR);
      }
    }
  } else if (coveredAbove) {
    // Warm architectural brass wall lanterns on covered arcade piers!
    for (const sPier of [sMin + pierW * 0.5, sMax - pierW * 0.5]) {
      const lp = frame.pt(sPier, v0 + 2.32, 0.08);
      b.addBox('iron', lp[0] - 0.045, lp[1] - 0.10, lp[2] - 0.045, lp[0] + 0.045, lp[1] + 0.10, lp[2] + 0.045, 0.4);
      b.addSphere('warmGlow', lp[0], lp[1], lp[2], 0.052, 8, 6);
    }
  }

  return vitrineCount;
}

/**
 * Builds upper-story architectural facade bays with tall French / SoHo / Tokyo windows,
 * realistic 3D recessed interiors with curtains/blinds, wrought-iron Juliet railings + flower boxes,
 * convex-only corner quoins, and razor-clean 90°-corner-aware cornices.
 */
function buildUpperFacade(
  b: MaterialGeometryBatcher<ShopMatKey>,
  foliage: BotanicalFoliageBatcher,
  frame: FacadeFrame,
  v0: number,
  v1: number,
  style: StyleKey,
  allBoxes: MassingBox[]
): void {
  const W = frame.width;
  const trimPad = frame.isXAxisWall ? 0.004 : 0.0;
  const sMin = trimPad;
  const sMax = W - trimPad;
  const usableW = sMax - sMin;

  // Divide vertically into upper stories aligned to GROUND_STORY_H + k * UPPER_STORY_H
  const levels: [number, number][] = [];
  let curY = v0;
  while (curY < v1 - 0.15) {
    const k = Math.floor((curY - GROUND_STORY_H + 0.05) / UPPER_STORY_H);
    const nextGrid = GROUND_STORY_H + (k + 1) * UPPER_STORY_H;
    const nextY = Math.min(v1, nextGrid > curY + 0.5 ? nextGrid : curY + UPPER_STORY_H);
    levels.push([curY, nextY]);
    curY = nextY;
  }

  for (let lvlIdx = 0; lvlIdx < levels.length; lvlIdx++) {
    const [sy0, sy1] = levels[lvlIdx];
    const sh = sy1 - sy0;
    const syMid = (sy0 + sy1) * 0.5;
    const leftEnd = classifyFacadeEnd(frame, 'left', syMid, allBoxes);
    const rightEnd = classifyFacadeEnd(frame, 'right', syMid, allBoxes);
    const isTopStory = Math.abs(sy1 - v1) < 0.15;

    // Narrow wall, recessed narrow cheek (< 1.8m with a concave inner corner), or short attic sliver: clean solid masonry!
    const isNarrowInnerCheek = usableW < 1.85 && (leftEnd === 'concave' || rightEnd === 'concave');
    if (usableW < 1.35 || isNarrowInnerCheek || sh < 1.8) {
      frame.addBox(b, 'upperWall', sMin, sy0, -0.24, sMax, sy1, 0.0, style === 'style-a' ? 2.6 : 1.85);
      const cornProj = isTopStory ? (style === 'style-b' ? 0.24 : 0.20) : 0.10;
      const cornH = isTopStory ? (style === 'style-b' ? 0.24 : 0.20) : 0.10;
      const cornMat: ShopMatKey = style === 'style-b' && isTopStory ? 'iron' : 'cornice';
      addCornerAwareCornice(b, frame, cornMat, sy1 - cornH, sy1 - cornH * 0.45, -0.02, cornProj * 0.62, leftEnd, rightEnd, 1.2);
      addCornerAwareCornice(b, frame, cornMat, sy1 - cornH * 0.45, sy1 + 0.02, -0.02, cornProj, leftEnd, rightEnd, 1.2);
      continue;
    }

    const baseMargin = Math.min(0.52, usableW * 0.16);
    // Extra clearance from concave 90° inner corners so sills, lintels & Juliet railings NEVER clip perpendicular walls!
    const marginL = leftEnd === 'concave' ? Math.max(baseMargin, 0.44) : baseMargin;
    const marginR = rightEnd === 'concave' ? Math.max(baseMargin, 0.44) : baseMargin;
    const span = usableW - marginL - marginR;
    if (span < 0.75) {
      frame.addBox(b, 'upperWall', sMin, sy0, -0.24, sMax, sy1, 0.0, style === 'style-a' ? 2.4 : 1.8);
      continue;
    }

    const bayCount = Math.max(1, Math.round(span / 2.25));
    const bayW = span / bayCount;
    const winW = Math.min(bayW * 0.58, style === 'style-b' ? 1.34 : 1.22);
    const winBot = sy0 + (style === 'style-a' ? 0.44 : 0.72);
    const winTop = Math.min(sy1 - 0.46, winBot + (style === 'style-a' ? 2.18 : 1.90));
    const wallUv = style === 'style-a' ? 2.6 : 1.85;

    // Solid bottom spandrel & top header bands (NEVER overlap window openings!)
    frame.addBox(b, 'upperWall', sMin, sy0, -0.26, sMax, winBot, 0.0, wallUv);
    frame.addBox(b, 'upperWall', sMin, winTop, -0.26, sMax, sy1, 0.0, wallUv);

    // Solid left & right outer edge piers
    const firstWinL = sMin + marginL + (bayW - winW) * 0.5;
    const lastWinR = sMin + marginL + (bayCount - 1) * bayW + (bayW + winW) * 0.5;
    frame.addBox(b, 'upperWall', sMin, winBot, -0.26, firstWinL, winTop, 0.0, wallUv);
    frame.addBox(b, 'upperWall', lastWinR, winBot, -0.26, sMax, winTop, 0.0, wallUv);

    // Dressed stone corner quoins STRICTLY on TRUE CONVEX 90° OUTER CORNERS (NEVER inside concave L-corners!)
    if (style !== 'style-c' && usableW >= 2.1) {
      const qCount = Math.max(5, Math.floor(sh / 0.40));
      const qh = (sh - 0.24) / qCount; // Stop neatly below crowning cornice!
      const qD = 0.032;
      for (let q = 0; q < qCount; q++) {
        const qw = q % 2 === 0 ? 0.34 : 0.22;
        const qy0 = sy0 + 0.04 + q * qh + 0.018;
        const qy1 = sy0 + 0.04 + (q + 1) * qh - 0.018;
        if (leftEnd === 'convex') {
          if (!frame.isXAxisWall) {
            frame.addBox(b, 'cornice', -qD, qy0, 0.002, sMin + qw, qy1, qD, 1.0);
          } else {
            frame.addBox(b, 'cornice', sMin + 0.002, qy0, 0.002, sMin + qw, qy1, qD, 1.0);
          }
        }
        if (rightEnd === 'convex') {
          if (!frame.isXAxisWall) {
            frame.addBox(b, 'cornice', sMax - qw, qy0, 0.002, W + qD, qy1, qD, 1.0);
          } else {
            frame.addBox(b, 'cornice', sMax - qw, qy0, 0.002, sMax - 0.002, qy1, qD, 1.0);
          }
        }
      }
    }

    for (let i = 0; i < bayCount; i++) {
      const w0 = sMin + marginL + i * bayW + (bayW - winW) * 0.5;
      const w1 = w0 + winW;
      const wm = (w0 + w1) * 0.5;

      // Solid intermediate wall pier between adjacent windows
      if (i > 0) {
        const prevW1 = sMin + marginL + (i - 1) * bayW + (bayW + winW) * 0.5;
        frame.addBox(b, 'upperWall', prevW1, winBot, -0.26, w0, winTop, 0.0, wallUv);
      }

      // Window opening molded stone/timber architrave jambs, sill, brackets & pediment lintel
      frame.addBox(b, 'trim', w0 - 0.075, winBot, -0.18, w0, winTop, 0.026, 1.0);
      frame.addBox(b, 'trim', w1, winBot, -0.18, w1 + 0.075, winTop, 0.026, 1.0);

      // Projecting beveled window sill + carved console corbel brackets
      frame.addBeveledBox(b, 'cornice', w0 - 0.11, winBot - 0.075, -0.18, w1 + 0.11, winBot + 0.005, 0.088, 0.01, 1.0);
      frame.addBox(b, 'cornice', w0 - 0.055, winBot - 0.19, 0.004, w0 + 0.035, winBot - 0.075, 0.068, 0.8);
      frame.addBox(b, 'cornice', w1 - 0.035, winBot - 0.19, 0.004, w1 + 0.055, winBot - 0.075, 0.068, 0.8);

      // Crown lintel hood + central sculpted stone keystone (Paris & SoHo realism!)
      frame.addBeveledBox(b, 'cornice', w0 - 0.10, winTop, -0.18, w1 + 0.10, winTop + 0.125, 0.082, 0.012, 1.0);
      if (style !== 'style-c') {
        frame.addBeveledBox(b, 'cornice', wm - 0.075, winTop - 0.025, 0.01, wm + 0.075, winTop + 0.16, 0.105, 0.01, 0.8);
      }

      // Slender realistic recessed window sash & muntins (d = -0.145..-0.095)
      const sashMat: ShopMatKey = style === 'style-a' ? 'trim' : style === 'style-b' ? 'iron' : 'accentWood';
      const sashW = style === 'style-b' ? 0.036 : 0.044;
      frame.addBox(b, sashMat, w0, winBot, -0.15, w0 + sashW, winTop, -0.095, 0.8);
      frame.addBox(b, sashMat, w1 - sashW, winBot, -0.15, w1, winTop, -0.095, 0.8);
      frame.addBox(b, sashMat, w0, winBot, -0.15, w1, winBot + sashW, -0.095, 0.8);
      frame.addBox(b, sashMat, w0, winTop - sashW, -0.15, w1, winTop, -0.095, 0.8);

      // Central casement stile / vertical muntin
      frame.addBox(b, sashMat, wm - 0.018, winBot + sashW, -0.142, wm + 0.018, winTop - sashW, -0.10, 0.8);

      // Horizontal muntins
      const hBars = style === 'style-b' ? 3 : 2;
      for (let hb = 1; hb <= hBars; hb++) {
        const hy = winBot + ((winTop - winBot) * hb) / (hBars + 1);
        frame.addBox(b, sashMat, w0 + sashW, hy - 0.012, -0.140, w1 - sashW, hy + 0.012, -0.105, 0.8);
      }

      // Recessed reflective upper Fresnel glass pane (d = -0.122)
      frame.addQuad(b, 'upperGlass', w0 + sashW, winBot + sashW, w1 - sashW, winTop - sashW, -0.122);

      // Realistic 3D interior window treatments softly visible behind glass (curtains / wood blinds!)
      if (style === 'style-c') {
        // Warm horizontal Japanese cedar venetian blinds partially lowered at top of window!
        const blindDrop = (winTop - winBot) * 0.42;
        const slatN = 7;
        for (let sl = 0; sl < slatN; sl++) {
          const sy = winTop - 0.08 - (blindDrop * sl) / slatN;
          frame.addBox(b, 'accentWood', w0 + 0.05, sy - 0.018, -0.185, w1 - 0.05, sy + 0.008, -0.155, 0.6);
        }
      } else {
        // Soft draped linen side curtains framing left & right edges behind the glass!
        const curtW = winW * 0.23;
        frame.addBox(b, 'curtain', w0 + 0.03, winBot + 0.04, -0.195, w0 + 0.03 + curtW, winTop - 0.04, -0.155, 0.6);
        frame.addBox(b, 'curtain', w1 - 0.03 - curtW, winBot + 0.04, -0.195, w1 - 0.03, winTop - 0.04, -0.155, 0.6);
        // Subtle translucent roller shade across upper fifth of window
        frame.addBox(b, 'curtain', w0 + 0.04, winTop - (winTop - winBot) * 0.18, -0.185, w1 - 0.04, winTop - 0.04, -0.165, 0.6);
      }

      // Recessed interior room backing (deterministic warm/dim inhabited variety at evening!)
      const pRef = frame.pt(wm, (winBot + winTop) * 0.5, 0);
      const litRoll = hash2(Math.round(pRef[0] * 2 + pRef[2] * 3), Math.round(pRef[1] * 2));
      const roomMat: ShopMatKey = litRoll > 0.34 ? 'upperRoomWarm' : 'upperRoomDim';
      frame.addQuad(b, roomMat, w0 + 0.02, winBot + 0.02, w1 - 0.02, winTop - 0.02, -0.24);

      // Style-specific upper window signature micro-details!
      if (style === 'style-a') {
        // Parisian wrought-iron Juliet balcony railing + terracotta/zinc flower box with greenery & red geraniums!
        const railH = winBot + 0.86;
        const railD = 0.16;
        frame.addBox(b, 'iron', w0 - 0.05, winBot + 0.04, railD - 0.016, w1 + 0.05, winBot + 0.07, railD + 0.016, 0.5);
        frame.addBox(b, 'iron', w0 - 0.07, railH - 0.022, railD - 0.022, w1 + 0.07, railH + 0.018, railD + 0.022, 0.5);
        frame.addBox(b, 'iron', w0 - 0.05, railH - 0.13, railD - 0.012, w1 + 0.05, railH - 0.108, railD + 0.012, 0.5);
        frame.addBox(b, 'iron', w0 - 0.06, railH - 0.018, 0.01, w0 - 0.035, railH + 0.014, railD, 0.5);
        frame.addBox(b, 'iron', w1 + 0.035, railH - 0.018, 0.01, w1 + 0.06, railH + 0.014, railD, 0.5);
        frame.addBox(b, 'iron', w0 - 0.06, winBot + 0.04, 0.01, w0 - 0.035, winBot + 0.068, railD, 0.5);
        frame.addBox(b, 'iron', w1 + 0.035, winBot + 0.04, 0.01, w1 + 0.06, winBot + 0.068, railD, 0.5);

        const spindles = Math.max(7, Math.round(winW / 0.14));
        for (let sp = 0; sp <= spindles; sp++) {
          const sx = w0 - 0.035 + ((winW + 0.07) * sp) / spindles;
          frame.addBox(b, 'iron', sx - 0.009, winBot + 0.07, railD - 0.009, sx + 0.009, railH - 0.02, railD + 0.009, 0.4);
        }
        const rMidY = (winBot + 0.07 + railH - 0.13) * 0.5;
        b.addOrientedCylinder('iron', frame.pt(wm - 0.15, rMidY - 0.15, railD), frame.pt(wm + 0.15, rMidY + 0.15, railD), 0.009, 0.009, 6);
        b.addOrientedCylinder('iron', frame.pt(wm + 0.15, rMidY - 0.15, railD), frame.pt(wm - 0.15, rMidY + 0.15, railD), 0.009, 0.009, 6);
        const medPt = frame.pt(wm, rMidY, railD + 0.006);
        b.addSphere('brass', medPt[0], medPt[1], medPt[2], 0.032, 10, 8);

        // Parisian zinc window flower box nestled behind the Juliet balcony (every other or front windows!)
        if (frame.dir === '+z' || frame.dir === '+x') {
          const fbW = Math.min(winW * 0.68, 0.72);
          frame.addBox(b, 'mansardZinc', wm - fbW * 0.5, winBot + 0.02, 0.02, wm + fbW * 0.5, winBot + 0.16, 0.13, 0.6);
          const fPt = frame.pt(wm, winBot + 0.15, 0.085);
          foliage.addPottedPlant(fPt[0], fPt[1], fPt[2], 0.28, 410 + i * 31 + lvlIdx * 17, 'emerald');
          // Tiny crimson geranium blossom clusters peeking through iron spindles!
          for (const gOff of [-fbW * 0.28, 0, fbW * 0.28]) {
            const gp = frame.pt(wm + gOff, winBot + 0.24, 0.095);
            b.addSphere('flowerRed', gp[0], gp[1], gp[2], 0.036, 7, 6);
          }
        }
      } else if (style === 'style-c') {
        // Tokyo Kissa: warm vertical cedar privacy screen louvers flanking one side of window + sleek iron bar
        const louverW = Math.min(0.32, winW * 0.28);
        for (let lv = 0; lv < 4; lv++) {
          const lx = w1 - louverW + (lv * louverW) / 3.5;
          frame.addBox(b, 'shopfront', lx, winBot + 0.06, 0.02, lx + 0.032, winTop - 0.06, 0.072, 0.8);
        }
        frame.addBox(b, 'iron', w0 - 0.04, winBot + 0.34, 0.068, w1 + 0.04, winBot + 0.37, 0.092, 0.5);
      } else {
        // SoHo Brick: exposed black steel lintel beam with bolts + iron window safety bar
        frame.addBox(b, 'iron', w0 - 0.12, winTop + 0.015, 0.005, w1 + 0.12, winTop + 0.135, 0.065, 0.8);
        frame.addBox(b, 'iron', w0 - 0.04, winBot + 0.24, 0.075, w1 + 0.04, winBot + 0.275, 0.105, 0.5);
        frame.addBox(b, 'iron', w0 - 0.04, winBot + 0.02, 0.075, w0 - 0.01, winBot + 0.27, 0.10, 0.5);
        frame.addBox(b, 'iron', w1 + 0.01, winBot + 0.02, 0.075, w1 + 0.04, winBot + 0.27, 0.10, 0.5);
      }
    }

    // Authentic SoHo forged-iron fire-escape balcony on wide front multi-story brick facades!
    if (style === 'style-b' && frame.dir === '+z' && usableW >= 3.8 && bayCount >= 2 && leftEnd !== 'concave' && rightEnd !== 'concave') {
      const fe0 = sMin + marginL + 0.12;
      const fe1 = sMax - marginR - 0.12;
      const feD = 0.56;
      const feY = sy0 + 0.16;
      const feH = 0.88;
      // Perforated iron balcony deck frame + support brackets
      frame.addBox(b, 'iron', fe0, feY, 0.02, fe1, feY + 0.045, feD, 0.6);
      for (const bx of [fe0 + 0.15, (fe0 + fe1) * 0.5, fe1 - 0.15]) {
        b.addOrientedCylinder('iron', frame.pt(bx, feY - 0.36, 0.02), frame.pt(bx, feY, feD - 0.04), 0.016, 0.016, 6);
      }
      // Top & bottom perimeter railing + vertical pickets
      frame.addBox(b, 'iron', fe0, feY + feH, feD - 0.022, fe1, feY + feH + 0.032, feD + 0.022, 0.5);
      frame.addBox(b, 'iron', fe0, feY + feH, 0.02, fe0 + 0.03, feY + feH + 0.032, feD, 0.5);
      frame.addBox(b, 'iron', fe1 - 0.03, feY + feH, 0.02, fe1, feY + feH + 0.032, feD, 0.5);
      const pickets = Math.max(8, Math.round((fe1 - fe0) / 0.22));
      for (let pk = 0; pk <= pickets; pk++) {
        const px = fe0 + ((fe1 - fe0) * pk) / pickets;
        frame.addBox(b, 'iron', px - 0.01, feY + 0.04, feD - 0.01, px + 0.01, feY + feH, feD + 0.01, 0.4);
      }
      // Iconic NYC diagonal iron fire-escape staircase stringer connecting to next floor when multi-story!
      if (!isTopStory) {
        b.addOrientedCylinder('iron', frame.pt(fe0 + 0.35, feY + 0.05, feD - 0.14), frame.pt(fe1 - 0.35, sy1 + 0.16, feD - 0.14), 0.022, 0.022, 6);
        b.addOrientedCylinder('iron', frame.pt(fe0 + 0.35, feY + 0.05, feD - 0.40), frame.pt(fe1 - 0.35, sy1 + 0.16, feD - 0.40), 0.022, 0.022, 6);
      }
    }

    // Horizontal story belt course / crowning cornice along top of each story (100% 90°-corner aware!)
    const cornProj = isTopStory ? (style === 'style-b' ? 0.24 : 0.20) : 0.10;
    const cornH = isTopStory ? (style === 'style-b' ? 0.24 : 0.20) : 0.10;
    const cornMat: ShopMatKey = style === 'style-b' && isTopStory ? 'iron' : 'cornice';
    addCornerAwareCornice(b, frame, cornMat, sy1 - cornH, sy1 - cornH * 0.45, -0.02, cornProj * 0.62, leftEnd, rightEnd, 1.2);
    addCornerAwareCornice(b, frame, cornMat, sy1 - cornH * 0.45, sy1 + 0.02, -0.02, cornProj, leftEnd, rightEnd, 1.2);

    // Classic architectural cornice dentils (Paris) or cast-iron modillion brackets (SoHo) along crown!
    if (isTopStory && style !== 'style-c' && usableW >= 2.0) {
      const step = style === 'style-b' ? 0.36 : 0.24;
      const bStart = leftEnd === 'concave' ? cornProj + 0.16 : 0.16;
      const bEnd = rightEnd === 'concave' ? W - cornProj - 0.16 : W - 0.16;
      if (bEnd > bStart + 0.3) {
        const cnt = Math.max(3, Math.floor((bEnd - bStart) / step));
        for (let bi = 0; bi <= cnt; bi++) {
          const bs = bStart + ((bEnd - bStart) * bi) / cnt;
          if (style === 'style-b') {
            frame.addBox(b, 'iron', bs - 0.038, sy1 - cornH - 0.14, 0.005, bs + 0.038, sy1 - cornH * 0.45, cornProj * 0.78, 0.5);
          } else {
            frame.addBox(b, 'cornice', bs - 0.04, sy1 - cornH - 0.06, 0.005, bs + 0.04, sy1 - cornH, 0.075, 0.6);
          }
        }
      }
    }
  }
}

/**
 * Builds the REAL 3D illuminated café interior inside every ground-floor MassingBox
 * (checkerboard marble / timber floor, walnut espresso bar + chrome espresso machine,
 * backlit bottle shelves, glowing brass pendant lamps, and interior bistro seating).
 * Strictly inset >= 0.28m from outer exterior faces -> ZERO z-fighting!
 */
function buildGroundInterior(
  b: MaterialGeometryBatcher<ShopMatKey>,
  box: MassingBox,
  allBoxes: MassingBox[],
  style: StyleKey,
  dynamicLights: DynamicShopLight[]
): number {
  const shopTop = Math.min(box.max[1], GROUND_STORY_H);
  if (box.min[1] >= 0.15 || shopTop < 2.3) return 0;

  // Inset 0.28m from exterior edges, only 0.01m where directly touching an adjacent ground box
  const touches = (dir: FaceDir): boolean => {
    const cx = (box.min[0] + box.max[0]) * 0.5;
    const cz = (box.min[2] + box.max[2]) * 0.5;
    const cy = 1.5;
    if (dir === '+x') return pointInsideAnyBox(allBoxes, box.max[0] + 0.08, cy, cz, 0.0);
    if (dir === '-x') return pointInsideAnyBox(allBoxes, box.min[0] - 0.08, cy, cz, 0.0);
    if (dir === '+z') return pointInsideAnyBox(allBoxes, cx, cy, box.max[2] + 0.08, 0.0);
    if (dir === '-z') return pointInsideAnyBox(allBoxes, cx, cy, box.min[2] - 0.08, 0.0);
    return false;
  };

  const x0 = box.min[0] + (touches('-x') ? 0.01 : 0.28);
  const x1 = box.max[0] - (touches('+x') ? 0.01 : 0.28);
  const z0 = box.min[2] + (touches('-z') ? 0.01 : 0.28);
  const z1 = box.max[2] - (touches('+z') ? 0.01 : 0.28);
  const w = x1 - x0;
  const d = z1 - z0;
  if (w < 1.2 || d < 1.2) return 0;

  const floorY = 0.045;
  const ceilY = shopTop - 0.16;

  // 1. Interior checkerboard marble / golden timber floor & warm illuminated ceiling slab
  b.addBox('interiorFloor', x0, 0.008, z0, x1, floorY, z1, style === 'style-a' ? 1.45 : 1.6);
  b.addBox('interiorCeiling', x0, ceilY, z0, x1, ceilY + 0.12, z1, 2.0);

  if (w >= 2.2 && d >= 2.2) {
    const cx = (x0 + x1) * 0.5;
    const cz = (z0 + z1) * 0.5;
    const coveW = Math.min(w - 1.0, 5.2);
    b.addBox('warmGlow', cx - coveW * 0.5, ceilY - 0.025, cz - 0.14, cx + coveW * 0.5, ceilY - 0.004, cz + 0.14, 1.0);
  }

  // 2. Central / rear Walnut & Marble Espresso Bar Counter + Back-Bar Shelving
  const cx = (x0 + x1) * 0.5;
  const barZ = z0 + Math.max(1.15, d * 0.34);
  const barW = Math.min(w - 1.35, 4.4);
  let interiorTables = 0;

  if (barW >= 1.5 && d >= 2.6) {
    const bx0 = cx - barW * 0.5;
    const bx1 = cx + barW * 0.5;
    const barFrontZ = barZ + 0.36;
    const barBackZ = barZ - 0.36;

    b.addBox('counterWood', bx0, floorY, barBackZ, bx1, floorY + 0.98, barFrontZ, 1.2);
    const slats = Math.floor(barW / 0.18);
    for (let s = 1; s < slats; s++) {
      const sx = bx0 + (barW * s) / slats;
      b.addBox('accentWood', sx - 0.02, floorY + 0.10, barFrontZ, sx + 0.02, floorY + 0.94, barFrontZ + 0.026, 0.6);
    }
    b.addBox('warmGlow', bx0 + 0.08, floorY + 0.94, barFrontZ + 0.008, bx1 - 0.08, floorY + 0.975, barFrontZ + 0.042, 0.6);
    b.addOrientedCylinder('brass', [bx0 + 0.1, floorY + 0.20, barFrontZ + 0.16], [bx1 - 0.1, floorY + 0.20, barFrontZ + 0.16], 0.018, 0.018, 8);

    b.addBeveledBox('counterTop', bx0 - 0.06, floorY + 0.98, barBackZ - 0.04, bx1 + 0.06, floorY + 1.045, barFrontZ + 0.09, 0.014, 1.2);

    const ctY = floorY + 1.045;
    const emX = bx0 + barW * 0.30;
    const emZ = barZ;
    b.addBeveledBox('steel', emX - 0.34, ctY, emZ - 0.22, emX + 0.34, ctY + 0.44, emZ + 0.20, 0.018, 0.8);
    b.addBox('brass', emX - 0.35, ctY + 0.36, emZ - 0.23, emX + 0.35, ctY + 0.41, emZ + 0.21, 0.6);
    b.addBox('iron', emX - 0.30, ctY, emZ + 0.20, emX + 0.30, ctY + 0.06, emZ + 0.32, 0.5);
    b.addCylinder('steel', emX - 0.14, ctY + 0.22, ctY + 0.34, emZ + 0.24, 0.045, 0.045, 10);
    b.addCylinder('steel', emX + 0.14, ctY + 0.22, ctY + 0.34, emZ + 0.24, 0.045, 0.045, 10);
    for (let c = 0; c < 4; c++) {
      b.addCylinder('porcelain', emX - 0.20 + c * 0.13, ctY + 0.44, ctY + 0.51, emZ, 0.032, 0.038, 10);
    }

    if (barW >= 2.2) {
      const pcX = bx0 + barW * 0.72;
      b.addBox('brass', pcX - 0.42, ctY, emZ - 0.22, pcX + 0.42, ctY + 0.04, emZ + 0.24, 0.6);
      b.addBox('porcelain', pcX - 0.36, ctY + 0.04, emZ - 0.16, pcX + 0.36, ctY + 0.07, emZ + 0.18, 0.6);
      for (let p = 0; p < 4; p++) {
        b.addSphere('pastryGold', pcX - 0.24 + p * 0.16, ctY + 0.11, emZ + 0.04, 0.052, 9, 7);
        b.addSphere('pastryGold', pcX - 0.22 + p * 0.15, ctY + 0.105, emZ - 0.08, 0.046, 9, 7);
      }
      b.addBox('brass', pcX - 0.42, ctY + 0.04, emZ + 0.21, pcX - 0.39, ctY + 0.40, emZ + 0.24, 0.4);
      b.addBox('brass', pcX + 0.39, ctY + 0.04, emZ + 0.21, pcX + 0.42, ctY + 0.40, emZ + 0.24, 0.4);
      b.addBox('warmGlow', pcX - 0.38, ctY + 0.36, emZ - 0.12, pcX + 0.38, ctY + 0.39, emZ + 0.16, 0.5);
    }

    const shelfZ = barBackZ - 0.62;
    if (shelfZ > z0 + 0.26) {
      const shW = barW * 0.92;
      const sx0 = cx - shW * 0.5;
      const sx1 = cx + shW * 0.5;
      b.addBox('interiorWall', sx0, floorY, shelfZ - 0.16, sx1, floorY + 2.52, shelfZ - 0.08, 1.5);
      const uprights = Math.max(3, Math.round(shW / 1.1) + 1);
      for (let u = 0; u < uprights; u++) {
        const ux = sx0 + (shW * u) / (uprights - 1);
        b.addBox('counterWood', ux - 0.03, floorY, shelfZ - 0.08, ux + 0.03, floorY + 2.48, shelfZ + 0.20, 0.8);
      }
      for (const shY of [floorY + 1.12, floorY + 1.62, floorY + 2.12]) {
        b.addBox('counterWood', sx0, shY, shelfZ - 0.08, sx1, shY + 0.045, shelfZ + 0.22, 0.9);
        b.addBox('warmGlow', sx0 + 0.08, shY + 0.045, shelfZ - 0.075, sx1 - 0.08, shY + 0.095, shelfZ - 0.04, 0.6);

        const items = Math.max(4, Math.floor(shW / 0.32));
        for (let k = 0; k < items; k++) {
          const ix = sx0 + 0.18 + ((shW - 0.36) * k) / Math.max(1, items - 1);
          const pick = (k + Math.round(shY * 3)) % 3;
          if (pick === 0) {
            b.addCylinder('bottleAmber', ix, shY + 0.045, shY + 0.32, shelfZ + 0.06, 0.042, 0.028, 8);
          } else if (pick === 1) {
            b.addCylinder('bottleGreen', ix, shY + 0.045, shY + 0.30, shelfZ + 0.06, 0.04, 0.025, 8);
          } else {
            b.addCylinder('porcelain', ix, shY + 0.045, shY + 0.19, shelfZ + 0.06, 0.055, 0.055, 8);
          }
        }
      }
    }

    const pendCount = Math.max(2, Math.min(4, Math.round(barW / 1.1)));
    const pendY = Math.min(ceilY - 0.72, 2.38);
    for (let p = 0; p < pendCount; p++) {
      const px = bx0 + 0.45 + ((barW - 0.9) * p) / Math.max(1, pendCount - 1);
      b.addCylinder('brass', px, pendY + 0.16, ceilY, barZ + 0.08, 0.01, 0.01, 6);
      b.addCylinder('brass', px, pendY, pendY + 0.17, barZ + 0.08, 0.16, 0.04, 14);
      b.addSphere('warmGlow', px, pendY - 0.015, barZ + 0.08, 0.065, 10, 8);
    }

    if (dynamicLights.filter((l) => l.kind === 'interior').length < 3) {
      const iLight = new THREE.PointLight('#ffc476', 0.4, 10.5, 1.7);
      iLight.position.set(cx, Math.min(ceilY - 0.45, 2.55), Math.min(z1 - 0.65, barFrontZ + 0.75));
      dynamicLights.push({ light: iLight, kind: 'interior' });
    }
  }

  const frontZoneZ = (barZ + 0.5 + z1 - 0.55) * 0.5;
  if (z1 - barZ >= 1.95 && w >= 2.8) {
    const tCount = Math.max(1, Math.min(3, Math.floor((w - 1.2) / 2.2)));
    for (let t = 0; t < tCount; t++) {
      const tx = x0 + 1.05 + ((w - 2.1) * t) / Math.max(1, tCount - 1);
      addBistroTableSet(b, tx, floorY, frontZoneZ, 0.15 * (t % 2 === 0 ? 1 : -1), style, w > 3.6);
      interiorTables++;
    }
  }

  return interiorTables;
}

/**
 * Computes the exposed 1D intervals along one edge of a roof patch at elevation `y` by subtracting
 * any neighboring boxes that occupy the adjacent strip at `y - 0.15` (same-height roof) or `y + 0.25` (taller wall).
 */
function computeExposedRoofEdgeSpans(
  side: 'n' | 's' | 'w' | 'e',
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y: number,
  allBoxes: MassingBox[]
): [number, number][] {
  let segs: [number, number][] = side === 'n' || side === 's' ? [[x0, x1]] : [[z0, z1]];
  const eps = 0.08;
  for (const bx of allBoxes) {
    // Only consider boxes that exist at roof level (same height or taller)
    if (bx.max[1] < y - 0.25 || bx.min[1] > y + 0.25) continue;
    let touches = false;
    let c0 = 0;
    let c1 = 0;
    if (side === 's' && bx.min[2] <= z1 + eps && bx.max[2] >= z1 + 0.12) {
      touches = true; c0 = bx.min[0]; c1 = bx.max[0];
    } else if (side === 'n' && bx.max[2] >= z0 - eps && bx.min[2] <= z0 - 0.12) {
      touches = true; c0 = bx.min[0]; c1 = bx.max[0];
    } else if (side === 'e' && bx.min[0] <= x1 + eps && bx.max[0] >= x1 + 0.12) {
      touches = true; c0 = bx.min[2]; c1 = bx.max[2];
    } else if (side === 'w' && bx.max[0] >= x0 - eps && bx.min[0] <= x0 - 0.12) {
      touches = true; c0 = bx.min[2]; c1 = bx.max[2];
    }
    if (!touches) continue;
    const next: [number, number][] = [];
    for (const [s0, s1] of segs) {
      if (c1 <= s0 + 0.02 || c0 >= s1 - 0.02) {
        next.push([s0, s1]);
      } else {
        if (c0 > s0 + 0.08) next.push([s0, c0]);
        if (c1 < s1 - 0.08) next.push([c1, s1]);
      }
    }
    segs = next;
  }
  return segs;
}

/**
 * Builds realistic, style-authentic rooftops WITHOUT cloning identical chimneys/skylights onto every patch:
 * - Exact exposed-edge interval subtraction so coplanar L-shaped roofs (Corner Bistro!) wrap cleanly
 *   with ZERO interior divider walls and razor-sharp 45° mitered Mansard valleys!
 * - Paris (style-a): authentic sloped standing-seam Parisian Zinc Mansard roof + sculpted zinc dormer lucarnes!
 * - SoHo (style-b): NYC brick parapet + cast-iron coping + industrial skylight on primary roof!
 * - Tokyo (style-c): crisp architectural metal fascia + slatted cedar screen + stainless coffee roaster exhaust flue!
 */
function buildRoofPatch(
  b: MaterialGeometryBatcher<ShopMatKey>,
  patch: MergedExteriorPatch,
  allBoxes: MassingBox[],
  style: StyleKey,
  isPrimaryRoof: boolean,
  isTopmostRoof: boolean
): void {
  const { u0: x0, u1: x1, v0: z0, v1: z1 } = patch.rect;
  const y = patch.plane;
  const w = x1 - x0;
  const d = z1 - z0;
  if (w < 0.4 || d < 0.4) return;

  const midX = (x0 + x1) * 0.5;
  const midZ = (z0 + z1) * 0.5;

  const northSpans = computeExposedRoofEdgeSpans('n', x0, x1, z0, z1, y, allBoxes);
  const southSpans = computeExposedRoofEdgeSpans('s', x0, x1, z0, z1, y, allBoxes);
  const westSpans = computeExposedRoofEdgeSpans('w', x0, x1, z0, z1, y, allBoxes);
  const eastSpans = computeExposedRoofEdgeSpans('e', x0, x1, z0, z1, y, allBoxes);

  // Check if any exterior point (px, pz) has roof mass at y - 0.15
  const hasRoofAt = (px: number, pz: number) => pointInsideAnyBox(allBoxes, px, y - 0.15, pz, 0.01);
  const hasTallerAt = (px: number, pz: number) => pointInsideAnyBox(allBoxes, px, y + 0.35, pz, 0.01);

  const isParisMansard = style === 'style-a' && isTopmostRoof && w >= 2.0 && d >= 2.0;

  if (isParisMansard) {
    // === AUTHENTIC PARISIAN SLOPED STANDING-SEAM ZINC MANSARD ROOF (100% L-CORNER MITERED!) ===
    const manH = 0.92;
    const manSet = 0.42;
    const yBase = y + 0.02;
    const yTop = y + manH;
    const capH = 0.09;
    const seamScale = 2.0;

    // Flat upper zinc terrace deck covering the patch cleanly (inset on fully exposed sides)
    const deckX0 = westSpans.length === 1 && westSpans[0][0] <= z0 + 0.1 && westSpans[0][1] >= z1 - 0.1 ? x0 + manSet : x0;
    const deckX1 = eastSpans.length === 1 && eastSpans[0][0] <= z0 + 0.1 && eastSpans[0][1] >= z1 - 0.1 ? x1 - manSet : x1;
    const deckZ0 = northSpans.length === 1 && northSpans[0][0] <= x0 + 0.1 && northSpans[0][1] >= x1 - 0.1 ? z0 + manSet : z0;
    const deckZ1 = southSpans.length === 1 && southSpans[0][0] <= x0 + 0.1 && southSpans[0][1] >= x1 - 0.1 ? z1 - manSet : z1;
    // Also place a slightly recessed base deck under partially-exposed L-corner transitions so zero holes ever appear!
    b.addBox('roof', Math.min(deckX0, x0 + manSet), yTop - 0.08, Math.min(deckZ0, z0 + manSet), Math.max(deckX1, x1 - manSet), yTop, Math.max(deckZ1, z1 - manSet), 2.2);
    b.addBox('roof', x0 + 0.04, y - 0.04, z0 + 0.04, x1 - 0.04, y + 0.03, z1 - 0.04, 2.2);

    // Helper: determines top-edge miter shift (+manSet = convex inset, -manSet = concave valley miter, 0 = flush seam)
    const endShift = (side: 'n' | 's' | 'w' | 'e', pos: number, isStart: boolean): number => {
      const dirT = isStart ? -1 : 1;
      if (side === 's') {
        if (hasRoofAt(pos + dirT * 0.16, z1 + 0.16)) return -manSet; // concave 90° L-valley!
        if (!hasRoofAt(pos + dirT * 0.16, z1 - 0.16)) return manSet; // convex 90° outer corner!
        return 0;
      }
      if (side === 'n') {
        if (hasRoofAt(pos + dirT * 0.16, z0 - 0.16)) return -manSet;
        if (!hasRoofAt(pos + dirT * 0.16, z0 + 0.16)) return manSet;
        return 0;
      }
      if (side === 'e') {
        if (hasRoofAt(x1 + 0.16, pos + dirT * 0.16)) return -manSet;
        if (!hasRoofAt(x1 - 0.16, pos + dirT * 0.16)) return manSet;
        return 0;
      }
      if (hasRoofAt(x0 - 0.16, pos + dirT * 0.16)) return -manSet;
      if (!hasRoofAt(x0 + 0.16, pos + dirT * 0.16)) return manSet;
      return 0;
    };

    const addMansardDormer = (cx: number, cz: number, dir: '+z' | '+x') => {
      const dw = 0.78;
      const dh = 0.78;
      const dy0 = yBase + 0.12;
      const dy1 = dy0 + dh;
      if (dir === '+z') {
        const dz = cz - 0.15;
        b.addBox('mansardZinc', cx - dw * 0.5, dy0, dz - 0.36, cx + dw * 0.5, dy1, dz, 0.8);
        b.addBeveledBox('mansardZinc', cx - dw * 0.58, dy1, dz - 0.38, cx + dw * 0.58, dy1 + 0.12, dz + 0.07, 0.02, 0.8);
        // Sculpted dark interior reveal + slender white casement frame + muntin cross + realistic dark dormer glazing!
        b.addBox('trim', cx - dw * 0.36, dy0 + 0.05, dz - 0.01, cx - dw * 0.30, dy1 - 0.05, dz + 0.032, 0.5);
        b.addBox('trim', cx + dw * 0.30, dy0 + 0.05, dz - 0.01, cx + dw * 0.36, dy1 - 0.05, dz + 0.032, 0.5);
        b.addBox('trim', cx - dw * 0.36, dy0 + 0.05, dz - 0.01, cx + dw * 0.36, dy0 + 0.10, dz + 0.032, 0.5);
        b.addBox('trim', cx - dw * 0.36, dy1 - 0.10, dz - 0.01, cx + dw * 0.36, dy1 - 0.05, dz + 0.032, 0.5);
        b.addBox('trim', cx - 0.014, dy0 + 0.10, dz + 0.01, cx + 0.014, dy1 - 0.10, dz + 0.028, 0.5);
        b.addBox('trim', cx - dw * 0.30, (dy0 + dy1) * 0.5 - 0.012, dz + 0.01, cx + dw * 0.30, (dy0 + dy1) * 0.5 + 0.012, dz + 0.028, 0.5);
        b.addQuad('upperRoomDim', [cx - dw * 0.30, dy0 + 0.10, dz + 0.008], [cx + dw * 0.30, dy0 + 0.10, dz + 0.008], [cx + dw * 0.30, dy1 - 0.10, dz + 0.008], [cx - dw * 0.30, dy1 - 0.10, dz + 0.008], 1, 1);
        b.addQuad('upperGlass', [cx - dw * 0.30, dy0 + 0.10, dz + 0.022], [cx + dw * 0.30, dy0 + 0.10, dz + 0.022], [cx + dw * 0.30, dy1 - 0.10, dz + 0.022], [cx - dw * 0.30, dy1 - 0.10, dz + 0.022], 1, 1);
      } else {
        const dx = cx - 0.15;
        b.addBox('mansardZinc', dx - 0.36, dy0, cz - dw * 0.5, dx, dy1, cz + dw * 0.5, 0.8);
        b.addBeveledBox('mansardZinc', dx - 0.38, dy1, cz - dw * 0.58, dx + 0.07, dy1 + 0.12, cz + dw * 0.58, 0.02, 0.8);
        b.addBox('trim', dx - 0.01, dy0 + 0.05, cz - dw * 0.36, dx + 0.032, dy1 - 0.05, cz - dw * 0.30, 0.5);
        b.addBox('trim', dx - 0.01, dy0 + 0.05, cz + dw * 0.30, dx + 0.032, dy1 - 0.05, cz + dw * 0.36, 0.5);
        b.addBox('trim', dx - 0.01, dy0 + 0.05, cz - dw * 0.36, dx + 0.032, dy0 + 0.10, cz + dw * 0.36, 0.5);
        b.addBox('trim', dx - 0.01, dy1 - 0.10, cz - dw * 0.36, dx + 0.032, dy1 - 0.05, cz + dw * 0.36, 0.5);
        b.addBox('trim', dx + 0.01, dy0 + 0.10, cz - 0.014, dx + 0.028, dy1 - 0.10, cz + 0.014, 0.5);
        b.addBox('trim', dx + 0.01, (dy0 + dy1) * 0.5 - 0.012, cz - dw * 0.30, dx + 0.028, (dy0 + dy1) * 0.5 + 0.012, cz + dw * 0.30, 0.5);
        b.addQuad('upperRoomDim', [dx + 0.008, dy0 + 0.10, cz + dw * 0.30], [dx + 0.008, dy0 + 0.10, cz - dw * 0.30], [dx + 0.008, dy1 - 0.10, cz - dw * 0.30], [dx + 0.008, dy1 - 0.10, cz + dw * 0.30], 1, 1);
        b.addQuad('upperGlass', [dx + 0.022, dy0 + 0.10, cz + dw * 0.30], [dx + 0.022, dy0 + 0.10, cz - dw * 0.30], [dx + 0.022, dy1 - 0.10, cz - dw * 0.30], [dx + 0.022, dy1 - 0.10, cz + dw * 0.30], 1, 1);
      }
    };

    for (const [s0, s1] of southSpans) {
      const t0 = s0 + endShift('s', s0, true);
      const t1 = s1 - endShift('s', s1, false);
      b.addQuadUV('mansardZinc', [s0, yBase, z1], [s1, yBase, z1], [t1, yTop, z1 - manSet], [t0, yTop, z1 - manSet], [s0 / seamScale, 0], [s1 / seamScale, 0], [t1 / seamScale, 0.6], [t0 / seamScale, 0.6]);
      b.addBox('mansardZinc', s0, yBase, z1 - 0.06, s1, yBase + 0.09, z1 + 0.03, 1.2);
      b.addBeveledBox('mansardZinc', Math.min(t0, t1), yTop, z1 - manSet - 0.08, Math.max(t0, t1), yTop + capH, z1 - manSet + 0.04, 0.015, 1.0);
      if (s1 - s0 >= 3.0) {
        const dCount = Math.max(1, Math.min(3, Math.floor((s1 - s0 - 1.0) / 2.6)));
        for (let di = 0; di < dCount; di++) {
          const dx = s0 + 0.95 + ((s1 - s0 - 1.9) * (di + 0.5)) / dCount;
          addMansardDormer(dx, z1, '+z');
        }
      }
    }
    for (const [s0, s1] of northSpans) {
      const t0 = s0 + endShift('n', s0, true);
      const t1 = s1 - endShift('n', s1, false);
      b.addQuadUV('mansardZinc', [s1, yBase, z0], [s0, yBase, z0], [t0, yTop, z0 + manSet], [t1, yTop, z0 + manSet], [s1 / seamScale, 0], [s0 / seamScale, 0], [t0 / seamScale, 0.6], [t1 / seamScale, 0.6]);
      b.addBox('mansardZinc', s0, yBase, z0 - 0.03, s1, yBase + 0.09, z0 + 0.06, 1.2);
      b.addBeveledBox('mansardZinc', Math.min(t0, t1), yTop, z0 + manSet - 0.04, Math.max(t0, t1), yTop + capH, z0 + manSet + 0.08, 0.015, 1.0);
    }
    for (const [s0, s1] of eastSpans) {
      const t0 = s0 + endShift('e', s0, true);
      const t1 = s1 - endShift('e', s1, false);
      b.addQuadUV('mansardZinc', [x1, yBase, s1], [x1, yBase, s0], [x1 - manSet, yTop, t0], [x1 - manSet, yTop, t1], [s1 / seamScale, 0], [s0 / seamScale, 0], [t0 / seamScale, 0.6], [t1 / seamScale, 0.6]);
      b.addBox('mansardZinc', x1 - 0.06, yBase, s0, x1 + 0.03, yBase + 0.09, s1, 1.2);
      b.addBeveledBox('mansardZinc', x1 - manSet - 0.08, yTop, Math.min(t0, t1), x1 - manSet + 0.04, yTop + capH, Math.max(t0, t1), 0.015, 1.0);
      if (s1 - s0 >= 3.0) {
        const dCount = Math.max(1, Math.min(2, Math.floor((s1 - s0 - 1.0) / 2.8)));
        for (let di = 0; di < dCount; di++) {
          const dz = s0 + 0.95 + ((s1 - s0 - 1.9) * (di + 0.5)) / dCount;
          addMansardDormer(x1, dz, '+x');
        }
      }
    }
    for (const [s0, s1] of westSpans) {
      const t0 = s0 + endShift('w', s0, true);
      const t1 = s1 - endShift('w', s1, false);
      b.addQuadUV('mansardZinc', [x0, yBase, s0], [x0, yBase, s1], [x0 + manSet, yTop, t1], [x0 + manSet, yTop, t0], [s0 / seamScale, 0], [s1 / seamScale, 0], [t1 / seamScale, 0.6], [t0 / seamScale, 0.6]);
      b.addBox('mansardZinc', x0 - 0.03, yBase, s0, x0 + 0.06, yBase + 0.09, s1, 1.2);
      b.addBeveledBox('mansardZinc', x0 + manSet - 0.04, yTop, Math.min(t0, t1), x0 + manSet + 0.08, yTop + capH, Math.max(t0, t1), 0.015, 1.0);
    }

    // Hero Parisian masonry chimney stack + terracotta mitrons ONLY on primary roof!
    if (isPrimaryRoof && w >= 2.6 && d >= 2.4) {
      const chX = x0 + manSet + Math.min(1.15, (w - manSet * 2) * 0.28);
      const chZ = z0 + manSet + Math.min(0.95, (d - manSet * 2) * 0.28);
      b.addBox('upperWall', chX - 0.52, yTop - 0.05, chZ - 0.28, chX + 0.52, yTop + 0.96, chZ + 0.28, 1.4);
      b.addBeveledBox('cornice', chX - 0.58, yTop + 0.96, chZ - 0.34, chX + 0.58, yTop + 1.07, chZ + 0.34, 0.016, 1.0);
      for (const dx of [-0.28, 0, 0.28]) {
        b.addCylinder('planterPot', chX + dx, yTop + 1.07, yTop + 1.38, chZ, 0.088, 0.070, 10);
        b.addCylinder('iron', chX + dx, yTop + 1.38, yTop + 1.43, chZ, 0.10, 0.085, 10);
      }
    }
    return;
  }

  // === STANDARD PARAPET ROOF (SoHo, Tokyo, and lower setback terraces!) ===
  b.addBox('roof', x0 + 0.04, y - 0.04, z0 + 0.04, x1 - 0.04, y + 0.025, z1 - 0.04, 2.2);

  const paraH = style === 'style-c' ? 0.38 : 0.54;
  const paraT = 0.24;
  const wallMat: ShopMatKey = 'upperWall';
  const copMat: ShopMatKey = style === 'style-c' ? 'iron' : 'cornice';

  for (const [s0, s1] of southSpans) {
    const a0 = hasTallerAt(s0 - 0.14, z1 - 0.14) ? s0 + 0.01 : s0;
    const a1 = hasTallerAt(s1 + 0.14, z1 - 0.14) ? s1 - 0.01 : s1;
    if (a1 <= a0 + 0.08) continue;
    b.addBox(wallMat, a0, y, z1 - paraT, a1, y + paraH, z1, 1.8);
    b.addBeveledBox(copMat, a0 - 0.02, y + paraH, z1 - paraT - 0.03, a1 + 0.02, y + paraH + 0.08, z1 + 0.04, 0.015, 1.2);
  }
  for (const [s0, s1] of northSpans) {
    const a0 = hasTallerAt(s0 - 0.14, z0 + 0.14) ? s0 + 0.01 : s0;
    const a1 = hasTallerAt(s1 + 0.14, z0 + 0.14) ? s1 - 0.01 : s1;
    if (a1 <= a0 + 0.08) continue;
    b.addBox(wallMat, a0, y, z0, a1, y + paraH, z0 + paraT, 1.8);
    b.addBeveledBox(copMat, a0 - 0.02, y + paraH, z0 - 0.04, a1 + 0.02, y + paraH + 0.08, z0 + paraT + 0.03, 0.015, 1.2);
  }
  for (const [s0, s1] of westSpans) {
    const zIn0 = northSpans.some(([a, b2]) => x0 >= a - 0.05 && x0 <= b2 + 0.05) && Math.abs(s0 - z0) < 0.05 ? s0 + paraT + 0.004 : s0 + (hasTallerAt(x0 + 0.14, s0 - 0.14) ? 0.01 : 0);
    const zIn1 = southSpans.some(([a, b2]) => x0 >= a - 0.05 && x0 <= b2 + 0.05) && Math.abs(s1 - z1) < 0.05 ? s1 - paraT - 0.004 : s1 - (hasTallerAt(x0 + 0.14, s1 + 0.14) ? 0.01 : 0);
    if (zIn1 <= zIn0 + 0.08) continue;
    b.addBox(wallMat, x0, y, zIn0, x0 + paraT, y + paraH, zIn1, 1.8);
    b.addBeveledBox(copMat, x0 - 0.04, y + paraH, zIn0 - 0.006, x0 + paraT + 0.03, y + paraH + 0.08, zIn1 + 0.006, 0.015, 1.2);
  }
  for (const [s0, s1] of eastSpans) {
    const zIn0 = northSpans.some(([a, b2]) => x1 >= a - 0.05 && x1 <= b2 + 0.05) && Math.abs(s0 - z0) < 0.05 ? s0 + paraT + 0.004 : s0 + (hasTallerAt(x1 - 0.14, s0 - 0.14) ? 0.01 : 0);
    const zIn1 = southSpans.some(([a, b2]) => x1 >= a - 0.05 && x1 <= b2 + 0.05) && Math.abs(s1 - z1) < 0.05 ? s1 - paraT - 0.004 : s1 - (hasTallerAt(x1 - 0.14, s1 + 0.14) ? 0.01 : 0);
    if (zIn1 <= zIn0 + 0.08) continue;
    b.addBox(wallMat, x1 - paraT, y, zIn0, x1, y + paraH, zIn1, 1.8);
    b.addBeveledBox(copMat, x1 - paraT - 0.03, y + paraH, zIn0 - 0.006, x1 + 0.04, y + paraH + 0.08, zIn1 + 0.006, 0.015, 1.2);
  }

  // Non-cloned rooftop architecture: ONLY primary roof gets hero skylight & chimney/flue!
  if (isPrimaryRoof && w >= 2.8 && d >= 2.6) {
    const skW = Math.min(w - 2.0, 2.8);
    const skD = Math.min(d - 2.0, 1.8);
    if (skW >= 1.1 && skD >= 0.9) {
      b.addBox('cornice', midX - skW * 0.5, y + 0.025, midZ - skD * 0.5, midX + skW * 0.5, y + 0.30, midZ + skD * 0.5, 1.0);
      b.addBox('iron', midX - skW * 0.5 - 0.03, y + 0.30, midZ - skD * 0.5 - 0.03, midX + skW * 0.5 + 0.03, y + 0.38, midZ + skD * 0.5 + 0.03, 0.8);
      b.addBox('upperGlass', midX - skW * 0.46, y + 0.38, midZ - skD * 0.46, midX + skW * 0.46, y + 0.44, midZ + skD * 0.46, 1.0);
      const ribs = Math.max(2, Math.round(skW / 0.72));
      for (let r = 1; r < ribs; r++) {
        const rx = midX - skW * 0.46 + (skW * 0.92 * r) / ribs;
        b.addBox('iron', rx - 0.02, y + 0.38, midZ - skD * 0.48, rx + 0.02, y + 0.46, midZ + skD * 0.48, 0.5);
      }
    }

    const chX = x0 + Math.min(1.2, w * 0.25);
    const chZ = z0 + Math.min(1.1, d * 0.25);
    if (style === 'style-c') {
      b.addBox('cornice', chX - 0.30, y + 0.025, chZ - 0.30, chX + 0.30, y + 0.52, chZ + 0.30, 0.8);
      b.addCylinder('steel', chX, y + 0.52, y + 1.68, chZ, 0.13, 0.12, 14);
      b.addCylinder('iron', chX, y + 1.68, y + 1.80, chZ, 0.21, 0.05, 14);
      const scX = x1 - 1.1;
      const scZ = z0 + 1.0;
      if (w >= 4.2 && d >= 3.8) {
        for (let sl = 0; sl < 6; sl++) {
          b.addBox('shopfront', scX - 0.55 + sl * 0.20, y + 0.03, scZ - 0.38, scX - 0.49 + sl * 0.20, y + 0.92, scZ + 0.38, 0.8);
        }
      }
    } else {
      b.addBox('upperWall', chX - 0.50, y + 0.025, chZ - 0.28, chX + 0.50, y + 1.15, chZ + 0.28, 1.3);
      b.addBeveledBox('cornice', chX - 0.56, y + 1.15, chZ - 0.34, chX + 0.56, y + 1.26, chZ + 0.34, 0.016, 1.0);
      for (const dx of [-0.26, 0, 0.26]) {
        b.addCylinder('planterPot', chX + dx, y + 1.26, y + 1.56, chZ, 0.088, 0.072, 10);
        b.addCylinder('iron', chX + dx, y + 1.56, y + 1.62, chZ, 0.10, 0.085, 10);
      }
    }
  } else if (!isPrimaryRoof && w >= 2.2 && d >= 2.0 && style !== 'style-a') {
    b.addBox('iron', midX - 0.32, y + 0.025, midZ - 0.28, midX + 0.32, y + 0.32, midZ + 0.28, 0.8);
    b.addBeveledBox('steel', midX - 0.36, y + 0.32, midZ - 0.32, midX + 0.36, y + 0.39, midZ + 0.32, 0.014, 0.8);
  }
}

/**
 * Builds underside soffits on cantilevered overhangs (e.g., Corner Bistro covered arcade!)
 * plus grounded fluted cast-iron colonnade columns with stone plinths & capitals.
 */
function buildSoffitPatch(
  b: MaterialGeometryBatcher<ShopMatKey>,
  patch: MergedExteriorPatch,
  allBoxes: MassingBox[],
  arcadeColumns: [number, number][]
): void {
  const { u0: x0, u1: x1, v0: z0, v1: z1 } = patch.rect;
  const y = patch.plane;
  if (y < 0.3) return;
  const w = x1 - x0;
  const d = z1 - z0;
  if (w < 0.25 || d < 0.25) return;

  // Coffered plaster underside soffit + perimeter arcade fascia beam
  b.addBox('cornice', x0 + 0.02, y - 0.04, z0 + 0.02, x1 - 0.02, y + 0.02, z1 - 0.02, 1.4);
  b.addBox('cornice', x0 + 0.04, y - 0.11, z0 + 0.04, x1 - 0.04, y - 0.04, z0 + 0.16, 1.2);
  b.addBox('cornice', x0 + 0.04, y - 0.11, z1 - 0.16, x1 - 0.04, y - 0.04, z1 - 0.04, 1.2);
  b.addBox('cornice', x0 + 0.04, y - 0.11, z0 + 0.16, x0 + 0.16, y - 0.04, z1 - 0.16, 1.2);
  b.addBox('cornice', x1 - 0.16, y - 0.11, z0 + 0.16, x1 - 0.04, y - 0.04, z1 - 0.16, 1.2);

  // Warm recessed soffit downlights
  const nx = Math.max(1, Math.floor(w / 2.2));
  const nz = Math.max(1, Math.floor(d / 2.2));
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      const lx = x0 + ((ix + 0.5) * w) / nx;
      const lz = z0 + ((iz + 0.5) * d) / nz;
      b.addCylinder('brass', lx, y - 0.055, y - 0.035, lz, 0.09, 0.09, 12);
      b.addCylinder('warmGlow', lx, y - 0.062, y - 0.045, lz, 0.072, 0.072, 12);
    }
  }

  // Grounding classical cast-iron colonnade columns under outer corners of overhangs (zero floating feel!)
  if (y >= 2.2 && y <= GROUND_STORY_H + 0.6 && (w >= 0.85 || d >= 0.85)) {
    const corners: [number, number][] = [
      [x0 + 0.24, z0 + 0.24],
      [x1 - 0.24, z0 + 0.24],
      [x0 + 0.24, z1 - 0.24],
      [x1 - 0.24, z1 - 0.24],
    ];
    for (const [cx, cz] of corners) {
      if (!pointNearAnyGroundBox(allBoxes, cx, cz, 0.42)) {
        // Molded stone base pedestal + fluted dark cast-iron column + brass collar + abacus capital
        b.addBeveledBox('cornice', cx - 0.18, -0.004, cz - 0.18, cx + 0.18, 0.34, cz + 0.18, 0.015, 0.8);
        b.addCylinder('iron', cx, 0.34, 0.48, cz, 0.145, 0.115, 12);
        b.addCylinder('iron', cx, 0.48, y - 0.24, cz, 0.102, 0.088, 14);
        b.addCylinder('brass', cx, y - 0.28, y - 0.22, cz, 0.115, 0.115, 12);
        b.addCylinder('iron', cx, y - 0.22, y - 0.13, cz, 0.105, 0.145, 12);
        b.addBeveledBox('cornice', cx - 0.18, y - 0.13, cz - 0.18, cx + 0.18, y - 0.03, cz + 0.18, 0.014, 0.8);
        arcadeColumns.push([cx, cz]);
      }
    }
  }
}

/**
 * Generates the complete, 100% dynamic VolumeCraft Shopfront PBR scene from any MassingState.
 */
export function generateShopfrontScene(
  state: MassingState,
  style: StyleKey,
  lighting: LightingKey,
  showTerrace: boolean,
  showAwnings: boolean,
  materials: ShopfrontMaterials
): ShopfrontBuildResult {
  const batcher = new MaterialGeometryBatcher<ShopMatKey>();
  const foliage = new BotanicalFoliageBatcher();
  const dynamicLights: DynamicShopLight[] = [];

  const bounds = computeStateBounds(state);
  const patches = computeMergedExteriorPatches(state);

  const roofPatches: MergedExteriorPatch[] = [];
  const verticalPatches: VerticalPatch[] = [];
  const arcadeColumns: [number, number][] = [];

  for (const p of patches) {
    if (p.dir === '+y') {
      roofPatches.push(p);
    } else if (p.dir === '-y') {
      buildSoffitPatch(batcher, p, state.boxes, arcadeColumns);
    } else {
      verticalPatches.push({
        dir: p.dir,
        plane: p.plane,
        u0: p.rect.u0,
        u1: p.rect.u1,
        v0: p.rect.v0,
        v1: p.rect.v1,
      });
    }
  }

  // Sort roof patches so ONLY ONE primary roof gets the hero chimney/skylight centerpiece (no cloned chimneys!)
  const maxRoofY = roofPatches.reduce((acc, r) => Math.max(acc, r.plane), 0);
  const sortedRoofs = [...roofPatches].sort((a, b) => {
    const topDiff = (Math.abs(b.plane - maxRoofY) < 0.2 ? 1 : 0) - (Math.abs(a.plane - maxRoofY) < 0.2 ? 1 : 0);
    if (topDiff !== 0) return topDiff;
    const areaA = (a.rect.u1 - a.rect.u0) * (a.rect.v1 - a.rect.v0);
    const areaB = (b.rect.u1 - b.rect.u0) * (b.rect.v1 - b.rect.v0);
    return areaB - areaA;
  });
  sortedRoofs.forEach((rp, idx) => {
    const isTopmost = Math.abs(rp.plane - maxRoofY) < 0.25;
    buildRoofPatch(batcher, rp, state.boxes, style, idx === 0, isTopmost);
  });

  // Pick prominent ground facades for fascia signage & projecting corner blade signs
  const groundPatches = verticalPatches.filter((vp) => vp.v0 < 0.15 && vp.v1 >= 2.2);
  let bestFrontPatch: VerticalPatch | null = null;
  let bestSidePatch: VerticalPatch | null = null;
  for (const gp of groundPatches) {
    const gw = gp.u1 - gp.u0;
    if (gp.dir === '+z' && (!bestFrontPatch || gw > bestFrontPatch.u1 - bestFrontPatch.u0)) {
      bestFrontPatch = gp;
    }
    if (gp.dir === '+x' && (!bestSidePatch || gw > bestSidePatch.u1 - bestSidePatch.u0)) {
      bestSidePatch = gp;
    }
  }

  const entrances: EntranceSpot[] = [];
  let vitrineCount = 0;
  let placedBladeSignCount = 0;

  for (const vp of verticalPatches) {
    const frame = new FacadeFrame(vp.dir, vp.plane, vp.u0, vp.u1);

    // Split vertically into Ground Storefront (0 .. GROUND_STORY_H) and Upper Stories (GROUND_STORY_H .. v1)
    if (vp.v0 < 0.15 && vp.v1 >= 2.2) {
      const shopTop = Math.min(vp.v1, GROUND_STORY_H);
      const allowSign =
        vp === bestFrontPatch ||
        vp === bestSidePatch ||
        (vp.dir === '+z' && vp.u1 - vp.u0 >= 4.2);
      vitrineCount += buildGroundStorefront(
        batcher,
        frame,
        vp.v0,
        shopTop,
        style,
        showAwnings,
        state.boxes,
        entrances,
        allowSign
      );

      // Projecting backlit blade sign STRICTLY on a TRUE CONVEX outer corner pier clear of overhead cantilevers & awnings!
      if (showAwnings && placedBladeSignCount < 2 && (vp === bestFrontPatch || vp === bestSidePatch) && frame.width >= 2.5) {
        const ySign = shopTop - 0.54; // Centered cleanly in frieze pier clear of cornice above & awning below!
        const rEnd = classifyFacadeEnd(frame, 'right', shopTop * 0.5, state.boxes);
        const lEnd = classifyFacadeEnd(frame, 'left', shopTop * 0.5, state.boxes);
        const rightClear = rEnd === 'convex' && !hasOverheadCantilever(frame, frame.width - 0.6, frame.width, shopTop, state.boxes);
        const leftClear = lEnd === 'convex' && !hasOverheadCantilever(frame, 0, 0.6, shopTop, state.boxes);

        if (rightClear && vp === bestFrontPatch) {
          addProjectingBladeSign(batcher, frame, frame.width - 0.20, ySign, style);
          placedBladeSignCount++;
        } else if (leftClear && vp === bestFrontPatch) {
          addProjectingBladeSign(batcher, frame, 0.20, ySign, style);
          placedBladeSignCount++;
        } else if (rightClear && vp === bestSidePatch && frame.width >= 5.0 && placedBladeSignCount < 2) {
          addProjectingBladeSign(batcher, frame, frame.width - 0.24, ySign, style);
          placedBladeSignCount++;
        }
      }

      if (vp.v1 > shopTop + 0.15) {
        buildUpperFacade(batcher, foliage, frame, shopTop, vp.v1, style, state.boxes);
      }
    } else {
      buildUpperFacade(batcher, foliage, frame, vp.v0, vp.v1, style, state.boxes);
    }
  }

  // Real 3D illuminated ground café interior inside EVERY ground-level massing box
  let tableCount = 0;
  for (const bx of state.boxes) {
    tableCount += buildGroundInterior(batcher, bx, state.boxes, style, dynamicLights);
  }

  // === URBAN FRAMING: CRISP LIMESTONE SIDEWALK + PALE ARCHITECTURAL MODEL STREET + CROSSWALKS ===
  const padFront = 4.2;
  const padRight = 3.6;
  const padLeft = 3.2;
  const padBack = 2.2;
  const swMinX = bounds.minX - padLeft;
  const swMaxX = bounds.maxX + padRight;
  const swMinZ = bounds.minZ - padBack;
  const swMaxZ = bounds.maxZ + padFront;

  // Human-scaled limestone sidewalk platform (uvScale 1.15 -> realistic architectural flagstone scale!)
  batcher.addBox('sidewalk', swMinX, -0.14, swMinZ, swMaxX, -0.004, swMaxZ, 1.15);

  // Raised granite street curbs framing the sidewalk block cleanly
  const curbW = 0.22;
  batcher.addBeveledBox('curb', swMinX - curbW, -0.15, swMaxZ, swMaxX + curbW, 0.012, swMaxZ + curbW, 0.018, 1.2);
  batcher.addBeveledBox('curb', swMinX - curbW, -0.15, swMinZ - curbW, swMaxX + curbW, 0.012, swMinZ, 0.018, 1.2);
  batcher.addBeveledBox('curb', swMaxX, -0.15, swMinZ, swMaxX + curbW, 0.012, swMaxZ, 0.018, 1.2);
  batcher.addBeveledBox('curb', swMinX - curbW, -0.15, swMinZ, swMinX, 0.012, swMaxZ, 0.018, 1.2);

  // Clean compact architectural model street plinth framing the sidewalk & crosswalks on pure white backdrop
  const stMinX = swMinX - 1.4;
  const stMaxX = swMaxX + 4.8;
  const stMinZ = swMinZ - 1.4;
  const stMaxZ = swMaxZ + 5.6;
  batcher.addBeveledBox('street', stMinX, -0.28, stMinZ, stMaxX, -0.145, stMaxZ, 0.025, 5.0);

  // Crisp white pedestrian crosswalk stripes along front boulevard & east cross-street (+0.008m above street!)
  const cwY0 = -0.144;
  const cwY1 = -0.135;
  const frontCwZ0 = swMaxZ + 0.95;
  const frontCwZ1 = swMaxZ + 3.55;
  for (let i = 0; i < 6; i++) {
    const sx = swMaxX - 3.6 + i * 0.68;
    batcher.addBox('crosswalk', sx, cwY0, frontCwZ0, sx + 0.36, cwY1, frontCwZ1, 1.0);
  }
  const eastCwX0 = swMaxX + 0.95;
  const eastCwX1 = swMaxX + 3.55;
  for (let i = 0; i < 6; i++) {
    const sz = swMaxZ - 3.6 + i * 0.68;
    batcher.addBox('crosswalk', eastCwX0, cwY0, sz, eastCwX1, cwY1, sz + 0.36, 1.0);
  }

  // Subtle dashed boulevard center-line dashes along front street (clipped cleanly within the street plinth)
  const roadMidZ = swMaxZ + 4.75;
  for (let x = stMinX + 0.9; x + 2.0 <= stMaxX - 0.9; x += 4.0) {
    batcher.addBox('crosswalk', x, cwY0, roadMidZ - 0.07, x + 2.0, cwY1, roadMidZ + 0.07, 1.0);
  }

  // === SIDEWALK TERRACE (TOGGLE A): BISTRO TABLES, CHALKBOARD MENU, POTTED LAURELS & STREETLAMPS ===
  if (showTerrace) {
    const placed: PlacedCircle[] = [];
    const foliagePalette: FoliagePaletteKind =
      style === 'style-a' ? 'olive' : style === 'style-b' ? 'emerald' : 'fern';

    const reserve = (x: number, z: number, r: number) => placed.push({ x, z, r });

    // Reserve all cantilevered arcade columns so bistro tables/planters NEVER collide with columns!
    for (const [acx, acz] of arcadeColumns) {
      reserve(acx, acz, 0.52);
    }

    const canPlace = (x: number, z: number, r: number, wallClear = 0.72): boolean => {
      if (x < swMinX + r + 0.25 || x > swMaxX - r - 0.25) return false;
      if (z < swMinZ + r + 0.25 || z > swMaxZ - r - 0.25) return false;
      if (pointNearAnyGroundBox(state.boxes, x, z, wallClear)) return false;
      for (const p of placed) {
        if (Math.hypot(x - p.x, z - p.z) < r + p.r) return false;
      }
      return true;
    };

    // Reserve entrance walk corridors & flank each main street entrance with potted bay laurels + A-frame menu
    let placedChalkboard = false;
    for (let eIdx = 0; eIdx < entrances.length; eIdx++) {
      const ent = entrances[eIdx];
      reserve(ent.x + ent.ox * 1.15, ent.z + ent.oz * 1.15, 0.92);

      for (const side of [-1, 1]) {
        const px = ent.x + ent.ox * 0.42 + ent.rx * side * 1.08;
        const pz = ent.z + ent.oz * 0.42 + ent.rz * side * 1.08;
        if (canPlace(px, pz, 0.34, 0.28)) {
          addPottedLaurel(batcher, foliage, px, -0.004, pz, 301 + eIdx * 53 + side * 19, foliagePalette);
          reserve(px, pz, 0.44);
        }
      }

      if (!placedChalkboard && (ent.oz > 0.5 || ent.ox > 0.5)) {
        const cx = ent.x + ent.ox * 1.55 + ent.rx * 1.25;
        const cz = ent.z + ent.oz * 1.55 + ent.rz * 1.25;
        if (canPlace(cx, cz, 0.45, 0.55)) {
          const yaw = Math.atan2(ent.ox, ent.oz) - 0.38;
          addChalkboardEasel(batcher, cx, -0.004, cz, yaw);
          reserve(cx, cz, 0.58);
          placedChalkboard = true;
        }
      }
    }

    // Style-authentic boulevard streetlamps along front & east sidewalk curb corners
    const lampSpots: [number, number][] = [
      [swMaxX - 0.65, swMaxZ - 0.65],
      [swMinX + 0.75, swMaxZ - 0.65],
      [swMaxX - 0.65, swMinZ + 0.95],
    ];
    for (const [lx, lz] of lampSpots) {
      if (canPlace(lx, lz, 0.35, 0.85)) {
        addVintageStreetlamp(batcher, lx, -0.004, lz, style, dynamicLights);
        reserve(lx, lz, 0.52);
      }
    }

    // Graceful boulevard olive tree framing the far-left sidewalk corner (never blocking camera view!)
    const treeX = swMinX + 1.15;
    const treeZ = swMaxZ - 1.35;
    if (canPlace(treeX, treeZ, 0.65, 1.05)) {
      batcher.addBeveledBox('curb', treeX - 0.52, -0.01, treeZ - 0.52, treeX + 0.52, 0.14, treeZ + 0.52, 0.02, 1.0);
      batcher.addBox('soil', treeX - 0.44, 0.02, treeZ - 0.44, treeX + 0.44, 0.12, treeZ + 0.44, 0.6);
      foliage.addArchitecturalTree(treeX, 0.08, treeZ, 0.68, 709, foliagePalette);
      reserve(treeX, treeZ, 0.95);
    }

    // Dynamically distribute round marble bistro tables along ALL street-facing (+z, +x) ground storefronts!
    const streetGroundPatches = groundPatches.filter((gp) => gp.dir === '+z' || gp.dir === '+x');
    for (const gp of streetGroundPatches) {
      const frame = new FacadeFrame(gp.dir, gp.plane, gp.u0, gp.u1);
      const tSpan = frame.width - 1.0;
      if (tSpan < 0.8) continue;
      const count = Math.max(1, Math.floor(frame.width / 2.45));
      for (let i = 0; i < count; i++) {
        const sPos = 0.85 + ((frame.width - 1.7) * (i + 0.5)) / count;
        const tPt = frame.pt(sPos, -0.004, 1.62);
        if (canPlace(tPt[0], tPt[2], 0.92, 1.05)) {
          const facing = frame.dir === '+z' ? 0.08 * (i % 2 === 0 ? 1 : -1) : Math.PI * 0.5 + 0.08;
          addBistroTableSet(batcher, tPt[0], -0.004, tPt[2], facing, style, true);
          reserve(tPt[0], tPt[2], 1.02);
          tableCount++;
        }
      }
    }

    // Corner potted laurel planters framing terrace boundary neatly
    const cornerPotX = swMaxX - 1.75;
    const cornerPotZ = swMaxZ - 0.72;
    if (canPlace(cornerPotX, cornerPotZ, 0.36, 0.6)) {
      addPottedLaurel(batcher, foliage, cornerPotX, -0.004, cornerPotZ, 881, foliagePalette);
      reserve(cornerPotX, cornerPotZ, 0.48);
    }
  }

  // Build final merged GPU meshes with calibrated shadow & transparency flags
  const styleMats = materials.getStyleSet(style);
  const group = batcher.buildMeshes(styleMats, {
    transparentKeys: ['vitrineGlass', 'upperGlass'],
    nonShadowKeys: ['street', 'crosswalk', 'warmGlow', 'lampGlobe', 'upperRoomWarm', 'upperRoomDim', 'curtain'],
  });

  const foliageGroup = foliage.buildGroup(materials.barkMat, materials.foliageMat);
  group.add(foliageGroup);

  for (const dl of dynamicLights) {
    group.add(dl.light);
  }

  const stories = Math.max(1, 1 + Math.round(Math.max(0, bounds.maxY - GROUND_STORY_H) / UPPER_STORY_H));
  const sceneBounds = new THREE.Box3(
    new THREE.Vector3(swMinX, -0.15, swMinZ),
    new THREE.Vector3(swMaxX, bounds.maxY + 1.5, swMaxZ)
  );

  void lighting;
  return {
    group,
    bounds: sceneBounds,
    dynamicLights,
    stats: {
      stories,
      vitrines: Math.max(1, vitrineCount),
      tables: Math.max(1, tableCount),
    },
  };
}
