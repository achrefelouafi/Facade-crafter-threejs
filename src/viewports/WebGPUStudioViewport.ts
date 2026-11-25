import * as THREE from 'three/webgpu';
import {
  abs,
  clamp,
  dot,
  float,
  fract,
  length,
  max,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  screenUV,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { denoise } from 'three/examples/jsm/tsl/display/DenoiseNode.js';
import {
  GeneratedSceneResult,
  LightingKey,
  MassingState,
  ProjectConfig,
  StyleKey,
} from '../core/types';
import { TextureLoadProgress } from '../building/pbrHelpers';

export type GPUBackendKind = 'WebGPU' | 'WebGL2';

export interface StudioLoadSnapshot {
  gpuReady: boolean;
  gpuBackend: GPUBackendKind | null;
  texturesLoaded: number;
  texturesTotal: number;
  hdrisLoaded: number;
  hdrisTotal: number;
  currentAsset: string;
  warmedUp: boolean;
}

export interface ProjectSceneDriver {
  generate: (
    state: MassingState,
    style: StyleKey,
    lighting: LightingKey,
    toggleA: boolean,
    toggleB: boolean
  ) => GeneratedSceneResult;
  onLightingChange: (style: StyleKey, lighting: LightingKey) => void;
  setEnvironmentMap: (envMap: THREE.Texture | null) => void;
  dispose: () => void;
}

export interface StudioViewportCallbacks {
  onBackendReady?: (backend: GPUBackendKind) => void;
  onLoadSnapshot?: (snapshot: StudioLoadSnapshot) => void;
}

function dirFrom(azDeg: number, elDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const a = (azDeg * Math.PI) / 180;
  const e = (elDeg * Math.PI) / 180;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}

export class WebGPUStudioViewport {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly controls: OrbitControls;

  private container: HTMLElement;
  private config: ProjectConfig;
  private driver: ProjectSceneDriver;
  private renderer: THREE.WebGPURenderer;
  private scene: THREE.Scene;
  private callbacks: StudioViewportCallbacks;
  private rgbeLoader = new RGBELoader();
  private hdriCache = new Map<string, THREE.DataTexture>();

  private keyLight: THREE.DirectionalLight;
  private fillLight: THREE.DirectionalLight;
  private rimLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;
  private uplights: THREE.SpotLight[] = [];

  private postProcessing: THREE.PostProcessing | null = null;
  private aoStrengthUniform = uniform(0.82);
  private gradeTime = uniform(0.0);
  private gradeContrast = uniform(1.07);
  private gradeSaturation = uniform(1.02);
  private gradeVignette = uniform(0.12);
  private gradeGrain = uniform(0.005);
  private gradeTemperature = uniform(0.0);
  private gradeShadowTint = uniform(new THREE.Color('#9aa0a8'));
  private gradeHighlightTint = uniform(new THREE.Color('#ffffff'));
  private gradeSplitTone = uniform(0.03);

  private postFXEnabled = true;
  private postFXFailed = false;

  private contentRoot = new THREE.Group();
  private currentBounds = new THREE.Box3();
  private currentTick?: (dt: number, elapsed: number) => void;
  private currentStyle: StyleKey = 'style-a';
  private currentLighting: LightingKey;
  private lastState: MassingState | null = null;
  private lastToggleA = true;
  private lastToggleB = true;

  private resizeObserver: ResizeObserver;
  private initialized = false;
  private disposed = false;
  private lastFrameTime = performance.now();
  private elapsed = 0;

  private loadState: StudioLoadSnapshot;
  private warmupFramesRemaining = 3;

  constructor(
    container: HTMLElement,
    config: ProjectConfig,
    createDriver: (onTexProgress: (p: TextureLoadProgress) => void) => ProjectSceneDriver,
    callbacks: StudioViewportCallbacks = {}
  ) {
    this.container = container;
    this.config = config;
    this.callbacks = callbacks;
    this.currentLighting = config.defaultLighting;

    const uniqueHdriUrls = Array.from(
      new Set(Object.values(config.lightingLooks).map((l) => l.hdriUrl))
    );

    this.loadState = {
      gpuReady: false,
      gpuBackend: null,
      texturesLoaded: 0,
      texturesTotal: 1,
      hdrisLoaded: 0,
      hdrisTotal: uniqueHdriUrls.length,
      currentAsset: 'Initializing WebGPU backend…',
      warmedUp: false,
    };

    const startLook = config.lightingLooks[this.currentLighting];
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.scene.fog = null;

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(
      config.scale.fov ?? 32,
      w / h,
      Math.max(0.05, config.scale.minCamDist * 0.04),
      Math.max(250, config.scale.maxCamDist * 4)
    );
    this.camera.position.set(...config.scale.defaultCamPos);

    this.renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor('#000000', 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = startLook.tone;
    this.renderer.toneMappingExposure = startLook.exposure;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = config.scale.minCamDist;
    this.controls.maxDistance = config.scale.maxCamDist;
    this.controls.target.set(...config.scale.defaultCamTarget);
    this.controls.update();

    this.driver = createDriver((p) => {
      if (this.disposed) return;
      this.loadState.texturesLoaded = p.loaded;
      this.loadState.texturesTotal = Math.max(1, p.total);
      if (p.lastUrl) this.loadState.currentAsset = p.lastUrl;
      this.emitLoadSnapshot();
    });

    this.keyLight = new THREE.DirectionalLight('#fff8f0', 4.0);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.00025;
    this.keyLight.shadow.normalBias = Math.max(0.005, config.scale.gridSize * 0.0003);
    this.keyLight.shadow.radius = 2.2;

    this.fillLight = new THREE.DirectionalLight('#eef1f6', 0.35);
    this.rimLight = new THREE.DirectionalLight('#ffffff', 0.35);
    this.hemiLight = new THREE.HemisphereLight('#eceef0', '#c8c3ba', 0.65);

    for (let i = 0; i < 4; i++) {
      const u = new THREE.SpotLight('#ffc884', 0, config.scale.gridSize * 0.6, Math.PI / 3.5, 0.85, 1.4);
      u.visible = false;
      this.uplights.push(u);
      this.scene.add(u, u.target);
    }

    this.scene.add(this.keyLight, this.keyLight.target, this.fillLight, this.rimLight, this.hemiLight);
    this.scene.add(this.contentRoot);

    this.applyLighting(this.currentLighting);
    this.preloadHdris(uniqueHdriUrls);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    void this.renderer.init().then(() => {
      if (this.disposed) {
        this.renderer.dispose();
        return;
      }
      this.initialized = true;
      this.handleResize();
      this.setupPostProcessing();

      const isWebGPU = Boolean(
        (this.renderer.backend as unknown as { isWebGPUBackend?: boolean })?.isWebGPUBackend
      );
      const backend: GPUBackendKind = isWebGPU ? 'WebGPU' : 'WebGL2';
      this.loadState.gpuReady = true;
      this.loadState.gpuBackend = backend;
      this.callbacks.onBackendReady?.(backend);
      this.emitLoadSnapshot();
      this.renderer.setAnimationLoop(this.renderFrame);
    });
  }

  private setupPostProcessing(): void {
    try {
      const scenePass = pass(this.scene, this.camera);
      scenePass.setMRT(mrt({ output, normal: normalView }));
      const scenePassColor = scenePass.getTextureNode('output');
      const scenePassNormal = scenePass.getTextureNode('normal');
      const scenePassDepth = scenePass.getTextureNode('depth');

      const scaleFactor = Math.max(0.15, Math.min(1.5, this.config.scale.gridSize / 80));
      const aoPass = ao(scenePassDepth, scenePassNormal, this.camera);
      aoPass.resolutionScale = 0.5;
      aoPass.radius.value = 0.55 * scaleFactor;
      aoPass.distanceExponent.value = 1.4;
      aoPass.thickness.value = 1.4 * scaleFactor;
      aoPass.scale.value = 1.0;
      aoPass.samples.value = 16;

      const denoisePass = denoise(aoPass.getTextureNode(), scenePassDepth, scenePassNormal, this.camera);
      denoisePass.radius.value = 6;
      denoisePass.lumaPhi.value = 10;
      denoisePass.depthPhi.value = 2;
      denoisePass.normalPhi.value = 3;

      // Preserve exact MSAA silhouette & glass coverage while keeping the background pure #ffffff
      const alpha = clamp(scenePassColor.a, float(0.0), float(1.0));
      const unpremulRGB = scenePassColor.rgb.div(max(alpha, float(0.0001)));

      const aoFactor = mix(float(1.0), denoisePass.r, this.aoStrengthUniform);
      const litWithAO = vec4(unpremulRGB.mul(aoFactor), float(1.0));
      const displayNode = renderOutput(litWithAO);

      const lumaCoeff = vec3(0.2126, 0.7152, 0.0722);
      const dir = screenUV.sub(vec2(0.5, 0.5));
      const wb = vec3(
        float(1.0).add(this.gradeTemperature.mul(0.35)),
        float(1.0).add(this.gradeTemperature.mul(0.05)),
        float(1.0).sub(this.gradeTemperature.mul(0.4))
      );
      const colWB = displayNode.rgb.mul(wb);
      const luma0 = dot(colWB, lumaCoeff);
      const toned = mix(this.gradeShadowTint, this.gradeHighlightTint, smoothstep(0.05, 0.75, luma0));
      const tonedLuma = max(dot(toned, lumaCoeff), float(0.001));
      const colSplit = mix(colWB, colWB.mul(toned).div(tonedLuma), this.gradeSplitTone);
      const colContrast = colSplit.sub(0.5).mul(this.gradeContrast).add(0.5);
      const luma1 = dot(colContrast, lumaCoeff);
      const colSat = mix(vec3(luma1), colContrast, this.gradeSaturation);
      const vig = smoothstep(0.35, 0.95, length(dir.mul(vec2(1.0, 0.8))).mul(1.25));
      const colVig = colSat.mul(float(1.0).sub(vig.mul(this.gradeVignette)));
      const grainSeed = screenUV.mul(1.7).add(fract(this.gradeTime.mul(7.13)));
      const grainNoise = fract(sin(dot(grainSeed, vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5);
      const midWeight = float(0.4).add(float(0.6).mul(float(1.0).sub(abs(luma1.sub(0.5)).mul(2.0))));
      const colGraded = clamp(colVig.add(grainNoise.mul(this.gradeGrain).mul(midWeight)), 0.0, 1.0);

      // Composite graded scene cleanly over pure minimalist white backdrop (#ffffff)
      const finalRGB = mix(vec3(1.0, 1.0, 1.0), colGraded, alpha);

      const pp = new THREE.PostProcessing(this.renderer);
      pp.outputColorTransform = false;
      pp.outputNode = vec4(finalRGB, float(1.0));
      this.postProcessing = pp;
    } catch {
      this.postProcessing = null;
      this.postFXFailed = true;
    }
  }

  public setPostFXEnabled(enabled: boolean): void {
    this.postFXEnabled = enabled;
    this.aoStrengthUniform.value = enabled ? 0.82 : 0.0;
  }

  private emitLoadSnapshot(): void {
    this.callbacks.onLoadSnapshot?.({ ...this.loadState });
  }

  private preloadHdris(urls: string[]): void {
    let completed = 0;
    for (const url of urls) {
      this.rgbeLoader.load(
        url,
        (hdrTex) => {
          if (this.disposed) {
            hdrTex.dispose();
            return;
          }
          hdrTex.mapping = THREE.EquirectangularReflectionMapping;
          this.hdriCache.set(url, hdrTex);
          const curLook = this.config.lightingLooks[this.currentLighting];
          if (curLook.hdriUrl === url) {
            this.scene.environment = hdrTex;
            this.scene.background = null;
            this.driver.setEnvironmentMap(hdrTex);
          }
          completed++;
          this.loadState.hdrisLoaded = completed;
          this.loadState.currentAsset = url;
          this.emitLoadSnapshot();
        },
        undefined,
        () => {
          if (this.disposed) return;
          completed++;
          this.loadState.hdrisLoaded = completed;
          this.emitLoadSnapshot();
        }
      );
    }
  }

  public applyLighting(key: LightingKey): void {
    this.currentLighting = key;
    const L = this.config.lightingLooks[key];

    this.renderer.toneMapping = L.tone;
    this.renderer.toneMappingExposure = L.exposure;
    this.scene.environmentIntensity = L.envIntensity;
    this.scene.background = null;
    this.scene.fog = null;

    this.gradeContrast.value = L.contrast;
    this.gradeSaturation.value = L.saturation;
    this.gradeVignette.value = L.vignette;
    this.gradeGrain.value = L.grain;
    this.gradeTemperature.value = L.temperature;
    this.gradeShadowTint.value.set(L.shadowTint);
    this.gradeHighlightTint.value.set(L.highlightTint);
    this.gradeSplitTone.value = L.splitTone;

    const cached = this.hdriCache.get(L.hdriUrl);
    if (cached) {
      this.scene.environment = cached;
      this.driver.setEnvironmentMap(cached);
    }

    this.driver.onLightingChange(this.currentStyle, key);
    this.positionStudioLights();
  }

  private positionStudioLights(): void {
    const L = this.config.lightingLooks[this.currentLighting];
    const center = new THREE.Vector3(...this.config.scale.defaultCamTarget);
    const size = new THREE.Vector3(
      this.config.scale.gridSize * 0.2,
      this.config.scale.gridSize * 0.12,
      this.config.scale.gridSize * 0.2
    );
    if (!this.currentBounds.isEmpty()) {
      this.currentBounds.getCenter(center);
      this.currentBounds.getSize(size);
      center.y = Math.max(size.y * 0.42, 0.2);
    }

    const r = Math.max(1.5, 0.5 * Math.hypot(size.x, size.z, size.y));
    const dist = Math.max(r * 3.0, this.config.scale.gridSize * 0.35);

    this.keyLight.color.set(L.keyColor);
    this.keyLight.intensity = L.keyIntensity;
    this.keyLight.position.copy(center).addScaledVector(dirFrom(L.keyAzimuth, L.keyElevation), dist);
    this.keyLight.target.position.copy(center);
    this.keyLight.target.updateMatrixWorld();
    this.keyLight.shadow.radius = L.keySoftness;

    const reach = Math.max(r * 2.2, this.config.scale.gridSize * 0.22);
    const cam = this.keyLight.shadow.camera;
    cam.left = -reach;
    cam.right = reach;
    cam.top = reach;
    cam.bottom = -reach;
    cam.near = Math.max(dist - reach * 2.2, 0.2);
    cam.far = dist + reach * 2.6;
    cam.updateProjectionMatrix();

    this.fillLight.color.set(L.fillColor);
    this.fillLight.intensity = L.fillIntensity;
    this.fillLight.position.copy(center).addScaledVector(dirFrom(L.fillAzimuth, L.fillElevation), dist);

    this.rimLight.color.set(L.rimColor);
    this.rimLight.intensity = L.rimIntensity;
    this.rimLight.position.copy(center).addScaledVector(dirFrom(L.rimAzimuth, L.rimElevation), dist);

    this.hemiLight.color.set(L.skyColor);
    this.hemiLight.groundColor.set(L.groundColor);
    this.hemiLight.intensity = L.hemiIntensity;

    const hw = Math.max(1.2, size.x * 0.5);
    const hl = Math.max(1.2, size.z * 0.5);
    const pad = Math.max(0.9, r * 0.22);
    const spots: [number, number, number, number][] = [
      [center.x, center.z + hl + pad, center.x, center.z + hl * 0.6],
      [center.x, center.z - hl - pad, center.x, center.z - hl * 0.6],
      [center.x + hw + pad, center.z, center.x + hw * 0.6, center.z],
      [center.x - hw - pad, center.z, center.x - hw * 0.6, center.z],
    ];
    this.uplights.forEach((u, i) => {
      const [px, pz, tx, tz] = spots[i];
      u.position.set(px, Math.max(0.18, size.y * 0.08), pz);
      u.target.position.set(tx, Math.max(0.5, size.y * 0.6), tz);
      u.target.updateMatrixWorld();
      u.color.set(L.uplightColor);
      u.distance = Math.max(6, r * 3.5);
      u.intensity = L.uplights * Math.max(3.5, r * 1.4);
      u.visible = L.uplights > 0.001;
    });
  }

  public updateContent(
    state: MassingState,
    style: StyleKey,
    toggleA: boolean,
    toggleB: boolean
  ): void {
    this.lastState = state;
    this.currentStyle = style;
    this.lastToggleA = toggleA;
    this.lastToggleB = toggleB;

    while (this.contentRoot.children.length > 0) {
      const child = this.contentRoot.children[0];
      this.contentRoot.remove(child);
      child.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
      });
    }

    this.driver.onLightingChange(style, this.currentLighting);
    const res = this.driver.generate(state, style, this.currentLighting, toggleA, toggleB);
    this.contentRoot.add(res.group);
    this.currentBounds.copy(res.bounds);
    this.currentTick = res.onTick;

    // Guarantee explicit envMap on cached materials for Three r172 WebGPU
    const cachedHdri = this.hdriCache.get(this.config.lightingLooks[this.currentLighting].hdriUrl);
    if (cachedHdri) this.driver.setEnvironmentMap(cachedHdri);

    this.positionStudioLights();
  }

  public isFullyWarmedUp(): boolean {
    return this.loadState.warmedUp;
  }

  private handleResize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private renderFrame = (): void => {
    if (this.disposed || !this.initialized) return;

    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.elapsed += dt;
    this.gradeTime.value += dt;

    this.controls.update();
    this.currentTick?.(dt, this.elapsed);

    if (this.postProcessing && this.postFXEnabled && !this.postFXFailed) {
      try {
        this.postProcessing.render();
      } catch {
        this.postFXFailed = true;
        this.renderer.render(this.scene, this.camera);
      }
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    if (
      !this.loadState.warmedUp &&
      this.loadState.gpuReady &&
      this.loadState.texturesLoaded >= this.loadState.texturesTotal &&
      this.loadState.hdrisLoaded >= this.loadState.hdrisTotal &&
      this.contentRoot.children.length > 0
    ) {
      this.warmupFramesRemaining--;
      if (this.warmupFramesRemaining <= 0) {
        this.loadState.warmedUp = true;
        this.loadState.currentAsset = 'Studio Ready';
        this.emitLoadSnapshot();
      }
    }
    void this.lastState; void this.lastToggleA; void this.lastToggleB;
  };

  public dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    while (this.contentRoot.children.length > 0) {
      const child = this.contentRoot.children[0];
      this.contentRoot.remove(child);
      child.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
      });
    }
    for (const tex of this.hdriCache.values()) tex.dispose();
    this.hdriCache.clear();
    this.driver.dispose();
    this.controls.dispose();
    this.postProcessing = null;
    if (this.initialized) {
      this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
    }
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
