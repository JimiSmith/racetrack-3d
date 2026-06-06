/**
 * Unified manifold-3d CSG model pipeline (issue #133).
 *
 * This module owns the entire mesh-generation path for every model mode
 * (embossed non-coaster, coaster-raised, coaster-flush). It loads the manifold
 * WASM once (module-cached), builds each colour group (base / secondary / track
 * / text) as an independent watertight Manifold solid via `CrossSection`
 * extrusion + boolean ops, then reads each back as welded `Triangle[]`.
 *
 * Loading the wasm:
 *   - Vite (dev/build/worker): the `?url` import lives ONLY in
 *     `manifold-wasm-url.web.ts`; we dynamic-import it so esbuild/tsx (node)
 *     never sees the `?url` specifier.
 *   - Node (tsx tests / scripts): resolved via `import.meta.resolve(...)`, with a
 *     `MANIFOLD_WASM_PATH` env override.
 */
import Module from 'manifold-3d';
import type { ManifoldToplevel, Manifold, CrossSection, Mesh } from 'manifold-3d';
import type { Triangle, OutlinePoints, BasePlate } from '../types/model.js';
import type { Point2D, ProjectedNode } from '../types/geometry.js';
import {
  BASE_THICKNESS_MM,
  COASTER_SIZE_MM,
  COASTER_CIRCLE_SEGMENTS,
  COASTER_POCKET_DEPTH_MM,
  BASE_CORNER_RADIUS_MM,
  BASE_CORNER_SEGMENTS_PER_CORNER,
  buildRoundedRectangleRing,
  buildCircleRing,
} from './base-plate.js';
import type { RibbonMeshOptions } from './track-ribbon.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** A simple closed contour as a list of {x,y} (mm). */
type Ring = Point2D[];

/** A polygon-with-holes footprint (outer CCW, holes CW), all coordinates in mm. */
export interface Footprint {
  outer: Ring;
  holes: Ring[];
}

export interface CsgSpec {
  mode: 'embossed' | 'coaster-raised' | 'coaster-flush';
  coasterShape: 'round' | 'square';
  /** metres → mm scale already solved by the caller. */
  scale: number;
  /** Primary track outline (already oriented/translated), in metres. */
  primaryOutline: OutlinePoints;
  /** Primary projected nodes (for elevation sampling), in metres. */
  primaryProjected: ProjectedNode[] | null;
  /**
   * Unique secondary sub-chains (combined mode), each as a buffered outline plus
   * its projected nodes for elevation sampling. Own grey group, all in metres.
   */
  secondaryOutlines: { outline: OutlinePoints; projected: ProjectedNode[] }[];
  /** Base plate bbox (metres) — only used for the embossed base plate. */
  basePlate: BasePlate;
  /** Un-perturbed flush text glyph footprints (mm), flush mode only. */
  flushTextFootprints: Footprint[];
  /** Raised/embossed text glyph footprints (mm) + Z band. null when no text. */
  textSolid: { footprints: Footprint[]; baseZ: number; height: number } | null;
  /** Ribbon parameters shared by primary + secondary. */
  ribbon: RibbonMeshOptions;
}

export interface CsgGeometryResult {
  triangles: Triangle[];
  baseTriangleCount: number;
  secondaryTrackTriangleCount: number;
  trackTriangleCount: number;
  textTriangleCount: number;
}

// ── Footprint contour simplify (2D, before extrude) ──────────────────────────
// Collapses near-coincident points on the buffered, turf-dissolved outline so tight
// pinches / hairpin near-self-touches don't extrude into ~0.1 mm-apart wall facets the
// self-intersection detector flags as a GENUINE `crossing`. Measured: at 1e-2 mm the
// Spa flush + raised-coaster track parts AND the combined-mode secondary group
// (overlapping sub-chains converging at the start/finish) go to 0 crossings. 1e-2 mm
// (10µm) is ≪ the ~0.1 mm FDM print resolution → loss-free for the printed part.
const FOOTPRINT_SIMPLIFY_MM = 1e-2;
// ── Elevation refine length (mm) ─────────────────────────────────────────────
// Before warping the elevation-aware ribbon top, the extruded prism is refined so no
// top edge exceeds this length. Without it, a long top triangle over a curved/sloped
// run sags in its interior (it interpolates between raised corners). 2 mm gives a
// smooth elevation profile at the ~200 mm model scale without exploding triangle count.
const ELEVATION_REFINE_LENGTH_MM = 2;
// ── Readback weld epsilon (Manifold → Triangle[] dedup) ──────────────────────
// SCOPED TO THE FLUSH POCKET-CUT BASE ONLY (§3.5). Manifold's `subtract` + top-face
// triangulation leaves boundary sliver triangles at the pocket-wall/top-face rim whose
// verts sit up to ~7-8µm off the wall verts (measured on real Spa flush). Those tiny
// offset pairs are a triangulation artifact of the same closed rim, not distinct
// geometry; welding the readback mesh within 1e-2 mm collapses each pair to one vertex
// so the shared rim edge is watertight. 1e-2 mm ≪ ~0.1 mm FDM print resolution → loss-
// free. The track/secondary/text parts are read back with NO weld (epsilon 0) — they are
// crossing-free by construction and verified honestly by the §3.5a gate.
const READBACK_WELD_EPSILON_MM = 1e-2;
// Simplify tolerance applied to every readback solid. Manifold's boolean output leaves
// sub-grid boundary slivers; 5e-4 mm (5× the 1e-4 export grid) collapses them while
// staying ≪ the ~0.1 mm FDM print resolution, so it is loss-free for the printed part.
const SIMPLIFY_TOLERANCE_MM = 5e-4;
// Glyph contours are densely sampled (8 segments/curve); collapsing near-collinear
// sub-5µm points on the 2D CrossSection before extrusion removes sliver wall triangles
// and is loss-free for the printed part (5µm ≪ ~0.1 mm FDM resolution).
const TEXT_SIMPLIFY_EPSILON_MM = 5e-3;

// ── WASM load (once, module-cached) ──────────────────────────────────────────

let _toplevel: Promise<ManifoldToplevel> | null = null;

async function resolveWasmUrl(): Promise<string> {
  // Node (tsx tests / scripts): no bundler, resolve from node_modules directly.
  // Access `process` via globalThis so this src/ module stays browser-global-clean
  // (eslint scopes src/**/*.ts to browser globals only).
  const nodeProcess = (globalThis as { process?: { versions?: { node?: string }; env?: Record<string, string | undefined> } }).process;
  const isNode = Boolean(nodeProcess?.versions?.node);
  // `import.meta.env` only exists under Vite; guard so node doesn't throw.
  const viteSsr = (import.meta as unknown as { env?: { SSR?: boolean } }).env?.SSR;
  if (isNode && !viteSsr) {
    const override = nodeProcess?.env?.MANIFOLD_WASM_PATH;
    if (override) {
      // Dynamic import so the browser/dev bundle never evaluates `node:url` at module
      // load (Vite externalizes it and accessing its members throws in client code).
      const { pathToFileURL } = await import('node:url');
      return pathToFileURL(override).href;
    }
    return import.meta.resolve('manifold-3d/manifold.wasm');
  }
  // Vite (dev server, prod build, worker chunk): the shim's ?url import is
  // statically analysable and emitted as a hashed, base-prefixed asset URL.
  const { MANIFOLD_WASM_URL } = await import('./manifold-wasm-url.web.js');
  return MANIFOLD_WASM_URL;
}

/** Loads (and caches) the manifold toplevel. Instantiated exactly once. */
export function loadManifold(): Promise<ManifoldToplevel> {
  if (!_toplevel) {
    _toplevel = resolveWasmUrl()
      .then((url) => Module({ locateFile: () => url }))
      .then((m) => {
        m.setup();
        return m;
      });
  }
  return _toplevel;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

type Vec2 = [number, number];

/** Converts a ring of {x,y} into manifold's Vec2[] form. */
function toVec2Ring(ring: Ring): Vec2[] {
  return ring.map((p) => [p.x, p.y] as Vec2);
}

/** Builds a CrossSection (Positive fill) from a polygon-with-holes footprint. */
function footprintCrossSection(api: ManifoldToplevel, fp: Footprint): CrossSection {
  const contours: Vec2[][] = [toVec2Ring(fp.outer), ...fp.holes.map(toVec2Ring)];
  // The turf-buffered outline can pinch to a near-self-touch at tight features
  // (hairpins, track-passes-close-to-infield). 'Positive' fill resolves the overlap,
  // but leaves two wall facets ~0.1 mm apart at the pinch that the self-intersection
  // detector flags as a genuine `crossing` (measured: 2 per Spa-flush part). Collapsing
  // near-coincident contour points on the 2D CrossSection at FOOTPRINT_SIMPLIFY_MM
  // removes the pinch entirely (0 crossings) and is ≪ the ~0.1 mm FDM print resolution,
  // so it is loss-free for the printed part. The SAME simplified footprint is shared by
  // the flush pocket cutter and the inlay, so WYSIWYG fit is preserved.
  const raw = new api.CrossSection(contours, 'Positive');
  const simplified = raw.simplify(FOOTPRINT_SIMPLIFY_MM);
  raw.delete();
  return simplified;
}

/**
 * Builds a single (unioned + simplified) CrossSection from text glyph footprints.
 * The union dissolves overlapping/abutting glyphs exactly; the simplify collapses
 * sub-5µm near-collinear curve points (loss-free for print) so the extruded walls
 * don't trip the self-intersection detector. Returns null for empty input.
 */
function buildTextCrossSection(api: ManifoldToplevel, footprints: Footprint[]): CrossSection | null {
  if (footprints.length === 0) {
    return null;
  }
  const csList = footprints.map((fp) => footprintCrossSection(api, fp));
  const merged = csList.length === 1 ? csList[0]! : api.CrossSection.union(csList);
  const simplified = merged.simplify(TEXT_SIMPLIFY_EPSILON_MM);
  // `merged` is either csList[0] (length 1) or a fresh union; either way it and every
  // input CrossSection are now consumed by the simplify above. Free them all.
  if (merged !== csList[0]) {
    merged.delete();
  }
  for (const cs of csList) {
    cs.delete();
  }
  return simplified;
}

/** Scales a metres-space outline to mm and returns a footprint. */
function scaleOutlineToFootprint(outline: OutlinePoints, scale: number): Footprint {
  const s = (p: Point2D): Point2D => ({ x: p.x * scale, y: p.y * scale });
  return {
    outer: outline.outerRing.map(s),
    holes: outline.holes.map((h) => h.map(s)),
  };
}

// ── Ribbon → native CSG Manifold (footprint extrude + elevation warp) ─────────

/**
 * Samples the per-XY elevation offset (mm) by nearest-point-on-path interpolation,
 * scaled to mm. Returns 0 when elevation is unavailable. Drives the top-face raise of
 * the elevation-aware ribbon.
 */
function makeElevationSampler(
  projected: ProjectedNode[] | null,
  scale: number,
): (x: number, y: number) => number {
  if (!projected?.length) {
    return () => 0;
  }
  const pts = projected;
  return (px: number, py: number): number => {
    const mx = px / scale;
    const my = py / scale;
    if (pts.length === 1) {
      return (pts[0]!.elevation ?? 0) * scale;
    }
    let minDist = Infinity;
    let elev = pts[0]!.elevation ?? 0;
    for (let i = 0; i < pts.length; i += 1) {
      const start = pts[i]!;
      const end = pts[(i + 1) % pts.length]!;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) {
        continue;
      }
      const t = Math.max(0, Math.min(1, ((mx - start.x) * dx + (my - start.y) * dy) / len2));
      const nx = start.x + dx * t;
      const ny = start.y + dy * t;
      const d2 = (mx - nx) * (mx - nx) + (my - ny) * (my - ny);
      if (d2 < minDist) {
        const se = start.elevation ?? 0;
        const ee = end.elevation ?? se;
        minDist = d2;
        elev = se + (ee - se) * t;
      }
    }
    return elev * scale;
  };
}


/**
 * Builds a track-ribbon Manifold for a single chain via native CSG.
 *
 * Both the flat and the elevation-aware ribbon extrude the buffered, turf-dissolved
 * `OutlinePoints` footprint — the SAME footprint the flush pocket cutter uses, so the
 * inlay fits the pocket exactly (WYSIWYG) and rounded caps + dissolved hairpins come
 * for free. The footprint cross-section is `simplify`-ed (FOOTPRINT_SIMPLIFY_MM) so
 * tight pinches don't extrude into self-intersecting wall facets.
 *
 * For the elevation-aware (embossed) ribbon, the extruded prism's TOP face is raised
 * per-XY by the sampled elevation (slope only, NOT banked: both edges of a section
 * share one sample, so the section stays horizontal). The deformation acts on the
 * already-watertight, dissolved prism, so it is crossing-free across the corpus
 * (verified by the §3.5a honest gate over the mesh-validation sweep) — a per-segment
 * hull+union of the centreline corners was prototyped first but produced non-manifold
 * edges, T-junctions, and genuine wall crossings at sharp turns / hairpins on real
 * tracks (the union of thousands of tiny frustums is not watertight), so it was
 * rejected in favour of this dissolved-footprint construction. The honest crossing
 * gate is the safety net: any elevation deformation that self-intersects fails the
 * sweep, so this stays correct by verification, not by exemption.
 */
function buildRibbonManifold(
  api: ManifoldToplevel,
  outline: OutlinePoints | null,
  projected: ProjectedNode[] | null,
  scale: number,
  ribbon: RibbonMeshOptions,
): Manifold | null {
  const ignoreElevation = ribbon.ignoreElevation ?? false;
  const trackHeight = ribbon.trackHeightMm ?? 3;
  const baseZ = ribbon.baseZ ?? BASE_THICKNESS_MM;

  if (!outline) {
    return null;
  }
  const fp = scaleOutlineToFootprint(outline, scale);
  if (fp.outer.length < 3) {
    return null;
  }
  const cs = footprintCrossSection(api, fp);
  if (cs.isEmpty()) {
    cs.delete();
    return null;
  }
  const extruded = cs.extrude(trackHeight);
  cs.delete();
  let solid = extruded.translate([0, 0, baseZ]);
  extruded.delete();
  if (!ignoreElevation && projected?.length) {
    // Subdivide the prism so the flat top face has interior vertices spaced ≤
    // ELEVATION_REFINE_LENGTH_MM before warping; otherwise a long top triangle spanning
    // a curved/sloped run would sag in its interior (its centre interpolates between the
    // raised corners instead of following the true elevation). With the refine, each
    // small top vertex is raised to its own sampled elevation → the top follows the
    // slope with no sag, and the underlying footprint is still the dissolved, watertight
    // outline (no self-intersection).
    const refined = solid.refineToLength(ELEVATION_REFINE_LENGTH_MM);
    solid.delete();
    const topZ = baseZ + trackHeight;
    const sampleElev = makeElevationSampler(projected, scale);
    const EPS = 1e-6;
    solid = refined.warp((v) => {
      if (Math.abs(v[2] - topZ) <= EPS) {
        v[2] = topZ + sampleElev(v[0], v[1]);
      }
    });
    refined.delete();
  }
  return solid;
}

/**
 * Builds the SECONDARY (grey) group as a single watertight solid (#128).
 *
 * All secondary sub-chain footprints are unioned in 2D (`CrossSection.union`) so shared
 * sections dissolve, then extruded once. For the elevation-aware case the prism's top is
 * warped by a combined nearest-chain sampler over EVERY secondary node, so the merged
 * group follows the slope and stays one closed shell. Returns null when there are no
 * secondaries.
 */
function buildSecondaryGroup(api: ManifoldToplevel, spec: CsgSpec): Manifold | null {
  if (spec.secondaryOutlines.length === 0) {
    return null;
  }
  const { ribbon, scale } = spec;
  const ignoreElevation = ribbon.ignoreElevation ?? false;
  const trackHeight = ribbon.trackHeightMm ?? 3;
  const baseZ = ribbon.baseZ ?? BASE_THICKNESS_MM;

  const csList: CrossSection[] = [];
  const allProjected: ProjectedNode[][] = [];
  for (const { outline, projected } of spec.secondaryOutlines) {
    const fp = scaleOutlineToFootprint(outline, scale);
    if (fp.outer.length < 3) {
      continue;
    }
    const cs = footprintCrossSection(api, fp);
    if (cs.isEmpty()) {
      cs.delete();
      continue;
    }
    csList.push(cs);
    if (projected?.length) {
      allProjected.push(projected);
    }
  }
  if (csList.length === 0) {
    return null;
  }
  // Union the sub-chains in 2D, then simplify the MERGED contour: overlapping
  // sub-chains converging near the start/finish create tight necks in the unioned
  // polygon that would extrude into ~0.1mm-apart self-intersecting wall facets. The
  // post-union simplify dissolves them (loss-free at FOOTPRINT_SIMPLIFY_MM ≪ print res).
  const mergedRaw = csList.length === 1 ? csList[0]! : api.CrossSection.union(csList);
  const merged = mergedRaw.simplify(FOOTPRINT_SIMPLIFY_MM);
  // `mergedRaw` (fresh union) and all sub-chain CrossSections are consumed by the
  // simplify above; free them. When csList.length === 1, mergedRaw IS csList[0] and is
  // freed by the loop below.
  if (mergedRaw !== csList[0]) {
    mergedRaw.delete();
  }
  for (const cs of csList) {
    cs.delete();
  }
  if (merged.isEmpty()) {
    merged.delete();
    return null;
  }
  const extruded = merged.extrude(trackHeight);
  merged.delete();
  let solid = extruded.translate([0, 0, baseZ]);
  extruded.delete();
  if (!ignoreElevation && allProjected.length > 0) {
    const refined = solid.refineToLength(ELEVATION_REFINE_LENGTH_MM);
    solid.delete();
    const samplers = allProjected.map((p) => makeElevationSampler(p, scale));
    const topZ = baseZ + trackHeight;
    const EPS = 1e-6;
    solid = refined.warp((v) => {
      if (Math.abs(v[2] - topZ) <= EPS) {
        v[2] = topZ + combinedElevation(samplers, allProjected, scale, v[0], v[1]);
      }
    });
    refined.delete();
  }
  return solid;
}

/**
 * Picks the elevation (mm) of the secondary sub-chain whose path passes CLOSEST to the
 * given XY (mm), so the warped top of the merged grey group follows whichever sub-chain
 * occupies that footprint cell — matching what the dissolved 2D footprint draws there.
 */
function combinedElevation(
  samplers: Array<(x: number, y: number) => number>,
  allProjected: ProjectedNode[][],
  scale: number,
  x: number,
  y: number,
): number {
  let best = 0;
  let bestDist = Infinity;
  const mx = x / scale;
  const my = y / scale;
  for (let i = 0; i < allProjected.length; i += 1) {
    const pts = allProjected[i]!;
    let minD = Infinity;
    for (const p of pts) {
      const dx = p.x - mx;
      const dy = p.y - my;
      const d = dx * dx + dy * dy;
      if (d < minD) {
        minD = d;
      }
    }
    if (minD < bestDist) {
      bestDist = minD;
      best = samplers[i]!(x, y);
    }
  }
  return best;
}

// ── Base solid ───────────────────────────────────────────────────────────────

function buildBaseFootprint(spec: CsgSpec): Footprint {
  if (spec.mode === 'embossed') {
    const minX = spec.basePlate.minX * spec.scale;
    const maxX = spec.basePlate.maxX * spec.scale;
    const minY = spec.basePlate.minY * spec.scale;
    const maxY = spec.basePlate.maxY * spec.scale;
    const radius = Math.min(BASE_CORNER_RADIUS_MM, (maxX - minX) / 2, (maxY - minY) / 2);
    const ring = radius > 0
      ? buildRoundedRectangleRing(minX, maxX, minY, maxY, radius, BASE_CORNER_SEGMENTS_PER_CORNER)
      : [
          { x: minX, y: minY },
          { x: maxX, y: minY },
          { x: maxX, y: maxY },
          { x: minX, y: maxY },
        ];
    return { outer: ring, holes: [] };
  }
  // Coaster: fixed 90 mm disc / rounded square centred at origin.
  const ring = spec.coasterShape === 'round'
    ? buildCircleRing(COASTER_SIZE_MM, COASTER_CIRCLE_SEGMENTS)
    : buildRoundedRectangleRing(
        -COASTER_SIZE_MM / 2, COASTER_SIZE_MM / 2,
        -COASTER_SIZE_MM / 2, COASTER_SIZE_MM / 2,
        BASE_CORNER_RADIUS_MM, BASE_CORNER_SEGMENTS_PER_CORNER,
      );
  return { outer: ring, holes: [] };
}

// ── Readback: Manifold → welded Triangle[] ───────────────────────────────────

/**
 * Reads a Manifold back as `Triangle[]`.
 *
 * `weldEpsilon` (mm) optionally merges near-coincident vertices on a spatial grid
 * so the self-intersection / T-junction detectors see shared rim edges. It is only
 * needed for the FLUSH-MODE BASE: manifold's `subtract` + top-face triangulation
 * places pocket-rim sliver verts up to ~7-8µm off the wall verts, and a 1e-4 grid
 * snap would NOT merge them. The hull+union ribbon / footprint extrude / text parts
 * are crossing-free by construction, so they pass `weldEpsilon = 0` (plain readback,
 * no merge). `1e-2 mm` is the measured loss-free rim value, ≪ ~0.1 mm print resolution.
 */
export function manifoldToTriangles(manifold: Manifold, weldEpsilon = 0): Triangle[] {
  if (manifold.isEmpty()) {
    return [];
  }
  const mesh: Mesh = manifold.getMesh();
  const { numProp, vertProperties, triVerts } = mesh;

  const repForVert: Array<{ x: number; y: number; z: number }> = [];
  const vertCount = vertProperties.length / numProp;
  if (weldEpsilon > 0) {
    // Spatial dedup at weldEpsilon. Snap to a representative, but search the 27
    // neighbouring cells too so vertices that straddle a cell boundary (and would
    // otherwise keep distinct keys, leaving the detectors with false near-coincident
    // pairs) still collapse to one point.
    const repByCell = new Map<string, { x: number; y: number; z: number }>();
    const eps2 = weldEpsilon * weldEpsilon;
    for (let v = 0; v < vertCount; v += 1) {
      const x = vertProperties[v * numProp + 0]!;
      const y = vertProperties[v * numProp + 1]!;
      const z = vertProperties[v * numProp + 2]!;
      const cx = Math.round(x / weldEpsilon);
      const cy = Math.round(y / weldEpsilon);
      const cz = Math.round(z / weldEpsilon);
      let rep: { x: number; y: number; z: number } | undefined;
      for (let dx = -1; dx <= 1 && !rep; dx += 1) {
        for (let dy = -1; dy <= 1 && !rep; dy += 1) {
          for (let dz = -1; dz <= 1 && !rep; dz += 1) {
            const cand = repByCell.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (cand) {
              const ddx = cand.x - x, ddy = cand.y - y, ddz = cand.z - z;
              if (ddx * ddx + ddy * ddy + ddz * ddz <= eps2) {
                rep = cand;
              }
            }
          }
        }
      }
      if (!rep) {
        rep = { x, y, z };
        repByCell.set(`${cx},${cy},${cz}`, rep);
      }
      repForVert.push(rep);
    }
  } else {
    for (let v = 0; v < vertCount; v += 1) {
      repForVert.push({
        x: vertProperties[v * numProp + 0]!,
        y: vertProperties[v * numProp + 1]!,
        z: vertProperties[v * numProp + 2]!,
      });
    }
  }

  const triangles: Triangle[] = [];
  for (let t = 0; t < triVerts.length; t += 3) {
    const a = repForVert[triVerts[t + 0]!]!;
    const b = repForVert[triVerts[t + 1]!]!;
    const c = repForVert[triVerts[t + 2]!]!;
    if (a === b || b === c || a === c) {
      continue; // collapsed after welding
    }
    triangles.push([
      { x: a.x, y: a.y, z: a.z },
      { x: b.x, y: b.y, z: b.z },
      { x: c.x, y: c.y, z: c.z },
    ]);
  }
  // NOTE: the `Mesh` (MeshGL) from getMesh() is a plain JS object holding JS-owned typed
  // arrays (copied out of WASM); it has no `.delete()` and owns no WASM heap, so there is
  // nothing to free here. Only Manifold/CrossSection objects must be explicitly deleted.
  return triangles;
}

/**
 * Simplify + read back a solid in one step (with null/empty guards).
 *
 * Takes ownership of `manifold`: it is deleted before returning (along with the
 * intermediate `simplified` solid), so the caller must not use it afterward.
 */
function finalizeSolid(manifold: Manifold | null, weldEpsilon = 0): Triangle[] {
  if (!manifold) {
    return [];
  }
  if (manifold.isEmpty()) {
    manifold.delete();
    return [];
  }
  const simplified = manifold.simplify(SIMPLIFY_TOLERANCE_MM);
  manifold.delete();
  const tris = manifoldToTriangles(simplified, weldEpsilon);
  simplified.delete();
  return tris;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function buildModelGeometryCsg(spec: CsgSpec): Promise<CsgGeometryResult> {
  const api = await loadManifold();

  // ── Base solid ──────────────────────────────────────────────────────────
  const baseFp = buildBaseFootprint(spec);
  const baseCs = footprintCrossSection(api, baseFp);
  let baseSolid: Manifold = baseCs.extrude(BASE_THICKNESS_MM);
  baseCs.delete();

  // ── Primary track solid (closed loop) ────────────────────────────────────
  const primarySolid = buildRibbonManifold(
    api, spec.primaryOutline, spec.primaryProjected, spec.scale, spec.ribbon,
  );

  // ── Secondary track group (own grey group, #128) ──────────────────────────
  // Combined-mode secondary sub-chains often SHARE/abut sections; unioning their
  // separately-extruded 3D solids leaves non-manifold edges, T-junctions and wall
  // crossings at the shared joints. Instead DISSOLVE the sub-chain footprints in 2D
  // first (`CrossSection.union`) — one clean combined cross-section with the shared
  // sections merged — then extrude ONCE. For the elevation-aware case the single
  // extruded prism's top is warped by a combined sampler over ALL secondary nodes, so
  // the whole grey group is one watertight shell (closes #128). Secondaries stay their
  // OWN colour group; they are never unioned into the red primary.
  const secondaryGroup = buildSecondaryGroup(api, spec);

  // ── Text solid ────────────────────────────────────────────────────────────
  let textSolid: Manifold | null = null;
  if (spec.textSolid && spec.textSolid.footprints.length > 0) {
    const merged = buildTextCrossSection(api, spec.textSolid.footprints);
    if (merged) {
      if (!merged.isEmpty()) {
        const extruded = merged.extrude(spec.textSolid.height);
        textSolid = extruded.translate([0, 0, spec.textSolid.baseZ]);
        extruded.delete();
      }
      merged.delete();
    }
  }

  // ── Flush inlay: subtract pocket cutter from the base top ─────────────────
  if (spec.mode === 'coaster-flush') {
    const cutterCsList: CrossSection[] = [];
    // primary outline footprint
    cutterCsList.push(footprintCrossSection(api, scaleOutlineToFootprint(spec.primaryOutline, spec.scale)));
    // secondary outline footprints
    for (const { outline } of spec.secondaryOutlines) {
      cutterCsList.push(footprintCrossSection(api, scaleOutlineToFootprint(outline, spec.scale)));
    }
    // text footprints (simplified to match the text solid that fills them)
    const textCutter = buildTextCrossSection(api, spec.flushTextFootprints);
    if (textCutter) {
      cutterCsList.push(textCutter);
    }
    const cutterCross = cutterCsList.length === 1 ? cutterCsList[0]! : api.CrossSection.union(cutterCsList);
    if (!cutterCross.isEmpty()) {
      const depth = COASTER_POCKET_DEPTH_MM;
      const extrudedCutter = cutterCross.extrude(depth);
      const cutter = extrudedCutter.translate([0, 0, BASE_THICKNESS_MM - depth]);
      extrudedCutter.delete();
      const pocketed = baseSolid.subtract(cutter);
      cutter.delete();
      baseSolid.delete();
      baseSolid = pocketed;
    }
    // Free the cutter cross-sections: the fresh union (if any) plus every footprint
    // CrossSection in the list. When length === 1, cutterCross IS cutterCsList[0] and is
    // freed by the loop.
    if (cutterCross !== cutterCsList[0]) {
      cutterCross.delete();
    }
    for (const cs of cutterCsList) {
      cs.delete();
    }
  }

  // ── Readback (base, secondary, primary track, text) ──────────────────────
  // Only the flush pocket-cut base needs the readback weld (the subtract rim leaves
  // ~7-8µm sliver verts); track / secondary / text are crossing-free by construction.
  const baseWeld = spec.mode === 'coaster-flush' ? READBACK_WELD_EPSILON_MM : 0;
  const baseTris = finalizeSolid(baseSolid, baseWeld);
  const secondaryTris = finalizeSolid(secondaryGroup);
  const primaryTris = finalizeSolid(primarySolid);
  const textTris = finalizeSolid(textSolid);

  return {
    triangles: [...baseTris, ...secondaryTris, ...primaryTris, ...textTris],
    baseTriangleCount: baseTris.length,
    secondaryTrackTriangleCount: secondaryTris.length,
    trackTriangleCount: primaryTris.length,
    textTriangleCount: textTris.length,
  };
}
