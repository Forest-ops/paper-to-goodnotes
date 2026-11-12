// Map strokes from photo pixels to Goodnotes page points.
// The photo's width becomes a US-Letter-wide area (612 pt) on the whiteboard, starting at
// `origin`, so a full page of notes comes out at roughly real paper size.
export const PAGE_WIDTH_PT = 612;

export function toPage(strokes, imgWidth, imgHeight, origin, { pageWidth = PAGE_WIDTH_PT, minHalfWidth = 0.35 } = {}) {
  const s = pageWidth / imgWidth;
  return strokes.map(({ points }) =>
    points.map(([x, y, r]) => [origin[0] + x * s, origin[1] + y * s, Math.max(minHalfWidth, r * s)]));
}
