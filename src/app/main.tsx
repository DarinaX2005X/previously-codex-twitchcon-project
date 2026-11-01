import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App.js';
import '../styles/index.css';
import './shell.css';
createRoot(document.getElementById('root')!).render(<StrictMode><App local/></StrictMode>);
