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
import AddIcon from "@mui/icons-material/Add";
import { api } from "../api";
import { TextCustomerView } from "../types";
import { GrantTextCreditsDialog } from "../components/GrantTextCreditsDialog";

/**
 * Tier-1 text-Jake customers (JAK-129): every texter keyed by sender phone, with
 * their prepaid credit balance and a Grant-credits action. The "Credit a phone"
 * button opens the free form so an admin can top up any number — including one
 * that hasn't texted in yet — which is how a gateway texter who ran out of Jake
 * credits gets unblocked.
 */
export function TextCustomersPage() {
  const [rows, setRows] = useState<TextCustomerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // undefined = closed; "" = free "credit any phone" form; a string = locked row.
  const [grantPhone, setGrantPhone] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await api.listTextCustomers());
    } catch {
      setError("Couldn't load text customers.");
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
          Text customers
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setGrantPhone("")}>
          Credit a phone
        </Button>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Tier-1 texters, billed by sender phone. Grant credits here to top up a
        texter&apos;s own account — this is separate from a sub-account&apos;s credits.
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
        <Alert severity="info">
          No text customers yet. Use “Credit a phone” to grant credits to a number before it texts in.
        </Alert>
      ) : (
        <TableContainer component={Paper}>
          <Table sx={{ minWidth: 720 }}>
            <TableHead>
              <TableRow>
                <TableCell>Phone</TableCell>
                <TableCell align="right">Credits</TableCell>
                <TableCell>First seen</TableCell>
                <TableCell>Last seen</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id} hover>
                  <TableCell sx={{ fontFamily: "monospace" }}>{c.phone}</TableCell>
                  <TableCell align="right">
                    <Chip
                      size="small"
                      label={c.creditBalance}
                      color={c.creditBalance > 0 ? "success" : "default"}
                    />
                  </TableCell>
                  <TableCell>{new Date(c.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell>{new Date(c.lastSeenAt).toLocaleDateString()}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                    <Button size="small" onClick={() => setGrantPhone(c.phone)}>
                      Grant credits
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <GrantTextCreditsDialog
        open={grantPhone !== undefined}
        phone={grantPhone === "" ? undefined : grantPhone}
        onClose={() => setGrantPhone(undefined)}
        onSaved={(phone, balance) => {
          setToast(`${phone} now has ${balance} credits.`);
          load();
        }}
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
