export function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function formatPrice(value: unknown): string {
  const number = finiteNumber(value);
  if (number === null) return '—';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: number >= 1000 ? 0 : 2,
  }).format(number);
}

export function formatPercent(value: unknown): string {
  const number = finiteNumber(value);
  if (number === null) return '—';
  const ratio = Math.abs(number) <= 1 ? number : number / 100;
  return new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 }).format(ratio);
}

export function formatDateTime(value: unknown): string {
  if (typeof value !== 'string' || !value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function stringList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      return stringList(JSON.parse(trimmed));
    } catch {
      return [trimmed];
    }
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string') return [item];
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const text = record.title ?? record.name ?? record.summary ?? record.description ?? record.value;
        return typeof text === 'string' ? [text] : [JSON.stringify(item)];
      }
      return item == null ? [] : [String(item)];
    });
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}：${typeof item === 'string' ? item : JSON.stringify(item)}`);
  }
  return [];
}

export function scenarioTargetList(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return stringList(value);
  return Object.entries(value as Record<string, unknown>).map(([key, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${key}：${String(raw ?? '—')}`;
    const target = raw as Record<string, unknown>;
    const low = finiteNumber(target.low);
    const high = finiteNumber(target.high);
    const center = finiteNumber(target.center);
    let range = '未给出区间';
    if (low !== null && high !== null) range = `${low.toLocaleString('zh-CN')} - ${high.toLocaleString('zh-CN')}`;
    else if (low !== null) range = `${low.toLocaleString('zh-CN')} 以上`;
    else if (high !== null) range = `${high.toLocaleString('zh-CN')} 以下`;
    return `${key}：${range}${center === null ? '' : `（中枢 ${center.toLocaleString('zh-CN')}）`}`;
  });
}

export function statusTone(value: unknown): 'good' | 'warn' | 'bad' | 'muted' {
  const status = String(value ?? '').toLowerCase();
  if (/unvalidated|uncalibrated|candidate|未验证|未校准|候选/.test(status)) return 'warn';
  if (/pass|ok|healthy|connected|active|verified|valid|通过|正常|已连接|有效/.test(status)) return 'good';
  if (/fail|error|invalid|offline|broken|失败|错误|离线|失效/.test(status)) return 'bad';
  if (/pending|insufficient|degraded|partial|wait|unknown|待|不足|降级|未知/.test(status)) return 'warn';
  return 'muted';
}

