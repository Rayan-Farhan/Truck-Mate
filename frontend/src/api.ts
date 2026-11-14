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
export async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  method?: string,
): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (body !== undefined && path.startsWith('/fleet/')) {
    const cookie = document.cookie.split('; ').find((value) => value.startsWith('csrftoken='));
    if (cookie) headers.set('X-CSRFToken', decodeURIComponent(cookie.slice('csrftoken='.length)));
  }
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
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
    const fieldMessage = Object.values(error.fields ?? {})
      .flat()
      .find((value): value is string => typeof value === 'string');
    throw new ApiError(
      (path.startsWith('/fleet/') ? fieldMessage : undefined) ??
        error.message ??
        'The request could not be completed.',
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
