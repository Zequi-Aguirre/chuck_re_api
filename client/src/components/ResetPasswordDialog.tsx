import { useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import { api, ApiError } from "../api";

const MIN_PASSWORD_LENGTH = 8;

interface Props {
  open: boolean;
  /** The admin whose password is being reset; null when the dialog is closed. */
  admin: { id: string; email: string } | null;
  onClose: () => void;
  /** Called with the admin's email after a successful reset. */
  onReset: (email: string) => void;
}

/**
 * Superadmin password reset (JAK-125). A superadmin types a brand-new password
 * for another admin; it's sent once, bcrypt-hashed server-side, and REPLACES the
 * old hash. There is NO email, reset link, or token — the superadmin hands the
 * new password over directly (same philosophy as create). It's never returned or
 * shown again.
 */
export function ResetPasswordDialog({ open, admin, onClose, onReset }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError(null);
    if (!admin) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    try {
      await api.resetAdminPassword(admin.id, password);
      onReset(admin.email);
      handleClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Reset failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleClose() {
    setPassword("");
    setError(null);
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>Reset password{admin ? ` — ${admin.email}` : ""}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="New password"
            type="password"
            fullWidth
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            helperText="You choose this password and share it with the admin yourself. It's stored hashed and never shown again."
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={onSubmit} disabled={busy}>
          {busy ? "Resetting…" : "Reset password"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
