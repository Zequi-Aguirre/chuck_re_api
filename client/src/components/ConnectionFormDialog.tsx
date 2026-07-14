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

const DEFAULT_BASE_URL = "https://services.leadconnectorhq.com";

interface Props {
  open: boolean;
  /** Create a new connection, or edit/rotate an existing one. */
  mode: "create" | "edit";
  initial?: { locationId: string; name?: string | null; baseUrl: string; phoneNumbers: string[] };
  onClose: () => void;
  onSaved: () => void;
}

/**
 * The connect / edit form (JAK-113). To connect a sub-account, Zequi pastes its
 * GHL API key + location id + base url; on save the key is sent once and stored
 * encrypted at rest — it is never returned or shown again. In edit mode the key
 * field is optional and only rotates the stored key when filled.
 */
export function ConnectionFormDialog({ open, mode, initial, onClose, onSaved }: Props) {
  const isEdit = mode === "edit";
  const [locationId, setLocationId] = useState(initial?.locationId ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? DEFAULT_BASE_URL);
  const [phones, setPhones] = useState((initial?.phoneNumbers ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError(null);

    const trimmedLocation = locationId.trim();
    const trimmedKey = apiKey.trim();
    const trimmedBase = baseUrl.trim();
    const phoneNumbers = phones
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    if (!isEdit && (!trimmedLocation || !trimmedKey || !trimmedBase)) {
      setError("Location ID, API key and base URL are required.");
      return;
    }

    setBusy(true);
    try {
      if (isEdit) {
        await api.updateConnection(trimmedLocation, {
          // JAK-190 — always send name (blank string clears it).
          name: name.trim(),
          // Only send the key when the operator typed a new one (rotation).
          apiKey: trimmedKey ? trimmedKey : undefined,
          baseUrl: trimmedBase,
          phoneNumbers,
        });
      } else {
        await api.createConnection({
          locationId: trimmedLocation,
          name: name.trim(),
          apiKey: trimmedKey,
          baseUrl: trimmedBase,
          phoneNumbers,
        });
      }
      onSaved();
      handleClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed. Please try again.");
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
      <DialogTitle>{isEdit ? "Edit sub-account" : "Connect a sub-account"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Name (friendly label)"
            fullWidth
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Realty"
            helperText="Shown as the heading. Leave blank to display the Location ID."
          />
          <TextField
            label="GHL Location ID"
            fullWidth
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            disabled={isEdit}
            helperText={isEdit ? "The location can't be changed." : undefined}
          />
          <TextField
            label={isEdit ? "New API key (leave blank to keep current)" : "GHL API key"}
            fullWidth
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            helperText="Stored encrypted. It's never shown again after saving."
          />
          <TextField
            label="Base URL"
            fullWidth
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <TextField
            label="Phone numbers (comma-separated, E.164)"
            fullWidth
            value={phones}
            onChange={(e) => setPhones(e.target.value)}
            placeholder="+15551234567, +15557654321"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={onSubmit} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
