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
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import CircularProgress from "@mui/material/CircularProgress";
import useMediaQuery from "@mui/material/useMediaQuery";
import AddIcon from "@mui/icons-material/Add";
import { api } from "../api";
import { TextCustomerView } from "../types";
import { GrantTextCreditsDialog } from "../components/GrantTextCreditsDialog";
import { TextCustomerFormDialog } from "../components/TextCustomerFormDialog";
import { TEXT_CUSTOMERS_MOBILE_QUERY, customerDisplayName } from "./textCustomersLayout";

/**
 * Tier-1 text-Jake customers (JAK-129 + JAK-146): every texter keyed by sender
 * phone, with an optional name/email profile and their prepaid credit balance.
 *
 * MOBILE-FIRST (JAK-146): the page must fit a phone with NO horizontal scroll and
 * the "Add customer" button must be reachable without scrolling right. Below the
 * mobile breakpoint the list renders as CARDS; above it, as a table (mirrors the
 * Automator LeadsTable pattern). "Add customer" captures name + optional email;
 * each customer has an Edit action, and the credit grant/lookup still works.
 */
export function TextCustomersPage() {
  const isMobile = useMediaQuery(TEXT_CUSTOMERS_MOBILE_QUERY);
  const [rows, setRows] = useState<TextCustomerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // undefined = closed; null = "add" form; a customer = "edit" form.
  const [formCustomer, setFormCustomer] = useState<TextCustomerView | null | undefined>(undefined);
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

  const renderCards = (list: TextCustomerView[]) => (
    <Stack spacing={1.5}>
      {list.map((c) => (
        <Card key={c.id} variant="outlined">
          <CardContent>
            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 1 }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="subtitle1" fontWeight={700} sx={{ wordBreak: "break-word" }}>
                  {customerDisplayName(c) || "Unnamed"}
                </Typography>
                <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
                  {c.phone}
                </Typography>
                {c.email && (
                  <Typography variant="body2" color="text.secondary" sx={{ wordBreak: "break-word" }}>
                    {c.email}
                  </Typography>
                )}
              </Box>
              <Chip
                size="small"
                label={`${c.creditBalance} credits`}
                color={c.creditBalance > 0 ? "success" : "default"}
              />
            </Box>
            <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
              <Button size="small" onClick={() => setFormCustomer(c)}>
                Edit
              </Button>
              <Button size="small" onClick={() => setGrantPhone(c.phone)}>
                Grant credits
              </Button>
            </Stack>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );

  const renderTable = (list: TextCustomerView[]) => (
    <TableContainer component={Paper}>
      <Table sx={{ minWidth: 720 }}>
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            <TableCell>Phone</TableCell>
            <TableCell>Email</TableCell>
            <TableCell align="right">Credits</TableCell>
            <TableCell>First seen</TableCell>
            <TableCell>Last seen</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {list.map((c) => (
            <TableRow key={c.id} hover>
              <TableCell>{customerDisplayName(c) || "—"}</TableCell>
              <TableCell sx={{ fontFamily: "monospace" }}>{c.phone}</TableCell>
              <TableCell>{c.email || "—"}</TableCell>
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
                <Button size="small" onClick={() => setFormCustomer(c)}>
                  Edit
                </Button>
                <Button size="small" onClick={() => setGrantPhone(c.phone)}>
                  Grant credits
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
      {/* flexWrap keeps the action buttons on-screen on a phone — no overflow. */}
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, mb: 3 }}>
        <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1, minWidth: 0 }}>
          Text customers
        </Typography>
        <Button variant="text" onClick={() => setGrantPhone("")}>
          Credit a phone
        </Button>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setFormCustomer(null)}>
          Add customer
        </Button>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Tier-1 texters, billed by sender phone. Add a customer with their name and
        an optional email; grant credits to top up a texter&apos;s own account.
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
          No text customers yet. Use “Add customer” to create one, or “Credit a phone” to grant
          credits to a number before it texts in.
        </Alert>
      ) : isMobile ? (
        renderCards(rows)
      ) : (
        renderTable(rows)
      )}

      <TextCustomerFormDialog
        open={formCustomer !== undefined}
        customer={formCustomer ?? null}
        onClose={() => setFormCustomer(undefined)}
        onSaved={(customer) => {
          const name = customerDisplayName(customer) || customer.phone;
          setToast(`Saved ${name}.`);
          load();
        }}
      />

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
