import { useCallback, useEffect, useRef, useState } from 'react';
import { requestApi } from '../api';

export interface ApiResource<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  refreshing: boolean;
  receivedAt: string | undefined;
  refresh: () => Promise<void>;
}

export function useApiResource<T>(path: string | null, refreshMs = 0): ApiResource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(Boolean(path));
  const [refreshing, setRefreshing] = useState(false);
  const [receivedAt, setReceivedAt] = useState<string>();
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!path) return;
    const id = ++requestId.current;
    setRefreshing(true);
    const result = await requestApi<T>({ path });
    if (id !== requestId.current) return;
    setReceivedAt(result.receivedAt);
    if (result.ok) {
      setData(result.data);
      setError(undefined);
    } else {
      setError(result.error ?? `HTTP ${result.status}`);
    }
    setLoading(false);
    setRefreshing(false);
  }, [path]);

  useEffect(() => {
    setLoading(Boolean(path));
    void refresh();
    if (!path || refreshMs <= 0) return undefined;
    const timer = window.setInterval(() => void refresh(), refreshMs);
    return () => window.clearInterval(timer);
  }, [path, refresh, refreshMs]);

  return { data, error, loading, refreshing, receivedAt, refresh };
}

