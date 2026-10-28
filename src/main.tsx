import React from "react";
import ReactDOM from "react-dom/client";
// Loaded before the app so screen styles (player.css) win equal-specificity ties.
import "./styles.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
