import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import Fleet from './fleet/Fleet';
import './styles.css';
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 600000 },
    mutations: { retry: false },
  },
});
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {location.pathname === '/fleet' || location.pathname.startsWith('/fleet/') ? <Fleet /> : <App />}
    </QueryClientProvider>
  </StrictMode>,
);
