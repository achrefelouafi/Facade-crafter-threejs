import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import {
  DragPreviewInfo,
  FaceDir,
  LightingKey,
  MassingFace,
  MassingState,
  SplitAxis,
  StyleKey,
  ToolMode,
} from './core/types';
import {
  applyExtrude,
  applyInsetFace,
  applySplitFace,
  computeExposedFaces,
  computeStateBounds,
  createMassingFromBoxes,
} from './core/massingEngine';
import { dirLabel } from './core/math2d';
import { MassingViewport } from './viewports/MassingViewport';
import {
  GPUBackendKind,
  StudioLoadSnapshot,
  WebGPUStudioViewport,
} from './viewports/WebGPUStudioViewport';
import { CameraSyncManager } from './viewports/CameraSync';
import { SplitPane } from './components/SplitPane';
import { TopBar } from './components/TopBar';
import { MassingToolbar } from './components/MassingToolbar';
import { RightControls } from './components/RightControls';
import { LoadingOverlay } from './components/LoadingOverlay';
import { ContactCard } from './components/ContactCard';
import { PROJECT_CONFIG, createProjectDriver } from './project/index';

interface HistoryState {
  past: MassingState[];
  present: MassingState;
  future: MassingState[];
}

function findPrimaryFaceId(state: MassingState): string | null {
  const faces = computeExposedFaces(state).filter((f) => !f.locked);
  const tops = faces.filter((f) => f.dir === '+y');
  if (tops.length > 0) {
    tops.sort((a, b) => b.plane - a.plane);
    return tops[0].id;
  }
  return faces[0]?.id ?? null;
}

declare global {
  interface Window {
    __vcStudio?: {
      isReady: () => boolean;
      setCamera: (pos: [number, number, number], target: [number, number, number]) => void;
      getCamera: () => { pos: [number, number, number]; target: [number, number, number] };
      selectPreset: (id: string) => void;
      selectStyle: (id: StyleKey) => void;
      selectLighting: (id: LightingKey) => void;
      setPostFX: (enabled: boolean) => void;
      setCaptureMode: (enabled: boolean) => void;
      setToggleA: (enabled: boolean) => void;
      setToggleB: (enabled: boolean) => void;
      selectFaceByDir: (
        dir: FaceDir,
        mode?: 'largest' | 'highest' | 'lowest' | 'smallest' | 'center-lower',
        index?: number
      ) => boolean;
      previewExtrude: (delta: number, isSetback?: boolean) => void;
      commitExtrude: (delta: number, isSetback?: boolean) => void;
      splitSelected: (axis?: SplitAxis, ratio?: number) => void;
      insetSelected: () => void;
      resetCamera: () => void;
      getPresets: () => string[];
      getBounds: () => { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
    };
  }
}

export const App: React.FC = () => {
  const config = PROJECT_CONFIG;
  const initialMassing = useMemo(() => createMassingFromBoxes(config.presets[0].boxes), [config]);

  const [history, setHistory] = useState<HistoryState>(() => ({
    past: [],
    present: initialMassing,
    future: [],
  }));
  const [selectedFaceId, setSelectedFaceId] = useState<string | null>(() => findPrimaryFaceId(initialMassing));
  const [hoveredFace, setHoveredFace] = useState<MassingFace | null>(null);
  const [dragInfo, setDragInfo] = useState<DragPreviewInfo | null>(null);
  const [activePreset, setActivePreset] = useState<string | null>(config.presets[0].id);

  const [toolMode, setToolMode] = useState<ToolMode>('extrude');
  const [splitAxis, setSplitAxis] = useState<SplitAxis>('auto');
  const [floorSnap, setFloorSnap] = useState<boolean>(true);

  const [style, setStyle] = useState<StyleKey>('style-a');
  const [lighting, setLighting] = useState<LightingKey>(config.defaultLighting);
  const [toggleA, setToggleA] = useState<boolean>(config.toggleA.defaultValue);
  const [toggleB, setToggleB] = useState<boolean>(config.toggleB.defaultValue);
  const [postFX, setPostFX] = useState<boolean>(true);
  const [cameraSync, setCameraSync] = useState<boolean>(true);
  const [gpuBackend, setGpuBackend] = useState<GPUBackendKind | null>(null);
  const [massingReady, setMassingReady] = useState<boolean>(false);
  const [loadSnapshot, setLoadSnapshot] = useState<StudioLoadSnapshot>({
    gpuReady: false,
    gpuBackend: null,
    texturesLoaded: 0,
    texturesTotal: 1,
    hdrisLoaded: 0,
    hdrisTotal: 3,
    currentAsset: 'Initializing WebGPU…',
    warmedUp: false,
  });

  const [previewState, setPreviewState] = useState<MassingState | null>(null);

  const leftHostRef = useRef<HTMLDivElement | null>(null);
  const rightHostRef = useRef<HTMLDivElement | null>(null);
  const massingVpRef = useRef<MassingViewport | null>(null);
  const studioVpRef = useRef<WebGPUStudioViewport | null>(null);
  const syncRef = useRef<CameraSyncManager | null>(null);

  const stateRef = useRef<MassingState>(history.present);
  stateRef.current = history.present;
  const selectedFaceIdRef = useRef<string | null>(selectedFaceId);
  selectedFaceIdRef.current = selectedFaceId;

  const commitState = useCallback((next: MassingState, nextFocusFaceId: string | null) => {
    setHistory((h) => ({
      past: [...h.past.slice(-49), h.present],
      present: next,
      future: [],
    }));
    setActivePreset(null);
    setSelectedFaceId(nextFocusFaceId);
  }, []);

  const handleCommitExtrude = useCallback(
    (face: MassingFace, distance: number, insetMargin: number) => {
      const res = applyExtrude(stateRef.current, face, distance, insetMargin, config.scale);
      if (res.state !== stateRef.current) {
        commitState(res.state, res.newFaceId);
      }
    },
    [commitState, config.scale]
  );

  const handleCommitSplit = useCallback(
    (face: MassingFace, axis: SplitAxis, ratio: number) => {
      const res = applySplitFace(stateRef.current, face, axis, ratio, config.scale);
      if (res.state !== stateRef.current) {
        commitState(res.state, res.newFaceId);
      }
    },
    [commitState, config.scale]
  );

  const handleCommitInset = useCallback(
    (face: MassingFace, margin: number) => {
      const res = applyInsetFace(stateRef.current, face, margin, config.scale);
      if (res.state !== stateRef.current) {
        commitState(res.state, res.newFaceId);
        setToolMode('extrude');
      }
    },
    [commitState, config.scale]
  );

  useEffect(() => {
    if (!leftHostRef.current || !rightHostRef.current) return;
    setMassingReady(false);

    const massingVp = new MassingViewport(leftHostRef.current, config.scale, {
      onReady: () => setMassingReady(true),
      onSelectFace: (face) => setSelectedFaceId(face ? face.id : null),
      onHoverFace: (face) => setHoveredFace(face),
      onPreviewState: (preview) => setPreviewState(preview),
      onDragInfo: (info) => setDragInfo(info),
      onCommitExtrude: handleCommitExtrude,
      onCommitSplit: handleCommitSplit,
      onCommitInset: handleCommitInset,
    });

    const studioVp = new WebGPUStudioViewport(
      rightHostRef.current,
      config,
      createProjectDriver,
      {
        onBackendReady: (b) => setGpuBackend(b),
        onLoadSnapshot: (s) => setLoadSnapshot(s),
      }
    );

    const sync = new CameraSyncManager(massingVp, studioVp, true);
    massingVpRef.current = massingVp;
    studioVpRef.current = studioVp;
    syncRef.current = sync;

    return () => {
      sync.dispose();
      massingVp.dispose();
      studioVp.dispose();
      syncRef.current = null;
      massingVpRef.current = null;
      studioVpRef.current = null;
    };
  }, [config, handleCommitExtrude, handleCommitInset, handleCommitSplit]);

  useEffect(() => {
    massingVpRef.current?.setMassingState(history.present, selectedFaceId);
  }, [history.present, selectedFaceId]);

  useEffect(() => { massingVpRef.current?.setToolMode(toolMode); }, [toolMode]);
  useEffect(() => { massingVpRef.current?.setSplitAxis(splitAxis); }, [splitAxis]);
  useEffect(() => { massingVpRef.current?.setFloorSnap(floorSnap); }, [floorSnap]);

  const activeState = previewState ?? history.present;
  useEffect(() => {
    studioVpRef.current?.updateContent(activeState, style, toggleA, toggleB);
  }, [activeState, style, toggleA, toggleB]);

  useEffect(() => { studioVpRef.current?.applyLighting(lighting); }, [lighting]);
  useEffect(() => { studioVpRef.current?.setPostFXEnabled(postFX); }, [postFX]);
  useEffect(() => { syncRef.current?.setEnabled(cameraSync); }, [cameraSync]);

  const exposedFaces = useMemo(() => computeExposedFaces(history.present), [history.present]);
  const selectedFace = useMemo(
    () => exposedFaces.find((f) => f.id === selectedFaceId && !f.locked) ?? null,
    [exposedFaces, selectedFaceId]
  );

  const metrics = useMemo(() => {
    const activeFaces = previewState ? computeExposedFaces(previewState) : exposedFaces;
    return config.computeMetrics(activeState, activeFaces.filter((f) => !f.locked).length);
  }, [activeState, exposedFaces, previewState, config]);

  const frameStateCamera = useCallback(
    (state: MassingState) => {
      const b = computeStateBounds(state);
      const cx = (b.minX + b.maxX) * 0.5;
      const cz = (b.minZ + b.maxZ) * 0.5;
      const spanX = b.maxX - b.minX;
      const spanY = (b.maxY - b.minY) + 2.0; // Include Mansard roof / chimney / roaster flue height cleanly!
      const spanZ = b.maxZ - b.minZ;
      const defPos = new THREE.Vector3(...config.scale.defaultCamPos);
      const defTarget = new THREE.Vector3(...config.scale.defaultCamTarget);
      const baseDir = defPos.clone().sub(defTarget);
      const baseDist = baseDir.length();
      baseDir.normalize();

      const radius = Math.hypot(Math.max(spanX, spanZ) * 0.56, spanY * 0.62);
      const dist = Math.max(baseDist * 0.84, radius * 3.22);
      const target = new THREE.Vector3(cx, Math.max(defTarget.y * 0.62, b.minY + spanY * 0.44), cz);
      const pos = target.clone().addScaledVector(baseDir, dist);
      syncRef.current?.resetBoth(target, pos);
    },
    [config.scale]
  );

  const handleSelectPreset = useCallback(
    (presetId: string) => {
      const found = config.presets.find((p) => p.id === presetId) ?? config.presets[0];
      const next = createMassingFromBoxes(found.boxes);
      setHistory((h) => ({
        past: [...h.past.slice(-49), h.present],
        present: next,
        future: [],
      }));
      setActivePreset(found.id);
      if (found.defaultStyle) setStyle(found.defaultStyle);
      setSelectedFaceId(findPrimaryFaceId(next));
      setToolMode('extrude');
      frameStateCamera(next);
    },
    [config.presets, frameStateCamera]
  );

  const handleResetCamera = useCallback(() => {
    frameStateCamera(stateRef.current);
  }, [frameStateCamera]);

  const handleUndo = useCallback(() => {
    setHistory((h) => {
      if (h.past.length === 0) return h;
      const prev = h.past[h.past.length - 1];
      setSelectedFaceId(findPrimaryFaceId(prev));
      setActivePreset(null);
      return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
    });
  }, []);

  const handleRedo = useCallback(() => {
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const next = h.future[0];
      setSelectedFaceId(findPrimaryFaceId(next));
      setActivePreset(null);
      return { past: [...h.past, h.present], present: next, future: h.future.slice(1) };
    });
  }, []);

  // Expose live interactive choreography API for automated QA & 1080p viral video capture
  useEffect(() => {
    window.__vcStudio = {
      isReady: () => Boolean(massingReady && studioVpRef.current?.isFullyWarmedUp()),
      setCamera: (pos, target) => {
        syncRef.current?.resetBoth(new THREE.Vector3(...target), new THREE.Vector3(...pos));
      },
      getCamera: () => {
        const vp = studioVpRef.current;
        if (!vp) return { pos: config.scale.defaultCamPos, target: config.scale.defaultCamTarget };
        const p = vp.camera.position, t = vp.controls.target;
        return { pos: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
      },
      selectPreset: (id) => handleSelectPreset(id),
      selectStyle: (id) => setStyle(id),
      selectLighting: (id) => setLighting(id),
      setPostFX: (enabled) => setPostFX(enabled),
      setCaptureMode: (enabled) => {
        if (massingVpRef.current) massingVpRef.current.controls.enableDamping = !enabled;
        if (studioVpRef.current) studioVpRef.current.controls.enableDamping = !enabled;
      },
      setToggleA: (enabled) => setToggleA(enabled),
      setToggleB: (enabled) => setToggleB(enabled),
      selectFaceByDir: (dir, mode = 'largest', index = 0) => {
        let faces = computeExposedFaces(stateRef.current).filter((f) => !f.locked && f.dir === dir);
        if (faces.length === 0) return false;
        if (mode === 'center-lower') {
          const lower = faces.filter((f) => f.center[1] < 4.5);
          if (lower.length > 0) faces = lower;
          faces.sort(
            (a, b) =>
              b.width * b.height - a.width * a.height ||
              Math.abs(a.center[0]) - Math.abs(b.center[0])
          );
        } else if (mode === 'highest') {
          faces.sort((a, b) => b.center[1] - a.center[1] || b.width * b.height - a.width * a.height);
        } else if (mode === 'lowest') {
          faces.sort((a, b) => a.center[1] - b.center[1] || b.width * b.height - a.width * a.height);
        } else if (mode === 'smallest') {
          faces.sort((a, b) => a.width * a.height - b.width * b.height);
        } else {
          faces.sort((a, b) => b.width * b.height - a.width * a.height);
        }
        const picked = faces[Math.min(Math.max(0, index), faces.length - 1)];
        setSelectedFaceId(picked.id);
        return true;
      },
      previewExtrude: (delta, isSetback = false) => {
        const faces = computeExposedFaces(stateRef.current);
        const f = faces.find((x) => x.id === selectedFaceIdRef.current && !x.locked);
        if (!f) return;
        massingVpRef.current?.showProgrammaticDragPreview(f, delta, isSetback);
        const inset = isSetback && delta > 0 ? config.scale.defaultInset : 0;
        if (Math.abs(delta) >= config.scale.minBoxSize * 0.25) {
          const res = applyExtrude(stateRef.current, f, delta, inset, config.scale);
          setPreviewState(res.state);
        } else {
          setPreviewState(null);
        }
      },
      commitExtrude: (delta, isSetback = false) => {
        const faces = computeExposedFaces(stateRef.current);
        const f = faces.find((x) => x.id === selectedFaceIdRef.current && !x.locked);
        massingVpRef.current?.showProgrammaticDragPreview(null, 0, false);
        setPreviewState(null);
        if (!f) return;
        const inset = isSetback && delta > 0 ? config.scale.defaultInset : 0;
        handleCommitExtrude(f, delta, inset);
      },
      splitSelected: (axis = 'auto', ratio = 0.5) => {
        const faces = computeExposedFaces(stateRef.current);
        const f = faces.find((x) => x.id === selectedFaceIdRef.current && !x.locked);
        if (f) handleCommitSplit(f, axis, ratio);
      },
      insetSelected: () => {
        const faces = computeExposedFaces(stateRef.current);
        const f = faces.find((x) => x.id === selectedFaceIdRef.current && !x.locked);
        if (f) handleCommitInset(f, config.scale.defaultInset);
      },
      resetCamera: () => handleResetCamera(),
      getPresets: () => config.presets.map((p) => p.id),
      getBounds: () => computeStateBounds(stateRef.current),
    };
    return () => { delete window.__vcStudio; };
  }, [
    config,
    massingReady,
    handleSelectPreset,
    handleCommitExtrude,
    handleCommitSplit,
    handleCommitInset,
    handleResetCamera,
  ]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo(); else handleUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === 'y') { e.preventDefault(); handleRedo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (key === 'e') setToolMode('extrude');
      else if (key === 's') setToolMode('setback');
      else if (key === 'k') setToolMode('split');
      else if (key === 'i') setToolMode('inset');
      else if (key === 'g') setFloorSnap((v) => !v);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleRedo, handleUndo]);

  const activeStyleAccent =
    config.styles.find((s) => s.id === style)?.accent ?? '#e2c08d';

  return (
    <div className="app-shell">
      <LoadingOverlay
        title={config.name}
        subtitle={config.subtitle}
        massingReady={massingReady}
        snapshot={loadSnapshot}
      />

      <TopBar
        config={config}
        activePreset={activePreset}
        metrics={metrics}
        cameraSync={cameraSync}
        onSelectPreset={handleSelectPreset}
        onToggleCameraSync={() => setCameraSync((v) => !v)}
        onResetCamera={handleResetCamera}
      />

      <SplitPane
        left={
          <div className="viewport-pane">
            <div ref={leftHostRef} className="canvas-host" />
            <div className="viewport-header">
              <div className="view-badge">
                <span className="view-dot cad" />
                <span className="view-badge-title">MASSING STUDIO</span>
                <span className="view-badge-sub">Programmatic Face Extrusion</span>
              </div>
              {hoveredFace && !dragInfo && (
                <div className="hover-pill">
                  {dirLabel(hoveredFace.dir)} · {hoveredFace.width.toFixed(2)}×{hoveredFace.height.toFixed(2)}m
                </div>
              )}
            </div>

            <MassingToolbar
              scale={config.scale}
              toolMode={toolMode}
              splitAxis={splitAxis}
              floorSnap={floorSnap}
              canUndo={history.past.length > 0}
              canRedo={history.future.length > 0}
              selectedFace={selectedFace}
              onToolChange={setToolMode}
              onSplitAxisChange={setSplitAxis}
              onToggleFloorSnap={() => setFloorSnap((v) => !v)}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onResetBox={() => handleSelectPreset(config.presets[0].id)}
              onQuickExtrude={(dist, inset = 0) => selectedFace && handleCommitExtrude(selectedFace, dist, inset)}
              onQuickSplit={() => selectedFace && handleCommitSplit(selectedFace, splitAxis, 0.5)}
              onQuickInset={() => selectedFace && handleCommitInset(selectedFace, config.scale.defaultInset)}
            />
          </div>
        }
        right={
          <div className="viewport-pane">
            <div ref={rightHostRef} className="canvas-host" />
            <div className="viewport-header">
              <div className="view-badge">
                <span className="view-dot pbr" />
                <span className="view-badge-title">PROCEDURAL PBR</span>
                <span className="view-badge-sub">{config.rightBadgeSub}</span>
              </div>
              <div className="right-status-pills">
                {gpuBackend && (
                  <div className={`status-pill ${gpuBackend === 'WebGPU' ? 'webgpu' : 'webgl'}`}>
                    <span className="status-dot" />
                    {gpuBackend}
                  </div>
                )}
              </div>
            </div>

            <RightControls
              config={config}
              style={style}
              lighting={lighting}
              postFX={postFX}
              toggleA={toggleA}
              toggleB={toggleB}
              onStyleChange={setStyle}
              onLightingChange={setLighting}
              onTogglePostFX={() => setPostFX((v) => !v)}
              onToggleA={() => setToggleA((v) => !v)}
              onToggleB={() => setToggleB((v) => !v)}
            />

            <ContactCard
              accent={activeStyleAccent}
              repoSlug={config.repoSlug}
              ready={massingReady && loadSnapshot.warmedUp}
            />
          </div>
        }
      />

      {dragInfo && dragInfo.active && (
        <div
          className={`drag-tooltip ${dragInfo.isCarve ? 'carve' : dragInfo.isSetback ? 'setback' : ''}`}
          style={{ left: dragInfo.screenX, top: dragInfo.screenY }}
        >
          {dragInfo.label}
        </div>
      )}
    </div>
  );
};
