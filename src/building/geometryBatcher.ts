import * as THREE from 'three/webgpu';

interface Bucket {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export class MaterialGeometryBatcher<K extends string = string> {
  private buckets = new Map<K, Bucket>();

  private getBucket(key: K): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { positions: [], normals: [], uvs: [], indices: [] };
      this.buckets.set(key, b);
    }
    return b;
  }

  public addQuad(
    mat: K,
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    p3: [number, number, number],
    uScale = 1,
    vScale = 1
  ): void {
    const b = this.getBucket(mat);
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    nx /= nLen; ny /= nLen; nz /= nLen;

    const uLen = Math.hypot(ux, uy, uz) / Math.max(0.001, uScale);
    const vLen = Math.hypot(vx, vy, vz) / Math.max(0.001, vScale);

    const base = b.positions.length / 3;
    b.positions.push(...p0, ...p1, ...p2, ...p3);
    b.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    b.uvs.push(0, 0, uLen, 0, uLen, vLen, 0, vLen);
    b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  public addQuadUV(
    mat: K,
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    p3: [number, number, number],
    uv0: [number, number],
    uv1: [number, number],
    uv2: [number, number],
    uv3: [number, number]
  ): void {
    const b = this.getBucket(mat);
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen < 1e-6) {
      const ux2 = p2[0] - p1[0], uy2 = p2[1] - p1[1], uz2 = p2[2] - p1[2];
      const vx2 = p3[0] - p1[0], vy2 = p3[1] - p1[1], vz2 = p3[2] - p1[2];
      nx = uy2 * vz2 - uz2 * vy2;
      ny = uz2 * vx2 - ux2 * vz2;
      nz = ux2 * vy2 - uy2 * vx2;
      const nLen2 = Math.hypot(nx, ny, nz);
      if (nLen2 < 1e-6) return;
      nx /= nLen2; ny /= nLen2; nz /= nLen2;
    } else {
      nx /= nLen; ny /= nLen; nz /= nLen;
    }

    const base = b.positions.length / 3;
    b.positions.push(...p0, ...p1, ...p2, ...p3);
    b.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    b.uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1], uv3[0], uv3[1]);
    b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  public addTriangleUV(
    mat: K,
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    uv0: [number, number],
    uv1: [number, number],
    uv2: [number, number]
  ): void {
    const b = this.getBucket(mat);
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen < 1e-6) return;
    nx /= nLen; ny /= nLen; nz /= nLen;

    const base = b.positions.length / 3;
    b.positions.push(...p0, ...p1, ...p2);
    b.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    b.uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
    b.indices.push(base, base + 1, base + 2);
  }

  public addBox(
    mat: K,
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    uvScale = 1.0
  ): void {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const minZ = Math.min(z0, z1), maxZ = Math.max(z0, z1);
    if (maxX - minX < 1e-4 || maxY - minY < 1e-4 || maxZ - minZ < 1e-4) return;

    const b = this.getBucket(mat);
    const inv = 1 / Math.max(0.01, uvScale);
    const pushFace = (
      pts: [number, number, number][],
      n: [number, number, number],
      uvs: [number, number][]
    ) => {
      const base = b.positions.length / 3;
      for (let i = 0; i < 4; i++) {
        b.positions.push(pts[i][0], pts[i][1], pts[i][2]);
        b.normals.push(n[0], n[1], n[2]);
        b.uvs.push(uvs[i][0], uvs[i][1]);
      }
      b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    pushFace(
      [[minX, minY, maxZ], [maxX, minY, maxZ], [maxX, maxY, maxZ], [minX, maxY, maxZ]],
      [0, 0, 1],
      [[minX * inv, minY * inv], [maxX * inv, minY * inv], [maxX * inv, maxY * inv], [minX * inv, maxY * inv]]
    );
    pushFace(
      [[maxX, minY, minZ], [minX, minY, minZ], [minX, maxY, minZ], [maxX, maxY, minZ]],
      [0, 0, -1],
      [[minX * inv, minY * inv], [maxX * inv, minY * inv], [maxX * inv, maxY * inv], [minX * inv, maxY * inv]]
    );
    pushFace(
      [[maxX, minY, maxZ], [maxX, minY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ]],
      [1, 0, 0],
      [[minZ * inv, minY * inv], [maxZ * inv, minY * inv], [maxZ * inv, maxY * inv], [minZ * inv, maxY * inv]]
    );
    pushFace(
      [[minX, minY, minZ], [minX, minY, maxZ], [minX, maxY, maxZ], [minX, maxY, minZ]],
      [-1, 0, 0],
      [[minZ * inv, minY * inv], [maxZ * inv, minY * inv], [maxZ * inv, maxY * inv], [minZ * inv, maxY * inv]]
    );
    pushFace(
      [[minX, maxY, maxZ], [maxX, maxY, maxZ], [maxX, maxY, minZ], [minX, maxY, minZ]],
      [0, 1, 0],
      [[minX * inv, minZ * inv], [maxX * inv, minZ * inv], [maxX * inv, maxZ * inv], [minX * inv, maxZ * inv]]
    );
    pushFace(
      [[minX, minY, minZ], [maxX, minY, minZ], [maxX, minY, maxZ], [minX, minY, maxZ]],
      [0, -1, 0],
      [[minX * inv, minZ * inv], [maxX * inv, minZ * inv], [maxX * inv, maxZ * inv], [minX * inv, maxZ * inv]]
    );
  }

  public addGeometry(mat: K, geo: THREE.BufferGeometry, matrix?: THREE.Matrix4, uvScale = 1): void {
    const g = geo.index ? geo : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    const pos = g.attributes.position;
    const norm = g.attributes.normal;
    const uv = g.attributes.uv;
    if (!pos || !norm) return;

    const b = this.getBucket(mat);
    const base = b.positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      b.positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      b.normals.push(norm.getX(i), norm.getY(i), norm.getZ(i));
      if (uv) {
        b.uvs.push(uv.getX(i) / Math.max(0.01, uvScale), uv.getY(i) / Math.max(0.01, uvScale));
      } else {
        b.uvs.push((pos.getX(i) + pos.getZ(i)) / uvScale, pos.getY(i) / uvScale);
      }
    }
    if (g.index) {
      const idx = g.index;
      for (let i = 0; i < idx.count; i++) {
        b.indices.push(base + idx.getX(i));
      }
    } else {
      for (let i = 0; i < pos.count; i++) {
        b.indices.push(base + i);
      }
    }
    if (g !== geo) g.dispose();
  }

  public addRotatedBox(
    mat: K,
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    rx: number, ry: number, rz: number,
    uvScale = 1.0
  ): void {
    if (sx < 1e-4 || sy < 1e-4 || sz < 1e-4) return;
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(cx, cy, cz),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(1, 1, 1)
    );
    // Scale UVs proportionally to box extents so wood/stone grain doesn't stretch
    const uvAttr = geo.attributes.uv;
    const normAttr = geo.attributes.normal;
    const inv = 1 / Math.max(0.01, uvScale);
    for (let i = 0; i < uvAttr.count; i++) {
      const nx = Math.abs(normAttr.getX(i));
      const ny = Math.abs(normAttr.getY(i));
      if (nx > 0.5) uvAttr.setXY(i, uvAttr.getX(i) * sz * inv, uvAttr.getY(i) * sy * inv);
      else if (ny > 0.5) uvAttr.setXY(i, uvAttr.getX(i) * sx * inv, uvAttr.getY(i) * sz * inv);
      else uvAttr.setXY(i, uvAttr.getX(i) * sx * inv, uvAttr.getY(i) * sy * inv);
    }
    this.addGeometry(mat, geo, m, 1);
    geo.dispose();
  }

  /**
   * Smoothly beveled architectural box (champfered countertops, walnut desks, millwork panels).
   */
  public addBeveledBox(
    mat: K,
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    bevel = 0.015,
    uvScale = 1.0
  ): void {
    const sx = Math.abs(x1 - x0), sy = Math.abs(y1 - y0), sz = Math.abs(z1 - z0);
    if (sx < 1e-3 || sy < 1e-3 || sz < 1e-3) return;
    const b = Math.min(bevel, sx * 0.25, sy * 0.25, sz * 0.25);
    const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = (z0 + z1) * 0.5;
    const innerW = Math.max(1e-3, sx - b * 2);
    const innerD = Math.max(1e-3, sz - b * 2);
    const shape = new THREE.Shape();
    const hw = innerW * 0.5, hd = innerD * 0.5;
    shape.moveTo(-hw, -hd);
    shape.lineTo(hw, -hd);
    shape.lineTo(hw, hd);
    shape.lineTo(-hw, hd);
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: Math.max(1e-3, sy - b * 2),
      bevelEnabled: true,
      bevelThickness: b,
      bevelSize: b,
      bevelSegments: 2,
    });
    geo.rotateX(-Math.PI / 2);
    geo.center();
    const pos = geo.attributes.position;
    const norm = geo.attributes.normal;
    const uvs = new Float32Array(pos.count * 2);
    const inv = 1 / Math.max(0.01, uvScale);
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i) + cx;
      const py = pos.getY(i) + cy;
      const pz = pos.getZ(i) + cz;
      const ax = Math.abs(norm.getX(i)), ay = Math.abs(norm.getY(i)), az = Math.abs(norm.getZ(i));
      if (ay >= ax && ay >= az) {
        uvs[i * 2] = px * inv; uvs[i * 2 + 1] = pz * inv;
      } else if (ax >= az) {
        uvs[i * 2] = pz * inv; uvs[i * 2 + 1] = py * inv;
      } else {
        uvs[i * 2] = px * inv; uvs[i * 2 + 1] = py * inv;
      }
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    const m = new THREE.Matrix4().makeTranslation(cx, cy, cz);
    this.addGeometry(mat, geo, m, 1);
    geo.dispose();
  }

  /**
   * Sculpted plush tufted cushion / sofa seat / throw pillow with superellipsoid rounding,
   * gentle organic crown swell, and subtle button-tuft dimples!
   */
  public addTuftedCushion(
    mat: K,
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    puffiness = 0.045,
    tuftCols = 2,
    tuftRows = 2,
    uvScale = 0.65,
    rotEuler?: [number, number, number]
  ): void {
    const sx = Math.abs(x1 - x0), sy = Math.abs(y1 - y0), sz = Math.abs(z1 - z0);
    if (sx < 0.02 || sy < 0.02 || sz < 0.02) return;
    const segX = Math.max(8, Math.min(20, Math.round(sx * 16)));
    const segY = Math.max(5, Math.min(10, Math.round(sy * 14)));
    const segZ = Math.max(8, Math.min(20, Math.round(sz * 16)));
    const geo = new THREE.BoxGeometry(sx, sy, sz, segX, segY, segZ);
    const pos = geo.attributes.position;

    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const nx = x / (sx * 0.5);
      const ny = y / (sy * 0.5);
      const nz = z / (sz * 0.5);

      // Soft superellipsoid corner rounding (plush upholstered feel!)
      const edgeR = Math.max(0, Math.hypot(Math.max(0, Math.abs(nx) - 0.72), Math.max(0, Math.abs(ny) - 0.62), Math.max(0, Math.abs(nz) - 0.72)));
      const roundPull = 1.0 - Math.min(0.22, edgeR * edgeR * 0.82);
      x *= roundPull;
      y *= roundPull;
      z *= roundPull;

      // Gentle crown puffiness on top & front faces
      const centerMask = (1 - nx * nx * 0.85) * (1 - nz * nz * 0.85);
      if (ny > 0.05) {
        y += puffiness * Math.max(0, centerMask) * Math.pow(ny, 1.3);
      }
      // Subtle quilted button tuft dimples on top face
      if (tuftCols > 0 && tuftRows > 0 && ny > 0.65) {
        let dimple = 0;
        for (let tc = 0; tc < tuftCols; tc++) {
          const tx = -0.5 + (tc + 0.5) / tuftCols;
          for (let tr = 0; tr < tuftRows; tr++) {
            const tz = -0.5 + (tr + 0.5) / tuftRows;
            const d2 = (nx * 0.5 - tx) ** 2 + (nz * 0.5 - tz) ** 2;
            dimple += Math.exp(-d2 * 48) * puffiness * 0.55;
          }
        }
        y -= dimple;
      }
      // Gentle side pillow swell
      const sideMask = (1 - ny * ny * 0.9);
      x += Math.sign(nx) * puffiness * 0.25 * Math.max(0, sideMask) * (1 - nz * nz * 0.6);
      z += Math.sign(nz) * puffiness * 0.25 * Math.max(0, sideMask) * (1 - nx * nx * 0.6);

      pos.setXYZ(i, x, y, z);
    }

    geo.computeVertexNormals();
    const norm = geo.attributes.normal;
    const uvs = new Float32Array(pos.count * 2);
    const inv = 1 / Math.max(0.01, uvScale);
    for (let i = 0; i < pos.count; i++) {
      const ax = Math.abs(norm.getX(i)), ay = Math.abs(norm.getY(i)), az = Math.abs(norm.getZ(i));
      if (ay >= ax && ay >= az) {
        uvs[i * 2] = pos.getX(i) * inv; uvs[i * 2 + 1] = pos.getZ(i) * inv;
      } else if (ax >= az) {
        uvs[i * 2] = pos.getZ(i) * inv; uvs[i * 2 + 1] = pos.getY(i) * inv;
      } else {
        uvs[i * 2] = pos.getX(i) * inv; uvs[i * 2 + 1] = pos.getY(i) * inv;
      }
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

    const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = (z0 + z1) * 0.5;
    const q = rotEuler
      ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotEuler))
      : new THREE.Quaternion();
    const m = new THREE.Matrix4().compose(new THREE.Vector3(cx, cy, cz), q, new THREE.Vector3(1, 1, 1));
    this.addGeometry(mat, geo, m, 1);
    geo.dispose();
  }

  public addCylinder(
    mat: K,
    cx: number, y0: number, y1: number, cz: number,
    rBot: number, rTop = rBot, segs = 16
  ): void {
    const h = Math.abs(y1 - y0);
    if (h < 1e-4) return;
    const geo = new THREE.CylinderGeometry(rTop, rBot, h, segs);
    const m = new THREE.Matrix4().makeTranslation(cx, (y0 + y1) * 0.5, cz);
    this.addGeometry(mat, geo, m, 1);
    geo.dispose();
  }

  /**
   * Arbitrary 3D cylinder connecting p0 -> p1 (cables, trusses, lamp arms, handrails, chair legs).
   */
  public addOrientedCylinder(
    mat: K,
    p0: [number, number, number],
    p1: [number, number, number],
    rBot: number,
    rTop = rBot,
    segs = 10
  ): void {
    const v0 = new THREE.Vector3(...p0);
    const v1 = new THREE.Vector3(...p1);
    const dir = new THREE.Vector3().subVectors(v1, v0);
    const len = dir.length();
    if (len < 1e-4) return;
    const geo = new THREE.CylinderGeometry(rTop, rBot, len, segs);
    const mid = v0.clone().add(v1).multiplyScalar(0.5);
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    const m = new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1));
    this.addGeometry(mat, geo, m, 1);
    geo.dispose();
  }

  /**
   * Curved 3D Catmull-Rom tube (catenary suspension cables, gooseneck faucets, coiled cables, arched ribs).
   */
  public addTube(
    mat: K,
    points: [number, number, number][],
    radius: number,
    tubularSegs = 24,
    radialSegs = 8
  ): void {
    if (points.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
    const geo = new THREE.TubeGeometry(curve, tubularSegs, radius, radialSegs, false);
    this.addGeometry(mat, geo, undefined, 1);
    geo.dispose();
  }

  public addSphere(
    mat: K,
    cx: number, cy: number, cz: number,
    radius: number,
    wSegs = 14,
    hSegs = 10
  ): void {
    const geo = new THREE.SphereGeometry(radius, wSegs, hSegs);
    const m = new THREE.Matrix4().makeTranslation(cx, cy, cz);
    this.addGeometry(mat, geo, m, 1);
    geo.dispose();
  }

  /**
   * Sweeping concave upturned East-Asian curved roof slope along 4 corner footprint bounds.
   */
  public addCurvedRoofTier(
    mat: K,
    x0: number, x1: number, z0: number, z1: number,
    yBase: number,
    rise: number,
    eaveOverhang: number,
    cornerCurl: number,
    uvScale = 1.6
  ): void {
    const b = this.getBucket(mat);
    const cx = (x0 + x1) * 0.5;
    const cz = (z0 + z1) * 0.5;
    const hwTop = Math.max(0.15, (x1 - x0) * 0.5 * 0.52);
    const hdTop = Math.max(0.15, (z1 - z0) * 0.5 * 0.52);
    const hwBot = (x1 - x0) * 0.5 + eaveOverhang;
    const hdBot = (z1 - z0) * 0.5 + eaveOverhang;
    const rings = 8;
    const segsPerSide = 8;

    const sampleRing = (t: number): [number, number, number][] => {
      // t = 0 at top ridge, t = 1 at outer eave
      const hw = hwTop + (hwBot - hwTop) * t;
      const hd = hdTop + (hdBot - hdTop) * t;
      // Graceful concave pagoda swoop
      const sag = Math.pow(t, 1.55);
      const yMid = yBase + rise * (1 - sag);
      const pts: [number, number, number][] = [];

      const pushEdge = (ax: number, az: number, bx: number, bz: number) => {
        for (let s = 0; s < segsPerSide; s++) {
          const f = s / segsPerSide;
          const x = cx + ax + (bx - ax) * f;
          const z = cz + az + (bz - az) * f;
          // Upturned corner curl peaks smoothly at corners (f near 0 or 1) and outer eaves (t near 1)
          const edgeCorner = Math.pow(Math.abs(f * 2 - 1), 2.4);
          const y = yMid + cornerCurl * edgeCorner * t * t;
          pts.push([x, y, z]);
        }
      };
      pushEdge(-hw, hd, hw, hd);
      pushEdge(hw, hd, hw, -hd);
      pushEdge(hw, -hd, -hw, -hd);
      pushEdge(-hw, -hd, -hw, hd);
      return pts;
    };

    const ringPts: [number, number, number][][] = [];
    for (let r = 0; r <= rings; r++) {
      ringPts.push(sampleRing(r / rings));
    }

    const totalPerRing = segsPerSide * 4;
    const thickness = 0.14;
    // Top roof tiled surface + underside soffit surface so eaves have crisp real thickness
    for (let r = 0; r < rings; r++) {
      for (let i = 0; i < totalPerRing; i++) {
        const iNext = (i + 1) % totalPerRing;
        const p00 = ringPts[r][i];
        const p10 = ringPts[r][iNext];
        const p11 = ringPts[r + 1][iNext];
        const p01 = ringPts[r + 1][i];
        this.addQuad(mat, p01, p11, p10, p00, uvScale, uvScale);
        // Underside offset slightly down
        this.addQuad(
          mat,
          [p00[0], p00[1] - thickness, p00[2]],
          [p10[0], p10[1] - thickness, p10[2]],
          [p11[0], p11[1] - thickness, p11[2]],
          [p01[0], p01[1] - thickness, p01[2]],
          uvScale,
          uvScale
        );
      }
    }
    // Outer eave fascia lip closing top & bottom
    const outer = ringPts[rings];
    for (let i = 0; i < totalPerRing; i++) {
      const iNext = (i + 1) % totalPerRing;
      const a = outer[i], c = outer[iNext];
      this.addQuad(
        mat,
        [a[0], a[1] - thickness, a[2]],
        [c[0], c[1] - thickness, c[2]],
        c,
        a,
        uvScale,
        uvScale
      );
    }
    // Top ridge cap closing the crown
    const top = ringPts[0];
    const yPeak = yBase + rise + 0.02;
    this.addBox(mat, cx - hwTop, yPeak - 0.12, cz - hdTop, cx + hwTop, yPeak, cz + hdTop, uvScale);
    void top;
    void b;
  }

  public buildMeshes(
    materials: Record<K, THREE.Material>,
    options: { nonShadowKeys?: K[]; transparentKeys?: K[] } = {}
  ): THREE.Group {
    const group = new THREE.Group();
    const nonShadow = new Set<K>(options.nonShadowKeys ?? []);
    const transparent = new Set<K>(options.transparentKeys ?? []);

    for (const [key, b] of this.buckets.entries()) {
      if (b.indices.length === 0) continue;
      const mat = materials[key];
      if (!mat) continue;

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3));
      const uvAttr = new THREE.Float32BufferAttribute(b.uvs, 2);
      geo.setAttribute('uv', uvAttr);
      geo.setAttribute('uv1', uvAttr); // Required by AmbientCG AO maps!
      geo.setIndex(b.indices);
      geo.computeBoundingSphere();

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `batch_${key}`;
      const isNoShadow = nonShadow.has(key);
      const isTrans = transparent.has(key);
      mesh.castShadow = !isNoShadow && !isTrans;
      mesh.receiveShadow = !isTrans;
      if (isTrans) mesh.renderOrder = 2;
      group.add(mesh);
    }

    return group;
  }
}

export type FoliagePaletteKind = 'olive' | 'emerald' | 'maple' | 'fern';

const FOLIAGE_PALETTES: Record<FoliagePaletteKind, [number, number, number][]> = {
  olive: [
    [0.24, 0.34, 0.20],
    [0.29, 0.40, 0.23],
    [0.34, 0.44, 0.25],
    [0.20, 0.30, 0.18],
  ],
  emerald: [
    [0.14, 0.34, 0.16],
    [0.19, 0.43, 0.20],
    [0.25, 0.49, 0.22],
    [0.11, 0.28, 0.14],
  ],
  maple: [
    [0.64, 0.16, 0.10],
    [0.76, 0.22, 0.12],
    [0.52, 0.11, 0.08],
    [0.82, 0.32, 0.14],
  ],
  fern: [
    [0.18, 0.39, 0.17],
    [0.24, 0.48, 0.21],
    [0.30, 0.52, 0.23],
    [0.14, 0.32, 0.15],
  ],
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FoliageTextureMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

export function createBotanicalLeafSprigTextures(anisotropy = 8): FoliageTextureMaps {
  const size = 256;
  const colCanvas = document.createElement('canvas');
  colCanvas.width = size; colCanvas.height = size;
  const cCtx = colCanvas.getContext('2d')!;

  const normCanvas = document.createElement('canvas');
  normCanvas.width = size; normCanvas.height = size;
  const nCtx = normCanvas.getContext('2d')!;
  nCtx.fillStyle = 'rgb(128,128,255)';
  nCtx.fillRect(0, 0, size, size);

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = size; roughCanvas.height = size;
  const rCtx = roughCanvas.getContext('2d')!;
  rCtx.fillStyle = 'rgb(200,200,200)';
  rCtx.fillRect(0, 0, size, size);

  cCtx.strokeStyle = 'rgb(96, 86, 62)';
  cCtx.lineWidth = 4;
  cCtx.lineCap = 'round';
  cCtx.beginPath();
  cCtx.moveTo(size * 0.5, size * 0.94);
  cCtx.quadraticCurveTo(size * 0.48, size * 0.55, size * 0.51, size * 0.12);
  cCtx.stroke();

  const leaves = [
    { x: 0.51, y: 0.16, rx: 19, ry: 34, ang: 0.04, tone: 1.0 },
    { x: 0.34, y: 0.28, rx: 18, ry: 31, ang: -0.68, tone: 0.94 },
    { x: 0.67, y: 0.30, rx: 18, ry: 31, ang: 0.65, tone: 0.96 },
    { x: 0.27, y: 0.48, rx: 20, ry: 35, ang: -0.92, tone: 0.88 },
    { x: 0.74, y: 0.49, rx: 20, ry: 34, ang: 0.88, tone: 0.91 },
    { x: 0.31, y: 0.68, rx: 19, ry: 33, ang: -0.82, tone: 0.84 },
    { x: 0.69, y: 0.70, rx: 19, ry: 32, ang: 0.80, tone: 0.86 },
    { x: 0.50, y: 0.42, rx: 17, ry: 29, ang: 0.14, tone: 0.98 },
    { x: 0.48, y: 0.63, rx: 18, ry: 30, ang: -0.18, tone: 0.92 },
  ];

  for (const lf of leaves) {
    const cx = lf.x * size;
    const cy = lf.y * size;
    cCtx.save();
    cCtx.translate(cx, cy);
    cCtx.rotate(lf.ang);
    const v = Math.round(230 * lf.tone);
    const g = cCtx.createLinearGradient(-lf.rx, 0, lf.rx, 0);
    g.addColorStop(0, `rgb(${Math.round(v * 0.8)},${Math.round(v * 0.86)},${Math.round(v * 0.78)})`);
    g.addColorStop(0.5, `rgb(${v},${Math.min(255, Math.round(v * 1.04))},${Math.round(v * 0.92)})`);
    g.addColorStop(1, `rgb(${Math.round(v * 0.74)},${Math.round(v * 0.80)},${Math.round(v * 0.72)})`);
    cCtx.fillStyle = g;
    cCtx.beginPath();
    cCtx.moveTo(0, -lf.ry);
    cCtx.bezierCurveTo(lf.rx * 1.15, -lf.ry * 0.4, lf.rx * 1.05, lf.ry * 0.55, 0, lf.ry);
    cCtx.bezierCurveTo(-lf.rx * 1.05, lf.ry * 0.55, -lf.rx * 1.15, -lf.ry * 0.4, 0, -lf.ry);
    cCtx.fill();
    cCtx.restore();

    nCtx.save();
    nCtx.translate(cx, cy);
    nCtx.rotate(lf.ang);
    const ng = nCtx.createLinearGradient(-lf.rx, 0, lf.rx, 0);
    ng.addColorStop(0, 'rgb(96, 134, 244)');
    ng.addColorStop(0.5, 'rgb(128, 128, 255)');
    ng.addColorStop(1, 'rgb(160, 122, 244)');
    nCtx.fillStyle = ng;
    nCtx.beginPath();
    nCtx.ellipse(0, 0, lf.rx, lf.ry, 0, 0, Math.PI * 2);
    nCtx.fill();
    nCtx.restore();

    rCtx.save();
    rCtx.translate(cx, cy);
    rCtx.rotate(lf.ang);
    rCtx.fillStyle = 'rgb(172, 172, 172)';
    rCtx.beginPath();
    rCtx.ellipse(0, 0, lf.rx, lf.ry, 0, 0, Math.PI * 2);
    rCtx.fill();
    rCtx.restore();
  }

  const mk = (canvas: HTMLCanvasElement, srgb: boolean) => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = anisotropy;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  };
  return { map: mk(colCanvas, true), normalMap: mk(normCanvas, false), roughnessMap: mk(roughCanvas, false) };
}

export class BotanicalFoliageBatcher {
  private barkPos: number[] = [];
  private barkNorm: number[] = [];
  private barkUv: number[] = [];
  private barkIdx: number[] = [];

  private leafPos: number[] = [];
  private leafNorm: number[] = [];
  private leafUv: number[] = [];
  private leafCol: number[] = [];
  private leafIdx: number[] = [];

  private addTaperedSegment(p0: THREE.Vector3, p1: THREE.Vector3, r0: number, r1: number, segs = 7): void {
    const axis = new THREE.Vector3().subVectors(p1, p0);
    const len = axis.length();
    if (len < 1e-4) return;
    axis.normalize();
    const ref = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(ref, axis).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u).normalize();

    const base = this.barkPos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = u.x * ca + v.x * sa;
      const ny = u.y * ca + v.y * sa;
      const nz = u.z * ca + v.z * sa;

      this.barkPos.push(p0.x + nx * r0, p0.y + ny * r0, p0.z + nz * r0);
      this.barkNorm.push(nx, ny, nz);
      this.barkUv.push(i / segs, 0);

      this.barkPos.push(p1.x + nx * r1, p1.y + ny * r1, p1.z + nz * r1);
      this.barkNorm.push(nx, ny, nz);
      this.barkUv.push(i / segs, len * 1.4);
    }
    for (let i = 0; i < segs; i++) {
      const i0 = base + i * 2;
      this.barkIdx.push(i0, i0 + 2, i0 + 3, i0, i0 + 3, i0 + 1);
    }
  }

  private addCurvedLeafCard(
    center: THREE.Vector3,
    canopyCenter: THREE.Vector3,
    size: number,
    yaw: number,
    pitch: number,
    roll: number,
    rgb: [number, number, number]
  ): void {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll));
    const half = size * 0.5;
    const bend = size * 0.16;
    const localPts = [
      new THREE.Vector3(-half, -half, -bend),
      new THREE.Vector3(0, -half, bend * 0.45),
      new THREE.Vector3(half, -half, -bend),
      new THREE.Vector3(-half, half, -bend * 0.7),
      new THREE.Vector3(0, half, bend * 0.35),
      new THREE.Vector3(half, half, -bend * 0.7),
    ];
    const uvPts: [number, number][] = [
      [0, 0], [0.5, 0], [1, 0],
      [0, 1], [0.5, 1], [1, 1],
    ];
    const outNormal = new THREE.Vector3().subVectors(center, canopyCenter).normalize();
    if (outNormal.lengthSq() < 0.01) outNormal.set(0, 1, 0);
    outNormal.y = Math.max(0.25, outNormal.y);
    outNormal.normalize();

    const base = this.leafPos.length / 3;
    for (let i = 0; i < 6; i++) {
      const wp = localPts[i].clone().applyQuaternion(q).add(center);
      this.leafPos.push(wp.x, wp.y, wp.z);
      this.leafNorm.push(outNormal.x, outNormal.y, outNormal.z);
      this.leafUv.push(uvPts[i][0], uvPts[i][1]);
      this.leafCol.push(rgb[0], rgb[1], rgb[2]);
    }
    this.leafIdx.push(
      base, base + 1, base + 4, base, base + 4, base + 3,
      base + 1, base + 2, base + 5, base + 1, base + 5, base + 4
    );
  }

  public addArchitecturalTree(
    x: number, y: number, z: number,
    scale = 1.0,
    seed = 101,
    paletteKind: FoliagePaletteKind = 'olive'
  ): void {
    const rand = mulberry32(seed);
    const palette = FOLIAGE_PALETTES[paletteKind];
    const trunkH = (2.1 + rand() * 0.5) * scale;
    const baseR = 0.16 * scale;

    const p0 = new THREE.Vector3(x, y, z);
    const p1 = new THREE.Vector3(x + (rand() - 0.5) * 0.14 * scale, y + trunkH * 0.5, z + (rand() - 0.5) * 0.14 * scale);
    const p2 = new THREE.Vector3(x + (rand() - 0.5) * 0.18 * scale, y + trunkH, z + (rand() - 0.5) * 0.18 * scale);
    this.addTaperedSegment(p0, p1, baseR, baseR * 0.72, 8);
    this.addTaperedSegment(p1, p2, baseR * 0.72, baseR * 0.48, 7);

    const canopyCenter = new THREE.Vector3(p2.x, p2.y + 1.35 * scale, p2.z);
    const boughCount = 6;
    for (let b = 0; b < boughCount; b++) {
      const az = (b / boughCount) * Math.PI * 2 + (rand() - 0.5) * 0.4;
      const len = (1.1 + rand() * 0.55) * scale;
      const lift = (0.85 + rand() * 0.65) * scale;
      const start = p1.clone().lerp(p2, 0.45 + (b % 3) * 0.24);
      const end = new THREE.Vector3(
        start.x + Math.cos(az) * len,
        start.y + lift,
        start.z + Math.sin(az) * len
      );
      this.addTaperedSegment(start, end, baseR * 0.42, baseR * 0.15, 6);

      const cards = 13;
      for (let c = 0; c < cards; c++) {
        const rad = (0.35 + rand() * 0.75) * scale;
        const a1 = rand() * Math.PI * 2;
        const a2 = (rand() - 0.35) * Math.PI * 0.7;
        const pos = new THREE.Vector3(
          end.x + Math.cos(a1) * Math.cos(a2) * rad,
          end.y + Math.sin(a2) * rad * 0.72 + 0.18 * scale,
          end.z + Math.sin(a1) * Math.cos(a2) * rad
        );
        const col = palette[Math.floor(rand() * palette.length)];
        const shade = 0.85 + Math.max(0, (pos.y - p2.y) / (2.4 * scale)) * 0.28;
        this.addCurvedLeafCard(
          pos,
          canopyCenter,
          (0.66 + rand() * 0.42) * scale,
          rand() * Math.PI * 2,
          (rand() - 0.5) * 1.1,
          (rand() - 0.5) * 0.9,
          [Math.min(1, col[0] * shade), Math.min(1, col[1] * shade), Math.min(1, col[2] * shade)]
        );
      }
    }
  }

  public addPottedPlant(
    x: number, y: number, z: number,
    scale = 0.35,
    seed = 202,
    paletteKind: FoliagePaletteKind = 'fern'
  ): void {
    const rand = mulberry32(seed);
    const palette = FOLIAGE_PALETTES[paletteKind];
    const center = new THREE.Vector3(x, y + 0.32 * scale, z);
    const stems = 7;
    for (let s = 0; s < stems; s++) {
      const az = (s / stems) * Math.PI * 2 + (rand() - 0.5) * 0.4;
      const spread = (0.28 + rand() * 0.42) * scale;
      const h = (0.45 + rand() * 0.48) * scale;
      const p0 = new THREE.Vector3(x, y, z);
      const p1 = new THREE.Vector3(x + Math.cos(az) * spread, y + h, z + Math.sin(az) * spread);
      this.addTaperedSegment(p0, p1, 0.025 * scale, 0.01 * scale, 5);
      const col = palette[Math.floor(rand() * palette.length)];
      for (let k = 0; k < 2; k++) {
        this.addCurvedLeafCard(
          p1.clone().add(new THREE.Vector3((rand() - 0.5) * 0.1 * scale, (rand() - 0.5) * 0.1 * scale, (rand() - 0.5) * 0.1 * scale)),
          center,
          (0.45 + rand() * 0.25) * scale,
          az + k * 0.8,
          0.35 + rand() * 0.4,
          (rand() - 0.5) * 0.5,
          col
        );
      }
    }
  }

  public buildGroup(barkMat: THREE.Material, foliageMat: THREE.Material): THREE.Group {
    const group = new THREE.Group();
    if (this.barkIdx.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(this.barkPos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.barkNorm, 3));
      const uvAttr = new THREE.Float32BufferAttribute(this.barkUv, 2);
      geo.setAttribute('uv', uvAttr);
      geo.setAttribute('uv1', uvAttr);
      geo.setIndex(this.barkIdx);
      const m = new THREE.Mesh(geo, barkMat);
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
    if (this.leafIdx.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(this.leafPos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.leafNorm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.leafUv, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(this.leafCol, 3));
      geo.setIndex(this.leafIdx);
      const m = new THREE.Mesh(geo, foliageMat);
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
    return group;
  }
}
