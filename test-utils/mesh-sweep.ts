/**
 * Shared mesh-validation sweep core (issue #122).
 *
 * Pure, importable engine with NO `process.exit` and NO `console` output: given a
 * track record + a build mode it produces a structured result, and given a list of
 * track ids it returns aggregated `SweepFailure[]`. Both the CLI sweep
 * (`scripts/validate-meshes.ts`) and the committed test
 * (`test/mesh-sweep-sample.test.ts`) import this, so the test validates the SAME
 * code path the CLI runs.
 *
 * Builds go through the worker/export path exactly as `src/workers/model.worker.ts`
 * does: `buildTrackModel({ outlinePoints: null, basePlate: null, ... })` derives the
 * real outline + base plate internally, then `validateModel()` (src/model/validate-mesh.ts,
 * from #121/#123) runs the current non-manifold, degenerate, and T-junction (#109)
 * detectors on every part.
 *
 * The failure predicate and row formatter iterate `report.parts` generically, so the
 * #115 (self-intersection / flipped winding / disjoint shell) detectors slot in later by
 * extending `validateModel` / `PartReport` and adding one line to `partFailed` + the
 * formatter — no structural change here.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { projectNodes } from '../src/geometry/projection.js';
import { buildTrackModel } from '../src/model/track-model.js';
import { validateModel } from '../src/model/validate-mesh.js';
import type { PartReport } from '../src/model/validate-mesh.js';
import type { LatLonNode } from '../src/types/geometry.js';

// ── Geometry corpus reading (no network) ──────────────────────────────────────

/** Minimal local shape of a buildable prebuilt geometry file. */
export interface PrebuiltTrackFile {
  trackId: string;
  name?: string;
  center?: { lat: number; lon: number };
  names?: { searchLabel?: string | null };
  layouts?: { id?: string; name?: string; nodes?: LatLonNode[] }[];
  selectedLayoutIndex?: number;
}

const GEOMETRY_DIR = new URL('../src/generated/geometry', import.meta.url).pathname;

/** A layout is buildable when it has at least 3 nodes (a valid chain). */
function buildableLayouts(file: PrebuiltTrackFile): { name: string; nodes: LatLonNode[] }[] {
  return (file.layouts ?? [])
    .filter((l): l is { id?: string; name?: string; nodes: LatLonNode[] } =>
      Array.isArray(l.nodes) && l.nodes.length >= 3,
    )
    .map(l => ({ name: l.name ?? l.id ?? '', nodes: l.nodes }));
}

/** True iff the file has at least one buildable layout. */
export function isBuildable(file: PrebuiltTrackFile): boolean {
  return buildableLayouts(file).length > 0;
}

/** The printed track label resolved the same way the runtime does. */
export function trackLabel(file: PrebuiltTrackFile): string {
  return file.names?.searchLabel ?? file.name ?? file.trackId;
}

/** Reads one geometry file by wikidata id, or returns null if missing. */
export function readTrackFile(trackId: string): PrebuiltTrackFile | null {
  try {
    const raw = readFileSync(join(GEOMETRY_DIR, `${trackId}.json`), 'utf-8');
    return JSON.parse(raw) as PrebuiltTrackFile;
  } catch {
    return null;
  }
}

/** All track ids that have a geometry file (buildable or stub), sorted. */
export function allTrackIds(): string[] {
  return readdirSync(GEOMETRY_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -'.json'.length))
    .sort();
}

/** All buildable track ids, sorted. */
export function buildableTrackIds(): string[] {
  return allTrackIds().filter(id => {
    const file = readTrackFile(id);
    return file !== null && isBuildable(file);
  });
}

// ── Mode matrix ───────────────────────────────────────────────────────────────

export interface Mode {
  coaster: boolean;
  coasterInlay: 'flush' | 'raised';
  coasterShape: 'round' | 'square';
  orientationDeg: number | 'auto';
  /** When true and the track has >1 layout, the other layouts build as secondaries. */
  combined: boolean;
}

export type SweepVariant = 'sample' | 'all' | 'full';

/** Human-readable mode string for the failure table. */
export function modeLabel(mode: Mode): string {
  const orient = mode.orientationDeg === 'auto' ? 'auto' : `${mode.orientationDeg}deg`;
  const layouts = mode.combined ? 'combined' : 'single';
  if (!mode.coaster) {
    return `flat/${orient}/${layouts}`;
  }
  return `coaster-${mode.coasterInlay}-${mode.coasterShape}/${orient}/${layouts}`;
}

/** Default non-coaster sub-axes (inlay/shape are no-ops when coaster:false). */
const FLAT: Pick<Mode, 'coaster' | 'coasterInlay' | 'coasterShape'> = {
  coaster: false,
  coasterInlay: 'raised',
  coasterShape: 'round',
};

/**
 * Enumerates the build modes for a track under a given variant. Pure function — the
 * tables in the plan ARE this code. `multiLayout` adds `combined` variants only when
 * the track actually has more than one buildable layout.
 */
export function enumerateModes(multiLayout: boolean, variant: SweepVariant): Mode[] {
  if (variant === 'sample') {
    // auto-trimmed 5-mode matrix: exactly ONE `auto` build per track.
    const base: Mode[] = [
      { ...FLAT, orientationDeg: 'auto', combined: false },
      { ...FLAT, orientationDeg: 0, combined: false },
      { ...FLAT, orientationDeg: 90, combined: false },
      { coaster: true, coasterInlay: 'flush', coasterShape: 'round', orientationDeg: 0, combined: false },
      { coaster: true, coasterInlay: 'raised', coasterShape: 'square', orientationDeg: 90, combined: false },
    ];
    if (multiLayout) {
      base.push({ ...FLAT, orientationDeg: 'auto', combined: true });
      base.push({ coaster: true, coasterInlay: 'flush', coasterShape: 'round', orientationDeg: 0, combined: true });
    }
    return base;
  }

  if (variant === 'all') {
    // lean 8-mode matrix (auto-heavy — on-demand only).
    const base: Mode[] = [
      { ...FLAT, orientationDeg: 'auto', combined: false },
      { ...FLAT, orientationDeg: 0, combined: false },
      { ...FLAT, orientationDeg: 90, combined: false },
      { coaster: true, coasterInlay: 'raised', coasterShape: 'round', orientationDeg: 'auto', combined: false },
      { coaster: true, coasterInlay: 'flush', coasterShape: 'round', orientationDeg: 'auto', combined: false },
      { coaster: true, coasterInlay: 'raised', coasterShape: 'square', orientationDeg: 'auto', combined: false },
      { coaster: true, coasterInlay: 'flush', coasterShape: 'square', orientationDeg: 'auto', combined: false },
      { coaster: true, coasterInlay: 'flush', coasterShape: 'round', orientationDeg: 0, combined: false },
    ];
    if (multiLayout) {
      base.push({ ...FLAT, orientationDeg: 'auto', combined: true });
      base.push({ coaster: true, coasterInlay: 'flush', coasterShape: 'round', orientationDeg: 'auto', combined: true });
      base.push({ coaster: true, coasterInlay: 'raised', coasterShape: 'round', orientationDeg: 'auto', combined: true });
    }
    return base;
  }

  // 'full' cross-product — single track, on demand.
  const modes: Mode[] = [];
  const orientations: (number | 'auto')[] = ['auto', 0, 90];
  const layoutVariants = multiLayout ? [false, true] : [false];
  for (const combined of layoutVariants) {
    for (const orientationDeg of orientations) {
      modes.push({ ...FLAT, orientationDeg, combined });
    }
    for (const coasterInlay of ['raised', 'flush'] as const) {
      for (const coasterShape of ['round', 'square'] as const) {
        for (const orientationDeg of orientations) {
          modes.push({ coaster: true, coasterInlay, coasterShape, orientationDeg, combined });
        }
      }
    }
  }
  return modes;
}

// ── Building + validating one (track, mode) ───────────────────────────────────

export interface SweepFailure {
  trackId: string;
  trackLabel: string;
  mode: string;
  part: PartReport['part'] | 'build';
  nonManifoldEdges: number;
  degenerateTriangles: number;
  tJunctions: number;
  /** From nonManifoldEdges[0], rounded to 4dp. */
  firstEdge?: { a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number } };
  buildError?: string;
}

/** Failure predicate for a part — extend here when #115 fields land on PartReport. */
function partFailed(part: PartReport): boolean {
  return (
    part.nonManifoldEdges.length > 0 ||
    part.degenerateTriangles.length > 0 ||
    part.tJunctions.length > 0
  );
}

function round4(n: number): number {
  return +n.toFixed(4);
}

/**
 * Builds one (track, mode) through the worker/export path and validates it.
 * Returns the failure rows for this single build (empty when clean). A thrown build
 * error becomes one row with `part: 'build'` so a crash on a hard track is reported.
 */
export function sweepOne(file: PrebuiltTrackFile, mode: Mode): SweepFailure[] {
  const label = trackLabel(file);
  const layouts = buildableLayouts(file);
  const primaryIndex =
    file.selectedLayoutIndex !== undefined && file.selectedLayoutIndex < layouts.length
      ? file.selectedLayoutIndex
      : 0;
  const primary = layouts[primaryIndex]!;
  const others = layouts.filter((_, i) => i !== primaryIndex);
  const center = file.center ?? null;

  try {
    const projected = projectNodes(primary.nodes, null, center);
    const secondaryProjectedNodes =
      mode.combined && others.length > 0
        ? others.map(l => projectNodes(l.nodes, null, center))
        : [];

    const model = buildTrackModel({
      outlinePoints: null,
      basePlate: null,
      trackName: label,
      projectedNodes: projected,
      secondaryProjectedNodes,
      primaryOrientationDeg: mode.orientationDeg,
      coasterMode: mode.coaster,
      coasterShape: mode.coasterShape,
      coasterInlay: mode.coasterInlay,
      trackWidthAuto: true,
    });

    const report = validateModel(model);
    const failures: SweepFailure[] = [];
    for (const part of report.parts) {
      if (!partFailed(part)) {
        continue;
      }
      const first = part.nonManifoldEdges[0];
      failures.push({
        trackId: file.trackId,
        trackLabel: label,
        mode: modeLabel(mode),
        part: part.part,
        nonManifoldEdges: part.nonManifoldEdges.length,
        degenerateTriangles: part.degenerateTriangles.length,
        tJunctions: part.tJunctions.length,
        ...(first
          ? {
              firstEdge: {
                a: { x: round4(first.a.x), y: round4(first.a.y), z: round4(first.a.z) },
                b: { x: round4(first.b.x), y: round4(first.b.y), z: round4(first.b.z) },
              },
            }
          : {}),
      });
    }
    return failures;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      {
        trackId: file.trackId,
        trackLabel: label,
        mode: modeLabel(mode),
        part: 'build',
        nonManifoldEdges: 0,
        degenerateTriangles: 0,
        tJunctions: 0,
        buildError: message,
      },
    ];
  }
}

// ── Aggregating over a list of tracks ─────────────────────────────────────────

export interface SweepResult {
  failures: SweepFailure[];
  built: number;
  skipped: { trackId: string; reason: 'no-geometry' }[];
}

export interface RunSweepOptions {
  /** Selects the per-track mode matrix. Defaults to 'sample'. */
  variant?: SweepVariant;
}

/**
 * Runs the sweep over a list of track ids. Stub/no-geometry files are recorded as
 * skipped (never failures). Returns aggregated failures + counts.
 */
export function runSweep(trackIds: string[], options: RunSweepOptions = {}): SweepResult {
  const variant = options.variant ?? 'sample';
  const failures: SweepFailure[] = [];
  const skipped: SweepResult['skipped'] = [];
  let built = 0;

  for (const trackId of trackIds) {
    const file = readTrackFile(trackId);
    if (file === null || !isBuildable(file)) {
      skipped.push({ trackId, reason: 'no-geometry' });
      continue;
    }
    const multiLayout = buildableLayouts(file).length > 1;
    const modes = enumerateModes(multiLayout, variant);
    for (const mode of modes) {
      failures.push(...sweepOne(file, mode));
    }
    built += 1;
  }

  return { failures, built, skipped };
}

// ── Compact failure table formatting ──────────────────────────────────────────

const COLS = {
  id: 12,
  label: 28,
  mode: 30,
  part: 10,
  nm: 8,
  degen: 7,
  tjunc: 7,
};

function truncate(s: string, width: number): string {
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}

function formatFirstEdge(f: SweepFailure): string {
  if (f.buildError) {
    return `BUILD ERROR: ${f.buildError}`;
  }
  if (!f.firstEdge) {
    return '';
  }
  const { a, b } = f.firstEdge;
  return `(${a.x},${a.y},${a.z})->(${b.x},${b.y},${b.z})`;
}

/**
 * Renders the compact failure table: one row per failed (track, mode, part), with a
 * summary footer. Used both as the CLI stdout table and as the test's assert message.
 */
export function formatFailureTable(result: SweepResult, tracksRequested: number): string {
  const lines: string[] = [];
  const header =
    'track id'.padEnd(COLS.id) +
    'label'.padEnd(COLS.label) +
    'mode'.padEnd(COLS.mode) +
    'part'.padEnd(COLS.part) +
    'nm-edges'.padStart(COLS.nm) +
    'degens'.padStart(COLS.degen) +
    'tjunc'.padStart(COLS.tjunc) +
    '  first edge';
  lines.push(header);
  lines.push('-'.repeat(header.length));

  for (const f of result.failures) {
    lines.push(
      f.trackId.padEnd(COLS.id) +
        truncate(f.trackLabel, COLS.label).padEnd(COLS.label) +
        truncate(f.mode, COLS.mode).padEnd(COLS.mode) +
        f.part.padEnd(COLS.part) +
        String(f.nonManifoldEdges).padStart(COLS.nm) +
        String(f.degenerateTriangles).padStart(COLS.degen) +
        String(f.tJunctions).padStart(COLS.tjunc) +
        '  ' +
        formatFirstEdge(f),
    );
  }

  const failedTracks = new Set(result.failures.map(f => f.trackId)).size;
  lines.push('-'.repeat(header.length));
  lines.push(
    `${result.built} tracks built, ${result.skipped.length} skipped (no geometry), ` +
      `${result.failures.length} failures across ${failedTracks} tracks ` +
      `(${tracksRequested} requested)`,
  );
  return lines.join('\n');
}

// ── Representative sample (shared by CLI default + committed test) ─────────────

/**
 * Deterministic, committed representative sample (~40 tracks). Anchored by the
 * verified known-hard ids (long name, many layouts, hairpins) plus a deterministic
 * spread sampled every-Nth across the sorted buildable corpus. NOT randomized per run.
 */
export const REPRESENTATIVE_SAMPLE: string[] = [
  // Anchors (known-hard, verified):
  'Q172851', // Spa-Francorchamps Circuit — long name + 2 layouts
  'Q171402', // Silverstone Circuit — 6 layouts (heavy combined)
  'Q171566', // Red Bull Ring — 3 layouts
  'Q171400', // Circuit de Monaco — tight hairpins, street circuit
  'Q173099', // 7 layouts (max layout count; combined stress)
  // Deterministic every-Nth spread across the sorted buildable corpus:
  'Q102141307',
  'Q108016849',
  'Q113455971',
  'Q116973540',
  'Q123411911',
  'Q129408771',
  'Q135397446',
  'Q14250583',
  'Q1523618',
  'Q1626077',
  'Q16830288',
  'Q17004958',
  'Q171449',
  'Q172884',
  'Q1738522',
  'Q18680802',
  'Q20022006',
  'Q222686',
  'Q2630372',
  'Q29035351',
  'Q3208132',
  'Q390103',
  'Q4827211',
  'Q4827237',
  'Q4879200',
  'Q5121627',
  'Q5457795',
  'Q5713001',
  'Q5967569',
  'Q648512',
  'Q6918074',
  'Q7170876',
  'Q7570163',
  'Q786639',
  'Q813859',
];
