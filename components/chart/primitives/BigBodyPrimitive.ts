/**
 * Canvas renderer for the "Big Body Candle Border + Retest" indicator.
 *
 * ONE series primitive draws every shape — boxes, level lines and pip labels —
 * on the candle series' own pane. Nothing is created per shape: there is a
 * single pane view and a single renderer for the whole series, so enabling the
 * indicator costs one `attachPrimitive` call regardless of how many big
 * candles exist.
 *
 * Colours are Pine's, not CSS's: `color.orange` is #FF9800 and `color.gray` is
 * #787B86. Pine's `transp` is a TRANSPARENCY percentage, so `color.new(c, 75)`
 * is 25% opaque and `color.new(c, 100)` is fully invisible.
 */

import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { BigBodyResult, SegmentState } from '@/lib/indicators/types';
import { LABEL_FONT_PX, labelFontFamily } from '../labelFont';

/** The `fancy-canvas` target the library hands to `draw`, without importing it. */
type RenderTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

/**
 * Presentation-only inputs. These never reach the API: they do not change the
 * geometry, so a colour tweak must not refetch the series.
 */
export interface BigBodyStyle {
  /** Pine `showPending`. False hides pending AND expired levels — see below. */
  showPending: boolean;
  /** Pine `borderCol`, default `color.orange`. */
  borderCol: string;
  /** Pine `pendingCol`, default `color.orange`. */
  pendingCol: string;
  /** Pine `touchedCol`, default `color.gray`. */
  touchedCol: string;
  /** Pine `borderWidth`, default 2. */
  borderWidth: number;
}

/** Pine's palette, not the CSS keywords of the same name. */
export const PINE_ORANGE = '#FF9800';
export const PINE_GRAY = '#787B86';

export const DEFAULT_BIG_BODY_STYLE: BigBodyStyle = {
  showPending: true,
  borderCol: PINE_ORANGE,
  pendingCol: PINE_ORANGE,
  touchedCol: PINE_GRAY,
  borderWidth: 2,
};

/** Padding grows with the 13px label font so the box keeps its proportions. */
const LABEL_PAD_X = 5;
const LABEL_PAD_Y = 4;
/** Pine `color.new(borderCol, 75)` — 75% transparent, i.e. 25% opaque. */
const LABEL_BG_ALPHA = 0.25;
/** How many already-drawn label rects a new label is tested against. */
const LABEL_COLLISION_WINDOW = 12;
/** Shapes this far outside the canvas are dropped before any drawing happens. */
const CULL_MARGIN = 64;

/**
 * `#RGB` / `#RRGGBB` (and `#RRGGBBAA`) to `rgba(...)` at the given opacity.
 * Anything unparseable falls back to the input, so a CSS colour name still
 * renders — just without the alpha.
 */
function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  if (hex.charCodeAt(0) !== 35 /* # */) return hex;
  const body = hex.slice(1);
  let r: number;
  let g: number;
  let b: number;
  if (body.length === 3) {
    r = parseInt(body[0] + body[0], 16);
    g = parseInt(body[1] + body[1], 16);
    b = parseInt(body[2] + body[2], 16);
  } else if (body.length === 6 || body.length === 8) {
    r = parseInt(body.slice(0, 2), 16);
    g = parseInt(body.slice(2, 4), 16);
    b = parseInt(body.slice(4, 6), 16);
  } else {
    return hex;
  }
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return hex;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Colour for a level line, or `null` when Pine would not draw it at all.
 *
 * Pine quirk, reproduced on purpose: with `showPending = false` a level is
 * created fully transparent, but `line.set_color(touchedCol)` on a touch makes
 * it visible again. So hiding pending lines still shows TOUCHED ones in grey.
 * Do not "fix" this.
 */
function segmentColor(state: SegmentState, style: BigBodyStyle): string | null {
  if (state === 'touched') return style.touchedCol;
  return style.showPending ? style.pendingCol : null;
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

class BigBodyRenderer implements IPrimitivePaneRenderer {
  private readonly _source: BigBodyPrimitive;

  public constructor(source: BigBodyPrimitive) {
    this._source = source;
  }

  public draw(target: RenderTarget): void {
    const source = this._source;
    const data = source.data;
    const series = source.series;
    const chart = source.chart;
    if (data === null || series === null || chart === null) return;

    const timeScale = chart.timeScale();
    const style = source.style;
    // `barSpacing` is the nominal width of one bar, used both as the fallback
    // width for an end time that is not itself a bar and as the cull margin.
    const barSpacing = timeScale.options().barSpacing;

    /**
     * Media-space x for a timestamp, or `null` when it cannot be placed.
     *
     * `timeToCoordinate` returns `null` for anything that is not an exact bar
     * timestamp — which happens for every `endTime` that falls in a weekend
     * gap or past the last bar. We snap to the nearest bar index and, for an
     * END coordinate, nudge forward by one nominal bar so the shape still has
     * width instead of collapsing. Never returns NaN.
     */
    const xFor = (time: number, isEnd: boolean): number | null => {
      const direct = timeScale.timeToCoordinate(time as UTCTimestamp);
      if (direct !== null && Number.isFinite(direct)) return direct;
      const index = timeScale.timeToIndex(time as UTCTimestamp, true);
      if (index === null) return null;
      const snapped = timeScale.logicalToCoordinate(index as unknown as Logical);
      if (snapped === null || !Number.isFinite(snapped)) return null;
      return isEnd ? snapped + barSpacing : snapped;
    };

    const yFor = (price: number): number | null => {
      const y = series.priceToCoordinate(price);
      if (y === null || !Number.isFinite(y)) return null;
      return y;
    };

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const width = scope.mediaSize.width;
      const height = scope.mediaSize.height;
      const minX = -CULL_MARGIN;
      const maxX = width + CULL_MARGIN;

      ctx.save();

      /* ---- level lines, underneath everything else ---- */
      const lineWidth = Math.max(1, Math.round(style.borderWidth * vr));
      for (const segment of data.segments) {
        const color = segmentColor(segment.state, style);
        if (color === null) continue;

        const x1 = xFor(segment.time, false);
        if (x1 === null || x1 > maxX) continue;
        const x2 = xFor(segment.endTime, true);
        if (x2 === null || x2 < minX) continue;

        const y = yFor(segment.price);
        if (y === null || y < -CULL_MARGIN || y > height + CULL_MARGIN) continue;

        const left = Math.round(Math.max(x1, minX) * hr);
        const right = Math.round(Math.min(x2, maxX) * hr);
        if (right <= left) continue;

        ctx.fillStyle = color;
        ctx.fillRect(left, Math.round(y * vr) - lineWidth / 2, right - left, lineWidth);
      }

      /* ---- boxes: stroke only. Pine's fill is color.new(borderCol, 100). ---- */
      const borderPx = Math.max(1, Math.round(style.borderWidth * hr));
      const half = borderPx / 2;
      ctx.strokeStyle = style.borderCol;
      ctx.lineWidth = borderPx;
      for (const box of data.boxes) {
        const x1 = xFor(box.time, false);
        if (x1 === null || x1 > maxX) continue;
        const x2 = xFor(box.endTime, true);
        if (x2 === null || x2 < minX) continue;

        const top = yFor(box.top);
        const bottom = yFor(box.bottom);
        if (top === null || bottom === null) continue;
        if (bottom < -CULL_MARGIN || top > height + CULL_MARGIN) continue;

        const left = Math.round(x1 * hr) + half;
        const right = Math.round(x2 * hr) - half;
        const topPx = Math.round(top * vr) + half;
        const bottomPx = Math.round(bottom * vr) - half;
        ctx.strokeRect(left, topPx, Math.max(1, right - left), Math.max(1, bottomPx - topPx));
      }

      /* ---- pip labels, on top, skipping collisions ---- */
      if (data.labels.length > 0) {
        // Scaled by the vertical pixel ratio: the canvas is a bitmap of
        // `mediaSize * ratio`, so an unscaled font would render at a third of
        // its size, or blurred back up, on a HiDPI screen.
        const fontPx = LABEL_FONT_PX * vr;
        ctx.font = `${fontPx}px ${labelFontFamily()}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const bg = withAlpha(style.borderCol, LABEL_BG_ALPHA);
        const padX = LABEL_PAD_X * hr;
        const padY = LABEL_PAD_Y * vr;
        const boxHeight = fontPx + padY * 2;
        // Big candles cluster, so several labels can land on nearly the same
        // pixel. Labels are time-ordered, so only a short trailing window of
        // drawn rects can still overlap the next one — testing against those
        // stops the stack turning into mush without an O(n^2) sweep.
        const recent: Rect[] = [];

        for (const label of data.labels) {
          const x = xFor(label.time, false);
          if (x === null || x < minX || x > maxX) continue;
          const anchor = yFor(label.price);
          if (anchor === null) continue;

          const textWidth = ctx.measureText(label.text).width;
          const boxWidth = textWidth + padX * 2;
          const left = Math.round(x * hr);
          // Pine `label.style_label_down`: the label hangs BELOW its anchor.
          const top = Math.round(anchor * vr);
          const rect: Rect = {
            left,
            right: left + boxWidth,
            top,
            bottom: top + boxHeight,
          };
          if (rect.bottom < 0 || rect.top > height * vr) continue;
          let collides = false;
          for (const drawn of recent) {
            if (overlaps(rect, drawn)) {
              collides = true;
              break;
            }
          }
          if (collides) continue;
          recent.push(rect);
          if (recent.length > LABEL_COLLISION_WINDOW) recent.shift();

          ctx.fillStyle = bg;
          ctx.fillRect(rect.left, rect.top, boxWidth, boxHeight);
          ctx.fillStyle = '#FFFFFF';
          ctx.fillText(label.text, rect.left + padX, rect.top + padY);
        }
      }

      ctx.restore();
    });
  }
}

class BigBodyPaneView implements IPrimitivePaneView {
  private readonly _source: BigBodyPrimitive;
  private readonly _renderer: BigBodyRenderer;

  public constructor(source: BigBodyPrimitive) {
    this._source = source;
    this._renderer = new BigBodyRenderer(source);
  }

  public zOrder(): PrimitivePaneViewZOrder {
    return 'top';
  }

  public renderer(): IPrimitivePaneRenderer | null {
    return this._source.data === null ? null : this._renderer;
  }
}

export class BigBodyPrimitive implements ISeriesPrimitive<Time> {
  public data: BigBodyResult | null = null;
  public style: BigBodyStyle = DEFAULT_BIG_BODY_STYLE;
  public chart: IChartApiBase<Time> | null = null;
  public series: ISeriesApi<SeriesType, Time> | null = null;

  /**
   * The array identity must be stable: the library caches pane views by
   * reference and rebuilds its internal state whenever a new array appears.
   */
  private readonly _paneViews: readonly IPrimitivePaneView[];
  private _requestUpdate: (() => void) | null = null;

  public constructor() {
    this._paneViews = [new BigBodyPaneView(this)];
  }

  public attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart;
    this.series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  public detached(): void {
    this.chart = null;
    this.series = null;
    this._requestUpdate = null;
  }

  public paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }

  /** Geometry is derived at draw time from live coordinates, so this is a no-op. */
  public updateAllViews(): void {}

  /** Swap the shapes in place and repaint — never re-attach a new primitive. */
  public setData(data: BigBodyResult | null): void {
    this.data = data;
    this._requestUpdate?.();
  }

  public setStyle(style: BigBodyStyle): void {
    this.style = style;
    this._requestUpdate?.();
  }
}
