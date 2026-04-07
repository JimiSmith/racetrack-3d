<script lang="ts">
  import type { RankedTextPlacement } from '../types/text.js';

  interface Props {
    placement: RankedTextPlacement | null;
    onclose: () => void;
  }

  let { placement, onclose }: Props = $props();

  let dialogEl: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (placement && dialogEl && !dialogEl.open) {
      dialogEl.showModal();
    } else if (!placement && dialogEl?.open) {
      dialogEl.close();
    }
  });

  function handleClose(): void {
    onclose();
  }

  const FACTOR_LABELS: Record<string, string> = {
    lineBalance: 'Line balance',
    textHeight: 'Text height (mm)',
    outsideMultiplier: 'Outside penalty',
    lineCountMultiplier: 'Line count',
    sizeWindowMultiplier: 'Size window',
    trackClearanceMultiplier: 'Track clearance',
    centralityMultiplier: 'Centrality',
    textClearanceMultiplier: 'Text clearance',
  };

  const MULTIPLIER_KEYS = [
    'outsideMultiplier',
    'lineCountMultiplier',
    'sizeWindowMultiplier',
    'trackClearanceMultiplier',
    'centralityMultiplier',
    'textClearanceMultiplier',
  ] as const;
</script>

{#if placement}
<dialog class="score-breakdown" bind:this={dialogEl} onclose={handleClose}>
  <header class="breakdown-header">
    <h3>Score breakdown — #{placement.candidateIndex}</h3>
    <button class="breakdown-close" onclick={handleClose}>&times;</button>
  </header>

  <div class="breakdown-context">
    <p>Lines: {placement.layout.lines.join(' / ')}</p>
    <p>Fitted: {placement.layout.fittedWidth.toFixed(1)} &times; {placement.layout.fittedHeight.toFixed(1)} mm</p>
    <p>Candidate: {placement.candidate.bounds.width.toFixed(1)} &times; {placement.candidate.bounds.height.toFixed(1)} mm</p>
  </div>

  {#if placement.scoreBreakdown}
  <table class="breakdown-table">
    <thead>
      <tr><th>Factor</th><th>Value</th><th>Impact</th></tr>
    </thead>
    <tbody>
      {#each Object.entries(placement.scoreBreakdown) as [key, value]}
      <tr>
        <td>{FACTOR_LABELS[key] ?? key}</td>
        <td class="mono">{typeof value === 'number' ? value.toFixed(4) : value}</td>
        <td class="mono">
          {#if MULTIPLIER_KEYS.includes(key as typeof MULTIPLIER_KEYS[number])}
            {typeof value === 'number' && value !== 1 ? ((value - 1) * 100 >= 0 ? '+' : '') + ((value - 1) * 100).toFixed(1) + '%' : '—'}
          {:else}
            —
          {/if}
        </td>
      </tr>
      {/each}
    </tbody>
    <tfoot>
      <tr><td>Composite score</td><td class="mono" colspan="2">{placement.score.toFixed(4)}</td></tr>
    </tfoot>
  </table>
  {/if}
</dialog>
{/if}
