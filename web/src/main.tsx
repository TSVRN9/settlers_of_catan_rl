import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// A console handle for poking at the running app: `__app.get().phase`, `__app.live.decide(...)`, and
// `__app.act(action)` to play the seated person's move from a test (web/design/phone/frames.html).
import { get as __get, set as __set } from "./store";
import { act as __act, live as __live } from "./game";
if (import.meta.env.DEV) (globalThis as unknown as { __app: unknown }).__app = { get: __get, set: __set, live: __live, act: __act };
