import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Tooltip from '@radix-ui/react-tooltip';
import App from './App';
import './index.css';
import { prepareIsolation } from './lib/isolation';
void prepareIsolation().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Tooltip.Provider delayDuration={250}>
        <App />
      </Tooltip.Provider>
    </React.StrictMode>,
  );
});
