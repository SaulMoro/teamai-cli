import { createHash } from 'node:crypto';
import { canonicalJson } from '../../utils/canonical-json.js';
import type { DriverDefinition, ResolvedDriver } from './definitions.js';

/**
 * Which entry of a driver definition a step runtime was opened from, as each attempt on it records it. `name` is the
 * runtime as records and messages name it (`use`, or `use through through`). `digest` is the sha256 of the entry as it
 * runs: its `use`, `through`, `sandbox` and options, with the member's `workflows.drivers.<driver>.runtimes` for each
 * runtime it names over them. Two entries with one digest start the same runtime on the same options, which answers for
 * the same handles, so either reaches a place the other opened. `isNameShared`: another entry of the definition has the
 * same name, so a record that names only the runtime, as one written before records named the entry, cannot tell which
 * of them holds its place.
 */
export interface RuntimeEntryIdentity {
  name: string;
  digest: string;
  isNameShared: boolean;
}

/** What an attempt's runtime record says of where its place is: the runtime's name, and the entry's digest once recorded. */
interface RecordedEntry {
  runtime: string;
  entry?: string | undefined;
}

type DefinitionEntry = DriverDefinition['runtimes'][number];

/** The name the engine gives `inner` through `outer`, in its records and messages. */
export function composedName(inner: string, outer: string): string {
  return `${inner} through ${outer}`;
}

const nameOf = (entry: DefinitionEntry): string => (entry.through === undefined ? entry.use : composedName(entry.use, entry.through));

/** The identity of `entry`, one of `driver`'s runtimes, as it runs on this machine. */
function of(driver: ResolvedDriver, entry: DefinitionEntry): RuntimeEntryIdentity {
  const member = driver.config.workflows?.drivers?.[driver.name]?.runtimes;

  const runs = {
    use: entry.use, through: entry.through, sandbox: entry.sandbox, options: entry.options,
    member: { [entry.use]: member?.[entry.use], ...(entry.through !== undefined && { [entry.through]: member?.[entry.through] }) },
  };

  const name = nameOf(entry);

  return {
    name,
    digest: createHash('sha256').update(canonicalJson(runs)).digest('hex'),
    isNameShared: driver.definition.runtimes.filter((other) => nameOf(other) === name).length > 1,
  };
}

/**
 * Whether the place `record` names is on the runtime of `entry`: by the entry's digest once the record has one; else,
 * for a record written before records named the entry, by the runtime's name, while no other entry shares it.
 */
function holds(record: RecordedEntry, entry: RuntimeEntryIdentity): boolean {
  return record.entry === undefined ? record.runtime === entry.name && !entry.isNameShared : record.entry === entry.digest;
}

/**
 * The one of `candidates`, the runtimes driver `driver` opened, that holds the place `record` names, or why none does.
 * None is taken for another of the same name: a stop sent there would find nothing and close nothing it ran.
 */
function find<TCandidate extends { entry: RuntimeEntryIdentity }>(record: RecordedEntry, candidates: readonly TCandidate[], driver: string): { ok: true; found: TCandidate } | { ok: false; why: string } {
  const found = candidates.find((candidate) => holds(record, candidate.entry));

  if (found) return { ok: true, found };
  const named = candidates.filter((candidate) => candidate.entry.name === record.runtime);

  if (named.length === 0) return { ok: false, why: `driver "${driver}" no longer uses that runtime.` };

  if (record.entry !== undefined) return { ok: false, why: `the entry of driver "${driver}" that ran it changed since, in the definition or in your workflows.drivers.${driver}.runtimes, so teamai cannot tell that the runtime it would ask runs on the same options. Put the entry back as it was.` };

  return { ok: false, why: `driver "${driver}" lists runtime "${record.runtime}" more than once, and the attempt's record, which an earlier teamai wrote, does not say which entry ran it.` };
}

/** Which entry of a driver definition each attempt's place is on, and the one test of whether a runtime holds it. */
export const RuntimeEntryIdentity = { of, holds, find } as const;
