import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from '@/App';
import {AppProviders} from '@/providers';
import '@/app.css';
import '@/design-tokens.css';
import '@/app-shell.css';
import '@/homepage.css';
import '@/services.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing.');

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
);
