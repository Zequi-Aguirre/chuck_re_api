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
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import Switch from "@mui/material/Switch";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import CircularProgress from "@mui/material/CircularProgress";
import useMediaQuery from "@mui/material/useMediaQuery";
import AddIcon from "@mui/icons-material/Add";
import { api } from "../api";
import { FooterView } from "../types";
import { FooterFormDialog } from "../components/FooterFormDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ADMIN_MOBILE_QUERY } from "./responsiveLayout";

/**
 * Rotating reply footers (JAK-188): the GLOBAL pool of footers Jake rotates
 * through, one uniformly-random ACTIVE footer per outbound message. Admins add
 * (multi-line), edit, delete, and toggle each footer active/inactive.
 *
 * MOBILE-FIRST (standing rule): the page must fit a phone with NO horizontal
 * scroll and the "Add footer" button must stay reachable without scrolling right.
 * Below the mobile breakpoint the list renders as CARDS; above it, as a table
 * (mirrors the Automator LeadsTable / other admin pages).
 */
export function FootersPage() {
  const isMobile = useMediaQuery(ADMIN_MOBILE_QUERY);
  const [rows, setRows] = useState<FooterView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // undefined = closed; null = "add" form; a footer = "edit" form.
  const [form, setForm] = useState<FooterView | null | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<FooterView | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api.listFooters());
    } catch {
      setError("Couldn't load footers.");
      setRows([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(footer: FooterView) {
    setBusyId(footer.id);
    setError(null);
    try {
      await api.updateFooter(footer.id, { active: !footer.active });
      setToast(footer.active ? "Footer parked." : "Footer activated.");
      await load();
    } catch {
      setError("Couldn't update the footer.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(footer: FooterView) {
    setBusyId(footer.id);
    setError(null);
    try {
      await api.deleteFooter(footer.id);
      setToast("Footer deleted.");
      await load();
    } catch {
      setError("Couldn't delete the footer.");
    } finally {
      setBusyId(null);
      setConfirmDelete(null);
    }
  }

  const renderCards = (list: FooterView[]) => (
    <Stack spacing={1.5}>
      {list.map((f) => (
        <Card key={f.id} variant="outlined">
          <CardContent>
            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 1 }}>
              {/* whiteSpace pre-wrap keeps the footer's own line breaks + wraps long lines. */}
              <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word", minWidth: 0 }}>
                {f.text}
              </Typography>
              <Chip
                size="small"
                label={f.active ? "Active" : "Inactive"}
                color={f.active ? "success" : "default"}
                sx={{ flexShrink: 0 }}
              />
            </Box>
            <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, mt: 1.5 }}>
              <Switch
                size="small"
                checked={f.active}
                disabled={busyId === f.id}
                onChange={() => toggle(f)}
                inputProps={{ "aria-label": "Toggle footer active" }}
              />
              <Box sx={{ flexGrow: 1 }} />
              <Button size="small" onClick={() => setForm(f)} disabled={busyId === f.id}>
                Edit
              </Button>
              <Button size="small" color="error" onClick={() => setConfirmDelete(f)} disabled={busyId === f.id}>
                Delete
              </Button>
            </Box>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );

  const renderTable = (list: FooterView[]) => (
    <TableContainer component={Paper}>
      <Table sx={{ minWidth: 640 }}>
        <TableHead>
          <TableRow>
            <TableCell>Footer</TableCell>
            <TableCell align="center">Active</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {list.map((f) => (
            <TableRow key={f.id}>
              <TableCell sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxWidth: 520 }}>
                {f.text}
              </TableCell>
              <TableCell align="center">
                <Switch
                  size="small"
                  checked={f.active}
                  disabled={busyId === f.id}
                  onChange={() => toggle(f)}
                  inputProps={{ "aria-label": "Toggle footer active" }}
                />
              </TableCell>
              <TableCell align="right">
                <Button size="small" onClick={() => setForm(f)} disabled={busyId === f.id}>
                  Edit
                </Button>
                <Button size="small" color="error" onClick={() => setConfirmDelete(f)} disabled={busyId === f.id}>
                  Delete
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );

  return (
    <Box>
      {/* flexWrap keeps the "Add footer" button on-screen on a phone. */}
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, mb: 1 }}>
        <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1, minWidth: 0 }}>
          Reply footers
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setForm(null)}>
          Add footer
        </Button>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Jake ends each reply with a random ACTIVE footer. If none are active, it uses the built-in default.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {rows === null ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress />
        </Box>
      ) : rows.length === 0 ? (
        <Paper sx={{ p: 6, textAlign: "center" }}>
          <Typography color="text.secondary">
            No footers yet. Click “Add footer” to create one.
          </Typography>
        </Paper>
      ) : isMobile ? (
        renderCards(rows)
      ) : (
        renderTable(rows)
      )}

      <FooterFormDialog
        open={form !== undefined}
        footer={form ?? null}
        onClose={() => setForm(undefined)}
        onSaved={() => {
          // Re-fetch so the new/edited footer appears immediately (no manual reload).
          setToast(form ? "Footer saved." : "Footer added.");
          void load();
        }}
      />
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete footer?"
        body="This removes the footer from the rotation. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove(confirmDelete)}
      />
      <Snackbar
        open={toast !== null}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
        message={toast ?? ""}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Box>
  );
}
