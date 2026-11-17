import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { ToastProvider, FullPageMessage, Spinner } from './lib/ui';
import { Home } from './pages/Home';
import { Join } from './pages/Join';
import { Participant } from './pages/Participant';

// The organizer console and the map are heavier; phones answering questions do not need to download them.
const Facilitator = lazy(() => import('./pages/Facilitator').then((m) => ({ default: m.Facilitator })));
const Explorer = lazy(() => import('./pages/Explorer').then((m) => ({ default: m.Explorer })));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={<Spinner />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/join" element={<Join />} />
          <Route path="/join/:code" element={<Join />} />
          <Route path="/p/:workshopId" element={<Participant />} />
          <Route path="/f/:workshopId" element={<Facilitator />} />
          <Route path="/x/:workshopId" element={<Explorer />} />
          <Route
            path="*"
            element={
              <FullPageMessage title="Page not found">
                <p className="muted">That address does not lead anywhere.</p>
                <a className="btn" href="/">
                  Go to the start
                </a>
              </FullPageMessage>
            }
          />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
);
