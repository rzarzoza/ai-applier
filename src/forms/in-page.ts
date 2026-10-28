/**
 * Wraps a browser-side function so Playwright can serialize it under any transform.
 * tsx/esbuild (keepNames) wraps nested functions in `__name(...)`, a helper that does not exist
 * in the page. Building the function with `new Function` from the (already compiled) source
 * shadows `__name` locally, and Playwright serializes the result via toString() as usual.
 */
export function inPage<A, R>(fn: (arg: A) => R): (arg: A) => R {
  return new Function("arg", `const __name = (f) => f; return (${fn.toString()})(arg);`) as (arg: A) => R;
}
