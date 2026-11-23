import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app";
import { DAEMON_BASE } from "./base";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* basename：守护进程按项目路由时为 /project/<名>/<hash>/web；直连为 undefined（/） */}
    <BrowserRouter basename={DAEMON_BASE || undefined}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
