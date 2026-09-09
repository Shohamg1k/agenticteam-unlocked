import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import { AppProvider } from './state.js';
import { TabProvider } from './shell/tabs.js';
import { AppShell } from './shell/AppShell.js';

const container = document.getElementById('root');
if (!container) throw new Error('No #root element — index.html is wrong');

createRoot(container).render(
  <React.StrictMode>
    <AppProvider>
      <TabProvider>
        <AppShell />
      </TabProvider>
    </AppProvider>
  </React.StrictMode>,
);
