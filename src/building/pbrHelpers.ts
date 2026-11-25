import * as THREE from 'three/webgpu';
import {
  abs,
  clamp,
  cos,
  dot,
  float,
  max,
  mix,
  normalView,
  positionViewDirection,
  positionWorld,
  sin,
  sqrt,
  time,
  vec3,
} from 'three/tsl';

export interface LoadedACGSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  aoMap?: THREE.Texture;
  metalnessMap?: THREE.Texture;
}

export interface TextureLoadProgress {
  loaded: number;
  total: number;
  lastUrl: string;
}

export class ACGTextureManager {
  private loader = new THREE.TextureLoader();
  private textures: THREE.Texture[] = [];
  private loaded = 0;
  private total = 0;
  private readyToEmit = false;
  private onProgress?: (p: TextureLoadProgress) => void;

  constructor(onProgress?: (p: TextureLoadProgress) => void) {
    this.onProgress = onProgress;
  }

  public finishQueuing(): void {
    this.readyToEmit = true;
    this.onProgress?.({ loaded: this.loaded, total: this.total, lastUrl: '' });
  }

  public loadMap(url: string, isColor: boolean, aniso = 8): THREE.Texture {
    this.total++;
    const done = () => {
      this.loaded++;
      if (this.readyToEmit) {
        this.onProgress?.({ loaded: this.loaded, total: this.total, lastUrl: url });
      }
    };
    const tex = this.loader.load(url, done, undefined, done);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = aniso;
    tex.generateMipmaps = true;
    this.textures.push(tex);
    return tex;
  }

  public loadSet(
    folder: string,
    opts: { aniso?: number; hasAO?: boolean; hasMetalness?: boolean } = {}
  ): LoadedACGSet {
    const aniso = opts.aniso ?? 8;
    const base = `/textures/${folder}`;
    const set: LoadedACGSet = {
      map: this.loadMap(`${base}/color.jpg`, true, aniso),
      normalMap: this.loadMap(`${base}/normal.jpg`, false, aniso),
      roughnessMap: this.loadMap(`${base}/roughness.jpg`, false, aniso),
    };
    if (opts.hasAO) set.aoMap = this.loadMap(`${base}/ao.jpg`, false, aniso);
    if (opts.hasMetalness) set.metalnessMap = this.loadMap(`${base}/metalness.jpg`, false, aniso);
    return set;
  }

  public dispose(): void {
    for (const t of this.textures) t.dispose();
    this.textures = [];
  }
}

/**
 * Exact WebGPU TSL Dielectric Fresnel Glass (FR_Glass from ProdceduralBuildingsThreeJS).
 */
export function createFresnelGlass(
  tintHex: string,
  fresnelBlend = 0.18,
  baseFloorOpacity = 0.04,
  envIntensity = 0.85,
  doubleSided = false
): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(tintHex),
    metalness: 1.0,
    roughness: 0.03,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    envMapIntensity: envIntensity,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });

  const eta = float(1.0 / (1.0 - fresnelBlend));
  const c = abs(dot(positionViewDirection, normalView));
  const g = sqrt(max(eta.mul(eta).sub(1.0).add(c.mul(c)), float(0.0)));
  const A = g.sub(c).div(max(g.add(c), float(1e-4)));
  const B = c.mul(g.add(c)).sub(1.0).div(max(c.mul(g.sub(c)).add(1.0), float(1e-4)));
  const F = float(0.5).mul(A).mul(A).mul(float(1.0).add(B.mul(B)));

  mat.opacityNode = clamp(F.add(float(baseFloorOpacity)), 0.0, 1.0);
  return mat;
}

/**
 * Real-time animated WebGPU TSL Shimmering Water (pools, rivers, koi ponds)
 * with multi-octave trigonometric wave ripples, caustic shimmer, and Fresnel reflections!
 */
export function createWaterNodeMaterial(
  deepHex = '#0c5268',
  shallowHex = '#22a6b3',
  envIntensity = 1.05,
  opacity = 0.86
): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    metalness: 0.12,
    roughness: 0.06,
    transparent: true,
    depthWrite: false,
    envMapIntensity: envIntensity,
  });

  const p = positionWorld;
  const t = time.mul(1.35);
  const w1 = sin(p.x.mul(1.7).add(t)).mul(cos(p.z.mul(1.4).sub(t.mul(0.8))));
  const wave = w1.mul(0.6).add(sin(p.x.mul(3.1).sub(p.z.mul(2.4)).add(t.mul(1.4))).mul(0.4));

  const cView = abs(dot(positionViewDirection, normalView));
  const fresnel = clamp(float(1.0).sub(cView).pow(3.0), 0.0, 1.0);

  const deepCol = vec3(
    new THREE.Color(deepHex).r,
    new THREE.Color(deepHex).g,
    new THREE.Color(deepHex).b
  );
  const shallowCol = vec3(
    new THREE.Color(shallowHex).r,
    new THREE.Color(shallowHex).g,
    new THREE.Color(shallowHex).b
  );
  const shimmer = clamp(wave.mul(0.5).add(0.5), 0.0, 1.0);
  mat.colorNode = mix(deepCol, shallowCol, shimmer.mul(0.55).add(0.25).add(fresnel.mul(0.2)));
  mat.roughnessNode = clamp(float(0.05).add(wave.abs().mul(0.06)), 0.03, 0.16);
  mat.opacityNode = clamp(float(opacity).add(fresnel.mul(0.14)), 0.0, 0.98);
  return mat;
}

export function createCanvasTexture(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  aniso = 8
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}
