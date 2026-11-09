import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export function DriverBriefing({ analysisId }: { analysisId: string }) {
  const [requested, setRequested] = useState(false);
  const briefing = useQuery({
    queryKey: ['briefing', analysisId],
    queryFn: ({ signal }) => api.briefing(analysisId, signal),
    enabled: requested,
    retry: false,
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const generated = briefing.data && briefing.data.source !== 'calculated';

  return (
    <section className="driver-briefing" aria-label="Driver briefing">
      <div className="briefing-heading">
        <h3>Driver briefing</h3>
        {!briefing.data && (
          <button
            type="button"
            disabled={briefing.isFetching}
            onClick={() => {
              if (requested) void briefing.refetch();
              else setRequested(true);
            }}
          >
            {briefing.isFetching
              ? 'Generating briefing…'
              : briefing.isError
                ? 'Retry briefing'
                : 'Generate briefing'}
          </button>
        )}
      </div>
      <div aria-live="polite" aria-busy={briefing.isFetching}>
        {briefing.data && (
          <>
            <span className="briefing-source">
              {generated
                ? `AI briefing · ${briefing.data.source === 'bedrock' ? 'Amazon Bedrock' : 'Groq'}`
                : 'Calculated explanation · AI briefing unavailable'}
            </span>
            <p>{briefing.data.text}</p>
            {generated && (
              <small>The route recommendation is calculated independently of this briefing.</small>
            )}
          </>
        )}
        {briefing.isError && <p>Briefing unavailable. Your route comparison is unchanged. Try again.</p>}
      </div>
    </section>
  );
}
