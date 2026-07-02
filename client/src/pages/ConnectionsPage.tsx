import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import CircularProgress from "@mui/material/CircularProgress";
import AddIcon from "@mui/icons-material/Add";
import { api } from "../api";
import { LocationStatusSummary } from "../types";
import { ConnectionFormDialog } from "../components/ConnectionFormDialog";
import { StatusChip } from "../components/StatusChip";

/** The dashboard home: every connected sub-account + a way to add one (JAK-113). */
export function ConnectionsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<LocationStatusSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api.listConnections());
    } catch {
      setError("Couldn't load connections.");
      setRows([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", mb: 3 }}>
        <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1 }}>
          Connected sub-accounts
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
          Connect sub-account
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
      ) : rows.length === 0 ? (
        <Paper sx={{ p: 6, textAlign: "center" }}>
          <Typography color="text.secondary">
            No sub-accounts connected yet. Click “Connect sub-account” to add one.
          </Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Location ID</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Credits</TableCell>
                <TableCell align="right">Enriched</TableCell>
                <TableCell align="right">Failed</TableCell>
                <TableCell align="right">Phones</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.connection.locationId}
                  hover
                  sx={{ cursor: "pointer" }}
                  onClick={() => navigate(`/connections/${encodeURIComponent(r.connection.locationId)}`)}
                >
                  <TableCell sx={{ fontFamily: "monospace" }}>{r.connection.locationId}</TableCell>
                  <TableCell>
                    <StatusChip status={r.connection.status} />
                  </TableCell>
                  <TableCell align="right">{r.creditBalance}</TableCell>
                  <TableCell align="right">{r.outcomes.enriched}</TableCell>
                  <TableCell align="right">
                    {r.outcomes.failed + r.outcomes.dead_letter > 0 ? (
                      <Chip
                        size="small"
                        color="error"
                        label={r.outcomes.failed + r.outcomes.dead_letter}
                      />
                    ) : (
                      0
                    )}
                  </TableCell>
                  <TableCell align="right">{r.connection.phoneNumberCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <ConnectionFormDialog
        open={addOpen}
        mode="create"
        onClose={() => setAddOpen(false)}
        onSaved={load}
      />
    </Box>
  );
}
