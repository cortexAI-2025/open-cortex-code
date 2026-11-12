import { createRoot } from 'react-dom/client';
import './monaco';
import './styles.css';
import './responsive.css';
import App from './App';
import { AppProvider } from './state';
import { PRODUCT_NAME } from './config';
document.title = `${PRODUCT_NAME} — Atelier local`;
createRoot(document.getElementById('root')!).render(<AppProvider><App /></AppProvider>);
