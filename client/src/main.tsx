import React from "react";
import ReactDOM from "react-dom/client";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AuthProvider } from "./auth";
import { theme } from "./theme";

// The SPA is served under /admin, so the router shares that basename.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter basename="/admin">
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);
