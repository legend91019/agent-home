import { describe, expect, it } from 'vitest';
import { sameRendererUrl } from '../../src/main/renderer-origin';

describe('renderer URL trust', () => {
  it('accepts the browser-normalized root URL of the configured dev server', () => {
    expect(sameRendererUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(true);
  });

  it('rejects other routes, origins, and query strings', () => {
    expect(sameRendererUrl('http://localhost:5173/other', 'http://localhost:5173')).toBe(false);
    expect(sameRendererUrl('http://evil.example/', 'http://localhost:5173')).toBe(false);
    expect(sameRendererUrl('http://localhost:5173/?x=1', 'http://localhost:5173')).toBe(false);
  });
});
