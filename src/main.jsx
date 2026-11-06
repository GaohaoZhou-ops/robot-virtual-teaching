import React from 'react';
import ReactDOM from 'react-dom/client';
import App from "./app/App.jsx";
import DesktopReleaseBoundary from './features/desktop/ui/DesktopReleaseBoundary.jsx';
import './styles.css';
if (window.AtlasVision?.native) document.documentElement.classList.add('atlas-vision-workbench');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DesktopReleaseBoundary><App /></DesktopReleaseBoundary>
  </React.StrictMode>,
);
