<script lang="ts">
  import { placementDebugData, debugScreenVisible } from '../stores/debug.js';
  import { outline, currentModel } from '../stores/model.js';
  import type { RankedTextPlacement } from '../types/text.js';
  import ScoreBreakdownDialog from './ScoreBreakdownDialog.svelte';

  let selectedPlacement: RankedTextPlacement | null = $state(null);

  function close(): void {
    debugScreenVisible.set(false);
    selectedPlacement = null;
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (selectedPlacement) {
        e.preventDefault();
        selectedPlacement = null;
      } else {
        close();
      }
    }
  }

  function scoreColor(score: number, min: number, max: number): string {
    const t = max > min ? (score - min) / (max - min) : 0.5;
    const r = Math.round(255 * (1 - t));
    const g = Math.round(255 * t);
    return `rgb(${r}, ${g}, 60)`;
  }

  function rankLabel(dedupRank: number): string | null {
    if (dedupRank === 0) return '1st';
    if (dedupRank === 1) return '2nd';
    if (dedupRank === 2) return '3rd';
    return null;
  }

  let viewBox = $derived.by(() => {
    const bp = $placementDebugData?.scaledBasePlate;
    if (!bp) return '0 0 100 100';
    const pad = Math.max(bp.width, bp.height) * 0.05;
    // Flip Y: negate and swap minY/maxY so SVG Y-down matches the model's Y-up coords.
    return `${bp.minX - pad} ${-(bp.minY + bp.height) - pad} ${bp.width + pad * 2} ${bp.height + pad * 2}`;
  });

  let dedupRankMap = $derived.by(() => {
    const deduped = $placementDebugData?.dedupedPlacements ?? [];
    const map = new Map<number, number>();
    deduped.forEach((p, i) => map.set(p.candidateIndex, i));
    return map;
  });

  let scoreThreshold = $derived(($placementDebugData?.dedupedPlacements?.[5]?.score) ?? 0);

  let scoreBounds = $derived.by(() => {
    const placements = $placementDebugData?.allScoredPlacements ?? [];
    if (!placements.length) return { min: 0, max: 1 };
    const scores = placements.map(p => p.score);
    return { min: Math.min(...scores), max: Math.max(...scores) };
  });

  let scaledOutline = $derived.by(() => {
    const o = $outline;
    const s = $currentModel?.scale ?? 1;
    if (!o) return null;
    return {
      outerRing: o.outerRing.map(p => ({ x: p.x * s, y: p.y * s })),
      holes: o.holes.map(h => h.map(p => ({ x: p.x * s, y: p.y * s }))),
    };
  });

  function pointsToPath(points: { x: number; y: number }[]): string {
    if (!points.length) return '';
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z';
  }

  let fontSize = $derived.by(() => {
    const bp = $placementDebugData?.scaledBasePlate;
    if (!bp) return 10;
    return Math.max(bp.width, bp.height) * 0.02;
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="placement-debug-overlay" onclick={close}>
  <button class="debug-overlay-close" onclick={close}>&times;</button>

  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="placement-debug-content" onclick={(e) => e.stopPropagation()}>
    {#if $placementDebugData}
      <svg class="placement-debug-svg" viewBox={viewBox} xmlns="http://www.w3.org/2000/svg">
        <!-- scale(1,-1) flips Y so the model's Y-up coords render correctly in SVG's Y-down system -->
        <g transform="scale(1,-1)">
        <!-- Base plate -->
        <rect
          x={$placementDebugData.scaledBasePlate.minX} y={$placementDebugData.scaledBasePlate.minY}
          width={$placementDebugData.scaledBasePlate.width} height={$placementDebugData.scaledBasePlate.height}
          fill="rgba(20, 24, 32, 0.9)" stroke="var(--border-strong)" stroke-width={fontSize * 0.1}
        />

        <!-- Track outline -->
        {#if scaledOutline}
          <path
            d={pointsToPath(scaledOutline.outerRing) + scaledOutline.holes.map(h => pointsToPath(h)).join('')}
            fill="rgba(255, 35, 79, 0.18)" stroke="var(--accent)" stroke-width={fontSize * 0.15}
            fill-rule="evenodd"
          />
        {/if}

        <!-- Candidate rectangles -->
        {#each $placementDebugData.allScoredPlacements.filter(p => p.score >= scoreThreshold) as placement}
          {@const b = placement.candidate.bounds}
          {@const dedupRank = dedupRankMap.get(placement.candidateIndex) ?? -1}
          {@const survived = dedupRank >= 0}
          {@const color = survived ? scoreColor(placement.score, scoreBounds.min, scoreBounds.max) : 'rgb(80,80,80)'}
          {@const isDashed = !survived || dedupRank >= 3}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <g class="candidate-group" onclick={(e) => { e.stopPropagation(); selectedPlacement = placement; }}>
            <rect
              x={b.minX} y={b.minY}
              width={b.width} height={b.height}
              fill={color} fill-opacity={survived ? 0.2 : 0.08}
              stroke={color} stroke-width={fontSize * 0.1}
              stroke-dasharray={isDashed ? `${fontSize * 0.3} ${fontSize * 0.2}` : 'none'}
              class="candidate-rect"
            />
            <text
              x={b.minX + b.width / 2} y={b.minY + b.height / 2}
              text-anchor="middle" dominant-baseline="central"
              transform="scale(1,-1) translate(0,{-(b.minY + b.height / 2) * 2})"
              fill={survived ? 'white' : 'rgb(100,100,100)'} font-size={fontSize} class="score-label"
            >
              {placement.score.toFixed(2)}
            </text>
            {#if rankLabel(dedupRank)}
              <text
                x={b.minX + fontSize * 0.3} y={b.minY + fontSize * 1.2}
                transform="scale(1,-1) translate(0,{-(b.minY + fontSize * 1.2) * 2})"
                fill="var(--accent)" font-size={fontSize * 0.9} font-weight="bold"
                class="rank-badge"
              >
                {rankLabel(dedupRank)}
              </text>
            {/if}
          </g>
        {/each}
        </g>
      </svg>

      <p class="debug-info-line">
        {$placementDebugData.allScoredPlacements.filter(p => p.score >= scoreThreshold).length} of {$placementDebugData.allScoredPlacements.length} candidates shown
        — click any rectangle for breakdown
      </p>
    {:else}
      <p class="debug-empty">No placement data available. Load a track first.</p>
    {/if}
  </div>
</div>

<ScoreBreakdownDialog
  placement={selectedPlacement}
  onclose={() => { selectedPlacement = null; }}
/>
