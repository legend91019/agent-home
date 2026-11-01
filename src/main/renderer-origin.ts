/** Compare the renderer frame URL to the URL loaded by the workbench window. */
export function sameRendererUrl(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  try { return new URL(actual).href === new URL(expected).href; }
  catch { return false; }
}
