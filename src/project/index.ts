import * as THREE from 'three/webgpu';
import {
  GeneratedSceneResult,
  LightingKey,
  MassingState,
  ProjectConfig,
  StyleKey,
} from '../core/types';
import { TextureLoadProgress } from '../building/pbrHelpers';
import { ProjectSceneDriver } from '../viewports/WebGPUStudioViewport';
import { ShopfrontMaterials } from './materials';
import {
  computeShopfrontMetrics,
  DynamicShopLight,
  generateShopfrontScene,
} from './generator';

export const PROJECT_CONFIG: ProjectConfig = {
  id: '08-facade-craft',
  name: 'Facade Crafter',
  subtitle: 'Boutique Storefront & Café Studio',
  rightBadgeSub: 'Boutique Facade & Café PBR',
  repoSlug: 'Facade-crafter-threejs',
  scale: {
    verticalSnap: 3.4,
    horizontalSnap: 1.5,
    fineSnap: 0.5,
    minBoxSize: 1.4,
    groundSnapThreshold: 1.2,
    defaultInset: 1.0,
    sideStepOut: 2.5,
    verticalStepLabel: '+1 Story (3.4m)',
    sideStepLabel: '+2.5m Bay',
    snapLabel: 'Bay Snap',
    gridSize: 44,
    gridMinorDivs: 44,
    gridMajorDivs: 11,
    minCamDist: 6,
    maxCamDist: 64,
    defaultCamPos: [19.5, 11.2, 24.5],
    defaultCamTarget: [0, 3.2, 0.5],
  },
  presets: [
    {
      id: 'paris-cafe',
      label: 'Paris Café',
      defaultStyle: 'style-a',
      boxes: [
        { min: [-5.5, 0, -3.5], max: [5.5, 7.2, 3.5] },
      ],
    },
    {
      id: 'corner-bakery',
      label: 'Corner Bistro',
      defaultStyle: 'style-a',
      boxes: [
        { min: [-5.5, 0, -4.5], max: [2.0, 7.2, 3.5] },
        { min: [2.0, 0, -4.5], max: [5.5, 3.8, 1.0] },
        { min: [2.0, 3.8, -4.5], max: [6.0, 7.2, 2.5] },
      ],
    },
    {
      id: 'tokyo-roastery',
      label: 'Tokyo Kissa',
      defaultStyle: 'style-c',
      boxes: [
        { min: [-3.0, 0, -3.0], max: [3.0, 10.6, 3.0] },
      ],
    },
    {
      id: 'soho-row',
      label: 'SoHo Row',
      defaultStyle: 'style-b',
      boxes: [
        { min: [-7.5, 0, -3.5], max: [-2.5, 10.6, 3.5] },
        { min: [-2.5, 0, -3.5], max: [2.5, 7.2, 2.0] },
        { min: [2.5, 0, -3.5], max: [7.5, 7.2, 3.5] },
        { min: [2.5, 7.2, -3.5], max: [7.0, 10.6, 2.0] },
      ],
    },
  ],
  styles: [
    { id: 'style-a', label: 'Paris', accent: '#2f6e5b' },
    { id: 'style-b', label: 'SoHo', accent: '#c4623d' },
    { id: 'style-c', label: 'Tokyo', accent: '#3d5a80' },
  ],
  lightingOptions: [
    {
      id: 'mood-a',
      label: 'Morning',
      icon: 'sun',
      activeClass: 'active',
      title: 'Crisp pale Parisian architectural morning daylight',
    },
    {
      id: 'mood-b',
      label: 'Apéro',
      icon: 'sunrise',
      activeClass: 'active-amber',
      title: 'Warm late-afternoon golden sun across awnings & terrace',
    },
    {
      id: 'mood-c',
      label: 'Evening',
      icon: 'moon',
      activeClass: 'active-violet',
      title: 'Blue-hour café street with glowing vitrines, signage & streetlamps',
    },
  ],
  defaultLighting: 'mood-a',
  lightingLooks: {
    'mood-a': {
      hdriUrl: '/hdri/daylight.hdr',
      useFlatBackdrop: true,
      backdropColor: '#edf0f3',
      exposure: 0.96,
      envIntensity: 0.54,
      bgIntensity: 1.0,
      tone: THREE.NeutralToneMapping,
      keyColor: '#fff9f2',
      keyIntensity: 3.65,
      keyAzimuth: 38,
      keyElevation: 48,
      keySoftness: 2.2,
      fillColor: '#dfe8f5',
      fillIntensity: 0.72,
      fillAzimuth: -125,
      fillElevation: 28,
      rimColor: '#ffffff',
      rimIntensity: 0.45,
      rimAzimuth: -155,
      rimElevation: 36,
      skyColor: '#f2f5f9',
      groundColor: '#cfc9be',
      hemiIntensity: 0.78,
      fogColor: '#edf0f3',
      fogDensity: 0.0042,
      uplightColor: '#ffe8cc',
      uplights: 0.0,
      contrast: 1.05,
      saturation: 1.04,
      vignette: 0.09,
      grain: 0.004,
      temperature: 0.01,
      shadowTint: '#8e98a6',
      highlightTint: '#fffdf9',
      splitTone: 0.04,
    },
    'mood-b': {
      hdriUrl: '/hdri/golden_hour.hdr',
      useFlatBackdrop: false,
      backdropColor: '#a55a38',
      exposure: 0.92,
      envIntensity: 0.62,
      bgIntensity: 0.78,
      tone: THREE.ACESFilmicToneMapping,
      keyColor: '#ffb36b',
      keyIntensity: 4.1,
      keyAzimuth: 58,
      keyElevation: 19,
      keySoftness: 2.8,
      fillColor: '#6b88c4',
      fillIntensity: 0.68,
      fillAzimuth: -115,
      fillElevation: 24,
      rimColor: '#ffd4a0',
      rimIntensity: 0.85,
      rimAzimuth: -145,
      rimElevation: 20,
      skyColor: '#e8b68c',
      groundColor: '#6b5748',
      hemiIntensity: 0.56,
      fogColor: '#c78c66',
      fogDensity: 0.0052,
      uplightColor: '#ffba6b',
      uplights: 0.16,
      contrast: 1.09,
      saturation: 1.12,
      vignette: 0.16,
      grain: 0.006,
      temperature: 0.07,
      shadowTint: '#485a82',
      highlightTint: '#ffe3bc',
      splitTone: 0.09,
    },
    'mood-c': {
      hdriUrl: '/hdri/twilight.hdr',
      useFlatBackdrop: true,
      backdropColor: '#131f44',
      exposure: 1.04,
      envIntensity: 0.28,
      bgIntensity: 0.6,
      tone: THREE.ACESFilmicToneMapping,
      keyColor: '#7ea4e8',
      keyIntensity: 1.15,
      keyAzimuth: -48,
      keyElevation: 38,
      keySoftness: 3.2,
      fillColor: '#4c6cb0',
      fillIntensity: 0.48,
      fillAzimuth: 120,
      fillElevation: 24,
      rimColor: '#98bcff',
      rimIntensity: 0.65,
      rimAzimuth: 150,
      rimElevation: 30,
      skyColor: '#2c4480',
      groundColor: '#282328',
      hemiIntensity: 0.44,
      fogColor: '#131f44',
      fogDensity: 0.0068,
      uplightColor: '#ffbf69',
      uplights: 0.52,
      contrast: 1.1,
      saturation: 1.12,
      vignette: 0.22,
      grain: 0.008,
      temperature: -0.05,
      shadowTint: '#243a75',
      highlightTint: '#ffdfb0',
      splitTone: 0.1,
    },
  },
  toggleA: {
    label: 'Terrace',
    title: 'Toggle sidewalk bistro tables, chalkboard menu, potted bay laurels & streetlamps',
    defaultValue: true,
  },
  toggleB: {
    label: 'Awnings',
    title: 'Toggle striped architectural canvas awnings & projecting backlit blade signs',
    defaultValue: true,
  },
  computeMetrics: (state: MassingState, faceCount: number) => {
    const m = computeShopfrontMetrics(state);
    return [
      { label: 'Stories', value: String(m.stories) },
      { label: 'Vitrines', value: String(m.vitrines) },
      { label: 'Tables', value: String(m.tables) },
      { label: 'Faces', value: String(faceCount) },
    ];
  },
};

export function createProjectDriver(
  onTexProgress: (p: TextureLoadProgress) => void
): ProjectSceneDriver {
  const materials = new ShopfrontMaterials(onTexProgress);
  let activeLights: DynamicShopLight[] = [];
  let currentLighting: LightingKey = PROJECT_CONFIG.defaultLighting;

  const syncLightIntensities = (lighting: LightingKey) => {
    const isEvening = lighting === 'mood-c';
    const isApero = lighting === 'mood-b';
    for (const dl of activeLights) {
      if (dl.kind === 'interior') {
        dl.light.intensity = isEvening ? 6.4 : isApero ? 1.8 : 0.45;
      } else {
        dl.light.intensity = isEvening ? 5.6 : isApero ? 1.1 : 0.0;
      }
      dl.light.visible = dl.light.intensity > 0.01;
    }
  };

  return {
    generate: (
      state: MassingState,
      style: StyleKey,
      lighting: LightingKey,
      toggleA: boolean,
      toggleB: boolean
    ): GeneratedSceneResult => {
      currentLighting = lighting;
      materials.applyMood(lighting);
      const res = generateShopfrontScene(state, style, lighting, toggleA, toggleB, materials);
      activeLights = res.dynamicLights;
      syncLightIntensities(lighting);
      return {
        group: res.group,
        bounds: res.bounds,
      };
    },

    onLightingChange: (_style: StyleKey, lighting: LightingKey) => {
      currentLighting = lighting;
      materials.applyMood(lighting);
      syncLightIntensities(lighting);
    },

    setEnvironmentMap: (envMap: THREE.Texture | null) => {
      materials.setEnvironmentMap(envMap);
      materials.applyMood(currentLighting);
    },

    dispose: () => {
      activeLights = [];
      materials.dispose();
    },
  };
}
