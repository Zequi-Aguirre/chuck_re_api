import { Link as RouterLink, Outlet } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Box from "@mui/material/Box";
import { useAuth } from "../auth";

/** Chrome for the authenticated app: a top bar + the routed page below. */
export function Layout() {
  const { user, logout } = useAuth();

  return (
    <>
      <AppBar position="static" color="transparent" elevation={0} sx={{ borderBottom: "1px solid #1d2533" }}>
        <Toolbar>
          <Typography
            variant="h6"
            component={RouterLink}
            to="/"
            sx={{ flexGrow: 1, color: "text.primary", textDecoration: "none" }}
          >
            Jake Admin
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <Typography variant="body2" color="text.secondary">
              {user?.email}
            </Typography>
            <Button size="small" onClick={() => logout()}>
              Sign out
            </Button>
          </Box>
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Outlet />
      </Container>
    </>
  );
}
