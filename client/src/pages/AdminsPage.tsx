import { useCallback, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import useMediaQuery from "@mui/material/useMediaQuery";
import AddIcon from "@mui/icons-material/Add";
import { api, ApiError } from "../api";
import { AdminUserView } from "../types";
import { AddAdminDialog } from "../components/AddAdminDialog";
import { ResetPasswordDialog } from "../components/ResetPasswordDialog";
import { useAuth } from "../auth";
import { ADMIN_MOBILE_QUERY } from "./responsiveLayout";

/**
 * Admin management (JAK-124): list admins + create another one.
 *
 * MOBILE-FIRST (JAK-149): below the mobile breakpoint the admins list renders as
 * CARDS (with the per-admin actions wrapping) instead of the wide table, so the
 * page fits a phone with no horizontal scroll and "Add admin" stays on-screen.
 */
export function AdminsPage() {
  const { user } = useAuth();
  const isMobile = useMediaQuery(ADMIN_MOBILE_QUERY);
  const [rows, setRows] = useState<AdminUserView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUserView | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api.listAdmins());
    } catch {
      setError("Couldn't load admins.");
      setRows([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleActive(admin: AdminUserView) {
    setError(null);
    setBusyId(admin.id);
    try {
      await api.setAdminActive(admin.id, !admin.isActive);
      setToast(`${admin.email} ${admin.isActive ? "deactivated" : "activated"}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update that admin.");
    } finally {
      setBusyId(null);
    }
  }

  // Per-admin controls, shared by the card + table views. `justify` lets the
  // table right-align them while the card leaves them left-aligned + wrapping.
  const adminActions = (admin: AdminUserView, justify: "flex-start" | "flex-end") => {
    const isSelf = admin.id === user?.id;
    return (
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" justifyContent={justify}>
        <Button size="small" disabled={busyId === admin.id} onClick={() => setResetTarget(admin)}>
          Reset password
        </Button>
        <Button
          size="small"
          color={admin.isActive ? "error" : "primary"}
          disabled={busyId === admin.id || (isSelf && admin.isActive)}
          title={isSelf && admin.isActive ? "You can't deactivate your own account" : undefined}
          onClick={() => toggleActive(admin)}
        >
          {admin.isActive ? "Deactivate" : "Activate"}
        </Button>
      </Stack>
    );
  };

  const roleChip = (admin: AdminUserView) => (
    <Chip
      size="small"
      label={admin.role === "superadmin" ? "Superadmin" : "Admin"}
      color={admin.role === "superadmin" ? "primary" : "default"}
      variant={admin.role === "superadmin" ? "filled" : "outlined"}
    />
  );

  const statusChip = (admin: AdminUserView) => (
    <Chip
      size="small"
      label={admin.isActive ? "Active" : "Disabled"}
      color={admin.isActive ? "success" : "default"}
    />
  );

  const renderCards = (list: AdminUserView[]) => (
    <Stack spacing={1.5}>
      {list.map((admin) => {
        const isSelf = admin.id === user?.id;
        return (
          <Card key={admin.id} variant="outlined">
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} sx={{ minWidth: 0, wordBreak: "break-word" }}>
                {admin.email}
                {isSelf && <Chip size="small" label="you" sx={{ ml: 1 }} variant="outlined" />}
              </Typography>
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center" sx={{ mt: 1 }}>
                {roleChip(admin)}
                {statusChip(admin)}
                <Typography variant="caption" color="text.secondary">
                  Created {new Date(admin.createdAt).toLocaleDateString()}
                </Typography>
              </Stack>
              <Box sx={{ mt: 1.5 }}>{adminActions(admin, "flex-start")}</Box>
            </CardContent>
          </Card>
        );
      })}
    </Stack>
  );

  const renderTable = (list: AdminUserView[]) => (
    <TableContainer component={Paper}>
      <Table sx={{ minWidth: 720 }}>
        <TableHead>
          <TableRow>
            <TableCell>Email</TableCell>
            <TableCell>Role</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Created</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {list.map((admin) => {
            const isSelf = admin.id === user?.id;
            return (
              <TableRow key={admin.id} hover>
                <TableCell>
                  {admin.email}
                  {isSelf && <Chip size="small" label="you" sx={{ ml: 1 }} variant="outlined" />}
                </TableCell>
                <TableCell>{roleChip(admin)}</TableCell>
                <TableCell>{statusChip(admin)}</TableCell>
                <TableCell>{new Date(admin.createdAt).toLocaleDateString()}</TableCell>
                <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                  {adminActions(admin, "flex-end")}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );

  return (
    <Box>
      {/* flexWrap keeps the "Add admin" button on-screen on a phone. */}
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, mb: 3 }}>
        <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1, minWidth: 0 }}>
          Admins
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
          Add admin
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {rows === null ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress />
        </Box>
      ) : isMobile ? (
        renderCards(rows)
      ) : (
        renderTable(rows)
      )}

      <AddAdminDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(email) => {
          setToast(`Admin ${email} created. Share the password you chose with them directly.`);
          load();
        }}
      />

      <ResetPasswordDialog
        open={resetTarget !== null}
        admin={resetTarget}
        onClose={() => setResetTarget(null)}
        onReset={(email) =>
          setToast(`Password for ${email} reset. Share the new password with them directly.`)
        }
      />

      <Snackbar
        open={toast !== null}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="success" onClose={() => setToast(null)} sx={{ width: "100%" }}>
          {toast}
        </Alert>
      </Snackbar>
    </Box>
  );
}
