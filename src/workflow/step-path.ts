/** One segment of a step path: a step id, and the item index when the instance is one item of a `for_each` step. */
export interface StepPathSegment {
  id: string;
  index?: number;
}

const ITEM = /^([^[\]]+)\[(0|[1-9][0-9]*)\]$/;

/**
 * The segments of a step instance's path, such as `a.b[2].c`. Step ids contain neither "." nor "[",
 * so a segment that is not `<id>[<n>]` is read whole as an id, which names no step.
 */
export function parseStepPath(path: string): StepPathSegment[] {
  return path.split('.').map((segment) => {
    const item = ITEM.exec(segment);
    return item ? { id: item[1]!, index: Number(item[2]) } : { id: segment };
  });
}
