export interface PerfEntry {
  step: string;
  ms: number;
}

export class PerfTimer {
  private marks: { name: string; time: number }[] = [];
  private start: number;

  constructor() {
    this.start = performance.now();
  }

  step(name: string): void {
    this.marks.push({ name, time: performance.now() });
  }

  finish(): PerfEntry[] {
    const end = performance.now();
    const entries: PerfEntry[] = [];
    let prev = this.start;
    for (const mark of this.marks) {
      entries.push({ step: mark.name, ms: Number((mark.time - prev).toFixed(1)) });
      prev = mark.time;
    }
    entries.push({ step: 'total', ms: Number((end - this.start).toFixed(1)) });
    return entries;
  }
}
