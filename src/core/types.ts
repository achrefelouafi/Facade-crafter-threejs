import * as THREE from 'three/webgpu';

export type FaceDir = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export type Vec3 = [number, number, number];

export interface Rect2D {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

export interface MassingBox {
  id: string;
  min: Vec3;
  max: Vec3;
  createdStep: number;
}

export interface FaceSubdivision {
  boxId: string;
  dir: FaceDir;
  rects: Rect2D[];
}

export interface MassingFace {
  id: string;
  boxId: string;
  dir: FaceDir;
  plane: number;
  rect: Rect2D;
  normal: Vec3;
  corners: [Vec3, Vec3, Vec3, Vec3];
  center: Vec3;
  width: number;
  height: number;
  locked: boolean;
  createdStep: number;
}

export interface MassingState {
  boxes: MassingBox[];
  subdivisions: FaceSubdivision[];
  step: number;
}

export type ToolMode = 'extrude' | 'setback' | 'split' | 'inset';
export type SplitAxis = 'auto' | 'u' | 'v' | 'grid';

export type StyleKey = 'style-a' | 'style-b' | 'style-c';
export type LightingKey = 'mood-a' | 'mood-b' | 'mood-c';

export interface DragPreviewInfo {
  active: boolean;
  delta: number;
  isSetback: boolean;
  isCarve: boolean;
  screenX: number;
  screenY: number;
  label: string;
}

export interface MetricItem {
  label: string;
  value: string;
}

export interface PresetDef {
  id: string;
  label: string;
  defaultStyle?: StyleKey;
  boxes: { min: Vec3; max: Vec3 }[];
}

export interface StyleOption {
  id: StyleKey;
  label: string;
  accent: string;
}

export interface LightingOption {
  id: LightingKey;
  label: string;
  icon: 'sun' | 'sunrise' | 'moon';
  activeClass: 'active' | 'active-amber' | 'active-violet';
  title: string;
}

export interface ToggleOption {
  label: string;
  title: string;
  defaultValue: boolean;
}

export interface MassingScaleConfig {
  /** Primary vertical snap increment in meters (e.g. 3.6 building, 0.9 kitchen, 0.45 sofa) */
  verticalSnap: number;
  /** Primary horizontal snap increment in meters */
  horizontalSnap: number;
  /** Fine Alt-key / free snap increment in meters */
  fineSnap: number;
  /** Minimum surviving box extent in meters */
  minBoxSize: number;
  /** Magnetic snap-to-ground threshold when pulling -y faces downward */
  groundSnapThreshold: number;
  /** Default inset/setback margin in meters */
  defaultInset: number;
  /** Quick-action outward extrude distance for side faces */
  sideStepOut: number;
  /** Quick-action button label for vertical +y extrude */
  verticalStepLabel: string;
  /** Quick-action button label for side extrude */
  sideStepLabel: string;
  /** Snap toggle button label */
  snapLabel: string;
  /** CAD grid total size in meters */
  gridSize: number;
  /** CAD minor grid subdivisions */
  gridMinorDivs: number;
  /** CAD major grid subdivisions */
  gridMajorDivs: number;
  /** CAD camera min/max orbit distance */
  minCamDist: number;
  maxCamDist: number;
  /** Initial camera position & target */
  defaultCamPos: Vec3;
  defaultCamTarget: Vec3;
  /** Camera FOV in degrees (32° telephoto default) */
  fov?: number;
}

export interface StudioLook {
  hdriUrl: string;
  useFlatBackdrop: boolean;
  backdropColor: string;
  exposure: number;
  envIntensity: number;
  bgIntensity: number;
  tone: THREE.ToneMapping;
  keyColor: string;
  keyIntensity: number;
  keyAzimuth: number;
  keyElevation: number;
  keySoftness: number;
  fillColor: string;
  fillIntensity: number;
  fillAzimuth: number;
  fillElevation: number;
  rimColor: string;
  rimIntensity: number;
  rimAzimuth: number;
  rimElevation: number;
  skyColor: string;
  groundColor: string;
  hemiIntensity: number;
  fogColor: string;
  fogDensity: number;
  uplightColor: string;
  uplights: number;
  contrast: number;
  saturation: number;
  vignette: number;
  grain: number;
  temperature: number;
  shadowTint: string;
  highlightTint: string;
  splitTone: number;
}

export interface GeneratedSceneResult {
  group: THREE.Group;
  bounds: THREE.Box3;
  onTick?: (dt: number, elapsed: number) => void;
}

export interface ProjectConfig {
  id: string;
  name: string;
  subtitle: string;
  rightBadgeSub: string;
  repoSlug: string;
  scale: MassingScaleConfig;
  presets: PresetDef[];
  styles: [StyleOption, StyleOption, StyleOption];
  lightingOptions: [LightingOption, LightingOption, LightingOption];
  defaultLighting: LightingKey;
  lightingLooks: Record<LightingKey, StudioLook>;
  toggleA: ToggleOption;
  toggleB: ToggleOption;
  computeMetrics: (state: MassingState, faceCount: number) => MetricItem[];
}

export const EPS = 1e-4;
