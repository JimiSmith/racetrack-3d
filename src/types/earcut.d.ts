declare module 'earcut' {
  function earcut(
    data: number[],
    holeIndices?: number[] | null,
    dim?: number,
  ): number[];
  export default earcut;
}
