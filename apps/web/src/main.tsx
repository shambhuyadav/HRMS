// tailwind.css comes first: it sets the cascade-layer order every stylesheet follows (shadcn/ui over the HRMS stylesheets). Then the
// base stylesheet, so the stylesheets of individual screens (imported by their components, under styles/) build on it.
import './tailwind.css';
import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { SessionProvider } from './session';
import { applyTheme, chosenTheme } from './theme';

// A theme chosen on this device applies before the first screen is drawn (without a choice the device setting applies).
applyTheme(chosenTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
