import { finiteNumber, formatDateTime, formatPrice } from '../format';
import type { Forecast } from '../types';

export interface Candle {
  ts: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
  confirmed?: boolean;
}

interface PlotPoint {
  ts: number;
  close?: number;
  median?: number;
  low80?: number;
  high80?: number;
  low95?: number;
  high95?: number;
  label?: string;
}

const WIDTH = 1040;
const HEIGHT = 390;
const PAD = { left: 80, right: 30, top: 28, bottom: 54 };

function pointsToString(points: Array<[number, number]>): string {
  return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

function timestamp(value: string | undefined): number | null {
  if (!value) return null;
  const number = new Date(value).valueOf();
  return Number.isFinite(number) ? number : null;
}

export function ForecastChart({ candles, forecasts }: { candles: Candle[]; forecasts: Forecast[] }) {
  const confirmed = candles
    .filter((item) => item.confirmed !== false && timestamp(item.ts) !== null && finiteNumber(item.close) !== null)
    .slice(-180);
  const history: PlotPoint[] = confirmed.map((item) => ({ ts: timestamp(item.ts)!, close: finiteNumber(item.close)! }));
  const future = forecasts.flatMap((item) => {
    const ts = timestamp(item.target_ts);
    const median = finiteNumber(item.median_price);
    const low80 = finiteNumber(item.interval_80_low);
    const high80 = finiteNumber(item.interval_80_high);
    if (ts === null || median === null || low80 === null || high80 === null) return [];
    return [{
      ts,
      median,
      low80,
      high80,
      low95: finiteNumber(item.interval_95_low) ?? undefined,
      high95: finiteNumber(item.interval_95_high) ?? undefined,
      label: `${item.horizon}日`,
    }];
  })
    .sort((a, b) => a.ts - b.ts);

  if (history.length === 0 && future.length === 0) {
    return (
      <div className="chart-empty" role="status">
        <span className="empty-mark">∅</span>
        <strong>暂无可绘制的真实数据</strong>
        <span>等待后端返回已确认日线与封存预测；客户端不会生成演示行情。</span>
      </div>
    );
  }

  const latest = history.at(-1);
  const anchor = latest
    ? {
        ts: latest.ts,
        median: latest.close!,
        low80: latest.close!,
        high80: latest.close!,
        low95: latest.close!,
        high95: latest.close!,
        label: '截止价',
      }
    : undefined;
  const bandPoints = anchor ? [anchor, ...future.filter((point) => point.ts > anchor.ts)] : future;
  const has95 = future.some((point) => point.low95 !== undefined && point.high95 !== undefined);
  const band95Points = has95 ? bandPoints.filter((point) => point.low95 !== undefined && point.high95 !== undefined) : [];
  const allPoints: PlotPoint[] = [...history, ...future];
  const values = allPoints.flatMap((point) =>
    [point.close, point.median, point.low80, point.high80, point.low95, point.high95].filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value),
    ),
  );
  if (values.length === 0) return null;

  const minTs = Math.min(...allPoints.map((point) => point.ts));
  const maxTs = Math.max(...allPoints.map((point) => point.ts));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const yPad = Math.max((rawMax - rawMin) * 0.08, rawMax * 0.005, 1);
  const minValue = rawMin - yPad;
  const maxValue = rawMax + yPad;
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const spanTs = Math.max(maxTs - minTs, 1);
  const spanValue = Math.max(maxValue - minValue, 1);
  const x = (ts: number) => PAD.left + ((ts - minTs) / spanTs) * plotWidth;
  const y = (value: number) => PAD.top + ((maxValue - value) / spanValue) * plotHeight;

  const historyLine = history.map((point) => [x(point.ts), y(point.close!)] as [number, number]);
  const medianLine = bandPoints.map((point) => [x(point.ts), y(point.median)] as [number, number]);
  const polygon = (points: PlotPoint[], low: 'low80' | 'low95', high: 'high80' | 'high95') => [
    ...points.map((point) => [x(point.ts), y(point[high]!)] as [number, number]),
    ...[...points].reverse().map((point) => [x(point.ts), y(point[low]!)] as [number, number]),
  ];
  const ticks = Array.from({ length: 5 }, (_, index) => maxValue - (index / 4) * spanValue);
  const dateTicks = Array.from({ length: 5 }, (_, index) => minTs + (index / 4) * spanTs);

  return (
    <div className="chart-shell">
      <div className="chart-legend" aria-label="图例">
        <span><i className="legend-line actual" />已确认收盘</span>
        <span><i className="legend-line median" />预测中位数</span>
        <span><i className="legend-box band80" />80% 区间</span>
        {has95 && <span><i className="legend-box band95" />95% 区间</span>}
      </div>
      <svg className="forecast-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="真实日线与预测区间图">
        <rect x={PAD.left} y={PAD.top} width={plotWidth} height={plotHeight} className="plot-bg" />
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} y1={y(tick)} x2={WIDTH - PAD.right} y2={y(tick)} className="grid-line" />
            <text x={PAD.left - 12} y={y(tick) + 4} textAnchor="end" className="axis-label">{formatPrice(tick)}</text>
          </g>
        ))}
        {dateTicks.map((tick) => (
          <text key={tick} x={x(tick)} y={HEIGHT - 18} textAnchor="middle" className="axis-label">
            {new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).format(new Date(tick))}
          </text>
        ))}
        {bandPoints.length >= 2 && (
          <>
            {band95Points.length >= 2 && <polygon points={pointsToString(polygon(band95Points, 'low95', 'high95'))} className="area-95" />}
            <polygon points={pointsToString(polygon(bandPoints, 'low80', 'high80'))} className="area-80" />
          </>
        )}
        {historyLine.length > 1 && <polyline points={pointsToString(historyLine)} className="line-actual" />}
        {medianLine.length > 1 && <polyline points={pointsToString(medianLine)} className="line-median" />}
        {future.map((point) => (
          <g key={`${point.ts}-${point.label}`}>
            <circle cx={x(point.ts)} cy={y(point.median)} r="4.5" className="forecast-dot" />
            <text x={x(point.ts)} y={Math.max(y(point.high95 ?? point.high80) - 9, 15)} textAnchor="middle" className="forecast-label">{point.label}</text>
            <title>{`${point.label} · ${formatDateTime(new Date(point.ts).toISOString())} · 中位 ${formatPrice(point.median)} · 80% ${formatPrice(point.low80)}–${formatPrice(point.high80)}${point.low95 !== undefined && point.high95 !== undefined ? ` · 95% ${formatPrice(point.low95)}–${formatPrice(point.high95)}` : ''}`}</title>
          </g>
        ))}
      </svg>
      <p className="chart-note">仅绘制后端返回的已确认日线和封存预测。阴影是目标日收盘价区间，不是盘中高低价。</p>
    </div>
  );
}

