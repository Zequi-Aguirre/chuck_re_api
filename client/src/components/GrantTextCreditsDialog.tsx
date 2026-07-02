import { useEffect, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { api, ApiError } from "../api";

interface Props {
  open: boolean;
  /**
   * Pre-filled, locked phone when granting from a customer row. Leave undefined
   * for the free "credit any number" form (phone editable, incl. one that
   * hasn't texted in yet).
   */
  phone?: string;
  onClose: () => void;
  onSaved: (phone: string, balance: number) => void;
}

/**
 * Grant / adjust a tier-1 text-Jake customer's credits BY PHONE (JAK-129). A
 * positive amount tops up; a negative amount is a correcting adjustment. Credits
 * land on the customer's OWN credit account (keyed by phone), not a connection —
 * so a gateway texter who ran out of Jake credits can be topped up here.
 */
export function GrantTextCreditsDialog({ open, phone, onClose, onSaved }: Props) {
  const locked = phone !== undefined;
  const [phoneInput, setPhoneInput] = useState(phone ?? "");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Sync the locked phone in when the dialog is (re)opened for a specific row.
  useEffect(() => {
    if (open) {
      setPhoneInput(phone ?? "");
      setAmount("");
      setError(null);
    }
  }, [open, phone]);

  async function onSubmit() {
    setError(null);
    const cleanPhone = phoneInput.trim();
    if (!cleanPhone) {
      setError("Enter a phone number (E.164, e.g. +17865274077).");
      return;
    }
    const n = Number(amount);
    if (!Number.isInteger(n) || n === 0) {
      setError("Enter a non-zero whole number (negative to deduct).");
      return;
    }
    setBusy(true);
    try {
      const res = await api.grantTextCustomerCredits(
        cleanPhone,
        n,
        n > 0 ? "manual_grant" : "adjustment"
      );
      onSaved(cleanPhone, res.balance);
      handleClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Grant failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleClose() {
    setPhoneInput(phone ?? "");
    setAmount("");
    setError(null);
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>{locked ? "Grant credits" : "Credit a phone"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <Typography variant="body2" color="text.secondary">
            Credits go to this texter&apos;s own account (by phone). Positive adds; negative deducts.
          </Typography>
          <TextField
            label="Phone (E.164)"
            fullWidth
            autoFocus={!locked}
            disabled={locked || busy}
            placeholder="+17865274077"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
          />
          <TextField
            label="Amount (credits)"
            type="number"
            fullWidth
            autoFocus={locked}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={onSubmit} disabled={busy}>
          {busy ? "Saving…" : "Apply"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
