/**
 * The JSON path grammar of the JSON assertions: dotted keys with
 * bracket indexes, `data.items[0].status`. No wildcards, filters or slices;
 * full JSONPath is on the deferred ledger. The check reads a document with
 * it (server/checks/jsonpath.ts) and the form refuses a path it does not
 * parse.
 */

/** One dotted segment: a key, then any number of `[n]` indexes. */
const segmentShape = /^([^.[\]*]+)((?:\[\d+\])*)$/;
const indexShape = /\[(\d+)\]/g;

/** The path's steps: a key or an index each; nothing when the path is malformed. */
export function parseJsonPath(
  path: string
): readonly (string | number)[] | undefined {
  const steps: (string | number)[] = [];
  for (const segment of path.split(".")) {
    const match = segmentShape.exec(segment);
    if (!match) {
      return;
    }
    const [, key = "", indexes = ""] = match;
    steps.push(key);
    for (const index of indexes.matchAll(indexShape)) {
      steps.push(Number(index[1]));
    }
  }
  return steps;
}
