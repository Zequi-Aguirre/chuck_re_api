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
 * JAK-192 — focused "Rotate API key" dialog. Replaces the stored GHL API key
 * (the one Zequi pasted, used to WRITE BACK to the sub-account) via the existing
 * `apiKey` field on `PUT /connections/:locationId`. Name/details are edited
 * separately (ConnectionFormDialog).
 *
 * This is NOT the inbound webhook key (JAK-189, the `x-api-key` on
 * /ghl/contact-created) — that has its own Copy/Regenerate control in the webhook
 * section. The helper text spells out the difference so they're never confused.
 */
export function RotateApiKeyDialog({ open, locationId, onClose, onSaved }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError(null);
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError("Paste the new GHL API key to rotate it.");
      return;
    }
    setBusy(true);
    try {
      await api.updateConnection(locationId, { apiKey: trimmed });
      onSaved();
      handleClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Rotate failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleClose() {
    setApiKey("");
    setError(null);
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>Rotate API key</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <Typography variant="body2" color="text.secondary">
            This is the <strong>GHL API key</strong> used to write enrichment results
            back to this sub-account. It is NOT the inbound webhook key (that has its
            own Copy / Regenerate control below). Pasting a new key replaces the stored
            one immediately.
          </Typography>
          <TextField
            label="New GHL API key"
            fullWidth
            type="password"
            autoComplete="off"
            autoFocus
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            helperText="Stored encrypted. It's never shown again after saving."
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={onSubmit} disabled={busy}>
          {busy ? "Saving…" : "Rotate key"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
