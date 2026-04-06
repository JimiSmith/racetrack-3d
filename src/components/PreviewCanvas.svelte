<script lang="ts">
  import { onMount } from 'svelte';
  import { initPreview, updatePreview } from '../preview/renderer.js';
  import { currentModel } from '../stores/model.js';
  import { previewOverlayState } from '../stores/ui.js';

  onMount(() => {
    initPreview();
    return () => {
      updatePreview(null);
    };
  });

  $effect(() => {
    updatePreview($currentModel);
  });
</script>

<section class="preview-card">
  <div class="section-heading-row">
    <p class="section-heading">3D preview</p>
  </div>
  <div class="preview-frame">
    <div id="preview" aria-label="3D preview"></div>
    {#if !$previewOverlayState.hidden}
      <div id="preview-overlay" class="preview-overlay" aria-live="polite">
        <p id="preview-overlay-title">{$previewOverlayState.title}</p>
        <p id="preview-overlay-body">{$previewOverlayState.body}</p>
      </div>
    {/if}
  </div>
  <p class="preview-footnote">Drag to rotate. Pinch or scroll to zoom.</p>
</section>
