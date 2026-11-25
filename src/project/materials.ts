import * as THREE from 'three/webgpu';
import { LightingKey, StyleKey } from '../core/types';
import {
  ACGTextureManager,
  createCanvasTexture,
  createFresnelGlass,
  TextureLoadProgress,
} from '../building/pbrHelpers';
import { createBotanicalLeafSprigTextures, FoliageTextureMaps } from '../building/geometryBatcher';

export type ShopMatKey =
  | 'upperWall'
  | 'shopfront'
  | 'trim'
  | 'cornice'
  | 'accentWood'
  | 'brass'
  | 'iron'
  | 'steel'
  | 'roof'
  | 'sidewalk'
  | 'curb'
  | 'street'
  | 'crosswalk'
  | 'vitrineGlass'
  | 'upperGlass'
  | 'awning'
  | 'fasciaSign'
  | 'bladeSign'
  | 'chalkboard'
  | 'interiorFloor'
  | 'interiorWall'
  | 'interiorCeiling'
  | 'counterTop'
  | 'counterWood'
  | 'chairAccent'
  | 'rattan'
  | 'planterPot'
  | 'soil'
  | 'pastryGold'
  | 'porcelain'
  | 'bottleAmber'
  | 'bottleGreen'
  | 'warmGlow'
  | 'lampGlobe'
  | 'upperRoomWarm'
  | 'upperRoomDim'
  | 'mansardZinc'
  | 'curtain'
  | 'noren'
  | 'flowerRed';

function createParisianLimestoneTextures(): {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const size = 512;
  const rows = 8; // 8 ashlar courses per tile (~0.36m tall dressed Lutetian stone courses)
  const cols = 4; // staggered running bond blocks
  const rowH = size / rows;
  const colW = size / cols;

  let seed = 314159;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const colCanvas = document.createElement('canvas');
  colCanvas.width = size; colCanvas.height = size;
  const cCtx = colCanvas.getContext('2d')!;

  const normCanvas = document.createElement('canvas');
  normCanvas.width = size; normCanvas.height = size;
  const nCtx = normCanvas.getContext('2d')!;

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = size; roughCanvas.height = size;
  const rCtx = roughCanvas.getContext('2d')!;

  const cImg = cCtx.createImageData(size, size);
  const nImg = nCtx.createImageData(size, size);
  const rImg = rCtx.createImageData(size, size);

  const blockTone: number[][] = [];
  for (let r = 0; r < rows; r++) {
    blockTone[r] = [];
    for (let c = 0; c < cols; c++) {
      blockTone[r][c] = 0.94 + rand() * 0.11;
    }
  }

  for (let y = 0; y < size; y++) {
    const r = Math.floor(y / rowH) % rows;
    const fy = (y - r * rowH) / rowH;
    const xShift = (r % 2) * (colW * 0.5);

    for (let x = 0; x < size; x++) {
      const sx = (x + xShift) % size;
      const c = Math.floor(sx / colW) % cols;
      const fx = (sx - c * colW) / colW;

      // Subtle architectural dressed-stone bevel & thin lime-mortar joints (refends)
      const hJoint = fy < 0.045 || fy > 0.955;
      const vJoint = fx < 0.018 || fx > 0.982;
      let nx = 0;
      let ny = 0;
      let shade = blockTone[r][c];
      let rough = 0.78;

      if (hJoint) {
        ny = fy < 0.5 ? -0.45 : 0.45;
        shade *= 0.84;
        rough = 0.92;
      } else if (vJoint) {
        nx = fx < 0.5 ? -0.35 : 0.35;
        shade *= 0.89;
        rough = 0.90;
      } else {
        // Gentle soft stone dressing bevel near horizontal rustication
        if (fy < 0.08) ny = -0.18;
        else if (fy > 0.92) ny = 0.18;
      }

      // Fine warm Lutetian limestone mineral grain & subtle rainwater weathering
      const n1 = Math.sin(x * 0.17 + y * 0.11) * Math.cos(x * 0.07 - y * 0.23) * 0.018;
      const grain = (rand() - 0.5) * 0.042 + n1;
      const v = Math.max(0.55, Math.min(1.0, shade + grain));

      // Creamy warm Parisian limestone (#ebe3d4 base)
      const idx = (y * size + x) * 4;
      cImg.data[idx] = Math.round(v * 238);
      cImg.data[idx + 1] = Math.round(v * 228);
      cImg.data[idx + 2] = Math.round(v * 210);
      cImg.data[idx + 3] = 255;

      const gx = nx + (rand() - 0.5) * 0.08;
      const gy = ny + (rand() - 0.5) * 0.08;
      const gz = Math.sqrt(Math.max(0.1, 1 - gx * gx - gy * gy));
      nImg.data[idx] = Math.round((gx * 0.5 + 0.5) * 255);
      nImg.data[idx + 1] = Math.round((gy * 0.5 + 0.5) * 255);
      nImg.data[idx + 2] = Math.round((gz * 0.5 + 0.5) * 255);
      nImg.data[idx + 3] = 255;

      const rv = Math.round(Math.max(120, Math.min(250, (rough + grain * 0.8) * 255)));
      rImg.data[idx] = rv; rImg.data[idx + 1] = rv; rImg.data[idx + 2] = rv; rImg.data[idx + 3] = 255;
    }
  }

  cCtx.putImageData(cImg, 0, 0);
  nCtx.putImageData(nImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);

  const mk = (canvas: HTMLCanvasElement, srgb: boolean) => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  };
  return { map: mk(colCanvas, true), normalMap: mk(normCanvas, false), roughnessMap: mk(roughCanvas, false) };
}

function createStandingSeamZincTextures(): {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const size = 512;
  const seams = 8;
  const seamW = size / seams;
  let seed = 88217;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const colCanvas = document.createElement('canvas');
  colCanvas.width = size; colCanvas.height = size;
  const cCtx = colCanvas.getContext('2d')!;
  const normCanvas = document.createElement('canvas');
  normCanvas.width = size; normCanvas.height = size;
  const nCtx = normCanvas.getContext('2d')!;
  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = size; roughCanvas.height = size;
  const rCtx = roughCanvas.getContext('2d')!;

  const cImg = cCtx.createImageData(size, size);
  const nImg = nCtx.createImageData(size, size);
  const rImg = rCtx.createImageData(size, size);

  const panelTone: number[] = [];
  for (let i = 0; i < seams; i++) panelTone.push(0.90 + rand() * 0.18);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = Math.floor(x / seamW) % seams;
      const fx = (x - s * seamW) / seamW;

      let nx = 0;
      let shade = panelTone[s];
      let rough = 0.46;

      if (fx < 0.08) {
        // Raised standing seam ridge
        const t = (fx / 0.08) * 2 - 1;
        nx = t * 0.78;
        shade *= 0.82 + (1 - Math.abs(t)) * 0.34;
        rough = 0.36;
      } else if (fx < 0.13 || fx > 0.96) {
        // Crisp standing-seam shadow recess
        shade *= 0.76;
        rough = 0.62;
      }

      const patina = Math.sin(x * 0.09 + y * 0.04) * 0.03 + (rand() - 0.5) * 0.035;
      const lum = Math.max(0.25, Math.min(0.95, shade + patina));
      const idx = (y * size + x) * 4;
      // Classic Parisian weathered blue-grey zinc (zinc prépatiné)
      cImg.data[idx] = Math.round(lum * 106);
      cImg.data[idx + 1] = Math.round(lum * 116);
      cImg.data[idx + 2] = Math.round(lum * 128);
      cImg.data[idx + 3] = 255;

      const nz = Math.sqrt(Math.max(0.08, 1 - nx * nx));
      nImg.data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      nImg.data[idx + 1] = 128;
      nImg.data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      nImg.data[idx + 3] = 255;

      const rv = Math.round(Math.max(60, Math.min(220, (rough + patina) * 255)));
      rImg.data[idx] = rv; rImg.data[idx + 1] = rv; rImg.data[idx + 2] = rv; rImg.data[idx + 3] = 255;
    }
  }
  cCtx.putImageData(cImg, 0, 0);
  nCtx.putImageData(nImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);

  const mk = (canvas: HTMLCanvasElement, srgb: boolean) => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  };
  return { map: mk(colCanvas, true), normalMap: mk(normCanvas, false), roughnessMap: mk(roughCanvas, false) };
}

function drawNorenCanvas(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // Deep Kyoto/Tokyo indigo-dyed aizome linen noren curtain
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#1e3250');
  g.addColorStop(1, '#16263f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Woven linen thread micro-texture
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
  for (let x = 0; x < w; x += 6) ctx.fillRect(x, 0, 1, h);

  // Traditional white circular kamon crest & kanji
  const cx = w * 0.5;
  const cy = h * 0.52;
  ctx.strokeStyle = '#f2ecdc';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.min(w, h) * 0.27, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#f2ecdc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 58px Georgia, "Yu Mincho", serif';
  ctx.fillText('珈琲', cx, cy + 2);
}

function drawStripedAwningCanvas(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  primaryHex: string,
  creamHex: string,
  pinHex: string
): void {
  ctx.fillStyle = creamHex;
  ctx.fillRect(0, 0, w, h);

  const stripes = 8;
  const sw = w / stripes;
  for (let i = 0; i < stripes; i++) {
    const x = i * sw;
    if (i % 2 === 0) {
      ctx.fillStyle = primaryHex;
      ctx.fillRect(x, 0, sw, h);
      // Subtle stitched seam pinstripes flanking the colored band
      ctx.fillStyle = pinHex;
      ctx.fillRect(x + 3, 0, 2, h);
      ctx.fillRect(x + sw - 5, 0, 2, h);
    } else {
      ctx.fillStyle = creamHex;
      ctx.fillRect(x, 0, sw, h);
      ctx.fillStyle = 'rgba(0,0,0,0.045)';
      ctx.fillRect(x + sw * 0.48, 0, 2, h);
    }
  }

  // Subtle woven canvas cross-grain threads
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (let y = 0; y < h; y += 6) {
    ctx.fillRect(0, y, w, 1);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.04)';
  for (let y = 3; y < h; y += 6) {
    ctx.fillRect(0, y, w, 1);
  }
}

function drawFasciaSignCanvas(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  style: StyleKey
): void {
  const palette =
    style === 'style-a'
      ? {
          bg: '#1c382f',
          border: '#dfc185',
          title: '#f7efd8',
          sub: '#d7be88',
          mainText: 'CAFÉ  ·  BOULANGERIE',
          subText: 'PATISSERIE ARTISANALE   ·   MAISON FONDÉE 1924',
          font: 'Georgia, "Times New Roman", serif',
        }
      : style === 'style-b'
        ? {
            bg: '#23262d',
            border: '#df9d66',
            title: '#f6efe4',
            sub: '#d49a6a',
            mainText: 'MERCER  ·  ESPRESSO',
            subText: 'BAKERY  &  ROASTERY   ·   SOHO NEW YORK',
            font: '"Trebuchet MS", "Segoe UI", sans-serif',
          }
        : {
            bg: '#223047',
            border: '#e4cf9c',
            title: '#f8f2e4',
            sub: '#d9c492',
            mainText: 'KISSA  ·  ROASTERY',
            subText: '喫茶  ·  珈琲焙煎所   ·   TOKYO SPECIALTY COFFEE',
            font: 'Georgia, "Yu Mincho", serif',
          };

  // Subtle gradient lacquered signboard
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, palette.bg);
  g.addColorStop(1, '#141c1a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Double gold architectural frame border
  ctx.strokeStyle = palette.border;
  ctx.lineWidth = 6;
  ctx.strokeRect(16, 14, w - 32, h - 28);
  ctx.lineWidth = 2;
  ctx.strokeRect(26, 24, w - 52, h - 48);

  // Corner brass rosettes
  const corners = [
    [36, 34],
    [w - 36, 34],
    [36, h - 34],
    [w - 36, h - 34],
  ];
  ctx.fillStyle = palette.border;
  for (const [cx, cy] of corners) {
    ctx.beginPath();
    ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Main gilded signage lettering
  ctx.fillStyle = palette.title;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 66px ${palette.font}`;
  ctx.fillText(palette.mainText, w * 0.5, h * 0.44);

  // Subtitle
  ctx.fillStyle = palette.sub;
  ctx.font = `600 22px "Segoe UI", sans-serif`;
  ctx.fillText(palette.subText, w * 0.5, h * 0.74);
}

function drawBladeSignCanvas(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  style: StyleKey
): void {
  const cfg =
    style === 'style-a'
      ? {
          bg: '#f4e0b8',
          ring: '#16382b',
          accent: '#a47e3c',
          text: '#112e23',
          topLabel: 'CAFÉ',
          botLabel: 'BISTRO',
        }
      : style === 'style-b'
        ? {
            bg: '#f5d9b2',
            ring: '#91351c',
            accent: '#20242c',
            text: '#1a1d24',
            topLabel: 'ESPRESSO',
            botLabel: 'SOHO',
          }
        : {
            bg: '#f4dcb0',
            ring: '#192b47',
            accent: '#a33822',
            text: '#15233b',
            topLabel: '珈琲',
            botLabel: 'ROASTERY',
          };

  ctx.fillStyle = cfg.bg;
  ctx.fillRect(0, 0, w, h);

  const cx = w * 0.5;
  const cy = h * 0.5;
  const r = Math.min(w, h) * 0.44;

  // Outer painted bezel ring
  ctx.strokeStyle = cfg.ring;
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = cfg.accent;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 18, 0, Math.PI * 2);
  ctx.stroke();

  // Minimalist steaming coffee cup icon in center
  ctx.fillStyle = cfg.ring;
  ctx.beginPath();
  ctx.roundRect(cx - 42, cy - 18, 72, 54, [4, 4, 24, 24]);
  ctx.fill();
  ctx.strokeStyle = cfg.ring;
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.arc(cx + 32, cy + 6, 16, -Math.PI * 0.45, Math.PI * 0.45);
  ctx.stroke();
  // Saucer
  ctx.fillRect(cx - 56, cy + 40, 102, 9);

  // Steam curls
  ctx.strokeStyle = cfg.accent;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  for (const dx of [-18, 0, 18]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx - 6, cy - 30);
    ctx.quadraticCurveTo(cx + dx + 6, cy - 46, cx + dx - 4, cy - 60);
    ctx.stroke();
  }

  // Labels above & below
  ctx.fillStyle = cfg.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = style === 'style-c' ? '700 44px Georgia, serif' : '700 38px Georgia, serif';
  ctx.fillText(cfg.topLabel, cx, cy - 102);
  ctx.font = '700 32px "Segoe UI", sans-serif';
  ctx.fillText(cfg.botLabel, cx, cy + 98);
}

function drawChalkboardCanvas(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  style: StyleKey
): void {
  // Slate chalkboard background with subtle chalk dust
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#262b2c');
  g.addColorStop(0.5, '#2d3335');
  g.addColorStop(1, '#222628');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Double chalk border
  ctx.strokeStyle = 'rgba(244, 238, 224, 0.72)';
  ctx.lineWidth = 4;
  ctx.strokeRect(18, 18, w - 36, h - 36);
  ctx.strokeStyle = 'rgba(232, 198, 130, 0.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(28, 28, w - 56, h - 56);

  const header =
    style === 'style-a'
      ? 'MENU DU JOUR'
      : style === 'style-b'
        ? 'DAILY ROAST'
        : 'TODAY · 珈琲';
  const items =
    style === 'style-a'
      ? [
          ['Café Crème', '4.5€'],
          ['Espresso', '3.0€'],
          ['Croissant Beurre', '2.8€'],
          ['Pain au Chocolat', '3.2€'],
          ['Tarte Citron', '5.8€'],
        ]
      : style === 'style-b'
        ? [
            ['Flat White', '$5.0'],
            ['Cortado', '$4.5'],
            ['Cold Brew', '$5.5'],
            ['Brioche Bun', '$4.8'],
            ['Almond Tart', '$6.2'],
          ]
        : [
            ['Hand Drip', '¥650'],
            ['Matcha Latte', '¥700'],
            ['Espresso', '¥550'],
            ['Shokupan Toast', '¥680'],
            ['Custard Flan', '¥620'],
          ];

  ctx.textAlign = 'center';
  ctx.fillStyle = '#f2d38c';
  ctx.font = '700 40px Georgia, serif';
  ctx.fillText(header, w * 0.5, 92);

  // Chalk divider flourish
  ctx.strokeStyle = '#e4c27a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(64, 118);
  ctx.lineTo(w - 64, 118);
  ctx.stroke();

  let y = 176;
  for (const [name, price] of items) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f4efe2';
    ctx.font = '600 28px Georgia, serif';
    ctx.fillText(name, 52, y);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#eccb82';
    ctx.font = '700 26px "Segoe UI", sans-serif';
    ctx.fillText(price, w - 52, y);
    y += 58;
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(244, 238, 224, 0.78)';
  ctx.font = 'italic 24px Georgia, serif';
  ctx.fillText('Freshly Baked Every Morning', w * 0.5, h - 56);
}

export class ShopfrontMaterials {
  public readonly texMgr: ACGTextureManager;
  public readonly barkMat: THREE.MeshStandardMaterial;
  public readonly foliageMat: THREE.MeshStandardMaterial;

  private sets: Record<StyleKey, Record<ShopMatKey, THREE.Material>>;
  private envTargets: THREE.MeshStandardMaterial[] = [];
  private vitrineGlassMats: THREE.MeshStandardNodeMaterial[] = [];
  private upperGlassMats: THREE.MeshStandardNodeMaterial[] = [];
  private fasciaMats: THREE.MeshStandardMaterial[] = [];
  private bladeMats: THREE.MeshStandardMaterial[] = [];
  private warmGlowMats: THREE.MeshStandardMaterial[] = [];
  private lampGlobeMats: THREE.MeshStandardMaterial[] = [];
  private upperWarmMats: THREE.MeshStandardMaterial[] = [];
  private upperDimMats: THREE.MeshStandardMaterial[] = [];
  private interiorWallMats: THREE.MeshStandardMaterial[] = [];
  private interiorCeilMats: THREE.MeshStandardMaterial[] = [];
  private interiorFloorMats: THREE.MeshStandardMaterial[] = [];

  private canvasTextures: THREE.CanvasTexture[] = [];
  private leafTextures: FoliageTextureMaps;
  private allMaterials: THREE.Material[] = [];

  constructor(onProgress?: (p: TextureLoadProgress) => void) {
    this.texMgr = new ACGTextureManager(onProgress);

    const paver = this.texMgr.loadSet('paver', { hasAO: true });
    const plaster = this.texMgr.loadSet('plaster');
    const brick = this.texMgr.loadSet('brick');
    const timber = this.texMgr.loadSet('timber', { hasAO: true });
    const walnut = this.texMgr.loadSet('walnut');
    const tiles = this.texMgr.loadSet('tiles');
    const fabric = this.texMgr.loadSet('fabric', { hasAO: true });
    const brass = this.texMgr.loadSet('brass', { hasMetalness: true });
    const metal = this.texMgr.loadSet('metal', { hasMetalness: true });
    const roof = this.texMgr.loadSet('roof');
    const asphalt = this.texMgr.loadSet('asphalt', { hasAO: true });
    const bark = this.texMgr.loadSet('bark', { hasAO: true });

    this.texMgr.finishQueuing();

    this.leafTextures = createBotanicalLeafSprigTextures(8);

    this.barkMat = this.track(
      new THREE.MeshStandardMaterial({
        map: bark.map,
        normalMap: bark.normalMap,
        normalScale: new THREE.Vector2(1.2, 1.2),
        roughnessMap: bark.roughnessMap,
        aoMap: bark.aoMap,
        aoMapIntensity: 0.85,
        color: '#b8a088',
        roughness: 0.9,
      })
    );

    this.foliageMat = this.track(
      new THREE.MeshStandardMaterial({
        map: this.leafTextures.map,
        normalMap: this.leafTextures.normalMap,
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughnessMap: this.leafTextures.roughnessMap,
        vertexColors: true,
        alphaTest: 0.42,
        side: THREE.DoubleSide,
        roughness: 0.68,
        metalness: 0.02,
      })
    );

    // Shared calibrated materials across styles
    const brassMat = this.trackEnv(
      new THREE.MeshStandardMaterial({
        map: brass.map,
        normalMap: brass.normalMap,
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughnessMap: brass.roughnessMap,
        metalnessMap: brass.metalnessMap,
        color: '#ebd7a8',
        metalness: 0.88,
        roughness: 0.26,
        envMapIntensity: 1.15,
      })
    );

    const ironMat = this.trackEnv(
      new THREE.MeshStandardMaterial({
        normalMap: metal.normalMap,
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughnessMap: metal.roughnessMap,
        color: '#343942',
        metalness: 0.76,
        roughness: 0.42,
        envMapIntensity: 0.85,
      })
    );

    const steelMat = this.trackEnv(
      new THREE.MeshStandardMaterial({
        map: metal.map,
        normalMap: metal.normalMap,
        normalScale: new THREE.Vector2(0.75, 0.75),
        roughnessMap: metal.roughnessMap,
        metalnessMap: metal.metalnessMap,
        color: '#dce0e6',
        metalness: 0.86,
        roughness: 0.24,
        envMapIntensity: 1.1,
      })
    );

    const roofMat = this.track(
      new THREE.MeshStandardMaterial({
        map: roof.map,
        normalMap: roof.normalMap,
        normalScale: new THREE.Vector2(1.0, 1.0),
        roughnessMap: roof.roughnessMap,
        color: '#8c929c',
        roughness: 0.86,
        metalness: 0.12,
      })
    );

    const sidewalkMat = this.track(
      new THREE.MeshStandardMaterial({
        map: paver.map,
        normalMap: paver.normalMap,
        normalScale: new THREE.Vector2(1.15, 1.15),
        roughnessMap: paver.roughnessMap,
        aoMap: paver.aoMap,
        aoMapIntensity: 0.75,
        color: '#dcd7ce',
        roughness: 0.86,
      })
    );

    const curbMat = this.track(
      new THREE.MeshStandardMaterial({
        map: plaster.map,
        normalMap: plaster.normalMap,
        normalScale: new THREE.Vector2(1.0, 1.0),
        roughnessMap: plaster.roughnessMap,
        color: '#c9c4bb',
        roughness: 0.82,
      })
    );

    // Pale architectural model street (roof base tinted #c8cbd0 + asphalt tactile grain)
    const streetMat = this.track(
      new THREE.MeshStandardMaterial({
        map: roof.map,
        normalMap: asphalt.normalMap,
        normalScale: new THREE.Vector2(1.05, 1.05),
        roughnessMap: asphalt.roughnessMap,
        aoMap: asphalt.aoMap,
        aoMapIntensity: 0.55,
        color: '#c8cbd0',
        roughness: 0.9,
      })
    );

    const crosswalkMat = this.track(
      new THREE.MeshStandardMaterial({
        map: plaster.map,
        normalMap: asphalt.normalMap,
        normalScale: new THREE.Vector2(0.55, 0.55),
        roughnessMap: plaster.roughnessMap,
        color: '#f2f3f5',
        roughness: 0.84,
      })
    );

    const counterTopMat = this.trackEnv(
      new THREE.MeshStandardMaterial({
        map: plaster.map,
        normalMap: plaster.normalMap,
        normalScale: new THREE.Vector2(0.45, 0.45),
        roughnessMap: plaster.roughnessMap,
        color: '#f5f2eb',
        roughness: 0.24,
        metalness: 0.04,
        envMapIntensity: 0.75,
      })
    );

    const counterWoodMat = this.trackEnv(
      new THREE.MeshStandardMaterial({
        map: walnut.map,
        normalMap: walnut.normalMap,
        normalScale: new THREE.Vector2(1.15, 1.15),
        roughnessMap: walnut.roughnessMap,
        color: '#cfa988',
        roughness: 0.52,
        metalness: 0.05,
        envMapIntensity: 0.55,
      })
    );

    const rattanMat = this.track(
      new THREE.MeshStandardMaterial({
        map: fabric.map,
        normalMap: fabric.normalMap,
        normalScale: new THREE.Vector2(1.3, 1.3),
        roughnessMap: fabric.roughnessMap,
        aoMap: fabric.aoMap,
        aoMapIntensity: 0.85,
        color: '#dec394',
        roughness: 0.84,
      })
    );

    const soilMat = this.track(
      new THREE.MeshStandardMaterial({
        map: bark.map,
        normalMap: bark.normalMap,
        normalScale: new THREE.Vector2(1.1, 1.1),
        roughnessMap: bark.roughnessMap,
        color: '#5a4a3c',
        roughness: 0.96,
      })
    );

    const pastryGoldMat = this.track(
      new THREE.MeshStandardMaterial({
        map: plaster.map,
        normalMap: plaster.normalMap,
        normalScale: new THREE.Vector2(0.8, 0.8),
        color: '#dca052',
        roughness: 0.62,
      })
    );

    const porcelainMat = this.trackEnv(
      new THREE.MeshStandardMaterial({
        color: '#f6f4ef',
        roughness: 0.16,
        metalness: 0.04,
        envMapIntensity: 0.9,
      })
    );

    const bottleAmberMat = this.trackEnv(
      new THREE.MeshStandardMaterial({
        color: '#c97828',
        emissive: '#944a10',
        emissiveIntensity: 0.2,
        roughness: 0.15,
        metalness: 0.1,
        envMapIntensity: 0.95,
      })
    );

    const bottleGreenMat = this.trackEnv(
      new THREE.MeshStandardMaterial({
        color: '#346e4b',
        emissive: '#163d24',
        emissiveIntensity: 0.15,
        roughness: 0.16,
        metalness: 0.1,
        envMapIntensity: 0.95,
      })
    );

    // High-res procedural architectural Parisian cut ashlar limestone & standing-seam zinc PBR maps
    const parisLimestone = createParisianLimestoneTextures();
    const zincMaps = createStandingSeamZincTextures();
    const norenTex = createCanvasTexture(256, 320, (ctx, w, h) => drawNorenCanvas(ctx, w, h));
    this.canvasTextures.push(
      parisLimestone.map,
      parisLimestone.normalMap,
      parisLimestone.roughnessMap,
      zincMaps.map,
      zincMaps.normalMap,
      zincMaps.roughnessMap,
      norenTex
    );

    const mansardZincMat = this.trackEnv(
      new THREE.MeshStandardMaterial({
        map: zincMaps.map,
        normalMap: zincMaps.normalMap,
        normalScale: new THREE.Vector2(1.35, 1.35),
        roughnessMap: zincMaps.roughnessMap,
        color: '#d4dce4',
        metalness: 0.56,
        roughness: 0.44,
        envMapIntensity: 0.95,
      })
    );

    const curtainMat = this.track(
      new THREE.MeshStandardMaterial({
        map: fabric.map,
        normalMap: fabric.normalMap,
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughnessMap: fabric.roughnessMap,
        color: '#ebe3d3',
        emissive: new THREE.Color('#ffda9e'),
        emissiveIntensity: 0.05,
        roughness: 0.9,
      })
    );

    const norenMat = this.track(
      new THREE.MeshStandardMaterial({
        map: norenTex,
        normalMap: fabric.normalMap,
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughnessMap: fabric.roughnessMap,
        roughness: 0.86,
        side: THREE.DoubleSide,
      })
    );

    const flowerRedMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#b8322c',
        roughness: 0.78,
        metalness: 0.0,
      })
    );

    const buildStyleSet = (style: StyleKey): Record<ShopMatKey, THREE.Material> => {
      // Crystal-clear Fresnel vitrine glass (low floor opacity so 3D interior shines clearly!)
      const vitrineGlass = createFresnelGlass('#f0f6fa', 0.16, 0.035, 0.6, false);
      this.vitrineGlassMats.push(vitrineGlass);
      this.allMaterials.push(vitrineGlass);

      // Realistic dark architectural upper window glazing (shows subtle interior curtains/depth instead of flat blue!)
      const upperGlass = createFresnelGlass('#768899', 0.22, 0.075, 0.86, false);
      this.upperGlassMats.push(upperGlass);
      this.allMaterials.push(upperGlass);

      // Striped woven canvas awning texture
      const awningTex = createCanvasTexture(512, 256, (ctx, w, h) => {
        if (style === 'style-a') drawStripedAwningCanvas(ctx, w, h, '#224c3d', '#f5eee0', '#d5b97d');
        else if (style === 'style-b') drawStripedAwningCanvas(ctx, w, h, '#a8442a', '#f4ede2', '#35373e');
        else drawStripedAwningCanvas(ctx, w, h, '#203454', '#f3ede0', '#c7a96f');
      });
      awningTex.wrapS = THREE.RepeatWrapping;
      awningTex.wrapT = THREE.RepeatWrapping;
      this.canvasTextures.push(awningTex);

      const awningMat = this.track(
        new THREE.MeshStandardMaterial({
          map: awningTex,
          normalMap: fabric.normalMap,
          normalScale: new THREE.Vector2(1.25, 1.25),
          roughnessMap: fabric.roughnessMap,
          aoMap: fabric.aoMap,
          aoMapIntensity: 0.72,
          roughness: 0.88,
          metalness: 0.02,
          side: THREE.DoubleSide,
        })
      );

      // High-res fascia sign board
      const fasciaTex = createCanvasTexture(1024, 256, (ctx, w, h) =>
        drawFasciaSignCanvas(ctx, w, h, style)
      );
      this.canvasTextures.push(fasciaTex);
      const fasciaMat = this.trackEnv(
        new THREE.MeshStandardMaterial({
          map: fasciaTex,
          emissiveMap: fasciaTex,
          emissive: new THREE.Color('#ffe5b8'),
          emissiveIntensity: 0.12,
          roughness: 0.34,
          metalness: 0.14,
          envMapIntensity: 0.65,
        })
      );
      this.fasciaMats.push(fasciaMat);

      // Projecting backlit glowing blade sign
      const bladeTex = createCanvasTexture(512, 512, (ctx, w, h) =>
        drawBladeSignCanvas(ctx, w, h, style)
      );
      this.canvasTextures.push(bladeTex);
      const bladeMat = this.trackEnv(
        new THREE.MeshStandardMaterial({
          map: bladeTex,
          emissiveMap: bladeTex,
          emissive: new THREE.Color('#ffdea0'),
          emissiveIntensity: 0.25,
          roughness: 0.25,
          metalness: 0.05,
          envMapIntensity: 0.55,
        })
      );
      this.bladeMats.push(bladeMat);

      // A-frame chalkboard menu
      const chalkTex = createCanvasTexture(512, 640, (ctx, w, h) =>
        drawChalkboardCanvas(ctx, w, h, style)
      );
      this.canvasTextures.push(chalkTex);
      const chalkMat = this.track(
        new THREE.MeshStandardMaterial({
          map: chalkTex,
          normalMap: plaster.normalMap,
          normalScale: new THREE.Vector2(0.45, 0.45),
          roughness: 0.88,
          metalness: 0.02,
        })
      );

      // Warm glowing bulbs / backlit café interior coves
      const warmGlow = this.track(
        new THREE.MeshStandardMaterial({
          color: '#fff4d6',
          emissive: new THREE.Color('#ffbe66'),
          emissiveIntensity: 1.0,
          roughness: 0.2,
          metalness: 0.0,
        })
      );
      this.warmGlowMats.push(warmGlow);

      // Vintage streetlamp milk-glass globe
      const lampGlobe = this.trackEnv(
        new THREE.MeshStandardMaterial({
          color: '#fffaf0',
          emissive: new THREE.Color('#ffc975'),
          emissiveIntensity: 0.35,
          roughness: 0.18,
          metalness: 0.02,
          envMapIntensity: 0.7,
        })
      );
      this.lampGlobeMats.push(lampGlobe);

      // Upper window interior backing rooms (warm lit vs cozy dim)
      const upperRoomWarm = this.track(
        new THREE.MeshStandardMaterial({
          color: '#5a5046',
          emissive: new THREE.Color('#ffb868'),
          emissiveIntensity: 0.15,
          roughness: 0.9,
        })
      );
      this.upperWarmMats.push(upperRoomWarm);

      const upperRoomDim = this.track(
        new THREE.MeshStandardMaterial({
          color: '#3c4048',
          emissive: new THREE.Color('#8c7c6a'),
          emissiveIntensity: 0.05,
          roughness: 0.92,
        })
      );
      this.upperDimMats.push(upperRoomDim);

      // Style-specific architectural shell & interior materials
      let upperWall: THREE.MeshStandardMaterial;
      let shopfront: THREE.MeshStandardMaterial;
      let trim: THREE.MeshStandardMaterial;
      let cornice: THREE.MeshStandardMaterial;
      let accentWood: THREE.MeshStandardMaterial;
      let interiorFloor: THREE.MeshStandardMaterial;
      let interiorWall: THREE.MeshStandardMaterial;
      let chairAccent: THREE.MeshStandardMaterial;
      let planterPot: THREE.MeshStandardMaterial;

      if (style === 'style-a') {
        // Parisian Haussmann Bistro — warm dressed Lutetian ashlar limestone + deep lacquered emerald millwork!
        upperWall = this.track(
          new THREE.MeshStandardMaterial({
            map: parisLimestone.map,
            normalMap: parisLimestone.normalMap,
            normalScale: new THREE.Vector2(1.15, 1.15),
            roughnessMap: parisLimestone.roughnessMap,
            color: '#f7f3eb',
            roughness: 0.84,
          })
        );
        shopfront = this.trackEnv(
          new THREE.MeshStandardMaterial({
            map: plaster.map,
            normalMap: timber.normalMap,
            normalScale: new THREE.Vector2(0.95, 0.95),
            roughnessMap: timber.roughnessMap,
            aoMap: timber.aoMap,
            aoMapIntensity: 0.65,
            color: '#1e3f33',
            roughness: 0.44,
            metalness: 0.08,
            envMapIntensity: 0.52,
          })
        );
        trim = this.track(
          new THREE.MeshStandardMaterial({
            map: plaster.map,
            normalMap: plaster.normalMap,
            normalScale: new THREE.Vector2(0.85, 0.85),
            roughnessMap: plaster.roughnessMap,
            color: '#f2ede3',
            roughness: 0.74,
          })
        );
        cornice = this.track(
          new THREE.MeshStandardMaterial({
            map: plaster.map,
            normalMap: plaster.normalMap,
            normalScale: new THREE.Vector2(1.0, 1.0),
            roughnessMap: plaster.roughnessMap,
            color: '#e8e0d0',
            roughness: 0.78,
          })
        );
        accentWood = this.trackEnv(
          new THREE.MeshStandardMaterial({
            map: walnut.map,
            normalMap: walnut.normalMap,
            normalScale: new THREE.Vector2(1.1, 1.1),
            roughnessMap: walnut.roughnessMap,
            color: '#cca886',
            roughness: 0.5,
            envMapIntensity: 0.5,
          })
        );
        interiorFloor = this.trackEnv(
          new THREE.MeshStandardMaterial({
            map: tiles.map,
            normalMap: tiles.normalMap,
            normalScale: new THREE.Vector2(0.95, 0.95),
            roughnessMap: tiles.roughnessMap,
            color: '#f2efe8',
            emissive: new THREE.Color('#ffd394'),
            emissiveIntensity: 0.04,
            roughness: 0.34,
            envMapIntensity: 0.6,
          })
        );
        interiorWall = this.track(
          new THREE.MeshStandardMaterial({
            map: plaster.map,
            normalMap: plaster.normalMap,
            normalScale: new THREE.Vector2(0.8, 0.8),
            roughnessMap: plaster.roughnessMap,
            color: '#f2e8d6',
            emissive: new THREE.Color('#ffcf86'),
            emissiveIntensity: 0.08,
            roughness: 0.82,
          })
        );
        chairAccent = this.track(
          new THREE.MeshStandardMaterial({
            map: fabric.map,
            normalMap: fabric.normalMap,
            normalScale: new THREE.Vector2(1.1, 1.1),
            roughnessMap: fabric.roughnessMap,
            color: '#2b5446',
            roughness: 0.78,
          })
        );
        planterPot = this.track(
          new THREE.MeshStandardMaterial({
            map: plaster.map,
            normalMap: plaster.normalMap,
            normalScale: new THREE.Vector2(1.0, 1.0),
            roughnessMap: plaster.roughnessMap,
            color: '#2f4e43',
            roughness: 0.68,
            metalness: 0.12,
          })
        );
      } else if (style === 'style-b') {
        // SoHo Historic Cast-Iron & Aged Terracotta Brick Loft
        upperWall = this.track(
          new THREE.MeshStandardMaterial({
            map: brick.map,
            normalMap: brick.normalMap,
            normalScale: new THREE.Vector2(1.55, 1.55),
            roughnessMap: brick.roughnessMap,
            color: '#b46f5a',
            roughness: 0.86,
          })
        );
        shopfront = this.trackEnv(
          new THREE.MeshStandardMaterial({
            normalMap: metal.normalMap,
            normalScale: new THREE.Vector2(0.95, 0.95),
            roughnessMap: metal.roughnessMap,
            color: '#282c34',
            metalness: 0.76,
            roughness: 0.36,
            envMapIntensity: 0.92,
          })
        );
        trim = this.track(
          new THREE.MeshStandardMaterial({
            map: plaster.map,
            normalMap: plaster.normalMap,
            normalScale: new THREE.Vector2(0.95, 0.95),
            roughnessMap: plaster.roughnessMap,
            color: '#d8cfc0',
            roughness: 0.8,
          })
        );
        cornice = this.track(
          new THREE.MeshStandardMaterial({
            map: plaster.map,
            normalMap: plaster.normalMap,
            normalScale: new THREE.Vector2(1.1, 1.1),
            roughnessMap: plaster.roughnessMap,
            color: '#cec4b4',
            roughness: 0.82,
          })
        );
        accentWood = this.trackEnv(
          new THREE.MeshStandardMaterial({
            map: walnut.map,
            normalMap: walnut.normalMap,
            normalScale: new THREE.Vector2(1.2, 1.2),
            roughnessMap: walnut.roughnessMap,
            color: '#cfa885',
            roughness: 0.48,
            envMapIntensity: 0.55,
          })
        );
        interiorFloor = this.trackEnv(
          new THREE.MeshStandardMaterial({
            map: timber.map,
            normalMap: timber.normalMap,
            normalScale: new THREE.Vector2(1.1, 1.1),
            roughnessMap: timber.roughnessMap,
            aoMap: timber.aoMap,
            aoMapIntensity: 0.7,
            color: '#dbc199',
            emissive: new THREE.Color('#ffca80'),
            emissiveIntensity: 0.04,
            roughness: 0.48,
            envMapIntensity: 0.45,
          })
        );
        interiorWall = this.track(
          new THREE.MeshStandardMaterial({
            map: brick.map,
            normalMap: brick.normalMap,
            normalScale: new THREE.Vector2(1.2, 1.2),
            roughnessMap: brick.roughnessMap,
            color: '#d4b2a0',
            emissive: new THREE.Color('#ffbe78'),
            emissiveIntensity: 0.07,
            roughness: 0.86,
          })
        );
        chairAccent = this.track(
          new THREE.MeshStandardMaterial({
            map: fabric.map,
            normalMap: fabric.normalMap,
            normalScale: new THREE.Vector2(1.15, 1.15),
            roughnessMap: fabric.roughnessMap,
            color: '#a84c32',
            roughness: 0.72,
          })
        );
        planterPot = this.track(
          new THREE.MeshStandardMaterial({
            map: plaster.map,
            normalMap: plaster.normalMap,
            normalScale: new THREE.Vector2(1.1, 1.1),
            roughnessMap: plaster.roughnessMap,
            color: '#b46648',
            roughness: 0.84,
          })
        );
      } else {
        // Tokyo Timber / Kissa
        upperWall = this.track(
          new THREE.MeshStandardMaterial({
            map: plaster.map,
            normalMap: plaster.normalMap,
            normalScale: new THREE.Vector2(1.05, 1.05),
            roughnessMap: plaster.roughnessMap,
            color: '#f2ede4',
            roughness: 0.82,
          })
        );
        shopfront = this.trackEnv(
          new THREE.MeshStandardMaterial({
            map: timber.map,
            normalMap: timber.normalMap,
            normalScale: new THREE.Vector2(1.25, 1.25),
            roughnessMap: timber.roughnessMap,
            aoMap: timber.aoMap,
            aoMapIntensity: 0.75,
            color: '#dfb98a',
            roughness: 0.56,
            metalness: 0.04,
            envMapIntensity: 0.42,
          })
        );
        trim = this.trackEnv(
          new THREE.MeshStandardMaterial({
            map: walnut.map,
            normalMap: walnut.normalMap,
            normalScale: new THREE.Vector2(1.15, 1.15),
            roughnessMap: walnut.roughnessMap,
            color: '#b89474',
            roughness: 0.58,
            envMapIntensity: 0.4,
          })
        );
        cornice = this.track(
          new THREE.MeshStandardMaterial({
            map: plaster.map,
            normalMap: metal.normalMap,
            normalScale: new THREE.Vector2(0.8, 0.8),
            roughnessMap: metal.roughnessMap,
            color: '#3c4048',
            roughness: 0.5,
            metalness: 0.35,
          })
        );
        accentWood = this.trackEnv(
          new THREE.MeshStandardMaterial({
            map: walnut.map,
            normalMap: walnut.normalMap,
            normalScale: new THREE.Vector2(1.15, 1.15),
            roughnessMap: walnut.roughnessMap,
            color: '#d2ae8a',
            roughness: 0.52,
            envMapIntensity: 0.45,
          })
        );
        interiorFloor = this.trackEnv(
          new THREE.MeshStandardMaterial({
            map: timber.map,
            normalMap: timber.normalMap,
            normalScale: new THREE.Vector2(1.05, 1.05),
            roughnessMap: timber.roughnessMap,
            aoMap: timber.aoMap,
            aoMapIntensity: 0.65,
            color: '#e0c59c',
            emissive: new THREE.Color('#ffcf86'),
            emissiveIntensity: 0.04,
            roughness: 0.46,
            envMapIntensity: 0.45,
          })
        );
        interiorWall = this.track(
          new THREE.MeshStandardMaterial({
            map: plaster.map,
            normalMap: plaster.normalMap,
            normalScale: new THREE.Vector2(0.85, 0.85),
            roughnessMap: plaster.roughnessMap,
            color: '#f5f0e4',
            emissive: new THREE.Color('#ffd08a'),
            emissiveIntensity: 0.08,
            roughness: 0.84,
          })
        );
        chairAccent = this.track(
          new THREE.MeshStandardMaterial({
            map: fabric.map,
            normalMap: fabric.normalMap,
            normalScale: new THREE.Vector2(1.15, 1.15),
            roughnessMap: fabric.roughnessMap,
            color: '#293f60',
            roughness: 0.8,
          })
        );
        planterPot = this.track(
          new THREE.MeshStandardMaterial({
            map: plaster.map,
            normalMap: plaster.normalMap,
            normalScale: new THREE.Vector2(1.05, 1.05),
            roughnessMap: plaster.roughnessMap,
            color: '#4b5058',
            roughness: 0.78,
          })
        );
      }

      const interiorCeiling = this.track(
        new THREE.MeshStandardMaterial({
          map: plaster.map,
          color: '#f7f0e2',
          emissive: new THREE.Color('#ffcf88'),
          emissiveIntensity: 0.14,
          roughness: 0.85,
        })
      );

      this.interiorFloorMats.push(interiorFloor);
      this.interiorWallMats.push(interiorWall);
      this.interiorCeilMats.push(interiorCeiling);

      return {
        upperWall,
        shopfront,
        trim,
        cornice,
        accentWood,
        brass: brassMat,
        iron: ironMat,
        steel: steelMat,
        roof: roofMat,
        sidewalk: sidewalkMat,
        curb: curbMat,
        street: streetMat,
        crosswalk: crosswalkMat,
        vitrineGlass,
        upperGlass,
        awning: awningMat,
        fasciaSign: fasciaMat,
        bladeSign: bladeMat,
        chalkboard: chalkMat,
        interiorFloor,
        interiorWall,
        interiorCeiling,
        counterTop: counterTopMat,
        counterWood: counterWoodMat,
        chairAccent,
        rattan: rattanMat,
        planterPot,
        soil: soilMat,
        pastryGold: pastryGoldMat,
        porcelain: porcelainMat,
        bottleAmber: bottleAmberMat,
        bottleGreen: bottleGreenMat,
        warmGlow,
        lampGlobe,
        upperRoomWarm,
        upperRoomDim,
        mansardZinc: mansardZincMat,
        curtain: curtainMat,
        noren: norenMat,
        flowerRed: flowerRedMat,
      };
    };

    this.sets = {
      'style-a': buildStyleSet('style-a'),
      'style-b': buildStyleSet('style-b'),
      'style-c': buildStyleSet('style-c'),
    };
  }

  private track<T extends THREE.Material>(m: T): T {
    this.allMaterials.push(m);
    return m;
  }

  private trackEnv(m: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    this.envTargets.push(m);
    this.allMaterials.push(m);
    return m;
  }

  public getStyleSet(style: StyleKey): Record<ShopMatKey, THREE.Material> {
    return this.sets[style];
  }

  public setEnvironmentMap(envMap: THREE.Texture | null): void {
    for (const m of this.envTargets) {
      m.envMap = envMap;
      m.needsUpdate = true;
    }
    for (const g of this.vitrineGlassMats) {
      g.envMap = envMap;
      g.needsUpdate = true;
    }
    for (const g of this.upperGlassMats) {
      g.envMap = envMap;
      g.needsUpdate = true;
    }
  }

  public applyMood(lighting: LightingKey): void {
    const isMorning = lighting === 'mood-a';
    const isApero = lighting === 'mood-b';
    const isEvening = lighting === 'mood-c';

    // CRITICAL: keep vitrine glass envMapIntensity LOW (0.22) at evening so the warm 3D café interior shines crystal-clear!
    const vitrineEnv = isEvening ? 0.22 : isApero ? 0.64 : 0.56;
    const upperEnv = isEvening ? 0.28 : isApero ? 0.92 : 0.82;
    for (const g of this.vitrineGlassMats) g.envMapIntensity = vitrineEnv;
    for (const g of this.upperGlassMats) g.envMapIntensity = upperEnv;

    const fasciaGlow = isEvening ? 1.45 : isApero ? 0.48 : 0.12;
    for (const m of this.fasciaMats) m.emissiveIntensity = fasciaGlow;

    const bladeGlow = isEvening ? 1.12 : isApero ? 0.55 : 0.16;
    for (const m of this.bladeMats) m.emissiveIntensity = bladeGlow;

    const bulbGlow = isEvening ? 3.2 : isApero ? 1.5 : 0.85;
    for (const m of this.warmGlowMats) m.emissiveIntensity = bulbGlow;

    const globeGlow = isEvening ? 3.3 : isApero ? 1.15 : 0.22;
    for (const m of this.lampGlobeMats) m.emissiveIntensity = globeGlow;

    // Warm cozy illuminated interior walls/ceiling/floor at evening so the whole café glows warmly inside
    const wallGlow = isEvening ? 0.58 : isApero ? 0.22 : 0.08;
    const ceilGlow = isEvening ? 0.72 : isApero ? 0.28 : 0.14;
    const floorGlow = isEvening ? 0.34 : isApero ? 0.12 : 0.04;
    for (const m of this.interiorWallMats) m.emissiveIntensity = wallGlow;
    for (const m of this.interiorCeilMats) m.emissiveIntensity = ceilGlow;
    for (const m of this.interiorFloorMats) m.emissiveIntensity = floorGlow;

    // Upper apartment windows: cozy warm glow in some rooms at night
    const upWarm = isEvening ? 1.45 : isApero ? 0.38 : 0.1;
    const upDim = isEvening ? 0.22 : isApero ? 0.08 : 0.03;
    for (const m of this.upperWarmMats) m.emissiveIntensity = upWarm;
    for (const m of this.upperDimMats) m.emissiveIntensity = upDim;

    void isMorning;
  }

  public dispose(): void {
    this.texMgr.dispose();
    for (const t of this.canvasTextures) t.dispose();
    this.leafTextures.map.dispose();
    this.leafTextures.normalMap.dispose();
    this.leafTextures.roughnessMap.dispose();
    for (const m of this.allMaterials) m.dispose();
  }
}
