import { describe, expect, it, vi } from "vitest";
import { createEvolutionScheduler } from "./scheduler.js";

describe("evolution scheduler", () => {
  it("runs scout and synthesis on cadence and stops cleanly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const onScout = vi.fn(async () => {});
    const onSynthesize = vi.fn(async () => {});

    const scheduler = createEvolutionScheduler({
      scoutEveryMs: 1000,
      synthEveryMs: 3000,
      onScout,
      onSynthesize,
    });

    scheduler.start();
    expect(scheduler.getNextScoutAtMs()).not.toBeNull();
    expect(scheduler.getNextSynthAtMs()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1100);
    expect(onScout).toHaveBeenCalledTimes(1);
    expect(onSynthesize).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(2100);
    expect(onScout).toHaveBeenCalledTimes(3);
    expect(onSynthesize).toHaveBeenCalledTimes(1);

    scheduler.stop();
    const scoutCalls = onScout.mock.calls.length;
    const synthCalls = onSynthesize.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(onScout).toHaveBeenCalledTimes(scoutCalls);
    expect(onSynthesize).toHaveBeenCalledTimes(synthCalls);

    vi.useRealTimers();
  });
});
