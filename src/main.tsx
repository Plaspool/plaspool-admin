import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import './styles/tokens.css';
import './styles/base.css';
import './styles/prose.css';
import { ToastProvider } from './components/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initTheme } from './components/ThemeToggle';
import { syncDocumentBrand } from './brand';
import { RouteError } from './components/RouteError';
import { TooltipProvider } from './components/ui/Switch';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import Dashboard from './routes/Dashboard';
import EditorRoute from './routes/Editor';
import Reader from './routes/Reader';
import SettingsRoute from './routes/Settings';

// Hash routing: this app is pure static and must work from file:// or any
// host without server rewrite rules.
// Apply the saved theme before first paint so there is no light flash.
initTheme();
// Same reason, and same moment: the brand's accent has to be in the cascade
// before anything paints, or the first frame renders in the design system's
// default green and then snaps to the publication's colour.
syncDocumentBrand();

// Offline shell. Production only — a service worker in dev fights HMR.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Offline capability is a bonus, never a requirement to run.
    });
  });
}

// Every route gets our own error element. Without this, React Router's default
// boundary catches render errors first and shows its own stack-trace page —
// which reads like the app ate your writing.
const router = createHashRouter([
  { path: '/', element: <Dashboard />, errorElement: <RouteError /> },
  { path: '/edit/:id', element: <EditorRoute />, errorElement: <RouteError /> },
  { path: '/read/:id', element: <Reader />, errorElement: <RouteError /> },
  { path: '/settings', element: <SettingsRoute />, errorElement: <RouteError /> },
  { path: '*', element: <Dashboard />, errorElement: <RouteError /> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <TooltipProvider>
        <ToastProvider>
          <RouterProvider router={router} />
          {/* Above the router: the shortcuts it describes belong to the app,
              not to whichever screen happens to be mounted. */}
          <ShortcutsDialog />
        </ToastProvider>
      </TooltipProvider>
    </ErrorBoundary>
  </StrictMode>,
);
