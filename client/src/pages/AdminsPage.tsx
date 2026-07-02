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
import Chip from "@mui/material/Chip";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import AddIcon from "@mui/icons-material/Add";
import { api, ApiError } from "../api";
import { AdminUserView } from "../types";
import { AddAdminDialog } from "../components/AddAdminDialog";
import { ResetPasswordDialog } from "../components/ResetPasswordDialog";
import { useAuth } from "../auth";

/** Admin management (JAK-124): list admins + create another one. */
export function AdminsPage() {
  const { user } = useAuth();
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

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", mb: 3 }}>
        <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1 }}>
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
      ) : (
        <TableContainer component={Paper}>
          <Table>
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
              {rows.map((admin) => {
                const isSelf = admin.id === user?.id;
                return (
                  <TableRow key={admin.id} hover>
                    <TableCell>
                      {admin.email}
                      {isSelf && (
                        <Chip size="small" label="you" sx={{ ml: 1 }} variant="outlined" />
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={admin.role === "superadmin" ? "Superadmin" : "Admin"}
                        color={admin.role === "superadmin" ? "primary" : "default"}
                        variant={admin.role === "superadmin" ? "filled" : "outlined"}
                      />
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={admin.isActive ? "Active" : "Disabled"}
                        color={admin.isActive ? "success" : "default"}
                      />
                    </TableCell>
                    <TableCell>{new Date(admin.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={1} justifyContent="flex-end">
                        <Button
                          size="small"
                          disabled={busyId === admin.id}
                          onClick={() => setResetTarget(admin)}
                        >
                          Reset password
                        </Button>
                        <Button
                          size="small"
                          color={admin.isActive ? "error" : "primary"}
                          disabled={busyId === admin.id || (isSelf && admin.isActive)}
                          title={
                            isSelf && admin.isActive ? "You can't deactivate your own account" : undefined
                          }
                          onClick={() => toggleActive(admin)}
                        >
                          {admin.isActive ? "Deactivate" : "Activate"}
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
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
