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
import { TextCustomerStatus, TextCustomerView } from "../types";
import { GrantTextCreditsDialog } from "../components/GrantTextCreditsDialog";
import { TextCustomerFormDialog } from "../components/TextCustomerFormDialog";
import {
  TEXT_CUSTOMERS_MOBILE_QUERY,
  customerDisplayName,
  customerStatusColor,
  customerStatusLabel,
} from "./textCustomersLayout";
import { CREDIT_TYPES, balanceOf, creditTypeLabel, creditTypeShort } from "./creditsLayout";

/**
 * Tier-1 text-Jake customers (JAK-129 + JAK-146 + JAK-148): every texter keyed by
 * sender phone, with an optional name/email profile, their prepaid credit balance,
 * and a two-level hold status.
 *
 * MOBILE-FIRST (JAK-146 standing rule): the page must fit a phone with NO
 * horizontal scroll and the "Add customer" button must be reachable without
 * scrolling right. Below the mobile breakpoint the list renders as CARDS; above
 * it, as a table (mirrors the Automator LeadsTable pattern).
 *
 * JAK-148 — each customer shows its current status and has per-customer controls:
 *   - On hold   — SOFT pause: GHL keeps forwarding, but Jake replies "on hold".
 *   - Deactivate — HARD off: turns off "text Jake" so GHL stops forwarding
 *                  (confirmed first, since it changes GoHighLevel).
 *   - Reactivate — back to normal.
 * None of these touch the customer's credits.
 */
export function TextCustomersPage() {
  const isMobile = useMediaQuery(TEXT_CUSTOMERS_MOBILE_QUERY);
  const [rows, setRows] = useState<TextCustomerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // The id whose status change is in flight, so we can disable its buttons.
  const [busyId, setBusyId] = useState<string | null>(null);
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

  // Change a customer's hold status (JAK-148). Deactivate is confirmed first — it
  // changes GoHighLevel (stops forwarding their texts). Credits are never affected.
  const onChangeStatus = useCallback(
    async (c: TextCustomerView, next: TextCustomerStatus) => {
      const name = customerDisplayName(c) || c.phone;
      if (
        next === "deactivated" &&
        !window.confirm(
          `Deactivate ${name}? This turns off “text Jake” in GoHighLevel so Jake stops ` +
            `receiving their texts. Their credits aren’t affected, and you can reactivate anytime.`
        )
      ) {
        return;
      }
      setError(null);
      setBusyId(c.id);
      try {
        const res =
          next === "on_hold"
            ? await api.holdTextCustomer(c.id)
            : next === "deactivated"
              ? await api.deactivateTextCustomer(c.id)
              : await api.reactivateTextCustomer(c.id);
        const savedName = customerDisplayName(res.customer) || res.customer.phone;
        const label = customerStatusLabel(res.customer.status);
        // Surface the GHL flip outcome inline when there was one (deactivate/reactivate).
        setToast(res.sync?.message ? `${savedName}: ${label}. ${res.sync.message}` : `${savedName}: ${label}.`);
        await load();
      } catch {
        setError("Couldn't update that customer's status. Please try again.");
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  // The hold controls for one customer, driven by its current status (JAK-148):
  //   active      → On hold, Deactivate
  //   on_hold     → Reactivate, Deactivate
  //   deactivated → Reactivate
  const statusActions = (c: TextCustomerView) => {
    const disabled = busyId === c.id;
    return (
      <>
        {c.status === "active" && (
          <Button size="small" color="warning" disabled={disabled} onClick={() => onChangeStatus(c, "on_hold")}>
            On hold
          </Button>
        )}
        {(c.status === "on_hold" || c.status === "deactivated") && (
          <Button size="small" color="success" disabled={disabled} onClick={() => onChangeStatus(c, "active")}>
            Reactivate
          </Button>
        )}
        {c.status !== "deactivated" && (
          <Button size="small" color="error" disabled={disabled} onClick={() => onChangeStatus(c, "deactivated")}>
            Deactivate
          </Button>
        )}
      </>
    );
  };

  // The three per-feature balances (JAK-161/JAK-162) as compact chips — a green
  // chip when the bucket has credits, a muted one at 0 so a low bucket stands out.
  // `dense` uses the short glyphs (Report/Skip/Comps) for the tight table cell.
  const creditChips = (c: TextCustomerView, dense: boolean) =>
    CREDIT_TYPES.map((t) => {
      const n = balanceOf(c.credits, t);
      return (
        <Chip
          key={t}
          size="small"
          variant="outlined"
          label={`${dense ? creditTypeShort(t) : creditTypeLabel(t)} ${n}`}
          color={n > 0 ? "success" : "default"}
        />
      );
    });

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
              {/* Status + the three per-feature credit chips stack so they never
                  push the card wide on a phone (JAK-162 mobile-first). */}
              <Stack spacing={0.5} alignItems="flex-end" sx={{ flexShrink: 0 }}>
                <Chip size="small" label={customerStatusLabel(c.status)} color={customerStatusColor(c.status)} />
                {creditChips(c, false)}
              </Stack>
            </Box>
            {/* flexWrap + useFlexGap keeps every action on-screen on a phone. */}
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 1.5 }}>
              <Button size="small" onClick={() => setFormCustomer(c)}>
                Edit
              </Button>
              <Button size="small" onClick={() => setGrantPhone(c.phone)}>
                Grant credits
              </Button>
              {statusActions(c)}
            </Stack>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );

  const renderTable = (list: TextCustomerView[]) => (
    <TableContainer component={Paper}>
      <Table sx={{ minWidth: 820 }}>
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            <TableCell>Phone</TableCell>
            <TableCell>Email</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Credits (report / skip / comps)</TableCell>
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
              <TableCell>
                <Chip size="small" label={customerStatusLabel(c.status)} color={customerStatusColor(c.status)} />
              </TableCell>
              <TableCell>
                <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
                  {creditChips(c, true)}
                </Stack>
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
                {statusActions(c)}
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
        an optional email; grant credits to top up a texter&apos;s own account. Put a
        customer on hold to pause them (Jake replies that they&apos;re on hold), or
        deactivate to stop GoHighLevel from sending their texts — neither changes credits.
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
        onSaved={(customer, sync) => {
          const name = customerDisplayName(customer) || customer.phone;
          // Surface the GHL sync outcome inline (JAK-147) — "Synced…", the dev
          // "sync runs in staging/production only", or a not-found/error note.
          setToast(sync?.message ? `Saved ${name}. ${sync.message}` : `Saved ${name}.`);
          load();
        }}
      />

      <GrantTextCreditsDialog
        open={grantPhone !== undefined}
        phone={grantPhone === "" ? undefined : grantPhone}
        onClose={() => setGrantPhone(undefined)}
        onSaved={(phone, balance, type) => {
          setToast(`${phone} now has ${balance} ${creditTypeLabel(type).toLowerCase()} credits.`);
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
