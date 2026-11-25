import * as THREE from 'three/webgpu';
import { Fn, float, vec3, vec4 } from 'three/tsl';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  DragPreviewInfo,
  MassingFace,
  MassingScaleConfig,
  MassingState,
  Rect2D,
  SplitAxis,
  ToolMode,
} from '../core/types';
import {
  applyExtrude,
  computeExposedFaces,
  computeInsetRect,
} from '../core/massingEngine';
import { dirLabel, faceToCorners3D, worldPointToFaceUV } from '../core/math2d';

export interface MassingViewportCallbacks {
  onReady?: () => void;
  onSelectFace: (face: MassingFace | null) => void;
  onHoverFace: (face: MassingFace | null) => void;
  onPreviewState: (preview: MassingState | null) => void;
  onDragInfo: (info: DragPreviewInfo | null) => void;
  onCommitExtrude: (face: MassingFace, distance: number, insetMargin: number) => void;
  onCommitSplit: (face: MassingFace, axis: SplitAxis, ratio: number) => void;
  onCommitInset: (face: MassingFace, margin: number) => void;
}

interface FaceHitEntry {
  mesh: THREE.Mesh;
  face: MassingFace;
}

export class MassingViewport {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly controls: OrbitControls;

  private container: HTMLElement;
  private scaleCfg: MassingScaleConfig;
  private renderer: THREE.WebGPURenderer;
  private scene: THREE.Scene;
  private callbacks: MassingViewportCallbacks;
  private resizeObserver: ResizeObserver;
  private initialized = false;
  private disposed = false;

  private massingGroup = new THREE.Group();
  private overlayGroup = new THREE.Group();
  private gizmoGroup = new THREE.Group();
  private previewGroup = new THREE.Group();

  private state: MassingState | null = null;
  private faces: MassingFace[] = [];
  private faceEntries: FaceHitEntry[] = [];
  private selectedFaceId: string | null = null;
  private hoveredFaceId: string | null = null;
  private toolMode: ToolMode = 'extrude';
  private splitAxis: SplitAxis = 'auto';
  private floorSnap = true;
  private gizmoHovered = false;

  private raycaster = new THREE.Raycaster();
  private pointerNDC = new THREE.Vector2();
  private gizmoHitMeshes: THREE.Object3D[] = [];

  private isDragging = false;
  private pointerDownPos = { x: 0, y: 0 };
  private dragFace: MassingFace | null = null;
  private dragPlane = new THREE.Plane();
  private dragStartHit = new THREE.Vector3();
  private dragUseScreenFallback = false;
  private dragNormalVec = new THREE.Vector3();
  private dragCurrentDelta = 0;
  private dragLastSnapped = 0;
  private dragIsSetback = false;
  private dragLastSetback = false;
  private hoverHitPoint = new THREE.Vector3();

  private clayBaseMat: THREE.MeshStandardMaterial;
  private clayTierMat: THREE.MeshStandardMaterial;
  private clayLockedMat: THREE.MeshStandardMaterial;
  private hoverMat: THREE.MeshBasicMaterial;
  private selectMat: THREE.MeshBasicMaterial;
  private edgeLineMat: THREE.LineBasicMaterial;

  constructor(
    container: HTMLElement,
    scaleCfg: MassingScaleConfig,
    callbacks: MassingViewportCallbacks
  ) {
    this.container = container;
    this.scaleCfg = scaleCfg;
    this.callbacks = callbacks;

    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.scene.fog = null;

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(
      scaleCfg.fov ?? 32,
      w / h,
      Math.max(0.05, scaleCfg.minCamDist * 0.04),
      Math.max(250, scaleCfg.maxCamDist * 4)
    );
    this.camera.position.set(...scaleCfg.defaultCamPos);

    this.renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor('#000000', 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = scaleCfg.minCamDist;
    this.controls.maxDistance = scaleCfg.maxCamDist;
    this.controls.target.set(...scaleCfg.defaultCamTarget);
    this.controls.update();

    this.clayBaseMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#dce4f0'),
      roughness: 0.72,
      metalness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.clayTierMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#e8eff8'),
      roughness: 0.68,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.clayLockedMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#94a3b8'),
      roughness: 0.85,
      metalness: 0.0,
    });
    this.hoverMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#38bdf8'),
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.selectMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color('#0ea5e9'),
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.edgeLineMat = new THREE.LineBasicMaterial({
      color: new THREE.Color('#1e293b'),
      transparent: true,
      opacity: 0.88,
    });

    this.setupStudioEnvironment();
    this.scene.add(this.massingGroup);
    this.scene.add(this.overlayGroup);
    this.scene.add(this.gizmoGroup);
    this.scene.add(this.previewGroup);

    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    void this.renderer.init().then(() => {
      if (this.disposed) {
        this.renderer.dispose();
        return;
      }
      this.initialized = true;
      this.handleResize();
      this.renderer.setAnimationLoop(this.renderFrame);
      this.callbacks.onReady?.();
    });
  }

  private setupStudioEnvironment(): void {
    const gs = this.scaleCfg.gridSize;
    // Clean neutral white studio lighting
    const hemi = new THREE.HemisphereLight('#ffffff', '#d4d4d4', 1.15);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight('#ffffff', 1.45);
    key.position.set(gs * 0.25, gs * 0.4, gs * 0.22);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = Math.max(0.2, gs * 0.02);
    key.shadow.camera.far = gs * 1.4;
    const d = gs * 0.35;
    key.shadow.camera.left = -d;
    key.shadow.camera.right = d;
    key.shadow.camera.top = d;
    key.shadow.camera.bottom = -d;
    key.shadow.bias = -0.0004;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight('#ffffff', 0.55);
    rim.position.set(-gs * 0.22, gs * 0.16, -gs * 0.24);
    this.scene.add(rim);

    // Minimalistic transparent shadow catcher on pure #ffffff white background (WebGPU-safe TSL)
    const totalShadow = float(1.0).toVar();
    const groundMat = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color('#000000'),
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    groundMat.receivedShadowNode = Fn(([shadow]: [ReturnType<typeof float>]) => {
      totalShadow.mulAssign(shadow);
      return shadow;
    }) as unknown as THREE.Node;
    groundMat.outputNode = vec4(
      vec3(0.0, 0.0, 0.0),
      float(1.0).sub(totalShadow).mul(0.13)
    );

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(gs * 2.6, gs * 2.6), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Subtle neutral drafting grid on pure white studio floor
    const minorGrid = new THREE.GridHelper(gs, this.scaleCfg.gridMinorDivs, '#efefef', '#f5f5f5');
    minorGrid.position.y = -0.005;
    (minorGrid.material as THREE.Material).transparent = true;
    (minorGrid.material as THREE.Material).opacity = 0.65;
    this.scene.add(minorGrid);

    const majorGrid = new THREE.GridHelper(gs, this.scaleCfg.gridMajorDivs, '#dcdcdc', '#e6e6e6');
    majorGrid.position.y = 0.0;
    (majorGrid.material as THREE.Material).transparent = true;
    (majorGrid.material as THREE.Material).opacity = 0.85;
    this.scene.add(majorGrid);

    const axisLen = gs * 0.06;
    const addAxis = (to: THREE.Vector3, color: string) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.006, 0), to]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75 }));
      this.scene.add(line);
    };
    addAxis(new THREE.Vector3(axisLen, 0.006, 0), '#f43f5e');
    addAxis(new THREE.Vector3(0, 0.006, axisLen), '#3b82f6');
  }

  public setMassingState(state: MassingState, selectedFaceId: string | null): void {
    this.state = state;
    this.faces = computeExposedFaces(state);
    this.selectedFaceId =
      selectedFaceId && this.faces.some((f) => f.id === selectedFaceId && !f.locked)
        ? selectedFaceId
        : null;
    this.rebuildMassingMeshes();
    this.rebuildOverlaysAndGizmo();
  }

  public showProgrammaticDragPreview(face: MassingFace | null, delta: number, isSetback = false): void {
    if (!face || Math.abs(delta) < 1e-3) {
      this.clearGroup(this.previewGroup, true);
      this.gizmoGroup.position.set(0, 0, 0);
      return;
    }
    this.rebuildDragPreview(face, delta, isSetback);
  }

  public setSelectedFaceId(id: string | null): void {
    this.selectedFaceId = id;
    this.rebuildOverlaysAndGizmo();
  }

  public setToolMode(mode: ToolMode): void {
    this.toolMode = mode;
    this.rebuildOverlaysAndGizmo();
  }

  public setSplitAxis(axis: SplitAxis): void {
    this.splitAxis = axis;
    this.rebuildOverlaysAndGizmo();
  }

  public setFloorSnap(snap: boolean): void {
    this.floorSnap = snap;
  }

  private clearGroup(group: THREE.Group, disposeMaterials = false): void {
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      child.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
        if (disposeMaterials && (obj as THREE.Mesh).material) {
          const mat = (obj as THREE.Mesh).material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      });
    }
  }

  private rebuildMassingMeshes(): void {
    this.clearGroup(this.massingGroup);
    this.faceEntries = [];

    for (const face of this.faces) {
      const geo = this.createQuadGeometry(face.corners, face.normal);
      const mat = face.locked
        ? this.clayLockedMat
        : face.createdStep === 0
        ? this.clayBaseMat
        : this.clayTierMat;

      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.faceId = face.id;
      this.massingGroup.add(mesh);

      const pts = [
        new THREE.Vector3(...face.corners[0]),
        new THREE.Vector3(...face.corners[1]),
        new THREE.Vector3(...face.corners[2]),
        new THREE.Vector3(...face.corners[3]),
        new THREE.Vector3(...face.corners[0]),
      ];
      const border = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.edgeLineMat);
      this.massingGroup.add(border);

      if (!face.locked) {
        this.faceEntries.push({ mesh, face });
      }
    }
  }

  private createQuadGeometry(
    corners: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]],
    normal: [number, number, number],
    offset = 0
  ): THREE.BufferGeometry {
    const [nx, ny, nz] = normal;
    const positions = new Float32Array([
      corners[0][0] + nx * offset, corners[0][1] + ny * offset, corners[0][2] + nz * offset,
      corners[1][0] + nx * offset, corners[1][1] + ny * offset, corners[1][2] + nz * offset,
      corners[2][0] + nx * offset, corners[2][1] + ny * offset, corners[2][2] + nz * offset,
      corners[3][0] + nx * offset, corners[3][1] + ny * offset, corners[3][2] + nz * offset,
    ]);
    const normals = new Float32Array([nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    return geo;
  }

  private addRectOutline(target: THREE.Group, face: MassingFace, rect: Rect2D, color: string, offset: number): void {
    const c = faceToCorners3D(face.dir, face.plane, rect);
    const [nx, ny, nz] = face.normal;
    const pts = [0, 1, 2, 3, 0].map(
      (i) => new THREE.Vector3(c[i][0] + nx * offset, c[i][1] + ny * offset, c[i][2] + nz * offset)
    );
    target.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color })));
  }

  private rebuildOverlaysAndGizmo(): void {
    this.clearGroup(this.overlayGroup, true);
    this.clearGroup(this.gizmoGroup, true);
    this.gizmoHitMeshes = [];

    const off = Math.max(0.004, this.scaleCfg.gridSize * 0.00035);
    const selected = this.faces.find((f) => f.id === this.selectedFaceId) ?? null;
    const hovered = this.faces.find((f) => f.id === this.hoveredFaceId) ?? null;

    if (hovered && hovered.id !== this.selectedFaceId && !this.isDragging) {
      this.overlayGroup.add(
        new THREE.Mesh(this.createQuadGeometry(hovered.corners, hovered.normal, off), this.hoverMat.clone())
      );
      this.addRectOutline(this.overlayGroup, hovered, hovered.rect, '#7dd3fc', off * 1.4);
    }

    const toolTarget = hovered ?? selected;
    if (toolTarget && !this.isDragging) {
      if (this.toolMode === 'split') {
        this.addSplitPreview(toolTarget, off * 2);
      } else if (this.toolMode === 'inset' || this.toolMode === 'setback') {
        const inner = computeInsetRect(toolTarget.rect, this.scaleCfg.defaultInset, this.scaleCfg.minBoxSize);
        if (inner) {
          this.addRectOutline(
            this.overlayGroup,
            toolTarget,
            inner,
            this.toolMode === 'setback' ? '#a78bfa' : '#34d399',
            off * 1.8
          );
        }
      }
    }

    if (selected) {
      this.overlayGroup.add(
        new THREE.Mesh(this.createQuadGeometry(selected.corners, selected.normal, off * 0.9), this.selectMat.clone())
      );
      this.addRectOutline(this.overlayGroup, selected, selected.rect, '#38bdf8', off * 1.6);

      if (this.toolMode === 'extrude' || this.toolMode === 'setback') {
        this.buildExtrudeGizmo(selected);
      }
    }
  }

  private addSplitPreview(face: MassingFace, off: number): void {
    const r = face.rect;
    const w = r.u1 - r.u0;
    const h = r.v1 - r.v0;
    const minP = this.scaleCfg.minBoxSize * 1.4;
    let chosen: 'u' | 'v' | 'grid' =
      this.splitAxis === 'auto' ? (w >= h ? 'u' : 'v') : this.splitAxis;
    if (chosen === 'u' && w < minP) chosen = 'v';
    if (chosen === 'v' && h < minP) chosen = 'u';

    const ratio = this.computeCursorSplitRatio(face, chosen);
    const mat = new THREE.LineBasicMaterial({ color: '#fbbf24' });
    const drawLine = (uA: number, vA: number, uB: number, vB: number) => {
      const pA = this.faceUVToWorld(face, uA, vA, off);
      const pB = this.faceUVToWorld(face, uB, vB, off);
      this.overlayGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([pA, pB]), mat.clone()));
    };
    if (chosen === 'u' || chosen === 'grid') {
      const mu = r.u0 + w * (chosen === 'grid' ? 0.5 : ratio);
      drawLine(mu, r.v0, mu, r.v1);
    }
    if (chosen === 'v' || chosen === 'grid') {
      const mv = r.v0 + h * (chosen === 'grid' ? 0.5 : ratio);
      drawLine(r.u0, mv, r.u1, mv);
    }
  }

  private computeCursorSplitRatio(face: MassingFace, axis: 'u' | 'v' | 'grid'): number {
    if (axis === 'grid' || this.hoveredFaceId !== face.id) return 0.5;
    const [hu, hv] = worldPointToFaceUV(face.dir, [
      this.hoverHitPoint.x, this.hoverHitPoint.y, this.hoverHitPoint.z,
    ]);
    const r = face.rect;
    const raw =
      axis === 'u'
        ? (hu - r.u0) / Math.max(0.01, r.u1 - r.u0)
        : (hv - r.v0) / Math.max(0.01, r.v1 - r.v0);
    const clamped = Math.max(0.2, Math.min(0.8, raw));
    for (const snap of [0.25, 0.5, 0.75]) {
      if (Math.abs(clamped - snap) < 0.06) return snap;
    }
    return Math.round(clamped * 20) / 20;
  }

  private faceUVToWorld(face: MassingFace, u: number, v: number, offset: number): THREE.Vector3 {
    const [nx, ny, nz] = face.normal;
    let x = 0, y = 0, z = 0;
    switch (face.dir) {
      case '+z': case '-z': x = u; y = v; z = face.plane; break;
      case '+x': case '-x': x = face.plane; y = v; z = u; break;
      case '+y': case '-y': x = u; y = face.plane; z = v; break;
    }
    return new THREE.Vector3(x + nx * offset, y + ny * offset, z + nz * offset);
  }

  private buildExtrudeGizmo(face: MassingFace): void {
    const isSetback = this.toolMode === 'setback';
    const baseColor = this.gizmoHovered ? '#fef08a' : isSetback ? '#a78bfa' : '#22d3ee';
    const emissiveColor = this.gizmoHovered ? '#eab308' : isSetback ? '#7c3aed' : '#0891b2';
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(baseColor),
      emissive: new THREE.Color(emissiveColor),
      emissiveIntensity: this.gizmoHovered ? 0.9 : 0.45,
      roughness: 0.25,
      metalness: 0.2,
    });

    const arrow = new THREE.Group();
    const baseScale = this.scaleCfg.gridSize * 0.012;
    const faceScale = Math.sqrt(Math.min(face.width, face.height)) * 0.34;
    const scale = Math.max(baseScale * 0.65, Math.min(baseScale * 1.45, faceScale));

    const disc = new THREE.Mesh(
      new THREE.RingGeometry(0.24 * scale, 0.40 * scale, 28),
      new THREE.MeshBasicMaterial({ color: baseColor, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.03 * scale;
    arrow.add(disc);

    const stemLen = 1.65 * scale;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * scale, 0.09 * scale, stemLen, 16), mat);
    stem.position.y = stemLen * 0.5 + 0.03 * scale;
    arrow.add(stem);

    const headLen = 0.72 * scale;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.32 * scale, headLen, 20), mat);
    head.position.y = stemLen + headLen * 0.5 + 0.03 * scale;
    arrow.add(head);

    const hitMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.65 * scale, 0.65 * scale, stemLen + headLen + 0.4 * scale, 12),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hitMesh.position.y = (stemLen + headLen) * 0.5 + 0.06 * scale;
    arrow.add(hitMesh);
    this.gizmoHitMeshes.push(hitMesh, stem, head, disc);

    const normalVec = new THREE.Vector3(...face.normal);
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normalVec);
    arrow.position.set(...face.center);
    this.gizmoGroup.add(arrow);
  }

  private rebuildDragPreview(face: MassingFace, delta: number, isSetback: boolean): void {
    this.clearGroup(this.previewGroup, true);
    if (Math.abs(delta) < 0.01) return;

    let rect = face.rect;
    if (isSetback && delta > 0) {
      const inner = computeInsetRect(face.rect, this.scaleCfg.defaultInset, this.scaleCfg.minBoxSize);
      if (inner) rect = inner;
    }

    const n = face.normal;
    const wA = face.plane;
    let wB = face.plane + delta * (n[0] + n[1] + n[2]);
    if ((face.dir === '+y' || face.dir === '-y') && wB < 0) wB = 0;

    const wMin = Math.min(wA, wB);
    const wMax = Math.max(wA, wB);
    if (wMax - wMin < 0.01) return;

    let minX = 0, maxX = 0, minY = 0, maxY = 0, minZ = 0, maxZ = 0;
    switch (face.dir) {
      case '+z': case '-z': minX = rect.u0; maxX = rect.u1; minY = rect.v0; maxY = rect.v1; minZ = wMin; maxZ = wMax; break;
      case '+x': case '-x': minX = wMin; maxX = wMax; minY = rect.v0; maxY = rect.v1; minZ = rect.u0; maxZ = rect.u1; break;
      case '+y': case '-y': minX = rect.u0; maxX = rect.u1; minY = wMin; maxY = wMax; minZ = rect.v0; maxZ = rect.v1; break;
    }

    const color = delta < 0 ? '#f43f5e' : isSetback ? '#a78bfa' : '#22d3ee';
    const boxGeo = new THREE.BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ);
    const boxMesh = new THREE.Mesh(
      boxGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false })
    );
    boxMesh.position.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
    this.previewGroup.add(boxMesh);

    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo), new THREE.LineBasicMaterial({ color }));
    edges.position.copy(boxMesh.position);
    this.previewGroup.add(edges);

    this.gizmoGroup.position.set(n[0] * delta, n[1] * delta, n[2] * delta);
  }

  private updatePointerNDC(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private raycastGizmo(): boolean {
    if (this.gizmoHitMeshes.length === 0) return false;
    this.raycaster.setFromCamera(this.pointerNDC, this.camera);
    return this.raycaster.intersectObjects(this.gizmoHitMeshes, false).length > 0;
  }

  private raycastFaces(): { face: MassingFace; point: THREE.Vector3 } | null {
    if (this.faceEntries.length === 0) return null;
    this.raycaster.setFromCamera(this.pointerNDC, this.camera);
    const hits = this.raycaster.intersectObjects(this.faceEntries.map((e) => e.mesh), false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    const entry = this.faceEntries.find((e) => e.mesh === hit.object);
    return entry ? { face: entry.face, point: hit.point.clone() } : null;
  }

  private snapDelta(raw: number, face: MassingFace, altHeld: boolean): number {
    if (face.dir === '-y' && raw > 0) {
      const remaining = face.plane - raw;
      if (remaining <= this.scaleCfg.groundSnapThreshold) return face.plane;
    }
    const isVert = face.dir === '+y' || face.dir === '-y';
    const step = altHeld
      ? this.scaleCfg.fineSnap
      : this.floorSnap
      ? isVert
        ? this.scaleCfg.verticalSnap
        : this.scaleCfg.horizontalSnap
      : this.scaleCfg.fineSnap;
    let snapped = Math.round(raw / step) * step;
    if (face.dir === '-y' && snapped > face.plane) snapped = face.plane;
    if (face.dir === '+y' && face.plane + snapped < this.scaleCfg.minBoxSize) {
      snapped = Math.max(snapped, -(face.plane - this.scaleCfg.minBoxSize));
    }
    return Math.round(snapped * 1000) / 1000;
  }

  private startDrag(face: MassingFace, e: PointerEvent): void {
    this.isDragging = true;
    this.dragFace = face;
    this.dragNormalVec.set(...face.normal).normalize();
    this.dragCurrentDelta = 0;
    this.dragLastSnapped = 0;
    this.dragIsSetback = this.toolMode === 'setback' || e.shiftKey;
    this.dragLastSetback = this.dragIsSetback;
    this.controls.enabled = false;

    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const tangent = new THREE.Vector3().crossVectors(this.dragNormalVec, camDir);
    if (tangent.lengthSq() < 1e-4) {
      this.dragUseScreenFallback = true;
    } else {
      this.dragUseScreenFallback = false;
      const planeNormal = new THREE.Vector3().crossVectors(tangent.normalize(), this.dragNormalVec).normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(planeNormal, new THREE.Vector3(...face.center));
      this.raycaster.setFromCamera(this.pointerNDC, this.camera);
      if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.dragStartHit)) {
        this.dragUseScreenFallback = true;
      }
    }
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.renderer.domElement.style.cursor = 'grabbing';
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.updatePointerNDC(e);
    this.pointerDownPos = { x: e.clientX, y: e.clientY };

    if ((this.toolMode === 'extrude' || this.toolMode === 'setback') && this.raycastGizmo()) {
      const selected = this.faces.find((f) => f.id === this.selectedFaceId);
      if (selected) {
        e.stopPropagation();
        this.startDrag(selected, e);
      }
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.updatePointerNDC(e);

    if (this.isDragging && this.dragFace && this.state) {
      let rawDelta = 0;
      if (!this.dragUseScreenFallback) {
        this.raycaster.setFromCamera(this.pointerNDC, this.camera);
        const curHit = new THREE.Vector3();
        if (this.raycaster.ray.intersectPlane(this.dragPlane, curHit)) {
          rawDelta = curHit.sub(this.dragStartHit).dot(this.dragNormalVec);
        }
      } else {
        rawDelta = (this.pointerDownPos.y - e.clientY) * (this.scaleCfg.gridSize * 0.0008);
      }

      const isSetback = this.toolMode === 'setback' || e.shiftKey;
      const snapped = this.snapDelta(rawDelta, this.dragFace, e.altKey);
      this.dragCurrentDelta = snapped;
      this.dragIsSetback = isSetback;

      if (Math.abs(snapped - this.dragLastSnapped) > 1e-4 || isSetback !== this.dragLastSetback) {
        this.dragLastSnapped = snapped;
        this.dragLastSetback = isSetback;
        this.rebuildDragPreview(this.dragFace, snapped, isSetback);

        const insetMargin = isSetback && snapped > 0 ? this.scaleCfg.defaultInset : 0;
        if (Math.abs(snapped) >= this.scaleCfg.minBoxSize * 0.25) {
          const previewRes = applyExtrude(this.state, this.dragFace, snapped, insetMargin, this.scaleCfg);
          this.callbacks.onPreviewState(previewRes.state);
        } else {
          this.callbacks.onPreviewState(null);
        }
      }

      const sign = snapped >= 0 ? '+' : '';
      const isGroundDrop = this.dragFace.dir === '-y' && Math.abs(snapped - this.dragFace.plane) < 0.02;
      this.callbacks.onDragInfo({
        active: true,
        delta: snapped,
        isSetback,
        isCarve: snapped < 0,
        screenX: e.clientX,
        screenY: e.clientY,
        label: isGroundDrop
          ? 'Ground Snap (0.0m)'
          : `${dirLabel(this.dragFace.dir)} ${sign}${snapped.toFixed(2)}m${isSetback && snapped > 0 ? ' (Setback)' : snapped < 0 ? ' (Carve)' : ''}`,
      });
      return;
    }

    const overGizmo = (this.toolMode === 'extrude' || this.toolMode === 'setback') && this.raycastGizmo();
    if (overGizmo !== this.gizmoHovered) {
      this.gizmoHovered = overGizmo;
      this.rebuildOverlaysAndGizmo();
    }
    if (overGizmo) {
      this.renderer.domElement.style.cursor = 'grab';
      return;
    }

    const faceHit = this.raycastFaces();
    const nextHoverId = faceHit ? faceHit.face.id : null;
    if (faceHit) this.hoverHitPoint.copy(faceHit.point);
    const shouldRedraw = nextHoverId !== this.hoveredFaceId || (this.toolMode === 'split' && nextHoverId !== null);
    if (nextHoverId !== this.hoveredFaceId) {
      this.hoveredFaceId = nextHoverId;
      this.callbacks.onHoverFace(faceHit ? faceHit.face : null);
    }
    if (shouldRedraw) this.rebuildOverlaysAndGizmo();
    this.renderer.domElement.style.cursor = faceHit ? (this.toolMode === 'split' ? 'crosshair' : 'pointer') : 'default';
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.isDragging && this.dragFace) {
      const face = this.dragFace;
      const delta = this.dragCurrentDelta;
      const insetMargin = this.dragIsSetback && delta > 0 ? this.scaleCfg.defaultInset : 0;

      this.isDragging = false;
      this.dragFace = null;
      this.controls.enabled = true;
      this.clearGroup(this.previewGroup, true);
      this.gizmoGroup.position.set(0, 0, 0);
      this.callbacks.onPreviewState(null);
      this.callbacks.onDragInfo(null);
      try { this.renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.renderer.domElement.style.cursor = 'default';

      if (Math.abs(delta) >= this.scaleCfg.minBoxSize * 0.25) {
        this.callbacks.onCommitExtrude(face, delta, insetMargin);
      }
      return;
    }

    if (e.button !== 0) return;
    if (Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y) > 5) return;

    this.updatePointerNDC(e);
    const hit = this.raycastFaces();
    if (!hit) {
      this.selectedFaceId = null;
      this.callbacks.onSelectFace(null);
      this.rebuildOverlaysAndGizmo();
      return;
    }

    if (this.toolMode === 'split') {
      const r = hit.face.rect;
      const w = r.u1 - r.u0, h = r.v1 - r.v0;
      let chosen: 'u' | 'v' | 'grid' = this.splitAxis === 'auto' ? (w >= h ? 'u' : 'v') : this.splitAxis;
      const minP = this.scaleCfg.minBoxSize * 1.4;
      if (chosen === 'u' && w < minP) chosen = 'v';
      if (chosen === 'v' && h < minP) chosen = 'u';
      this.hoverHitPoint.copy(hit.point);
      this.hoveredFaceId = hit.face.id;
      const ratio = this.computeCursorSplitRatio(hit.face, chosen);
      this.callbacks.onCommitSplit(hit.face, chosen, ratio);
      return;
    }

    if (this.toolMode === 'inset') {
      this.callbacks.onCommitInset(hit.face, this.scaleCfg.defaultInset);
      return;
    }

    this.selectedFaceId = hit.face.id;
    this.callbacks.onSelectFace(hit.face);
    this.rebuildOverlaysAndGizmo();
  };

  private bindEvents(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
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
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  public dispose(): void {
    this.disposed = true;
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    this.resizeObserver.disconnect();
    this.clearGroup(this.massingGroup);
    this.clearGroup(this.overlayGroup, true);
    this.clearGroup(this.gizmoGroup, true);
    this.clearGroup(this.previewGroup, true);
    this.controls.dispose();
    if (this.initialized) {
      this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
    }
    if (el.parentElement) el.parentElement.removeChild(el);
  }
}
