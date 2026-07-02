import { useState } from "react";
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
  locationId: string;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Manual credit grant / adjustment (JAK-113 beta path — Stripe billing deferred).
 * A positive amount tops up; a negative amount is a correcting adjustment.
 */
export function GrantCreditsDialog({ open, locationId, onClose, onSaved }: Props) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError(null);
    const n = Number(amount);
    if (!Number.isInteger(n) || n === 0) {
      setError("Enter a non-zero whole number (negative to deduct).");
      return;
    }
    setBusy(true);
    try {
      await api.grantCredits(locationId, n, n > 0 ? "manual_grant" : "adjustment");
      onSaved();
      handleClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Grant failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleClose() {
    setAmount("");
    setError(null);
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>Adjust credits</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <Typography variant="body2" color="text.secondary">
            Positive adds credits; negative deducts.
          </Typography>
          <TextField
            label="Amount (credits)"
            type="number"
            fullWidth
            autoFocus
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
