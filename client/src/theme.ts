import { createTheme } from "@mui/material/styles";

/** A simple, clean dark theme for the admin dashboard (JAK-113). */
export const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#0a84ff" }, // Jake blue (matches the landing page)
    background: { default: "#0a0e14", paper: "#10151f" },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily:
      'Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif',
    h6: { fontWeight: 700 },
  },
});
