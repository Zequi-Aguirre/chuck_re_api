import { useEffect, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import { api, ApiError } from "../api";
import { TextCustomerSyncResult, TextCustomerView } from "../types";

interface Props {
  open: boolean;
  /** The customer being edited, or null/undefined to add a new one. */
  customer?: TextCustomerView | null;
  onClose: () => void;
  onSaved: (customer: TextCustomerView, sync: TextCustomerSyncResult) => void;
}

/**
 * Add or edit a text-Jake customer's profile (JAK-146): first + last name, a
 * REQUIRED phone (the billing identity), and an OPTIONAL email. Saving without an
 * email is allowed. On add it POSTs a new customer; on edit it PUTs by id.
 *
 * JAK-147: a "Find contact" action looks the phone up in the Jake GoHighLevel
 * sub-account and prefills any name/email already on that contact; on save the
 * customer is created/found there and marked approved to text Jake. Mobile
 * friendly — fields stack full-width and the dialog is `fullWidth maxWidth="xs"`,
 * so nothing overflows on a phone.
 */
export function TextCustomerFormDialog({ open, customer, onClose, onSaved }: Props) {
  const editing = !!customer;
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState(false);
  // Inline, non-technical status for the GHL find/sync (JAK-147).
  const [findMsg, setFindMsg] = useState<string | null>(null);

  // Seed the fields from the edited customer (or blank for add) on open.
  useEffect(() => {
    if (open) {
      setFirstName(customer?.firstName ?? "");
      setLastName(customer?.lastName ?? "");
      setPhone(customer?.phone ?? "");
      setEmail(customer?.email ?? "");
      setError(null);
      setFindMsg(null);
    }
  }, [open, customer]);

  // Look the phone up in the Jake sub-account and prefill any name/email on file.
  async function onFindContact() {
    const cleanPhone = phone.trim();
    if (!cleanPhone) {
      setError("Enter a phone number first (E.164, e.g. +17865274077).");
      return;
    }
    setError(null);
    setFindMsg(null);
    setFinding(true);
    try {
      const res = await api.findTextCustomerContact(cleanPhone);
      if (res.found && res.contact) {
        // Only fill blanks / overwrite with what GoHighLevel has on the contact.
        if (res.contact.firstName) setFirstName(res.contact.firstName);
        if (res.contact.lastName) setLastName(res.contact.lastName);
        if (res.contact.email) setEmail(res.contact.email);
      }
      setFindMsg(res.message);
    } catch (err) {
      setFindMsg(
        err instanceof ApiError ? err.message : "Couldn’t look up that contact right now."
      );
    } finally {
      setFinding(false);
    }
  }

  async function onSubmit() {
    setError(null);
    const cleanPhone = phone.trim();
    if (!cleanPhone) {
      setError("Enter a phone number (E.164, e.g. +17865274077).");
      return;
    }
    const cleanEmail = email.trim();
    // Email is optional; only validate the shape when one is provided.
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError("Enter a valid email, or leave it blank.");
      return;
    }
    const input = {
      phone: cleanPhone,
      firstName: firstName.trim() || null,
      lastName: lastName.trim() || null,
      email: cleanEmail || null,
    };
    setBusy(true);
    try {
      const saved = editing
        ? await api.updateTextCustomer(customer!.id, input)
        : await api.createTextCustomer(input);
      onSaved(saved.customer, saved.sync);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>{editing ? "Edit customer" : "Add customer"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="First name"
            fullWidth
            autoFocus
            disabled={busy}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
          />
          <TextField
            label="Last name"
            fullWidth
            disabled={busy}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
          <TextField
            label="Phone (E.164)"
            required
            fullWidth
            disabled={busy}
            placeholder="+17865274077"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              // A phone change invalidates the previous lookup message.
              setFindMsg(null);
            }}
          />
          {/* Look the phone up in GoHighLevel to prefill any existing contact (JAK-147). */}
          <Button
            size="small"
            variant="outlined"
            onClick={onFindContact}
            disabled={busy || finding || !phone.trim()}
            sx={{ alignSelf: "flex-start" }}
          >
            {finding ? "Looking up…" : "Find contact in GoHighLevel"}
          </Button>
          {findMsg && <Alert severity="info">{findMsg}</Alert>}
          <TextField
            label="Email (optional)"
            type="email"
            fullWidth
            disabled={busy}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={onSubmit} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
