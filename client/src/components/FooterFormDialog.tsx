import { useEffect, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import { api, ApiError } from "../api";
import { FooterView } from "../types";

interface Props {
  open: boolean;
  /** null = add a new footer; a footer = edit it. */
  footer: FooterView | null;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Add / edit a rotating reply footer (JAK-188). The text is MULTI-LINE — the
 * seeded default footer is two lines, and admins can add more of any shape. A new
 * footer is active by default (joins the rotation immediately); the switch lets
 * an admin add it parked or flip an existing one.
 */
export function FooterFormDialog({ open, footer, onClose, onSaved }: Props) {
  const isEdit = footer !== null;
  const [text, setText] = useState("");
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset the fields whenever the dialog opens for a different footer.
  useEffect(() => {
    if (open) {
      setText(footer?.text ?? "");
      setActive(footer?.active ?? true);
      setError(null);
    }
  }, [open, footer]);

  async function onSubmit() {
    setError(null);
    const trimmed = text.trim();
    if (!trimmed) {
      setError("Footer text is required.");
      return;
    }

    setBusy(true);
    try {
      if (isEdit && footer) {
        await api.updateFooter(footer.id, { text: trimmed, active });
      } else {
        await api.createFooter({ text: trimmed, active });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the footer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{isEdit ? "Edit footer" : "Add footer"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Footer text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Every Lead Deserves Jake.\nGoTextJake.com/CRM"}
            multiline
            minRows={2}
            fullWidth
            autoFocus
            helperText="Shown at the end of a reply. Multiple lines are supported."
          />
          <FormControlLabel
            control={<Switch checked={active} onChange={(e) => setActive(e.target.checked)} />}
            label={active ? "Active (in rotation)" : "Inactive (parked)"}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={onSubmit} disabled={busy}>
          {isEdit ? "Save" : "Add"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
