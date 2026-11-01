import type { OverlayLayout, Rect } from '../../shared/contracts/index.js';

export const FRAME = { width: 1920, height: 1080, margin: 64, protection: 24 } as const;
export type SceneLayout = { bounds: Rect; mode: 'full' | 'compact'; captionSize: 80 | 88 | 96; openingSize: 136 | 152; };
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
export const protectedBounds = (rect: Rect): Rect => ({x: rect.x - 24, y: rect.y - 24, width: rect.width + 48, height: rect.height + 48});
/** Exhaustive edge-aligned free rectangles. The outer clipping envelope includes all shadows and travel. */
export function resolveSceneLayout(input: OverlayLayout): SceneLayout | null {
  const blocked = input.protectedRects.map(protectedBounds);
  const xs = [...new Set([64, 1856, ...blocked.flatMap(r => [Math.max(64, r.x), Math.min(1856, r.x + r.width)])])].sort((a,b) => a-b);
  const ys = [...new Set([64, 1016, ...blocked.flatMap(r => [Math.max(64, r.y), Math.min(1016, r.y + r.height)])])].sort((a,b) => a-b);
  const candidates: Rect[] = [];
  for (const x of xs) for (const right of xs) for (const y of ys) for (const bottom of ys) {
    const r = {x,y,width:right-x,height:bottom-y};
    if (x < 64 || y < 64 || right > 1856 || bottom > 1016 || r.width < 1100 || r.height < 350 || blocked.some(b => intersects(r,b))) continue;
    candidates.push(r);
  }
  const preference = (r: Rect) => input.preset === 'lower' ? r.y+r.height : input.preset === 'upper' ? 1080-r.y : input.preset === 'left' ? 1920-r.x : r.x+r.width;
  candidates.sort((a,b) => Number(b.width>=1450&&b.height>=420)-Number(a.width>=1450&&a.height>=420) || preference(b)-preference(a) || b.width*b.height-a.width*a.height);
  const free = candidates[0];
  if (!free) return null;
  const full = free.width >= 1450 && free.height >= 420;
  const height = Math.min(free.height, full ? 490 : 400);
  const y = input.preset === 'upper' ? free.y : free.y+free.height-height;
  return {bounds:{...free,y,height},mode:full?'full':'compact',captionSize:free.width>=1650?96:free.width>=1450?88:80,openingSize:full?152:136};
}

export type MeasureText = (text: string, size: number, weight?: number) => number;
/** The browser passes Onest's canvas measurements. Conservative fallback makes node geometry tests portable. */
export const conservativeMeasure: MeasureText = (text,size) => [...text].reduce((sum,c) => sum + (/\s/.test(c)?0.28:/[ilI1.,'’]/.test(c)?0.3:/[MWЖШЩЮ]/.test(c)?0.92:0.6)*size,0);
export function wrapCaption(text: string, width: number, size: number, measure: MeasureText = conservativeMeasure): string[] {
  const lines: string[] = []; let line = '';
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    if (measure(word,size,600)>width) {
      if (line) {lines.push(line);line='';}
      let fragment='';
      for(const char of [...word]) {if(fragment&&measure(fragment+char,size,600)>width){lines.push(fragment);fragment='';}fragment+=char;}
      line=fragment;
    } else if (line && measure(`${line} ${word}`,size,600)>width) {lines.push(line);line=word;}
    else line=line?`${line} ${word}`:word;
  }
  if(line)lines.push(line);
  return lines;
}
