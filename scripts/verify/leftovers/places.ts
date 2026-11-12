/**
 * The attempt places teamai's own records say an external step runtime still keeps open, under every HOME of the world,
 * and each attempt that ran on seatbelt. The record is the product's (`readAttemptPlacementAt`), read the way a cancel reads it.
 */
import path from 'node:path';
import { isPlaceLeftOpen, readAttemptPlacementAt, type AttemptPlacement } from '../../../src/workflow/runtimes/attempt.js';
import type { LeftoverKind } from '../leftovers.js';

/** Each record file's placement, in the order given. */
export function readPlacements(files: readonly string[]): Promise<AttemptPlacement[]> {
  return Promise.all(files.map((file) => readAttemptPlacementAt(file)));
}

/** `<run> attempt <attempt>` from `.../runs/<run>/attempts/<attempt>/runtime.json`. */
function attemptOf(file: string): string {
  const attempt = path.dirname(file);

  return `${path.basename(path.dirname(path.dirname(attempt)))} attempt ${path.basename(attempt)}`;
}

export const places: LeftoverKind = {
  title: 'open attempt place',
  // A record is the run's history: the ledger reports an open one, and cleanup removes the world with it.
  onCleanup: 'keep',
  async observe({ records }) {
    const placements = await readPlacements(records.files);

    const findings = records.files.flatMap((file, index) => {
      const placement = placements[index];

      if (placement === undefined) return [];
      const own = { kind: 'own' as const, why: `teamai's record ${file}` };

      if (placement.kind === 'unreadable') return [{ what: `the runtime record of run ${attemptOf(file)}, which cannot be read (${placement.why}), so whether its place is open is unknown`, attribution: own }];

      if (!isPlaceLeftOpen(placement)) return [];
      const { record } = placement;
      const held = record.heldFor === undefined ? '' : `, held for a ${record.heldFor.conversation.tool} conversation`;

      return [{ what: `run ${attemptOf(file)}'s place on ${record.driver}/${record.runtime}${record.open.handle === undefined ? '' : ` (${record.open.handle})`}, ${record.phase}${held}`, attribution: own }];
    });

    // The record keeps the provider once the place closes, which a short step does before the observer looks.
    const notes = records.files.flatMap((file, index) => {
      const placement = placements[index];
      const isSeatbelt = placement?.kind === 'external' && (placement.record.sources ?? []).some((source) => source.sandbox?.provider === 'seatbelt');

      return isSeatbelt ? [`run ${attemptOf(file)} ran on seatbelt, which no observer reads: the env check proves nothing for it`] : [];
    });

    return [{ kind: 'observed', findings, notes }];
  },
};
