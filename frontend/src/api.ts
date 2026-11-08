import type { Analysis, Briefing, Configuration, Corridor, Place, PlanRequest } from './types';
export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public fields: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError('The service returned an unexpected response. Please try again.', 'INVALID_RESPONSE');
  }
  if (!response.ok) {
    const error = data.error ?? {};
    throw new ApiError(
      error.message ?? 'The request could not be completed.',
      error.code ?? 'REQUEST_FAILED',
      error.fields ?? {},
    );
  }
  return data as T;
}
export const api = {
  config: (signal?: AbortSignal) => request<Configuration>('/config', undefined, signal),
  places: (q: string, signal?: AbortSignal) =>
    request<{ results: Place[] }>(`/places?q=${encodeURIComponent(q)}`, undefined, signal),
  analyze: (payload: PlanRequest) => request<Analysis>('/analyses', payload),
  corridor: (id: string, route: string, signal?: AbortSignal) =>
    request<Corridor>(`/analyses/${id}/corridor`, { route_id: route }, signal),
  briefing: (id: string, signal?: AbortSignal) => request<Briefing>(`/analyses/${id}/briefing`, {}, signal),
};
