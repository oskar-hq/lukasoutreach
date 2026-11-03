import '@fontsource-variable/inter';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { AuthProvider } from './state/auth';
import { CockpitProvider } from './state/cockpit';
import { DemoProvider } from './state/demo';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <DemoProvider>
        <CockpitProvider>
          <ErrorBoundary fullPage>
            <App />
          </ErrorBoundary>
        </CockpitProvider>
      </DemoProvider>
    </AuthProvider>
  </StrictMode>,
);
