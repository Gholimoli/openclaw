import { computeNextRunAtMs } from "../cron/schedule.js";

export type EvolutionScheduler = {
  start: () => void;
  stop: () => void;
  getNextScoutAtMs: () => number | null;
  getNextSynthAtMs: () => number | null;
};

export function createEvolutionScheduler(params: {
  scoutEveryMs: number;
  synthEveryMs: number;
  onScout: () => Promise<void>;
  onSynthesize: () => Promise<void>;
  now?: () => number;
}): EvolutionScheduler {
  const now = params.now ?? Date.now;
  let scoutTimer: ReturnType<typeof setTimeout> | null = null;
  let synthTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let nextScoutAtMs: number | null = null;
  let nextSynthAtMs: number | null = null;

  const scheduleScout = () => {
    if (!running) {
      return;
    }
    // Add 1ms so "every" schedules are always strictly in the future and never
    // re-arm immediately on exact cadence boundaries.
    const next = computeNextRunAtMs(
      { kind: "every", everyMs: params.scoutEveryMs, anchorMs: 0 },
      now() + 1,
    );
    nextScoutAtMs = next ?? null;
    if (!next) {
      return;
    }
    const delay = Math.max(0, next - now());
    scoutTimer = setTimeout(() => {
      void params.onScout().finally(() => {
        scheduleScout();
      });
    }, delay);
  };

  const scheduleSynth = () => {
    if (!running) {
      return;
    }
    // Add 1ms so "every" schedules are always strictly in the future and never
    // re-arm immediately on exact cadence boundaries.
    const next = computeNextRunAtMs(
      { kind: "every", everyMs: params.synthEveryMs, anchorMs: 0 },
      now() + 1,
    );
    nextSynthAtMs = next ?? null;
    if (!next) {
      return;
    }
    const delay = Math.max(0, next - now());
    synthTimer = setTimeout(() => {
      void params.onSynthesize().finally(() => {
        scheduleSynth();
      });
    }, delay);
  };

  return {
    start: () => {
      if (running) {
        return;
      }
      running = true;
      scheduleScout();
      scheduleSynth();
    },
    stop: () => {
      running = false;
      if (scoutTimer) {
        clearTimeout(scoutTimer);
        scoutTimer = null;
      }
      if (synthTimer) {
        clearTimeout(synthTimer);
        synthTimer = null;
      }
      nextScoutAtMs = null;
      nextSynthAtMs = null;
    },
    getNextScoutAtMs: () => nextScoutAtMs,
    getNextSynthAtMs: () => nextSynthAtMs,
  };
}
