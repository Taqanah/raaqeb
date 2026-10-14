/**
 * Readable server function ids for TanStack Start's
 * `serverFns.generateFunctionId` (vite.config.ts), in place of its default,
 * the SHA-256 of the file and the export: a server function's URL and the
 * request log's line then name it, as `/_serverFn/routes.-monitors--testMonitorFn`.
 */

/** What Start hands the generator: the file relative to the project root, and the export it extracted. */
export interface ServerFunctionSource {
  readonly filename: string;
  readonly functionName: string;
}

/**
 * A generator of ids, one per build: the module path under `src/` with dots
 * for slashes, `--`, and the variable the function is assigned to. The same
 * function always gets the same id; two functions that would share one, or a
 * file outside the project or outside `src/`, fail the build.
 */
export function serverFunctionIds(): (source: ServerFunctionSource) => string {
  // Each id with the source it was given, so a second asker gets the same and a clash is caught.
  const given = new Map<string, string>();
  return ({ filename, functionName }) => {
    const file = filename.replaceAll("\\", "/");
    if (outsideProject.test(file)) {
      throw new Error(
        `a server function in a file outside the project: ${functionName}`
      );
    }
    if (!sourceRoot.test(file)) {
      throw new Error(
        `a server function in a file outside src: ${file}#${functionName}`
      );
    }
    const module = file
      .replace(sourceRoot, "")
      .replace(extension, "")
      .replaceAll("/", ".");
    const id =
      `${module}--${functionName.replace(handlerSuffix, "$1")}`.replace(
        unsafe,
        "_"
      );
    const source = `${file}#${functionName}`;
    const earlier = given.get(id);
    if (earlier !== undefined && earlier !== source) {
      throw new Error(
        `two server functions share the id ${id}: ${earlier} and ${source}`
      );
    }
    given.set(id, source);
    return id;
  };
}

// Absolute, on either system, or above the root.
const outsideProject = /^(\/|[A-Za-z]:|\.\.\/)/;
const sourceRoot = /^src\//;
const extension = /\.[cm]?[jt]sx?$/;
// Start names the extracted handler `<variable>_createServerFn_handler`, numbering a repeat `_1`.
const handlerSuffix = /_createServerFn_handler(_\d+)?$/;
// Anything a URL path segment would percent-encode, or split on.
const unsafe = /[^\w.$-]/g;
