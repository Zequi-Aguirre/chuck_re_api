import { useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import { api, ApiError } from "../api";
import { AdminRole } from "../types";

const MIN_PASSWORD_LENGTH = 8;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the new admin's email after a successful create. */
  onCreated: (email: string) => void;
}

/**
 * Create-another-admin form (JAK-124). Zequi types the new admin's email and a
 * password HE chooses, then clicks create — no email/invite/reset flow. He shares
 * the password he typed manually. The password is sent once, hashed server-side
 * with bcrypt, and never returned or shown again.
 */
export function AddAdminDialog({ open, onClose, onCreated }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AdminRole>("admin");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError(null);
    const trimmedEmail = email.trim();

    if (!trimmedEmail || !password) {
      setError("Email and password are required.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    try {
      const admin = await api.createAdmin(trimmedEmail, password, role);
      onCreated(admin.email);
      handleClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Create failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleClose() {
    setEmail("");
    setPassword("");
    setRole("admin");
    setError(null);
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>Add admin</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Email"
            type="email"
            fullWidth
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextField
            label="Password"
            type="password"
            fullWidth
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            helperText="You choose this password and share it with the new admin yourself. It's stored hashed and never shown again."
          />
          <TextField
            select
            label="Role"
            fullWidth
            value={role}
            onChange={(e) => setRole(e.target.value as AdminRole)}
            helperText="Admins manage sub-accounts. Superadmins also manage other admins."
          >
            <MenuItem value="admin">Admin</MenuItem>
            <MenuItem value="superadmin">Superadmin</MenuItem>
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={onSubmit} disabled={busy}>
          {busy ? "Creating…" : "Create admin"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
