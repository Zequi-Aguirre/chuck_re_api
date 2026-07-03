import { useState } from "react";
import { Link as RouterLink, Outlet, useLocation } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Drawer from "@mui/material/Drawer";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import MenuIcon from "@mui/icons-material/Menu";
import GroupsIcon from "@mui/icons-material/Groups";
import SmsIcon from "@mui/icons-material/Sms";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import PersonSearchIcon from "@mui/icons-material/PersonSearch";
import AdminPanelSettingsIcon from "@mui/icons-material/AdminPanelSettings";
import LogoutIcon from "@mui/icons-material/Logout";
import { useAuth } from "../auth";

const DRAWER_WIDTH = 240;

/**
 * Chrome for the authenticated app (JAK-126): a left sidebar nav that is a
 * permanent Drawer on desktop and a temporary, hamburger-toggled Drawer on
 * mobile, with the routed page rendered to its right.
 */
export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Nav sections. Admin management stays superadmin-only (JAK-125) — the item
  // never renders for a regular admin (route + API 403 back it up).
  const navItems = [
    { label: "Sub-accounts", to: "/", icon: <GroupsIcon />, show: true },
    { label: "Text customers", to: "/text-customers", icon: <SmsIcon />, show: true },
    // AI Prompt (JAK-131) — every logged-in admin can tune the report style.
    { label: "AI Prompt", to: "/report-settings", icon: <AutoAwesomeIcon />, show: true },
    // Router Prompt (JAK-135) — every logged-in admin can tune how Jake routes texts.
    { label: "Router Prompt", to: "/router-settings", icon: <CallSplitIcon />, show: true },
    // Skip-Trace (JAK-136) — every logged-in admin can tune the reply + credit cost.
    { label: "Skip-Trace", to: "/skiptrace-settings", icon: <PersonSearchIcon />, show: true },
    {
      label: "Admins",
      to: "/admins",
      icon: <AdminPanelSettingsIcon />,
      show: user?.role === "superadmin",
    },
  ].filter((item) => item.show);

  const isSelected = (to: string) =>
    to === "/" ? location.pathname === "/" : location.pathname.startsWith(to);

  const drawer = (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Toolbar sx={{ px: 3 }}>
        <Typography
          variant="h6"
          component={RouterLink}
          to="/"
          onClick={() => setMobileOpen(false)}
          sx={{ color: "text.primary", textDecoration: "none" }}
        >
          Jake Admin
        </Typography>
      </Toolbar>
      <Divider />

      <List sx={{ flexGrow: 1, px: 1, pt: 1 }}>
        {navItems.map((item) => (
          <ListItem key={item.to} disablePadding sx={{ mb: 0.5 }}>
            <ListItemButton
              component={RouterLink}
              to={item.to}
              selected={isSelected(item.to)}
              onClick={() => setMobileOpen(false)}
              sx={{ borderRadius: 2 }}
            >
              <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
              <ListItemText primary={item.label} />
            </ListItemButton>
          </ListItem>
        ))}
      </List>

      <Divider />
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary" noWrap title={user?.email} sx={{ mb: 1 }}>
          {user?.email}
        </Typography>
        <Button
          fullWidth
          size="small"
          variant="outlined"
          startIcon={<LogoutIcon />}
          onClick={() => {
            setMobileOpen(false);
            logout();
          }}
        >
          Sign out
        </Button>
      </Box>
    </Box>
  );

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      {/* Mobile-only top bar with the hamburger toggle. */}
      <AppBar
        position="fixed"
        color="transparent"
        elevation={0}
        sx={{
          display: { md: "none" },
          borderBottom: "1px solid #1d2533",
          backgroundColor: "background.default",
        }}
      >
        <Toolbar>
          <IconButton
            edge="start"
            color="inherit"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
            sx={{ mr: 2 }}
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" sx={{ color: "text.primary" }}>
            Jake Admin
          </Typography>
        </Toolbar>
      </AppBar>

      {/* Sidebar: temporary Drawer on mobile, permanent on desktop. */}
      <Box component="nav" sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}>
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            display: { xs: "block", md: "none" },
            "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box" },
          }}
        >
          {drawer}
        </Drawer>
        <Drawer
          variant="permanent"
          open
          sx={{
            display: { xs: "none", md: "block" },
            "& .MuiDrawer-paper": {
              width: DRAWER_WIDTH,
              boxSizing: "border-box",
              borderRight: "1px solid #1d2533",
            },
          }}
        >
          {drawer}
        </Drawer>
      </Box>

      {/* Main content. The empty Toolbar offsets the fixed mobile AppBar. */}
      <Box component="main" sx={{ flexGrow: 1, width: { md: `calc(100% - ${DRAWER_WIDTH}px)` } }}>
        <Toolbar sx={{ display: { md: "none" } }} />
        <Box sx={{ p: { xs: 2, sm: 3, md: 4 } }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
