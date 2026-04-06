import type { Layout } from '../types/geometry.js';

interface LayoutOption {
  value: string;
  label: string;
  selected: boolean;
}

interface LayoutPickerState {
  hidden: boolean;
  hint: string;
  options: LayoutOption[];
  selectedIndex: number;
  selectedLayout: Layout | null;
}

export function formatLayoutOptionLabel(layout: Layout | undefined | null, index: number): string {
  const fallback = `Layout ${index + 1}`;
  const name = layout?.name?.trim() || fallback;
  const lengthKm = layout?.stats?.lengthMetres ? layout.stats.lengthMetres / 1000 : null;
  return Number.isFinite(lengthKm) ? `${name} - ${(lengthKm as number).toFixed(1)} km` : name;
}

export function normalizeSelectedLayoutIndex(
  layouts: Layout[] | undefined | null,
  selectedIndex: number = 0,
): number {
  if (!Array.isArray(layouts) || layouts.length === 0) {
    return 0;
  }

  const numericIndex = Number(selectedIndex);
  if (!Number.isInteger(numericIndex)) {
    return 0;
  }

  return Math.min(Math.max(numericIndex, 0), layouts.length - 1);
}

export function getSelectedLayout(
  layouts: Layout[] | undefined | null,
  selectedIndex: number = 0,
): Layout | null {
  if (!Array.isArray(layouts)) {
    return null;
  }
  return layouts[normalizeSelectedLayoutIndex(layouts, selectedIndex)] ?? null;
}

export function buildLayoutPickerState(
  layouts: Layout[] | undefined | null,
  selectedIndex: number = 0,
): LayoutPickerState {
  const normalizedIndex = normalizeSelectedLayoutIndex(layouts, selectedIndex);

  if (!Array.isArray(layouts) || layouts.length <= 1) {
    return {
      hidden: true,
      hint: '',
      options: [],
      selectedIndex: normalizedIndex,
      selectedLayout: getSelectedLayout(layouts, normalizedIndex),
    };
  }

  const variantSectionCount = layouts[0]?.stats?.variantSectionCount ?? 1;

  return {
    hidden: false,
    hint:
      variantSectionCount === 1
        ? 'Select the alternate section to use for the circuit.'
        : `Select one of ${layouts.length} fork-based layout combinations.`,
    options: layouts.map((layout, index) => ({
      value: String(index),
      label: formatLayoutOptionLabel(layout, index),
      selected: index === normalizedIndex,
    })),
    selectedIndex: normalizedIndex,
    selectedLayout: layouts[normalizedIndex] ?? null,
  };
}
