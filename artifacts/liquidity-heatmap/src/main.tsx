import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const rootEl = document.getElementById("root");

if (!rootEl) {
  throw new Error('Unable to mount app: missing #root element.');
}

createRoot(rootEl).render(<App />);
