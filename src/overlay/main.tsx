import React from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import { CopilotPanel } from './CopilotPanel';

ReactDOM.createRoot(document.getElementById('overlay-root')!).render(
  <React.StrictMode>
    <CopilotPanel />
  </React.StrictMode>
);
