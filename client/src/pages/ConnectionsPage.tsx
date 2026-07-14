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
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import useMediaQuery from "@mui/material/useMediaQuery";
import AddIcon from "@mui/icons-material/Add";
import { api } from "../api";
import { LocationStatusSummary } from "../types";
import { ConnectionFormDialog } from "../components/ConnectionFormDialog";
import { StatusChip } from "../components/StatusChip";
import { ADMIN_MOBILE_QUERY } from "./responsiveLayout";

/**
 * The dashboard home: every connected sub-account + a way to add one (JAK-113).
 *
 * MOBILE-FIRST (JAK-149): Zequi runs this on his phone, so it must fit a phone
 * with NO horizontal scroll and the "Connect sub-account" button must stay
 * reachable without scrolling right. Below the mobile breakpoint the list renders
 * as CARDS; above it, the wide table (mirrors the text-customers page / Automator
 * LeadsTable pattern).
 */
export function ConnectionsPage() {
  const navigate = useNavigate();
  const isMobile = useMediaQuery(ADMIN_MOBILE_QUERY);
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

  const open = (locationId: string) =>
    navigate(`/connections/${encodeURIComponent(locationId)}`);

  const renderCards = (list: LocationStatusSummary[]) => (
    <Stack spacing={1.5}>
      {list.map((r) => {
        const failed = r.outcomes.failed + r.outcomes.dead_letter;
        return (
          <Card key={r.connection.locationId} variant="outlined">
            <CardActionArea onClick={() => open(r.connection.locationId)}>
              <CardContent>
                <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 1 }}>
                  <Typography
                    variant="subtitle1"
                    fontWeight={700}
                    sx={{ fontFamily: "monospace", minWidth: 0, wordBreak: "break-all" }}
                  >
                    {r.connection.locationId}
                  </Typography>
                  <Box sx={{ flexShrink: 0 }}>
                    <StatusChip status={r.connection.status} />
                  </Box>
                </Box>
                {/* Metrics wrap so they never push the card wider than the phone. */}
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 1.5 }}>
                  <Chip size="small" variant="outlined" label={`${r.creditBalance} credits`} />
                  <Chip size="small" variant="outlined" label={`${r.outcomes.enriched} enriched`} />
                  <Chip
                    size="small"
                    variant="outlined"
                    color={failed > 0 ? "error" : "default"}
                    label={`${failed} failed`}
                  />
                  <Chip size="small" variant="outlined" label={`${r.connection.phoneNumberCount} phones`} />
                </Stack>
              </CardContent>
            </CardActionArea>
          </Card>
        );
      })}
    </Stack>
  );

  const renderTable = (list: LocationStatusSummary[]) => (
    <TableContainer component={Paper}>
      <Table sx={{ minWidth: 640 }}>
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
          {list.map((r) => (
            <TableRow
              key={r.connection.locationId}
              hover
              sx={{ cursor: "pointer" }}
              onClick={() => open(r.connection.locationId)}
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
  );

  return (
    <Box>
      {/* flexWrap keeps the "Connect sub-account" button on-screen on a phone. */}
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, mb: 3 }}>
        <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1, minWidth: 0 }}>
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
      ) : isMobile ? (
        renderCards(rows)
      ) : (
        renderTable(rows)
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
