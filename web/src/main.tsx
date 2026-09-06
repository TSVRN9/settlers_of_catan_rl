import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// A console handle for poking at the running app: `__app.get().phase`, `__app.live.decide(...)`.
import { get as __get, set as __set } from "./store";
import { live as __live } from "./game";
if (import.meta.env.DEV) (globalThis as unknown as { __app: unknown }).__app = { get: __get, set: __set, live: __live };
