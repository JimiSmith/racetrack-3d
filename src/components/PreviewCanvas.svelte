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

<div id="preview" aria-label="3D preview"></div>
{#if !$previewOverlayState.hidden}
  <div id="preview-overlay" class="preview-overlay" aria-live="polite">
    <p id="preview-overlay-title">{$previewOverlayState.title}</p>
    <p id="preview-overlay-body">{$previewOverlayState.body}</p>
  </div>
{/if}
<p class="canvas-hud" aria-hidden="true">Drag · rotate &nbsp;·&nbsp; Scroll · zoom</p>
